import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, publicSite } from './store.js';
import { Auth } from './auth.js';
import { JobManager } from './jobs.js';
import { Router, sendJson, readJson, serveStatic, setSecurityHeaders } from './http.js';
import { WPClient, WPError, connectSite, discoverSite, USER_AGENT } from './wp-client.js';
import { TermResolver } from './terms.js';
import { ACTIONS } from './actions.js';
import { queryPosts, getPostForEdit, savePost, queryPlugins, querySettings, queryTerms } from './queries.js';
import { HttpError, badRequest, pool, htmlToText, clampInt } from './util.js';
import { VERSION } from './version.js';

const DEFAULT_PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const wporgApi = () => process.env.WPBM_WPORG_API || 'https://api.wordpress.org/plugins/info/1.2/';
const JSON_LIMIT = 1024 * 1024;
const UPLOAD_LIMIT = 25 * 1024 * 1024;

const now = () => new Date().toISOString();

/** Same site if host + path match; http vs https doesn't matter. */
function siteKey(url) {
  try {
    const u = new URL(url);
    return (u.host + u.pathname).replace(/\/+$/, '').toLowerCase();
  } catch {
    return String(url).toLowerCase();
  }
}

/** Per-request cache of API clients and term lookups, one per site. */
function makeContext(store) {
  const contexts = new Map();
  return {
    getSite(id) {
      const site = store.getSite(id);
      if (!site) throw badRequest('站点不存在，可能已被删除，请刷新页面');
      return site;
    },
    siteContext(site) {
      if (!contexts.has(site.id)) {
        const { username, password } = store.credentials(site);
        const client = new WPClient({ apiRoot: site.apiRoot, username, password });
        contexts.set(site.id, { site, client, terms: new TermResolver(client) });
      }
      return contexts.get(site.id);
    },
  };
}

/** Import lines: "网址,用户名,应用密码[,分组]" (comma, Chinese comma, | or tab), or space separated. */
export function parseImportText(text) {
  const lines = [];
  String(text ?? '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    let parts = line.split(/\s*[,，|\t]\s*/);
    if (parts.length === 1) {
      // "example.com admin abcd efgh ijkl mnop qrst uvwx": app passwords contain spaces.
      const words = line.split(/\s+/);
      parts = words.length >= 3 ? [words[0], words[1], words.slice(2).join(' ')] : parts;
    }
    const [url, username, password, group] = parts;
    lines.push(url && username && password
      ? { lineNo: i + 1, url, username, password, group: group || '' }
      : { lineNo: i + 1, url: url || line, error: '格式不正确，应为：网址,用户名,应用密码' });
  });
  return lines;
}

