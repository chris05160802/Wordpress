import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { startMockWp } from './support/mock-wp.js';

async function startApp(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpbm-test-'));
  const app = createApp({ dataDir, ...options });
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  async function call(method, urlPath, body, headers = {}) {
    const init = { method, headers: { Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers } };
    if (method !== 'GET') {
      init.headers['Content-Type'] ??= 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    }
    const res = await fetch(base + urlPath, init);
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  }

  async function login() {
    const r = await call('POST', '/api/auth/setup', { password: 'test-password-1', code: app.auth.setupCode });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }

  /** Starts a job and waits for it to finish; returns the final job with all results. */
  async function runJob(body) {
    const r = await call('POST', '/api/jobs', body);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    await app.jobs.wait(r.data.job.id);
    return (await call('GET', `/api/jobs/${r.data.job.id}`)).data.job;
  }

  async function addSite(wp, extra = {}) {
    const r = await call('POST', '/api/sites', { url: wp.url, username: wp.auth.username, appPassword: wp.auth.password, ...extra });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.site;
  }

  const close = () => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { app, base, call, login, runJob, addSite, dataDir, close, setCookie: (c) => { cookie = c; } };
}

test('console login: setup code, sessions, CSRF and host checks', async (t) => {
  const ctx = await startApp({ allowedHosts: ['127.0.0.1', 'localhost'] });
  t.after(ctx.close);
  const { call, app } = ctx;

  let r = await call('GET', '/api/auth/status');
  assert.deepEqual([r.data.configured, r.data.authenticated], [false, false]);
  assert.equal((await call('GET', '/api/sites')).status, 401);

  r = await call('POST', '/api/auth/setup', { password: 'test-password-1', code: 'wrong' });
  assert.equal(r.status, 403);
  r = await call('POST', '/api/auth/setup', { password: 'short', code: app.auth.setupCode });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/auth/setup', { password: 'test-password-1', code: app.auth.setupCode });
  assert.equal(r.status, 200);
  assert.equal(app.auth.setupCode, null, 'setup code is single use');
  assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await call('GET', '/api/sites')).status, 200);

  // Password is stored hashed, never in plain text.
  const config = fs.readFileSync(path.join(ctx.dataDir, 'config.json'), 'utf8');
  assert.ok(!config.includes('test-password-1'));

  // CSRF: form posts and foreign origins are refused.
  r = await call('POST', '/api/sites/test', 'siteIds=1', { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(r.status, 415);
  r = await call('POST', '/api/sites/test', { siteIds: [] }, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);

  // DNS rebinding: unknown Host header refused.
  // (fetch() can't override Host, so use http.get.)
  const status = await new Promise((resolve, reject) => {
    http.get(`${ctx.base}/api/auth/status`, { headers: { Host: 'evil.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 403);

  await call('POST', '/api/auth/logout');
  assert.equal((await call('GET', '/api/sites')).status, 401);
  r = await call('POST', '/api/auth/login', { password: 'nope-nope' });
  assert.equal(r.status, 401);
  r = await call('POST', '/api/auth/login', { password: 'test-password-1' });
  assert.equal(r.status, 200);

  // Changing the password invalidates other sessions.
  const oldCookie = r.headers.get('set-cookie').split(';')[0];
  r = await call('POST', '/api/auth/password', { current: 'test-password-1', password: 'test-password-2' });
  assert.equal(r.status, 200);
  ctx.setCookie(oldCookie);
  assert.equal((await call('GET', '/api/sites')).status, 401);
});

test('login rate limiting', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);
  await ctx.login();
  await ctx.call('POST', '/api/auth/logout');
  let r;
  for (let i = 0; i < 10; i++) r = await ctx.call('POST', '/api/auth/login', { password: `wrong-${i}` });
  assert.equal(r.status, 401);
  r = await ctx.call('POST', '/api/auth/login', { password: 'test-password-1' });
  assert.equal(r.status, 429);
});

test('static files and SPA fallback', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);
  let res = await fetch(`${ctx.base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await res.text(), /<html/);
  res = await fetch(`${ctx.base}/some/page`);
  assert.equal(res.status, 200);
  res = await fetch(`${ctx.base}/..%2f..%2fpackage.json`);
  assert.equal(res.status, 404);
  res = await fetch(`${ctx.base}/nope.js`);
  assert.equal(res.status, 404);
});

test('sites: add, list without secrets, duplicates, errors, edit, test, delete', async (t) => {
  const wp = await startMockWp();
  const plainWp = await startMockWp({ restStyle: 'plain', name: '文章站' });
  const ctx = await startApp();
  t.after(async () => {
    await ctx.close();
    await wp.close();
    await plainWp.close();
  });
  await ctx.login();
  const { call } = ctx;

  const site = await ctx.addSite(wp, { group: '新闻站' });
  assert.equal(site.name, 'Mock 新闻站');
  assert.equal(site.apiRoot, `${wp.url}/wp-json/`);
  assert.equal(site.group, '新闻站');
  assert.equal(site.caps.install_plugins, true);
  assert.equal(site.user.name, 'Admin & Co');
  assert.equal(site.secret, undefined);

  const plain = await ctx.addSite(plainWp, { name: '我的文章站' });
  assert.equal(plain.apiRoot, `${plainWp.url}/?rest_route=%2F`);
  assert.equal(plain.name, '我的文章站');

  // The app password is encrypted at rest.
  const raw = fs.readFileSync(path.join(ctx.dataDir, 'sites.json'), 'utf8');
  assert.ok(!raw.includes(wp.auth.password));
  assert.ok(raw.includes('"secret": "v1:'));

  let r = await call('GET', '/api/sites');
  assert.equal(r.data.sites.length, 2);
  assert.ok(r.data.sites.every((s) => s.secret === undefined));

  r = await call('POST', '/api/sites', { url: wp.url.replace('http://', ''), username: 'admin', appPassword: wp.auth.password });
  assert.equal(r.status, 400, 'https:// is assumed and fails against the http-only mock');
  r = await call('POST', '/api/sites', { url: wp.url, username: 'ADMIN', appPassword: wp.auth.password });
  assert.equal(r.status, 400, 'username mismatch is an auth error');
  r = await call('POST', '/api/sites', { url: `${wp.url}/wp-admin/`, username: 'admin', appPassword: wp.auth.password });
  assert.equal(r.status, 409);
  r = await call('POST', '/api/sites', { url: wp.url, username: 'admin', appPassword: 'wrong wrong wrong' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /应用密码/);

  r = await call('POST', '/api/sites/discover', { url: plainWp.url });
  assert.equal(r.data.name, '文章站');
  assert.equal(r.data.appPasswords.authorizeUrl, `${plainWp.url}/wp-admin/authorize-application.php`);

  r = await call('PATCH', `/api/sites/${site.id}`, { name: '改名', group: '' });
  assert.equal(r.data.site.name, '改名');
  assert.equal(r.data.site.group, '');
  r = await call('PATCH', `/api/sites/${site.id}`, { appPassword: 'bad bad bad' });
  assert.equal(r.status, 400);

  wp.auth.password = 'newpasswordnew';
  r = await call('POST', '/api/sites/test', { siteIds: [site.id, plain.id] });
  assert.deepEqual(r.data.results.map((x) => x.ok), [false, true]);
  assert.equal(r.data.sites.find((s) => s.id === site.id).lastCheck.ok, false);
  r = await call('PATCH', `/api/sites/${site.id}`, { appPassword: 'newpasswordnew' });
  assert.equal(r.status, 200);
  assert.equal(r.data.site.lastCheck.ok, true);

  r = await call('DELETE', `/api/sites/${plain.id}`);
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/sites')).data.sites.length, 1);
  assert.equal((await call('DELETE', `/api/sites/${plain.id}`)).status, 404);
});

test('sites: batch import as a job', async (t) => {
  const wp1 = await startMockWp();
  const wp2 = await startMockWp({ username: '编辑', role: 'editor' });
  const ctx = await startApp();
  t.after(async () => {
    await ctx.close();
    await wp1.close();
    await wp2.close();
  });
  await ctx.login();
  const r = await ctx.call('POST', '/api/sites/import', {
    group: '批量',
    text: [
      `${wp1.url},admin,${wp1.auth.password},新闻站`,
      `${wp2.url}，编辑，${wp2.auth.password}`,
      // Same site again (lines are processed concurrently; whichever connects first wins).
      `${wp1.url},admin,${wp1.auth.password},新闻站`,
      'nonsense',
    ].join('\n'),
  });
  assert.equal(r.status, 200);
  await ctx.app.jobs.wait(r.data.job.id);
  const job = (await ctx.call('GET', `/api/jobs/${r.data.job.id}`)).data.job;
  assert.equal(job.total, 4);
  assert.deepEqual(job.counts, { ok: 2, warn: 0, error: 2, skipped: 0 });
  const sites = (await ctx.call('GET', '/api/sites')).data.sites;
  assert.deepEqual(sites.map((s) => s.group).sort(), ['批量', '新闻站']);
  assert.equal(sites.find((s) => s.username === '编辑').caps.install_plugins, false);
});

test('posts: query, batch edit, trash, restore, delete, find & replace', async (t) => {
  const wp1 = await startMockWp();
  const wp2 = await startMockWp({ restStyle: 'plain' });
  const ctx = await startApp();
  t.after(async () => {
    await ctx.close();
    await wp1.close();
    await wp2.close();
  });
  await ctx.login();
  const tech = wp1.addTerm('categories', '科技');
  for (let i = 1; i <= 130; i++) {
    wp1.addPost('posts', { title: `新闻 ${i} &`, content: `来源：旧来源网 第${i}篇`, categories: i % 2 ? [tech.id] : [1], status: i % 10 ? 'publish' : 'draft' });
  }
  wp2.addPost('posts', { title: 'B站文章', content: 'WordPress wordpress 旧来源网' });
  const s1 = await ctx.addSite(wp1);
  const s2 = await ctx.addSite(wp2);
  const { call, runJob } = ctx;

  // Pagination across sites.
  let r = await call('POST', '/api/posts/query', { siteIds: [s1.id, s2.id], limit: 120 });
  assert.equal(r.status, 200);
  assert.equal(r.data.items.length, 121);
  assert.deepEqual(r.data.sites.map((s) => [s.total, s.count]), [[130, 120], [1, 1]]);
  const first = r.data.items[0];
  assert.equal(first.title, '新闻 130 &');
  assert.deepEqual(first.categories, ['Uncategorized']);

  r = await call('POST', '/api/posts/query', { siteIds: [s1.id, s2.id], category: '科技', status: 'draft' });
  assert.equal(r.data.items.length, 0, 'odd posts are published');
  assert.equal(r.data.sites[1].note, '该站点没有这个分类');
  r = await call('POST', '/api/posts/query', { siteIds: [s1.id], search: '新闻 12', status: 'publish' });
  assert.deepEqual(r.data.items.map((p) => p.id).length, 10);
  r = await call('POST', '/api/posts/query', { siteIds: [s1.id], after: '2024/01/01' });
  assert.equal(r.status, 400);

  // Batch edit: status + add categories (created when missing) + set tags.
  const targets = [...wp1.state.posts.values()].slice(0, 3).map((p) => ({ siteId: s1.id, id: p.id, title: p.title }));
  targets.push({ siteId: s2.id, id: [...wp2.state.posts.keys()][0] });
  let job = await runJob({
    action: 'posts.update',
    targets,
    params: { status: 'draft', categories: { mode: 'add', names: '国际新闻, 科技' }, tags: { mode: 'set', names: ['热点'] } },
  });
  assert.equal(job.status, 'done');
  assert.deepEqual(job.counts, { ok: 4, warn: 0, error: 0, skipped: 0 });
  const intl = [...wp1.state.categories.values()].filter((c) => c.name === '国际新闻');
  assert.equal(intl.length, 1, 'category created once even with concurrent tasks');
  const p0 = wp1.state.posts.get(targets[0].id);
  assert.equal(p0.status, 'draft');
  assert.deepEqual(p0.categories.sort(), [tech.id, intl[0].id].sort());
  assert.equal(p0.tags.length, 1);
  assert.equal([...wp2.state.categories.values()].filter((c) => c.name === '国际新闻').length, 1);

  job = await runJob({ action: 'posts.update', targets: targets.slice(0, 1), params: { categories: { mode: 'remove', names: ['科技'] } } });
  assert.deepEqual(wp1.state.posts.get(targets[0].id).categories, [intl[0].id]);

  r = await call('POST', '/api/jobs', { action: 'posts.update', targets, params: {} });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/jobs', { action: 'posts.update', targets: [{ siteId: 'nope', id: 1 }], params: { status: 'draft' } });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/jobs', { action: 'nope' });
  assert.equal(r.status, 400);

  // Find & replace: preview first, then apply.
  const replaceTargets = [...targets.slice(0, 2), targets[3]];
  job = await runJob({ action: 'posts.replace', targets: replaceTargets, params: { find: '旧来源网', replace: '新来源网', dryRun: true } });
  assert.deepEqual(job.counts, { ok: 3, warn: 0, error: 0, skipped: 0 });
  assert.match(job.results[0].message, /预览/);
  assert.match(wp1.state.posts.get(targets[0].id).content, /旧来源网/);
  job = await runJob({ action: 'posts.replace', targets: replaceTargets, params: { find: 'wordpress', replace: 'WordPress', caseSensitive: false } });
  assert.deepEqual(job.counts, { ok: 1, warn: 0, error: 0, skipped: 2 });
  assert.equal([...wp2.state.posts.values()][0].content, 'WordPress WordPress 旧来源网');
  job = await runJob({ action: 'posts.replace', targets: replaceTargets, params: { find: '旧来源网', replace: '新来源网', fields: ['content'] } });
  assert.equal(job.counts.ok, 3);
  assert.match(wp1.state.posts.get(targets[0].id).content, /新来源网/);

  // Trash (twice), restore, delete permanently.
  const trashTargets = targets.slice(0, 2);
  wp1.state.posts.get(trashTargets[0].id).slug = ''; // a draft that never had a slug
  job = await runJob({ action: 'posts.trash', targets: trashTargets });
  assert.deepEqual(job.counts, { ok: 2, warn: 0, error: 0, skipped: 0 });
  job = await runJob({ action: 'posts.trash', targets: trashTargets });
  assert.deepEqual(job.counts, { ok: 0, warn: 0, error: 0, skipped: 2 });
  r = await call('POST', '/api/posts/query', { siteIds: [s1.id], status: 'trash' });
  assert.equal(r.data.items.length, 2);
  job = await runJob({ action: 'posts.restore', targets: trashTargets.slice(0, 1) });
  assert.equal(wp1.state.posts.get(trashTargets[0].id).status, 'draft');
  assert.equal(wp1.state.posts.get(trashTargets[0].id).slug, '', 'the "__trashed" slug is cleared on restore');
  job = await runJob({ action: 'posts.delete', targets: [...trashTargets, { siteId: s1.id, id: 999999 }] });
  assert.deepEqual(job.counts, { ok: 2, warn: 0, error: 0, skipped: 1 });
  assert.equal(wp1.state.posts.has(trashTargets[1].id), false);

  // Single post edit.
  const editId = targets[2].id;
  r = await call('GET', `/api/sites/${s1.id}/posts/${editId}?type=posts`);
  assert.equal(r.data.title, wp1.state.posts.get(editId).title);
  r = await call('PUT', `/api/sites/${s1.id}/posts/${editId}?type=posts`, { title: '新标题', content: '<p>正文</p>' });
  assert.equal(r.status, 200);
  assert.equal(r.data.title, '新标题');
  assert.equal(wp1.state.posts.get(editId).content, '<p>正文</p>');
  r = await call('GET', `/api/sites/${s1.id}/posts/999999`);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /不存在/);
});

test('posts: publish one article to several sites with image and terms', async (t) => {
  const wp1 = await startMockWp();
  const wp2 = await startMockWp({ restStyle: 'plain' });
  const ctx = await startApp();
  t.after(async () => {
    await ctx.close();
    await wp1.close();
    await wp2.close();
  });
  await ctx.login();
  const s1 = await ctx.addSite(wp1);
  const s2 = await ctx.addSite(wp2);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const future = new Date(Date.now() + 86400000).toISOString();
  const job = await ctx.runJob({
    action: 'posts.create',
    siteIds: [s1.id, s2.id],
    params: {
      title: '重大新闻',
      content: '<p>内容</p>',
      status: 'future',
      date: future,
      categories: '国内新闻',
      tags: '热点，头条',
      image: { dataBase64: png.toString('base64'), mimeType: 'image/png', filename: '新闻图片.png' },
    },
  });
  assert.deepEqual(job.counts, { ok: 2, warn: 0, error: 0, skipped: 0 });
  for (const wp of [wp1, wp2]) {
    const post = [...wp.state.posts.values()].at(-1);
    assert.equal(post.title, '重大新闻');
    assert.equal(post.status, 'future');
    assert.equal(post.categories.length, 1);
    assert.equal(post.tags.length, 2);
    assert.equal(wp.state.media.length, 1);
    assert.equal(post.featured_media, wp.state.media[0].id);
    assert.match(wp.state.media[0].file, /^image-\d+\.png$/, 'non-ASCII file names are replaced');
    assert.equal(wp.state.media[0].size, png.length);
  }
  assert.ok(job.results.every((x) => x.data.link.includes('?p=')));

  let r = await ctx.call('POST', '/api/jobs', { action: 'posts.create', siteIds: [s1.id], params: { title: ' ' } });
  assert.equal(r.status, 400);
  r = await ctx.call('POST', '/api/jobs', { action: 'posts.create', siteIds: [s1.id], params: { title: 'x', status: 'future' } });
  assert.equal(r.status, 400);
  r = await ctx.call('POST', '/api/jobs', { action: 'posts.create', siteIds: [s1.id], params: { title: 'x', image: { dataBase64: 'AAAA', mimeType: 'application/pdf' } } });
  assert.equal(r.status, 400);

  // Media upload failure still publishes the post, reported as a warning.
  wp1.state.intercept = (method, p) => (p === '/wp/v2/media' ? { status: 413, body: '<html>Too large</html>', contentType: 'text/html' } : null);
  const warnJob = await ctx.runJob({
    action: 'posts.create',
    siteIds: [s1.id],
    params: { title: '带图', image: { dataBase64: png.toString('base64'), mimeType: 'image/png' } },
  });
  assert.equal(warnJob.counts.warn, 1);
  assert.match(warnJob.results[0].message, /特色图片上传失败/);
});

test('plugins: aggregate, install, activate, deactivate, delete', async (t) => {
  const wp1 = await startMockWp();
  const wp2 = await startMockWp({ role: 'editor' });
  const ctx = await startApp();
  t.after(async () => {
    await ctx.close();
    await wp1.close();
    await wp2.close();
  });
  await ctx.login();
  const s1 = await ctx.addSite(wp1);
  const s2 = await ctx.addSite(wp2);
  const { call, runJob } = ctx;

  let r = await call('POST', '/api/plugins/query', { siteIds: [s1.id, s2.id] });
  assert.deepEqual(r.data.plugins.map((p) => p.plugin), ['akismet/akismet', 'hello']);
  assert.deepEqual(r.data.plugins[0].sites[s1.id], { status: 'active', version: '5.3' });
  assert.match(r.data.sites[1].error, /没有权限/);

  let job = await runJob({ action: 'plugins.install', siteIds: [s1.id, s2.id], params: { slugs: 'classic-editor, no-such-plugin', activate: true } });
  assert.deepEqual(job.counts, { ok: 1, warn: 0, error: 3, skipped: 0 });
  assert.equal(wp1.state.plugins.get('classic-editor/classic-editor').status, 'active');
  assert.match(job.results.find((x) => x.siteId === s2.id).message, /没有权限/);
  assert.match(job.results.find((x) => x.label === 'no-such-plugin').message, /WordPress\.org/);

  // Installing again: already there.
  wp1.state.plugins.get('classic-editor/classic-editor').status = 'inactive';
  job = await runJob({ action: 'plugins.install', siteIds: [s1.id], params: { slugs: ['classic-editor'], activate: true } });
  assert.deepEqual(job.counts, { ok: 1, warn: 0, error: 0, skipped: 0 });
  assert.match(job.results[0].message, /现已启用/);
  job = await runJob({ action: 'plugins.install', siteIds: [s1.id], params: { slugs: ['classic-editor'] } });
  assert.equal(job.counts.skipped, 1);

  r = await call('POST', '/api/jobs', { action: 'plugins.install', siteIds: [s1.id], params: { slugs: '../evil' } });
  assert.equal(r.status, 400);

  job = await runJob({ action: 'plugins.activate', siteIds: [s1.id], params: { plugins: ['hello', 'akismet/akismet', 'missing/missing'] } });
  assert.deepEqual(job.results.map((x) => x.status), ['ok', 'skipped', 'skipped']);
  assert.equal(wp1.state.plugins.get('hello').status, 'active');

  job = await runJob({ action: 'plugins.deactivate', siteIds: [s1.id], params: { plugins: ['hello'] } });
  assert.equal(wp1.state.plugins.get('hello').status, 'inactive');

  job = await runJob({ action: 'plugins.delete', siteIds: [s1.id], params: { plugins: ['akismet/akismet', 'hello'] } });
  assert.deepEqual(job.results.map((x) => x.message), ['已停用并删除', '已删除']);
  assert.deepEqual([...wp1.state.plugins.keys()], ['classic-editor/classic-editor']);

  r = await call('POST', '/api/jobs', { action: 'plugins.delete', siteIds: [s1.id], params: { plugins: ['../../wp-config'] } });
  assert.equal(r.status, 400);
});

test('settings: read and batch update with verification', async (t) => {
  const wp1 = await startMockWp();
  const wp2 = await startMockWp({ restStyle: 'plain' });
  const ctx = await startApp();
  t.after(async () => {
    await ctx.close();
    await wp1.close();
    await wp2.close();
  });
  await ctx.login();
  const s1 = await ctx.addSite(wp1);
  const s2 = await ctx.addSite(wp2);

  let r = await ctx.call('POST', '/api/settings/query', { siteIds: [s1.id, s2.id] });
  assert.equal(r.data.sites[0].settings.timezone, 'UTC');

  let job = await ctx.runJob({
    action: 'settings.update',
    siteIds: [s1.id, s2.id],
    params: { settings: { description: '新闻 & 资讯', timezone: 'Asia/Shanghai', posts_per_page: 20, use_smilies: false } },
  });
  assert.deepEqual(job.counts, { ok: 2, warn: 0, error: 0, skipped: 0 }, JSON.stringify(job.results));
  assert.equal(wp2.state.settings.timezone, 'Asia/Shanghai');
  assert.equal(wp2.state.settings.posts_per_page, 20);

  job = await ctx.runJob({ action: 'settings.update', siteIds: [s1.id], params: { settings: { language: 'zh_CN', seo_plugin_option: 'x' } } });
  assert.equal(job.counts.warn, 1);
  assert.match(job.results[0].message, /不支持：seo_plugin_option/);
  assert.match(job.results[0].message, /未生效：language/);

  r = await ctx.call('POST', '/api/jobs', { action: 'settings.update', siteIds: [s1.id], params: { settings: { 'bad key': 1 } } });
  assert.equal(r.status, 400);
  r = await ctx.call('POST', '/api/jobs', { action: 'settings.update', siteIds: [s1.id], params: { settings: {} } });
  assert.equal(r.status, 400);
});

test('categories & tags: aggregate, create, delete', async (t) => {
  const wp1 = await startMockWp();
  const wp2 = await startMockWp();
  const ctx = await startApp();
  t.after(async () => {
    await ctx.close();
    await wp1.close();
    await wp2.close();
  });
  await ctx.login();
  wp1.addTerm('categories', '体育');
  const s1 = await ctx.addSite(wp1);
  const s2 = await ctx.addSite(wp2);

  let job = await ctx.runJob({ action: 'terms.create', siteIds: [s1.id, s2.id], params: { taxonomy: 'categories', names: '体育，财经' } });
  assert.deepEqual(job.counts, { ok: 3, warn: 0, error: 0, skipped: 1 });

  const r = await ctx.call('POST', '/api/terms/query', { siteIds: [s1.id, s2.id], taxonomy: 'categories' });
  const byName = Object.fromEntries(r.data.terms.map((x) => [x.name, Object.keys(x.sites).length]));
  assert.deepEqual(byName, { Uncategorized: 2, 体育: 2, 财经: 2 });

  job = await ctx.runJob({ action: 'terms.delete', siteIds: [s1.id, s2.id], params: { taxonomy: 'categories', names: ['财经', '不存在'] } });
  assert.deepEqual(job.counts, { ok: 2, warn: 0, error: 0, skipped: 2 });
  assert.equal([...wp1.state.categories.values()].some((c) => c.name === '财经'), false);

  job = await ctx.runJob({ action: 'terms.create', siteIds: [s1.id], params: { taxonomy: 'tags', names: ['头条'] } });
  assert.equal(wp1.state.tags.size, 1);
});

test('jobs: per-site concurrency, cancel, history', async (t) => {
  const wp = await startMockWp();
  const ctx = await startApp();
  t.after(async () => {
    await ctx.close();
    await wp.close();
  });
  await ctx.login();
  const site = await ctx.addSite(wp);
  const ids = Array.from({ length: 40 }, (_, i) => wp.addPost('posts', { title: `p${i}` }).id);

  wp.state.delayMs = 15;
  wp.state.peakInFlight = 0;

  const r = await ctx.call('POST', '/api/jobs', { action: 'posts.trash', targets: ids.map((id) => ({ siteId: site.id, id })) });
  const jobId = r.data.job.id;
  await ctx.call('POST', `/api/jobs/${jobId}/cancel`);
  await ctx.app.jobs.wait(jobId);
  const job = (await ctx.call('GET', `/api/jobs/${jobId}`)).data.job;
  assert.equal(job.status, 'cancelled');
  assert.equal(job.done, 40);
  assert.ok(job.counts.skipped > 0, 'remaining tasks were skipped');
  assert.ok(wp.state.peakInFlight <= 3, `per-site concurrency respected (peak ${wp.state.peakInFlight})`);

  const partial = (await ctx.call('GET', `/api/jobs/${jobId}?since=35`)).data.job;
  assert.equal(partial.results.length, 5);
  assert.equal(partial.resultsFrom, 35);

  let history = (await ctx.call('GET', '/api/history')).data.jobs;
  assert.equal(history[0].id, jobId);
  assert.equal(history[0].results, undefined);
  await ctx.call('DELETE', '/api/history');
  history = (await ctx.call('GET', '/api/history')).data.jobs;
  assert.equal(history.length, 0);
});

test('wordpress.org plugin search proxy', async (t) => {
  const directory = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      info: { page: 1, pages: 1, results: 1 },
      plugins: [{ name: 'Yoast SEO &#8211; Advanced SEO', slug: 'wordpress-seo', version: '23.0', rating: 96, active_installs: 10000000, short_description: `search=${url.searchParams.get('request[search]')}`, icons: { '1x': 'https://ps.w.org/icon.png' } }],
    }));
  });
  await new Promise((resolve) => directory.listen(0, '127.0.0.1', resolve));
  process.env.WPBM_WPORG_API = `http://127.0.0.1:${directory.address().port}/plugins/info/1.2/`;
  const ctx = await startApp();
  t.after(async () => {
    delete process.env.WPBM_WPORG_API;
    await ctx.close();
    directory.close();
    directory.closeAllConnections?.();
  });
  await ctx.login();
  const r = await ctx.call('GET', '/api/wporg/plugins?search=seo');
  assert.equal(r.status, 200);
  assert.equal(r.data.plugins[0].name, 'Yoast SEO – Advanced SEO');
  assert.equal(r.data.plugins[0].shortDescription, 'search=seo');
  assert.equal(r.data.plugins[0].icon, 'https://ps.w.org/icon.png');
});
