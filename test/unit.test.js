import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { decodeEntities, htmlToText, parseList, pool, sleep } from '../src/util.js';
import { encrypt, decrypt, hashPassword, verifyPassword, signToken, verifyToken } from '../src/crypto.js';
import { normalizeSiteUrl, buildUrl, parseJsonLoose, describeWpError, pluginPath } from '../src/wp-client.js';
import { makeReplacer } from '../src/actions.js';
import { parseImportText } from '../src/app.js';

test('decodeEntities / htmlToText', () => {
  assert.equal(decodeEntities('A &amp; B &#8217;s &#x4e2d; &hellip; &unknown;'), 'A & B ’s 中 … &unknown;');
  assert.equal(htmlToText('<b>Hello</b>  &lt;world&gt;\n'), 'Hello <world>');
  assert.equal(htmlToText(null), '');
});

test('parseList splits on commas (incl. Chinese) and newlines, de-duplicates', () => {
  assert.deepEqual(parseList('国内新闻, 科技，体育、 科技\n财经'), ['国内新闻', '科技', '体育', '财经']);
  assert.deepEqual(parseList([' a ', 'b', '', 'a']), ['a', 'b']);
  assert.deepEqual(parseList(undefined), []);
});

test('pool never exceeds the concurrency limit and keeps order', async () => {
  let active = 0;
  let peak = 0;
  const out = await pool([5, 1, 4, 2, 3, 1], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await sleep(n * 3);
    active--;
    return n * 10;
  });
  assert.equal(peak, 2);
  assert.deepEqual(out, [50, 10, 40, 20, 30, 10]);
});

test('encrypt / decrypt round trip and tamper detection', () => {
  const key = crypto.randomBytes(32);
  const token = encrypt(key, 'abcd efgh ijkl mnop');
  assert.notEqual(token, 'abcd efgh ijkl mnop');
  assert.equal(decrypt(key, token), 'abcd efgh ijkl mnop');
  const tampered = `v1:${Buffer.from(Buffer.from(token.slice(3), 'base64').map((b, i) => (i === 40 ? b ^ 1 : b))).toString('base64')}`;
  assert.throws(() => decrypt(key, tampered));
  assert.throws(() => decrypt(crypto.randomBytes(32), token));
});

test('password hashing', async () => {
  const hash = await hashPassword('correct horse');
  assert.match(hash, /^scrypt\$/);
  assert.equal(await verifyPassword('correct horse', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  assert.equal(await verifyPassword('x', ''), false);
});

test('session tokens: signature and expiry', () => {
  const token = signToken('secret', { exp: Date.now() + 1000 });
  assert.ok(verifyToken('secret', token));
  assert.equal(verifyToken('other', token), null);
  assert.equal(verifyToken('secret', `${token.split('.')[0]}.AAAA`), null);
  assert.equal(verifyToken('secret', signToken('secret', { exp: Date.now() - 1 })), null);
  assert.equal(verifyToken('secret', undefined), null);
});

test('normalizeSiteUrl', () => {
  assert.equal(normalizeSiteUrl('example.com'), 'https://example.com');
  assert.equal(normalizeSiteUrl(' http://Example.com/blog/wp-admin/post.php?post=1#x '), 'http://example.com/blog');
  assert.equal(normalizeSiteUrl('https://a.com/wp-json/wp/v2/posts'), 'https://a.com');
  assert.equal(normalizeSiteUrl('https://user:pass@a.com/news/'), 'https://a.com/news');
  assert.throws(() => normalizeSiteUrl(''), /请填写网站网址/);
  assert.throws(() => normalizeSiteUrl('ftp://a.com'), /http/);
});

test('buildUrl supports /wp-json/ and ?rest_route= roots', () => {
  assert.equal(buildUrl('https://a.com/wp-json/', '/wp/v2/posts', { per_page: 5, search: '', status: ['publish', 'draft'] }),
    'https://a.com/wp-json/wp/v2/posts?per_page=5&status=publish%2Cdraft');
  assert.equal(buildUrl('https://a.com/index.php?rest_route=%2F', 'wp/v2/plugins/akismet/akismet'),
    'https://a.com/index.php?rest_route=%2Fwp%2Fv2%2Fplugins%2Fakismet%2Fakismet');
  assert.equal(pluginPath('my plugin/main'), 'my%20plugin/main');
});

test('parseJsonLoose tolerates BOM and PHP notices before JSON', () => {
  assert.deepEqual(parseJsonLoose('﻿{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('<br /><b>Deprecated</b>: foo() in x.php<br />[{"id":1}]'), [{ id: 1 }]);
  assert.equal(parseJsonLoose('<html>blocked</html>'), undefined);
  assert.equal(parseJsonLoose(''), null);
});

test('describeWpError gives Chinese explanations', () => {
  assert.match(describeWpError(401, 'rest_not_logged_in', 'You are not currently logged in.'), /应用密码/);
  assert.match(describeWpError(403, 'rest_cannot_install_plugin', 'x'), /没有权限安装插件/);
  assert.equal(describeWpError(400, 'rest_invalid_param', 'Invalid parameter(s): status'), '参数不正确（Invalid parameter(s): status）');
  assert.equal(describeWpError(418, 'weird_code', 'I am a teapot'), 'I am a teapot');
  assert.match(describeWpError(503, '', ''), /HTTP 503/);
  assert.match(describeWpError(500, 'mkdir_failed_destination', 'Could not create directory.'), /无法创建插件目录/);
});

test('makeReplacer: plain text, case-insensitive, regex', () => {
  const plain = makeReplacer({ find: '$1.00', replace: '$2' });
  assert.deepEqual(plain('cost $1.00 or $1.00'), { count: 2, text: 'cost $2 or $2' });
  const ci = makeReplacer({ find: 'wordpress', replace: 'WordPress', caseSensitive: false });
  assert.deepEqual(ci('WORDPRESS and wordpress'), { count: 2, text: 'WordPress and WordPress' });
  const re = makeReplacer({ find: '来源：(\\S+)', replace: '来源：新站（原 $1）', regex: true });
  assert.deepEqual(re('来源：旧站'), { count: 1, text: '来源：新站（原 旧站）' });
  assert.deepEqual(plain('nothing'), { count: 0, text: 'nothing' });
  assert.throws(() => makeReplacer({ find: '(', regex: true }), /正则表达式有误/);
  assert.throws(() => makeReplacer({ find: '' }), /请填写要查找的内容/);
});

test('parseImportText accepts several separators', () => {
  const lines = parseImportText([
    '# 注释',
    'https://a.com,admin,abcd efgh ijkl mnop qrst uvwx,新闻站',
    'b.com，editor，xxxx xxxx',
    'c.com | admin | pass',
    'd.com\tadmin\tpass pass',
    'e.com admin abcd efgh ijkl',
    'broken-line',
    '',
  ].join('\n'));
  assert.deepEqual(lines.map((l) => [l.url, l.username, l.password, l.group || '']), [
    ['https://a.com', 'admin', 'abcd efgh ijkl mnop qrst uvwx', '新闻站'],
    ['b.com', 'editor', 'xxxx xxxx', ''],
    ['c.com', 'admin', 'pass', ''],
    ['d.com', 'admin', 'pass pass', ''],
    ['e.com', 'admin', 'abcd efgh ijkl', ''],
    ['broken-line', undefined, undefined, ''],
  ]);
  assert.equal(lines[5].lineNo, 7);
  assert.match(lines[5].error, /格式不正确/);
});
