#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/app.js';
import { VERSION } from './src/version.js';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const port = parseInt(process.env.PORT, 10) || 8686;
const host = process.env.HOST || '127.0.0.1';
const dataDir = process.env.WPBM_DATA_DIR || path.join(rootDir, 'data');
const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(host);

// When only reachable from this computer, also reject requests whose Host header is some
// other name: that blocks DNS-rebinding attacks from web pages open in the browser.
const extraHosts = String(process.env.WPBM_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
const allowedHosts = isLoopback || extraHosts.length ? ['localhost', '127.0.0.1', '[::1]', ...extraHosts] : null;

const app = createApp({ dataDir, allowedHosts, trustProxy: process.env.WPBM_TRUST_PROXY === '1' });
await app.auth.configureFromEnv(process.env.WPBM_PASSWORD);

function openBrowser(url) {
  const options = { stdio: 'ignore', detached: true };
  let cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  let args = [url];
  if (process.platform === 'win32') {
    // `start "" "<url>"`: the empty first argument is the window title. Passed verbatim,
    // because Node's default quoting would turn "" into \"\" and break the command.
    cmd = 'cmd';
    args = ['/c', 'start', '""', `"${url}"`];
    options.windowsVerbatimArguments = true;
  }
  try {
    spawn(cmd, args, options).on('error', () => {}).unref();
  } catch {
    // no browser available; the URL is printed anyway
  }
}

const server = http.createServer(app.handler);
server.requestTimeout = 15 * 60 * 1000;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`端口 ${port} 已被占用。可以换一个端口启动，例如：PORT=8687 npm start`);
  else console.error(err);
  process.exit(1);
});

server.listen(port, host, () => {
  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  const url = `http://${shownHost}:${port}`;
  const openUrl = app.auth.setupCode ? `${url}/?setup=${app.auth.setupCode}` : url;
  console.log(`\nWP 批量管家 v${VERSION} 已启动：${url}`);
  console.log(`数据目录：${dataDir}`);
  if (app.auth.setupCode) {
    console.log('\n首次使用：请在浏览器中打开下面的链接来设置管理密码（链接里包含一次性设置码）：');
    console.log(`  ${openUrl}`);
    console.log(`  设置码：${app.auth.setupCode}`);
  }
  if (!isLoopback) {
    console.log('\n注意：当前监听的不是本机地址，其他电脑也能访问。请务必设置足够强的管理密码，并通过 HTTPS 反向代理访问。');
  }
  console.log('\n按 Ctrl+C 停止运行。');
  if (process.argv.includes('--open')) openBrowser(openUrl);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
