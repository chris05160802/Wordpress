import fs from 'node:fs';
import path from 'node:path';
import { loadKey, encrypt, decrypt } from './crypto.js';
import { newId } from './util.js';

const HISTORY_LIMIT = 100;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`无法读取数据文件 ${file}：${err.message}`);
  }
}

/** Write to a temp file then rename, so a crash never leaves a half-written file. */
function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Local JSON storage. Everything is kept in memory and written synchronously, so a
 * read-modify-write inside one request handler can't interleave with another.
 */
export class Store {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.key = loadKey(this.dataDir);
    this.files = {
      config: path.join(this.dataDir, 'config.json'),
      sites: path.join(this.dataDir, 'sites.json'),
      history: path.join(this.dataDir, 'history.json'),
    };
    this.config = readJson(this.files.config, {});
    this.sites = readJson(this.files.sites, { sites: [] }).sites || [];
    this.history = readJson(this.files.history, { jobs: [] }).jobs || [];
  }

  saveConfig() {
    writeJson(this.files.config, this.config);
  }

  saveSites() {
    writeJson(this.files.sites, { version: 1, sites: this.sites });
  }

  // ---- sites -------------------------------------------------------------

  listSites() {
    return this.sites.map(publicSite);
  }

  getSite(id) {
    return this.sites.find((s) => s.id === id);
  }

  addSite({ password, ...fields }) {
    const now = new Date().toISOString();
    const site = { id: newId(), ...fields, secret: encrypt(this.key, password), addedAt: now, updatedAt: now };
    this.sites.push(site);
    this.saveSites();
    return site;
  }

  updateSite(id, { password, ...fields }) {
    const site = this.getSite(id);
    if (!site) return null;
    Object.assign(site, fields, { updatedAt: new Date().toISOString() });
    if (password) site.secret = encrypt(this.key, password);
    this.saveSites();
    return site;
  }

  removeSite(id) {
    const before = this.sites.length;
    this.sites = this.sites.filter((s) => s.id !== id);
    if (this.sites.length === before) return false;
    this.saveSites();
    return true;
  }

  credentials(site) {
    try {
      return { username: site.username, password: decrypt(this.key, site.secret) };
    } catch {
      const err = new Error('无法解密该站点保存的应用密码（密钥可能已更换），请在"站点管理"中重新填写应用密码');
      err.code = 'decrypt_failed';
      throw err;
    }
  }

  // ---- history -----------------------------------------------------------

  addHistory(job) {
    this.history = [job, ...this.history.filter((j) => j.id !== job.id)].slice(0, HISTORY_LIMIT);
    writeJson(this.files.history, { version: 1, jobs: this.history });
  }

  getHistory(id) {
    return this.history.find((j) => j.id === id) || null;
  }

  clearHistory() {
    this.history = [];
    writeJson(this.files.history, { version: 1, jobs: [] });
  }
}

export function publicSite(site) {
  const { secret, ...rest } = site;
  return rest;
}
