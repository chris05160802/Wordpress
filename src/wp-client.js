import { sleep, htmlToText } from './util.js';
import { VERSION } from './version.js';

export const USER_AGENT = `WP-Batch-Manager/${VERSION}`;

const RETRY_STATUSES = new Set([429, 502, 503, 504]);

export class WPError extends Error {
  constructor(message, { status = 0, code = '', detail = '', data = null } = {}) {
    super(message);
    this.name = 'WPError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.data = data;
  }
}

const AUTH_HINT = '注意：这里要填"应用密码"，不是后台登录密码';

// Chinese explanations for the error codes WordPress returns most often.
const CODE_MESSAGES = {
  rest_not_logged_in: `身份验证失败：用户名或应用密码不正确（${AUTH_HINT}）。如果确认无误，可能是网站服务器丢弃了 Authorization 请求头`,
  incorrect_password: `应用密码不正确（${AUTH_HINT}）`,
  invalid_username: '用户名不存在',
  invalid_email: '用户名不存在',
  application_passwords_disabled: '该网站已禁用应用密码功能',
  application_passwords_disabled_for_user: '该账号被禁止使用应用密码',
  rest_cannot_access: 'REST API 被安全插件或主机限制访问',
  rest_disabled: 'REST API 已被禁用',
  rest_forbidden: '当前账号没有权限执行此操作',
  rest_forbidden_context: '当前账号没有权限查看此内容',
  rest_cannot_view: '当前账号没有权限查看此内容',
  rest_cannot_edit: '当前账号没有权限编辑此内容',
  rest_cannot_create: '当前账号没有权限创建内容',
  rest_cannot_delete: '当前账号没有权限删除此内容',
  rest_cannot_publish: '当前账号没有权限发布内容',
  rest_cannot_assign_term: '当前账号没有权限设置分类或标签',
  rest_cannot_edit_others: '当前账号没有权限编辑其他作者的内容',
  rest_cannot_view_plugins: '没有权限查看插件（需要管理员账号）',
  rest_cannot_manage_plugins: '没有权限管理插件（需要管理员账号）',
  rest_cannot_install_plugin: '没有权限安装插件（需要管理员账号，且网站没有禁止安装插件）',
  rest_cannot_activate_plugin: '没有权限启用此插件',
  rest_cannot_deactivate_plugin: '没有权限停用此插件',
  rest_cannot_delete_active_plugin: '插件正在启用中，需要先停用才能删除',
  rest_cannot_manage_network_plugins: '这是多站点网络插件，需要在网络后台管理',
  rest_network_only_plugin: '这是多站点网络插件，需要在网络后台管理',
  rest_plugin_not_found: '该站点未安装此插件',
  rest_post_invalid_id: '内容不存在（可能已被永久删除）',
  rest_post_invalid_page_number: '页码超出范围',
  rest_already_trashed: '已在回收站中',
  rest_trash_not_supported: '该网站关闭了回收站功能，只能永久删除',
  rest_term_invalid: '分类/标签不存在',
  term_exists: '分类/标签已存在',
  rest_no_route: '网站不支持此接口（WordPress 版本过低，或接口被插件禁用）',
  plugins_api_failed: '无法从 WordPress.org 获取该插件（插件名称可能有误，或网站服务器无法连接 WordPress.org）',
  folder_exists: '插件已存在',
  fs_unavailable: '网站主机不允许直接写入文件，无法安装插件',
  fs_error: '网站文件系统出错，无法安装插件',
  fs_no_plugins_dir: '找不到网站的插件目录',
  unable_to_connect_to_filesystem: '无法连接到网站文件系统（主机限制），无法安装插件',
  download_failed: '网站服务器下载插件失败',
  plugin_wp_incompatible: '插件已安装，但需要更高版本的 WordPress 才能启用',
  plugin_php_incompatible: '插件已安装，但需要更高版本的 PHP 才能启用',
  plugin_wp_php_incompatible: '插件已安装，但需要更高版本的 WordPress 和 PHP 才能启用',
};

// Codes whose original WordPress message carries useful details worth showing too.
const VERBOSE_CODES = new Set(['rest_invalid_param', 'rest_missing_callback_param', 'plugins_api_failed', 'fs_error', 'download_failed']);