export function createApp({
  dataDir,
  publicDir = DEFAULT_PUBLIC_DIR,
  allowedHosts = null,
  trustProxy = false,
} = {}) {
  const store = new Store(dataDir);
  const auth = new Auth(store);
  const jobs = new JobManager({ store });
  const router = new Router();
  const root = path.resolve(publicDir);

  const isSecure = (req) => Boolean(req.socket.encrypted) || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
  const clientIp = (req) => (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';

  function sitesFromIds(ids) {
    if (!Array.isArray(ids) || !ids.length) throw badRequest('请先在左侧选择站点');
    return [...new Set(ids.map(String))].map((id) => {
      const site = store.getSite(id);
      if (!site) throw badRequest('站点不存在，可能已被删除，请刷新页面');
      return site;
    });
  }

  function requireSite(id) {
    const site = store.getSite(id);
    if (!site) throw new HttpError(404, '站点不存在');
    return site;
  }

  async function addSite({ url, username, appPassword, group, name }) {
    const password = String(appPassword ?? '').trim();
    const info = await connectSite({ url, username, password });
    const user = String(username).trim();
    // No await between this check and addSite(), so concurrent imports can't both pass it.
    const dup = store.sites.find((s) => siteKey(s.url) === siteKey(info.home) && s.username.toLowerCase() === user.toLowerCase());
    if (dup) throw new HttpError(409, `这个站点已经用账号 ${user} 添加过了（${dup.name}）`);
    return store.addSite({
      name: String(name ?? '').trim() || info.name || new URL(info.home).host,
      url: info.home,
      adminUrl: `${info.siteUrl}/wp-admin/`,
      apiRoot: info.apiRoot,
      username: user,
      password,
      group: String(group ?? '').trim(),
      wpName: info.name,
      user: info.user,
      caps: info.caps,
      lastCheck: { ok: true, at: now(), message: '连接正常' },
    });
  }

  async function testSite(site) {
    try {
      const { username, password } = store.credentials(site);
      const info = await connectSite({ url: site.url, username, password });
      store.updateSite(site.id, {
        url: info.home,
        adminUrl: `${info.siteUrl}/wp-admin/`,
        apiRoot: info.apiRoot,
        wpName: info.name,
        user: info.user,
        caps: info.caps,
        lastCheck: { ok: true, at: now(), message: '连接正常' },
      });
      return { siteId: site.id, ok: true, message: '连接正常' };
    } catch (err) {
      store.updateSite(site.id, { lastCheck: { ok: false, at: now(), message: err.message } });
      return { siteId: site.id, ok: false, message: err.message };
    }
  }

  // ---- console login ------------------------------------------------------

  router.add('GET', '/api/auth/status', ({ req }) => ({
    version: VERSION,
    configured: auth.isConfigured(),
    authenticated: auth.isConfigured() && auth.isAuthenticated(req),
  }), { public: true });

  router.add('POST', '/api/auth/setup', async ({ req, res, body }) => {
    await auth.setup(body.password, body.code);
    res.setHeader('Set-Cookie', auth.sessionCookie(isSecure(req)));
    return { ok: true };
  }, { public: true });

  router.add('POST', '/api/auth/login', async ({ req, res, body }) => {
    await auth.login(body.password, clientIp(req));
    res.setHeader('Set-Cookie', auth.sessionCookie(isSecure(req)));
    return { ok: true };
  }, { public: true });

  router.add('POST', '/api/auth/logout', ({ req, res }) => {
    res.setHeader('Set-Cookie', auth.clearCookie(isSecure(req)));
    return { ok: true };
  }, { public: true });

  router.add('POST', '/api/auth/password', async ({ req, res, body }) => {
    await auth.changePassword(body.current, body.password);
    res.setHeader('Set-Cookie', auth.sessionCookie(isSecure(req)));
    return { ok: true };
  });

  // ---- sites --------------------------------------------------------------

  router.add('GET', '/api/sites', () => ({ sites: store.listSites() }));

  router.add('POST', '/api/sites/discover', async ({ body }) => {
    const info = await discoverSite(body.url);
    return { home: info.home, siteUrl: info.siteUrl, name: info.name, apiRoot: info.apiRoot, appPasswords: info.appPasswords };
  });

  router.add('POST', '/api/sites', async ({ body }) => ({ site: publicSite(await addSite(body)) }));

  router.add('PATCH', '/api/sites/:id', async ({ params, body }) => {
    const site = requireSite(params.id);
    const patch = {};
    if (typeof body.name === 'string') patch.name = body.name.trim() || site.name;
    if (typeof body.group === 'string') patch.group = body.group.trim();
    const url = String(body.url ?? '').trim();
    const username = String(body.username ?? '').trim();
    const appPassword = String(body.appPassword ?? '').trim();
    if ((url && url !== site.url) || (username && username !== site.username) || appPassword) {
      const creds = {
        url: url || site.url,
        username: username || site.username,
        password: appPassword || store.credentials(site).password,
      };
      const info = await connectSite(creds);
      Object.assign(patch, {
        url: info.home,
        adminUrl: `${info.siteUrl}/wp-admin/`,
        apiRoot: info.apiRoot,
        username: creds.username,
        password: creds.password,
        wpName: info.name,
        user: info.user,
        caps: info.caps,
        lastCheck: { ok: true, at: now(), message: '连接正常' },
      });
    }
    return { site: publicSite(store.updateSite(site.id, patch)) };
  });

  router.add('DELETE', '/api/sites/:id', ({ params }) => {
    if (!store.removeSite(params.id)) throw new HttpError(404, '站点不存在');
    return { ok: true };
  });

  router.add('POST', '/api/sites/test', async ({ body }) => ({
    results: await pool(sitesFromIds(body.siteIds), 6, testSite),
    sites: store.listSites(),
  }));

  router.add('POST', '/api/sites/import', ({ body }) => {
    const lines = parseImportText(body.text);
    if (!lines.length) throw badRequest('没有可导入的内容');
    if (lines.length > 500) throw badRequest('一次最多导入 500 个站点');
    const defaultGroup = String(body.group ?? '').trim();
    const tasks = lines.map((line, i) => ({
      siteId: `import-${i}`,
      siteName: line.url,
      label: `第 ${line.lineNo} 行`,
      run: async () => {
        if (line.error) throw new Error(line.error);
        const site = await addSite({ ...line, appPassword: line.password, group: line.group || defaultGroup });
        return { message: `已添加：${site.name}`, data: { siteId: site.id } };
      },
    }));
    const job = jobs.start({ action: 'sites.import', title: `批量导入站点（${tasks.length} 个）`, tasks, perSite: 1 });
    return { job: jobs.view(job.id) };
  });

  // ---- queries --------------------------------------------------------------

  router.add('POST', '/api/posts/query', ({ body }) => queryPosts(makeContext(store), sitesFromIds(body.siteIds), body));

  router.add('GET', '/api/sites/:id/posts/:postId', ({ params, query }) =>
    getPostForEdit(makeContext(store), requireSite(params.id), query.get('type'), clampInt(params.postId, 1, 1e12, 0)));

  router.add('PUT', '/api/sites/:id/posts/:postId', ({ params, query, body }) =>
    savePost(makeContext(store), requireSite(params.id), query.get('type'), clampInt(params.postId, 1, 1e12, 0), body));

  router.add('POST', '/api/plugins/query', ({ body }) => queryPlugins(makeContext(store), sitesFromIds(body.siteIds)));

  router.add('POST', '/api/settings/query', ({ body }) => querySettings(makeContext(store), sitesFromIds(body.siteIds)));

  router.add('POST', '/api/terms/query', ({ body }) =>
    queryTerms(makeContext(store), sitesFromIds(body.siteIds), body.taxonomy));

  router.add('GET', '/api/wporg/plugins', async ({ query }) => {
    const search = String(query.get('search') || '').trim().slice(0, 100);
    const url = new URL(wporgApi());
    url.searchParams.set('action', 'query_plugins');
    if (search) url.searchParams.set('request[search]', search);
    else url.searchParams.set('request[browse]', 'popular');
    url.searchParams.set('request[page]', String(clampInt(query.get('page'), 1, 50, 1)));
    url.searchParams.set('request[per_page]', '24');
    for (const field of ['description', 'sections', 'versions', 'screenshots', 'banners', 'contributors', 'ratings', 'tags']) {
      url.searchParams.set(`request[fields][${field}]`, '0');
    }
    let data;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      throw new HttpError(502, `无法连接 WordPress.org 插件目录（${err.message}）。也可以直接填写插件的英文名称来安装`);
    }
    return {
      info: data.info || null,
      plugins: (data.plugins || []).map((p) => ({
        name: htmlToText(p.name),
        slug: p.slug,
        version: p.version,
        author: htmlToText(p.author),
        rating: p.rating,
        numRatings: p.num_ratings,
        activeInstalls: p.active_installs,
        shortDescription: htmlToText(p.short_description),
        icon: p.icons?.['1x'] || p.icons?.default || p.icons?.svg || null,
        requires: p.requires,
        tested: p.tested,
        lastUpdated: p.last_updated,
      })),
    };
  });

  // ---- batch jobs -----------------------------------------------------------

  router.add('POST', '/api/jobs', async ({ body }) => {
    const def = ACTIONS[body.action];
    if (!def) throw badRequest('未知的操作类型');
    const tasks = await def.build(body, makeContext(store));
    if (!tasks.length) throw badRequest('没有需要执行的任务');
    const job = jobs.start({ action: body.action, title: def.title(body), tasks, perSite: def.perSite });
    return { job: jobs.view(job.id) };
  }, { bodyLimit: UPLOAD_LIMIT });

  router.add('GET', '/api/jobs/:id', ({ params, query }) => {
    const job = jobs.view(params.id, query.get('since'));
    if (!job) throw new HttpError(404, '任务不存在');
    return { job };
  });

  router.add('POST', '/api/jobs/:id/cancel', ({ params }) => ({ ok: jobs.cancel(params.id) }));

  router.add('GET', '/api/history', () => ({ jobs: jobs.list() }));

  router.add('DELETE', '/api/history', () => {
    store.clearHistory();
    return { ok: true };
  });

  // ---- request handling -----------------------------------------------------

  function hostAllowed(req) {
    if (!allowedHosts) return true;
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    return allowedHosts.includes(host);
  }

  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const host = (trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  async function handleApi(req, res, url) {
    const match = router.match(req.method, url.pathname);
    if (!match) return sendJson(res, 404, { error: '接口不存在' });
    if (match.methodNotAllowed) return sendJson(res, 405, { error: '请求方法不支持' });
    const { route, params } = match;

    if (req.method !== 'GET') {
      // CSRF: browsers can't send a cross-site JSON request without a CORS preflight,
      // which this server never approves; the Origin check covers the rest.
      if (!sameOrigin(req)) return sendJson(res, 403, { error: '请求来源不被允许' });
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
        return sendJson(res, 415, { error: '请求格式必须是 JSON' });
      }
    }
    if (!route.public && !auth.isAuthenticated(req)) {
      return sendJson(res, 401, { error: '请先登录', code: 'unauthorized' });
    }
    const body = req.method === 'GET' ? {} : await readJson(req, route.bodyLimit || JSON_LIMIT);
    const result = await route.handler({ req, res, params, query: url.searchParams, body });
    if (!res.headersSent) sendJson(res, 200, result ?? { ok: true });
  }

  async function handler(req, res) {
    setSecurityHeaders(res);
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400);
      return res.end();
    }
    if (!hostAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Host not allowed. 如需通过其他域名访问，请设置 WPBM_ALLOWED_HOSTS。');
    }
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname, root);
    try {
      await handleApi(req, res, url);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, code: err.code });
      if (err instanceof WPError || err?.code === 'decrypt_failed') {
        return sendJson(res, 400, { error: err.message, code: err.code });
      }
      console.error(err);
      sendJson(res, 500, { error: `服务器内部错误：${err?.message || err}` });
    }
  }

  return { handler, store, auth, jobs };
}
