import { pluginPath, USER_AGENT } from './wp-client.js';
import { parseList, badRequest, decodeEntities } from './util.js';
import { postType } from './queries.js';

const MAX_TARGETS = 5000;
const EDIT_STATUSES = ['publish', 'draft', 'pending', 'private'];
const STATUS_TEXT = { publish: '已发布', draft: '草稿', pending: '待审核', private: '私密', future: '定时发布', trash: '回收站' };
const TYPE_TEXT = { posts: '文章', pages: '页面' };
const TAX_TEXT = { categories: '分类', tags: '标签' };

function sitesOf(input, ctx) {
  const ids = [...new Set(Array.isArray(input.siteIds) ? input.siteIds.map(String) : [])];
  if (!ids.length) throw badRequest('请先在左侧选择站点');
  return ids.map((id) => ctx.getSite(id));
}

function targetsOf(input, ctx) {
  const list = input.targets;
  if (!Array.isArray(list) || !list.length) throw badRequest('请先勾选要操作的内容');
  if (list.length > MAX_TARGETS) throw badRequest(`一次最多操作 ${MAX_TARGETS} 条内容`);
  return list.map((t) => {
    const id = parseInt(t?.id, 10);
    if (!(id > 0)) throw badRequest('内容 ID 不正确');
    return { site: ctx.getSite(String(t.siteId)), id, title: String(t.title ?? '').slice(0, 200) };
  });
}

function task(site, label, run, targetId = null) {
  return { siteId: site.id, siteName: site.name, label, targetId, run };
}

function postTask(target, run) {
  return task(target.site, target.title || `#${target.id}`, run, target.id);
}

// ---- posts -----------------------------------------------------------------

function termOperation(op) {
  if (!op) return null;
  const mode = op.mode || 'add';
  if (!['add', 'set', 'remove'].includes(mode)) throw badRequest('分类/标签的操作方式不正确');
  const names = parseList(op.names);
  if (!names.length && mode !== 'set') return null;
  return { mode, names, create: op.createMissing !== false };
}

async function applyTermOperation(sc, taxonomy, op, current = []) {
  if (op.mode === 'remove') {
    const ids = await sc.terms.resolve(taxonomy, op.names);
    return current.filter((id) => !ids.includes(id));
  }
  const ids = await sc.terms.resolve(taxonomy, op.names, { create: op.create });
  return op.mode === 'set' ? ids : [...new Set([...current, ...ids])];
}

function buildPostsUpdate(input, ctx) {
  const type = postType(input.type);
  const p = input.params || {};
  const body = {};
  if (p.status) {
    if (!EDIT_STATUSES.includes(p.status)) throw badRequest('状态不正确');
    body.status = p.status;
  }
  if (p.commentStatus) {
    if (p.commentStatus !== 'open' && p.commentStatus !== 'closed') throw badRequest('评论设置不正确');
    body.comment_status = p.commentStatus;
  }
  if (typeof p.sticky === 'boolean') {
    if (type !== 'posts') throw badRequest('页面不支持置顶');
    body.sticky = p.sticky;
  }
  const categories = termOperation(p.categories);
  const tags = termOperation(p.tags);
  if (type !== 'posts' && (categories || tags)) throw badRequest('页面不支持分类和标签');
  if (!Object.keys(body).length && !categories && !tags) throw badRequest('没有选择要修改的内容');

  return targetsOf(input, ctx).map((t) => postTask(t, async () => {
    const sc = ctx.siteContext(t.site);
    const update = { ...body };
    if (categories || tags) {
      const needsCurrent = (categories && categories.mode !== 'set') || (tags && tags.mode !== 'set');
      const current = needsCurrent
        ? await sc.client.get(`/wp/v2/${type}/${t.id}`, { context: 'edit', _fields: 'id,categories,tags' })
        : {};
      if (categories) update.categories = await applyTermOperation(sc, 'categories', categories, current.categories || []);
      if (tags) update.tags = await applyTermOperation(sc, 'tags', tags, current.tags || []);
    }
    await sc.client.post(`/wp/v2/${type}/${t.id}`, update, { retries: 1 });
    return { message: '已更新' };
  }));
}

function buildPostsTrash(input, ctx) {
  const type = postType(input.type);
  return targetsOf(input, ctx).map((t) => postTask(t, async () => {
    try {
      await ctx.siteContext(t.site).client.del(`/wp/v2/${type}/${t.id}`, undefined, { retries: 1 });
    } catch (err) {
      if (err.code === 'rest_already_trashed') return { status: 'skipped', message: '已在回收站中' };
      throw err;
    }
    return { message: '已移到回收站' };
  }));
}

