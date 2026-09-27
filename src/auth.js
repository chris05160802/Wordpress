import { hashPassword, verifyPassword, randomToken, signToken, verifyToken, safeEqual } from './crypto.js';
import { HttpError } from './util.js';

const COOKIE = 'wpbm_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) cookies[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return cookies;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, '管理密码至少需要 8 个字符');
  if (password.length > 200) throw new HttpError(400, '管理密码太长');
}

/**
 * Password protection for the console itself (it holds admin access to every site).
 * The first password can only be set with the one-time setup code printed on startup,
 * so nobody else who can reach the port can claim a fresh install.
 */
export class Auth {
  constructor(store) {
    this.store = store;
    this.failures = new Map();
    this.setupCode = this.isConfigured() ? null : randomToken(12);
  }

  isConfigured() {
    return Boolean(this.store.config.passwordHash);
  }

  /** WPBM_PASSWORD: set the password non-interactively (Docker / servers). */
  async configureFromEnv(password) {
    if (password && !this.isConfigured()) {
      await this.#setPassword(password);
      this.setupCode = null;
    }
  }

  async setup(password, code) {
    if (this.isConfigured()) throw new HttpError(409, '管理密码已经设置过了，请直接登录');
    if (!this.setupCode || !safeEqual(String(code ?? '').trim(), this.setupCode)) {
      throw new HttpError(403, '设置码不正确：请使用程序启动时命令行窗口里显示的链接或设置码');
    }
    await this.#setPassword(password);
    this.setupCode = null;
  }

  async login(password, ip) {
    if (!this.isConfigured()) throw new HttpError(409, '请先设置管理密码', 'setup_required');
    const now = Date.now();
    const entry = this.failures.get(ip);
    if (entry && now - entry.first > FAILURE_WINDOW_MS) this.failures.delete(ip);
    if ((this.failures.get(ip)?.count || 0) >= MAX_FAILURES) {
      throw new HttpError(429, '密码错误次数过多，请 15 分钟后再试');
    }
    if (!(await verifyPassword(String(password ?? ''), this.store.config.passwordHash))) {
      const e = this.failures.get(ip) || { count: 0, first: now };
      e.count++;
      this.failures.set(ip, e);
      throw new HttpError(401, '密码不正确', 'bad_password');
    }
    this.failures.delete(ip);
  }

  async changePassword(current, next) {
    if (!(await verifyPassword(String(current ?? ''), this.store.config.passwordHash))) {
      throw new HttpError(400, '当前密码不正确');
    }
    await this.#setPassword(next);
  }

  async #setPassword(password) {
    validatePassword(password);
    this.store.config.passwordHash = await hashPassword(password);
    // A new signing secret logs out every existing session.
    this.store.config.sessionSecret = randomToken(32);
    this.store.saveConfig();
  }

  isAuthenticated(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    return Boolean(verifyToken(this.store.config.sessionSecret, token));
  }

  sessionCookie(secure) {
    const token = signToken(this.store.config.sessionSecret, { exp: Date.now() + SESSION_TTL_MS });
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`;
  }

  clearCookie(secure) {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
  }
}