const PREFIX_MESSAGES = [
  ['mkdir_failed', '无法创建插件目录（请检查网站文件权限）'],
  ['copy_failed', '无法写入插件文件（请检查网站文件权限）'],
  ['incompatible_archive', '插件安装包无效'],
  ['rest_upload', '图片上传失败'],
  ['rest_invalid_param', '参数不正确'],
];

function statusMessage(status) {
  if (status === 401) return `身份验证失败（${AUTH_HINT}）`;
  if (status === 403) return '没有权限执行此操作（也可能被网站防火墙拦截）';
  if (status === 404) return '接口或内容不存在';
  if (status === 410) return '内容已被删除';
  if (status === 413) return '上传的文件太大，被网站服务器拒绝';
  if (status === 429) return '请求过于频繁，被网站限制，请稍后再试';
  if (status >= 500) return `网站服务器出错（HTTP ${status}）`;
  return '';
}

export function describeWpError(status, code, rawMessage) {
  let zh = CODE_MESSAGES[code];
  if (!zh && code) zh = PREFIX_MESSAGES.find(([prefix]) => code.startsWith(prefix))?.[1];
  const known = Boolean(zh) && !VERBOSE_CODES.has(code);
  if (!zh) zh = statusMessage(status);
  const raw = htmlToText(rawMessage);
  if (zh && raw && !known && !zh.includes(raw)) return `${zh}（${raw}）`;
  return zh || raw || `请求失败（HTTP ${status}）`;
}

function wpErrorFrom(status, body, fallbackText = '') {
  const code = typeof body?.code === 'string' ? body.code : '';
  let detail = typeof body?.message === 'string' ? body.message : fallbackText;
  // e.g. plugins_api_failed puts the underlying reason in additional_data.
  const extra = Array.isArray(body?.additional_data) ? body.additional_data.filter((x) => typeof x === 'string') : [];
  if (extra.length) detail = [detail, ...extra].filter(Boolean).join(' ');
  return new WPError(describeWpError(status, code, detail), {
    status, code, detail: htmlToText(detail), data: body?.data ?? null,
  });
}

function networkError(err, timeout) {
  const cause = err?.cause || err;
  const code = cause?.code || '';
  let message;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || cause?.name === 'TimeoutError') {
    message = `连接超时（${Math.round(timeout / 1000)} 秒内网站没有响应）`;
  } else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    message = '域名无法解析，请检查网址是否正确';
  } else if (code === 'ECONNREFUSED') {
    message = '连接被拒绝，网站服务器没有响应';
  } else if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') {
    message = '连接被网站服务器中断';
  } else if (/CERT|SSL|TLS/i.test(code) || /certificate/i.test(cause?.message || '')) {
    message = '网站的 HTTPS 证书无效或已过期';
  } else {
    message = '无法连接到网站';
  }
  const detail = cause?.message || err?.message || '';
  return new WPError(detail ? `${message}（${detail}）` : message, { code: code || 'network_error', detail });
}

/** Parses JSON, tolerating a BOM or PHP notices printed before the body. undefined = not JSON. */
export function parseJsonLoose(text) {
  const t = String(text ?? '').replace(/^﻿/, '').trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    // fall through
  }
  for (const marker of ['{"', '[{', '[]', '{}']) {
    const i = t.indexOf(marker);
    if (i > 0) {
      try {
        return JSON.parse(t.slice(i));
      } catch {
        // try next marker
      }
    }
  }
  return undefined;
}

export function basicAuth(username, password) {
  return 'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
}