function buildPostsDelete(input, ctx) {
  const type = postType(input.type);
  return targetsOf(input, ctx).map((t) => postTask(t, async () => {
    try {
      await ctx.siteContext(t.site).client.del(`/wp/v2/${type}/${t.id}`, { force: true });
    } catch (err) {
      if (err.code === 'rest_post_invalid_id') return { status: 'skipped', message: '内容已不存在' };
      throw err;
    }
    return { message: '已永久删除' };
  }));
}

function buildPostsRestore(input, ctx) {
  const type = postType(input.type);
  return targetsOf(input, ctx).map((t) => postTask(t, async () => {
    const sc = ctx.siteContext(t.site);
    const current = await sc.client.get(`/wp/v2/${type}/${t.id}`, { context: 'edit', _fields: 'id,status,slug' });
    if (current.status !== 'trash') return { status: 'skipped', message: '不在回收站中' };
    const body = { status: 'draft' };
    // WordPress renames a trashed draft that had no slug to "__trashed" and doesn't undo it
    // on restore, so it would later be published under that URL. Clear it instead.
    if (/^__trashed(-\d+)?$/.test(current.slug || '')) body.slug = '';
    await sc.client.post(`/wp/v2/${type}/${t.id}`, body, { retries: 1 });
    return { message: '已恢复为草稿' };
  }));
}