/** "example.com/wp-admin/" -> "https://example.com"; keeps sub-directory installs. */
export function normalizeSiteUrl(input) {
  let s = String(input ?? '').trim();
  if (!s) throw new WPError('请填写网站网址', { code: 'invalid_url' });
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new WPError('网址格式不正确', { code: 'invalid_url' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WPError('网址必须以 http:// 或 https:// 开头', { code: 'invalid_url' });
  }
  url.hash = '';
  url.search = '';
  url.username = '';
  url.password = '';
  url.pathname = url.pathname
    .replace(/\/(wp-admin|wp-login\.php|wp-json|index\.php)(\/.*)?$/i, '')
    .replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

export function buildUrl(apiRoot, route, query) {
  const url = new URL(apiRoot);
  const r = '/' + String(route).replace(/^\/+/, '');
  if (url.searchParams.has('rest_route')) url.searchParams.set('rest_route', r);
  else url.pathname = url.pathname.replace(/\/+$/, '') + r;
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  return url.toString();
}

function toApiRoot(foundUrl) {
  const url = new URL(foundUrl);
  url.hash = '';
  if (url.searchParams.has('rest_route')) {
    url.searchParams.set('rest_route', '/');
    return url.toString();
  }
  url.search = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

/** Plugin ids look like "akismet/akismet" or "hello"; keep the slash, encode the parts. */
export function pluginPath(plugin) {
  return String(plugin).split('/').map(encodeURIComponent).join('/');
}

export class WPClient {
  constructor({ apiRoot, username, password, timeout = 30000 }) {
    this.apiRoot = apiRoot;
    this.authorization = basicAuth(username, password);
    this.timeout = timeout;
  }

  url(route, query) {
    return buildUrl(this.apiRoot, route, query);
  }

  /**
   * Returns { data, headers, status }. GETs are retried on network errors and 429/5xx.
   * Writes are not retried by default (a retried "create" could duplicate content) and
   * do not follow redirects (fetch would silently turn a redirected POST into a GET).
   */
  async request(method, route, { query, body, headers = {}, timeout = this.timeout, retries } = {}) {
    const url = this.url(route, query);
    const isRead = method === 'GET';
    const maxRetries = retries ?? (isRead ? 2 : 0);
    const init = {
      method,
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, Authorization: this.authorization, ...headers },
      redirect: isRead ? 'follow' : 'manual',
    };
    if (body !== undefined) {
      if (body instanceof Uint8Array) {
        init.body = body;
      } else {
        init.body = JSON.stringify(body);
        init.headers['Content-Type'] = 'application/json; charset=utf-8';
      }
    }

    for (let attempt = 0; ; attempt++) {
      let res;
      let text;
      try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
        text = await res.text();
      } catch (err) {
        if (attempt < maxRetries) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw networkError(err, timeout);
      }
      if (RETRY_STATUSES.has(res.status) && attempt < maxRetries) {
        const retryAfter = Math.min(10, parseInt(res.headers.get('retry-after'), 10) || 0);
        await sleep(retryAfter ? retryAfter * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      return parseResponse(res, text);
    }
  }

  async get(route, query, opts) {
    return (await this.request('GET', route, { ...opts, query })).data;
  }

  async post(route, body, opts) {
    return (await this.request('POST', route, { ...opts, body })).data;
  }

  async del(route, query, opts) {
    return (await this.request('DELETE', route, { ...opts, query })).data;
  }

  /** Fetches up to `limit` items following X-WP-TotalPages. Returns { items, total }. */
  async getAll(route, query = {}, limit = 100) {
    const items = [];
    let total = null;
    for (let page = 1; items.length < limit; page++) {
      const perPage = Math.min(100, limit - items.length);
      const { data, headers } = await this.request('GET', route, { query: { ...query, per_page: perPage, page } });
      if (!Array.isArray(data)) throw new WPError('网站返回的数据格式不正确', { code: 'invalid_response' });
      items.push(...data);
      if (total === null) total = parseInt(headers.get('x-wp-total'), 10);
      const totalPages = parseInt(headers.get('x-wp-totalpages'), 10) || 1;
      if (page >= totalPages || data.length < perPage) break;
    }
    return { items, total: Number.isFinite(total) ? total : items.length };
  }
}

function parseResponse(res, text) {
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    throw new WPError(
      `请求被网站重定向${location ? `到 ${location}` : ''}，请在"站点管理"中重新测试该站点以更新地址`,
      { status: res.status, code: 'redirect' },
    );
  }
  const data = parseJsonLoose(text);
  if (!res.ok) throw wpErrorFrom(res.status, data, data === undefined ? String(text).slice(0, 200) : '');
  if (data === undefined) {
    throw new WPError('网站返回的不是有效的 JSON 数据（可能被防火墙、CDN 或安全插件拦截）', {
      status: res.status, code: 'invalid_json', detail: htmlToText(String(text).slice(0, 300)),
    });
  }
  return { data, headers: res.headers, status: res.status };
}

/**
 * Finds the site's REST API root: /wp-json/, then the Link header, then ?rest_route=/
 * (sites with plain permalinks). Credentials are optional; some security plugins only
 * allow authenticated access to the API index.
 */
export async function discoverSite(inputUrl, { username, password, timeout = 20000 } = {}) {
  const base = normalizeSiteUrl(inputUrl);
  const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT };
  if (username && password) headers.Authorization = basicAuth(username, password);

  let apiError = null;
  const tryIndex = async (url) => {
    let res;
    let text;
    try {
      res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
      text = await res.text();
    } catch (err) {
      throw networkError(err, timeout);
    }
    const data = parseJsonLoose(text);
    if (res.ok && data && Array.isArray(data.namespaces)) return { data, url: res.url || url };
    if (data && typeof data.code === 'string' && !apiError) apiError = wpErrorFrom(res.status, data);
    return null;
  };

  const findLinkHeader = async () => {
    try {
      const res = await fetch(`${base}/`, {
        headers: { Accept: 'text/html', 'User-Agent': USER_AGENT },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
      });
      await res.body?.cancel().catch(() => {});
      const match = (res.headers.get('link') || '').match(/<([^>]+)>\s*;\s*rel="?https:\/\/api\.w\.org\/"?/);
      return match ? new URL(match[1], res.url || base).toString() : null;
    } catch {
      return null;
    }
  };

  let found = await tryIndex(`${base}/wp-json/`);
  if (!found) {
    const link = await findLinkHeader();
    if (link) found = await tryIndex(link);
  }
  if (!found) found = await tryIndex(`${base}/?rest_route=/`);
  if (!found) {
    if (apiError) throw apiError;
    throw new WPError('没有找到 WordPress REST API：请确认网址正确、这是 WordPress 网站，并且 REST API 没有被安全插件关闭', {
      code: 'no_api',
    });
  }

  const index = found.data;
  const appPasswords = index.authentication?.['application-passwords'];
  return {
    apiRoot: toApiRoot(found.url),
    name: htmlToText(index.name),
    description: htmlToText(index.description),
    home: String(index.home || index.url || base).replace(/\/+$/, ''),
    // WordPress address (where wp-admin lives); differs from home for sub-directory installs.
    siteUrl: String(index.url || index.home || base).replace(/\/+$/, ''),
    namespaces: index.namespaces,
    appPasswords: {
      available: Boolean(appPasswords),
      authorizeUrl: appPasswords?.endpoints?.authorization || null,
    },
  };
}

export const CAPABILITY_KEYS = [
  'edit_posts', 'edit_others_posts', 'publish_posts', 'delete_posts', 'delete_others_posts',
  'edit_pages', 'manage_categories', 'upload_files', 'manage_options',
  'install_plugins', 'activate_plugins', 'delete_plugins',
];

/** Discovers the API and verifies the credentials. Throws WPError with a readable message. */
export async function connectSite({ url, username, password }) {
  username = String(username ?? '').trim();
  password = String(password ?? '').trim();
  if (!username) throw new WPError('请填写用户名', { code: 'missing_username' });
  if (!password) throw new WPError('请填写应用密码', { code: 'missing_password' });

  const info = await discoverSite(url, { username, password });
  const client = new WPClient({ apiRoot: info.apiRoot, username, password });
  let me;
  try {
    me = await client.get('/wp/v2/users/me', { context: 'edit', _fields: 'id,name,slug,roles,capabilities' });
  } catch (err) {
    if (err.status === 401 && !info.appPasswords.available) {
      err.message = '该网站没有开启"应用密码"功能：WordPress 默认只在 HTTPS 网站上开启它，也可能被安全插件关闭了';
    }
    throw err;
  }
  const caps = Object.fromEntries(CAPABILITY_KEYS.map((c) => [c, Boolean(me.capabilities?.[c])]));
  return {
    ...info,
    user: { id: me.id, name: htmlToText(me.name), slug: me.slug, roles: me.roles || [] },
    caps,
  };
}