export function makeReplacer({ find, replace = '', regex = false, caseSensitive = true }) {
  const needle = String(find ?? '');
  if (!needle) throw badRequest('请填写要查找的内容');
  const replacement = String(replace ?? '');
  const flags = caseSensitive === false ? 'gi' : 'g';
  let re;
  try {
    re = new RegExp(regex ? needle : needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  } catch (err) {
    throw badRequest(`正则表达式有误：${err.message}`);
  }
  return (text) => {
    const count = (text.match(re) || []).length;
    if (!count) return { count, text };
    // Plain mode must not interpret "$1" etc. in the replacement.
    return { count, text: text.replace(re, regex ? replacement : () => replacement) };
  };
}

function buildPostsReplace(input, ctx) {
  const type = postType(input.type);
  const p = input.params || {};
  const replacer = makeReplacer(p);
  const fields = (Array.isArray(p.fields) && p.fields.length ? p.fields : ['title', 'content'])
    .filter((f) => ['title', 'content', 'excerpt'].includes(f));
  if (!fields.length) throw badRequest('请选择要替换的位置（标题/正文/摘要）');
  const dryRun = Boolean(p.dryRun);

  return targetsOf(input, ctx).map((t) => postTask(t, async () => {
    const sc = ctx.siteContext(t.site);
    const post = await sc.client.get(`/wp/v2/${type}/${t.id}`, { context: 'edit', _fields: 'id,title,content,excerpt' });
    const update = {};
    let total = 0;
    for (const field of fields) {
      const raw = post[field]?.raw;
      if (typeof raw !== 'string') continue;
      const { count, text } = replacer(raw);
      if (count) {
        update[field] = text;
        total += count;
      }
    }
    if (!total) return { status: 'skipped', message: '没有匹配的内容' };
    if (dryRun) return { message: `找到 ${total} 处匹配（预览，未修改）`, data: { matches: total } };
    await sc.client.post(`/wp/v2/${type}/${t.id}`, update, { retries: 1 });
    return { message: `已替换 ${total} 处`, data: { matches: total } };
  }));
}

const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

function safeFilename(name, ext) {
  const base = String(name || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base || `image-${Date.now()}`}.${ext}`;
}

/** Accepts { dataBase64, mimeType, filename } (uploaded in the browser) or { url }. */
export async function loadImage(image) {
  if (!image || (!image.dataBase64 && !image.url)) return null;
  let buffer;
  let mime;
  let filename = String(image.filename || '');
  if (image.dataBase64) {
    buffer = Buffer.from(String(image.dataBase64), 'base64');
    mime = String(image.mimeType || '').toLowerCase();
  } else {
    let url;
    try {
      url = new URL(String(image.url));
    } catch {
      throw badRequest('图片网址格式不正确');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw badRequest('图片网址必须以 http:// 或 https:// 开头');
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30000) });
    } catch (err) {
      throw badRequest(`图片下载失败：${err.cause?.message || err.message}`);
    }
    if (!res.ok) throw badRequest(`图片下载失败（HTTP ${res.status}）`);
    if (Number(res.headers.get('content-length')) > MAX_IMAGE_BYTES) throw badRequest('图片不能超过 15MB');
    mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    buffer = Buffer.from(await res.arrayBuffer());
    if (!filename) filename = decodeURIComponent(url.pathname.split('/').pop() || '');
  }
  if (!IMAGE_TYPES[mime]) throw badRequest('特色图片只支持 JPG、PNG、GIF、WebP 格式');
  if (!buffer.length) throw badRequest('图片内容为空');
  if (buffer.length > MAX_IMAGE_BYTES) throw badRequest('图片不能超过 15MB');
  return { buffer, mime, filename: safeFilename(filename, IMAGE_TYPES[mime]) };
}

async function buildPostsCreate(input, ctx) {
  const type = postType(input.type);
  const sites = sitesOf(input, ctx);
  const p = input.params || {};
  const title = String(p.title ?? '').trim();
  if (!title) throw badRequest('请填写标题');
  const status = p.status || 'draft';
  if (![...EDIT_STATUSES, 'future'].includes(status)) throw badRequest('发布状态不正确');
  const body = { title, content: String(p.content ?? ''), status };
  if (p.excerpt) body.excerpt = String(p.excerpt);
  if (p.slug) body.slug = String(p.slug).trim();
  if (p.commentStatus === 'open' || p.commentStatus === 'closed') body.comment_status = p.commentStatus;
  if (p.date) {
    const date = new Date(p.date);
    if (Number.isNaN(date.getTime())) throw badRequest('发布时间格式不正确');
    if (status === 'future' && date <= new Date()) throw badRequest('定时发布的时间必须晚于现在');
    body.date_gmt = date.toISOString().slice(0, 19);
  } else if (status === 'future') {
    throw badRequest('定时发布需要填写发布时间');
  }
  const categories = type === 'posts' ? parseList(p.categories) : [];
  const tags = type === 'posts' ? parseList(p.tags) : [];
  const createTerms = p.createTerms !== false;
  const image = await loadImage(p.image);

  return sites.map((site) => task(site, title, async () => {
    const sc = ctx.siteContext(site);
    const post = { ...body };
    if (categories.length) post.categories = await sc.terms.resolve('categories', categories, { create: createTerms });
    if (tags.length) post.tags = await sc.terms.resolve('tags', tags, { create: createTerms });
    let warning = '';
    if (image) {
      try {
        const media = await sc.client.post('/wp/v2/media', image.buffer, {
          headers: { 'Content-Type': image.mime, 'Content-Disposition': `attachment; filename="${image.filename}"` },
          timeout: 120000,
        });
        post.featured_media = media.id;
      } catch (err) {
        warning = `特色图片上传失败：${err.message}`;
      }
    }
    // Never retried: a retry after a lost response would publish the post twice.
    const created = await sc.client.post(`/wp/v2/${type}`, post);
    const message = `已创建（${STATUS_TEXT[created.status] || created.status}）`;
    return {
      status: warning ? 'warn' : 'ok',
      message: warning ? `${message}，但${warning}` : message,
      data: { id: created.id, link: created.link },
    };
  }));
}

// ---- plugins ---------------------------------------------------------------

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,199}$/;
// Plugin ids as the REST API addresses them: "folder/main-file" or "single-file" (no ".php", no dots).
const PLUGIN_ID_RE = /^[^./\\\s]+(\/[^./\\\s]+)?$/;

function pluginIdsOf(input) {
  const ids = parseList(input.params?.plugins);
  if (!ids.length) throw badRequest('请先选择插件');
  const bad = ids.find((id) => !PLUGIN_ID_RE.test(id));
  if (bad) throw badRequest(`插件标识不正确：${bad}`);
  return ids;
}

async function findPlugin(client, idOrSlug) {
  const list = await client.get('/wp/v2/plugins', { _fields: 'plugin,status,name,version' });
  return list.find((p) => p.plugin === idOrSlug) || list.find((p) => p.plugin.split('/')[0] === idOrSlug) || null;
}

function buildPluginsInstall(input, ctx) {
  const sites = sitesOf(input, ctx);
  const slugs = parseList(input.params?.slugs).map((s) => s.toLowerCase());
  if (!slugs.length) throw badRequest('请填写插件的英文名称（slug）');
  const bad = slugs.find((s) => !SLUG_RE.test(s));
  if (bad) throw badRequest(`插件名称不正确：${bad}（应为 WordPress.org 插件网址中的英文名称，例如 wordpress-seo）`);
  const activate = Boolean(input.params?.activate);

  return sites.flatMap((site) => slugs.map((slug) => task(site, slug, async () => {
    const { client } = ctx.siteContext(site);
    try {
      const p = await client.post('/wp/v2/plugins', { slug, status: activate ? 'active' : 'inactive' }, { timeout: 180000 });
      return { message: `${activate ? '已安装并启用' : '已安装'}（版本 ${p.version}）`, data: { plugin: p.plugin } };
    } catch (err) {
      if (err.code !== 'folder_exists') throw err;
    }
    const existing = await findPlugin(client, slug);
    if (!existing) return { status: 'skipped', message: '网站上已存在同名的插件目录' };
    if (activate && existing.status === 'inactive') {
      await client.post(`/wp/v2/plugins/${pluginPath(existing.plugin)}`, { status: 'active' }, { timeout: 60000 });
      return { message: '插件之前已安装，现已启用', data: { plugin: existing.plugin } };
    }
    return {
      status: 'skipped',
      message: existing.status === 'inactive' ? '已安装（未启用）' : '已安装并已启用',
      data: { plugin: existing.plugin },
    };
  })));
}

function buildPluginsStatus(status) {
  return (input, ctx) => {
    const sites = sitesOf(input, ctx);
    const plugins = pluginIdsOf(input);
    return sites.flatMap((site) => plugins.map((plugin) => task(site, plugin, async () => {
      const { client } = ctx.siteContext(site);
      const existing = await findPlugin(client, plugin);
      if (!existing) return { status: 'skipped', message: '该站点未安装此插件' };
      if (existing.status === 'network-active') return { status: 'skipped', message: '多站点网络启用的插件，需要在网络后台管理' };
      if (existing.status === status) return { status: 'skipped', message: status === 'active' ? '已经是启用状态' : '已经是停用状态' };
      await client.post(`/wp/v2/plugins/${pluginPath(existing.plugin)}`, { status }, { timeout: 60000 });
      return { message: status === 'active' ? '已启用' : '已停用' };
    })));
  };
}

function buildPluginsDelete(input, ctx) {
  const sites = sitesOf(input, ctx);
  const plugins = pluginIdsOf(input);
  return sites.flatMap((site) => plugins.map((plugin) => task(site, plugin, async () => {
    const { client } = ctx.siteContext(site);
    const existing = await findPlugin(client, plugin);
    if (!existing) return { status: 'skipped', message: '该站点未安装此插件' };
    if (existing.status === 'network-active') return { status: 'skipped', message: '多站点网络启用的插件，需要在网络后台管理' };
    const path = `/wp/v2/plugins/${pluginPath(existing.plugin)}`;
    if (existing.status === 'active') await client.post(path, { status: 'inactive' }, { timeout: 60000 });
    await client.del(path, undefined, { timeout: 120000 });
    return { message: existing.status === 'active' ? '已停用并删除' : '已删除' };
  })));
}

// ---- settings --------------------------------------------------------------

const SETTING_KEY_RE = /^[a-zA-Z0-9_]{1,64}$/;

function sameSetting(actual, wanted) {
  if (typeof wanted === 'number' || typeof actual === 'number') return Number(actual) === Number(wanted);
  if (typeof wanted === 'boolean' || typeof actual === 'boolean') return Boolean(actual) === Boolean(wanted);
  // WordPress stores some text settings HTML-escaped ("A & B" -> "A &amp; B").
  return decodeEntities(actual ?? '') === decodeEntities(wanted ?? '');
}

function buildSettingsUpdate(input, ctx) {
  const sites = sitesOf(input, ctx);
  const settings = input.params?.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw badRequest('没有要修改的设置');
  const keys = Object.keys(settings);
  if (!keys.length) throw badRequest('请至少勾选一项要修改的设置');
  for (const key of keys) {
    if (!SETTING_KEY_RE.test(key)) throw badRequest(`设置项名称不正确：${key}`);
    const v = settings[key];
    if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) throw badRequest(`设置项 ${key} 的值不正确`);
  }

  return sites.map((site) => task(site, '网站设置', async () => {
    const result = await ctx.siteContext(site).client.post('/wp/v2/settings', settings, { retries: 1 });
    const unsupported = keys.filter((k) => !(k in result));
    const ignored = keys.filter((k) => k in result && !sameSetting(result[k], settings[k]));
    if (!unsupported.length && !ignored.length) return { message: '设置已更新' };
    const notes = [];
    if (unsupported.length) notes.push(`该站点不支持：${unsupported.join('、')}`);
    if (ignored.length) notes.push(`未生效：${ignored.map((k) => `${k}（现在是 ${JSON.stringify(result[k])}）`).join('、')}`);
    return { status: 'warn', message: `部分设置未更新 —— ${notes.join('；')}` };
  }));
}

// ---- categories & tags -----------------------------------------------------

function taxonomyOf(input) {
  return input.params?.taxonomy === 'tags' ? 'tags' : 'categories';
}

function termNamesOf(input) {
  const names = parseList(input.params?.names);
  if (!names.length) throw badRequest('请填写名称');
  if (names.length > 200) throw badRequest('一次最多 200 个名称');
  return names;
}

function buildTermsCreate(input, ctx) {
  const sites = sitesOf(input, ctx);
  const taxonomy = taxonomyOf(input);
  const names = termNamesOf(input);
  return sites.flatMap((site) => names.map((name) => task(site, name, async () => {
    const { terms } = ctx.siteContext(site);
    if (await terms.resolveOne(taxonomy, name)) return { status: 'skipped', message: '已存在' };
    await terms.resolveOne(taxonomy, name, true);
    return { message: '已创建' };
  })));
}

function buildTermsDelete(input, ctx) {
  const sites = sitesOf(input, ctx);
  const taxonomy = taxonomyOf(input);
  const names = termNamesOf(input);
  return sites.flatMap((site) => names.map((name) => task(site, name, async () => {
    const sc = ctx.siteContext(site);
    const id = await sc.terms.resolveOne(taxonomy, name);
    if (!id) return { status: 'skipped', message: `该站点没有这个${TAX_TEXT[taxonomy]}` };
    try {
      await sc.client.del(`/wp/v2/${taxonomy}/${id}`, { force: true });
    } catch (err) {
      if (err.code === 'rest_cannot_delete') err.message = '无法删除：网站的默认分类不能删除（或当前账号没有权限）';
      throw err;
    }
    return { message: '已删除' };
  })));
}

// ---- registry --------------------------------------------------------------

const count = (input, key) => (Array.isArray(input[key]) ? input[key].length : 0);
const typeText = (input) => TYPE_TEXT[input.type] || '文章';
const listText = (value) => parseList(value).join('、');

/**
 * perSite: how many tasks may run at once against one site. Plugin operations must be
 * sequential per site because WordPress rewrites the whole active_plugins option.
 */
export const ACTIONS = {
  'posts.update': { perSite: 3, build: buildPostsUpdate, title: (i) => `批量修改${typeText(i)}（${count(i, 'targets')} 篇）` },
  'posts.trash': { perSite: 3, build: buildPostsTrash, title: (i) => `移到回收站（${count(i, 'targets')} 篇）` },
  'posts.delete': { perSite: 3, build: buildPostsDelete, title: (i) => `永久删除${typeText(i)}（${count(i, 'targets')} 篇）` },
  'posts.restore': { perSite: 3, build: buildPostsRestore, title: (i) => `从回收站恢复（${count(i, 'targets')} 篇）` },
  'posts.replace': {
    perSite: 3,
    build: buildPostsReplace,
    title: (i) => `${i.params?.dryRun ? '查找替换预览' : '查找替换'}（${count(i, 'targets')} 篇）`,
  },
  'posts.create': { perSite: 1, build: buildPostsCreate, title: (i) => `批量发布：${String(i.params?.title ?? '').slice(0, 40)}` },
  'plugins.install': { perSite: 1, build: buildPluginsInstall, title: (i) => `安装插件：${listText(i.params?.slugs)}` },
  'plugins.activate': { perSite: 1, build: buildPluginsStatus('active'), title: (i) => `启用插件：${listText(i.params?.plugins)}` },
  'plugins.deactivate': { perSite: 1, build: buildPluginsStatus('inactive'), title: (i) => `停用插件：${listText(i.params?.plugins)}` },
  'plugins.delete': { perSite: 1, build: buildPluginsDelete, title: (i) => `删除插件：${listText(i.params?.plugins)}` },
  'settings.update': {
    perSite: 1,
    build: buildSettingsUpdate,
    title: (i) => `修改网站设置：${Object.keys(i.params?.settings || {}).join('、')}`,
  },
  'terms.create': { perSite: 2, build: buildTermsCreate, title: (i) => `创建${TAX_TEXT[taxonomyOf(i)]}：${listText(i.params?.names)}` },
  'terms.delete': { perSite: 2, build: buildTermsDelete, title: (i) => `删除${TAX_TEXT[taxonomyOf(i)]}：${listText(i.params?.names)}` },
};
