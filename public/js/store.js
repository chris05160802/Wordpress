// Shared state: the site list and which sites are selected in the sidebar.
import { GET } from './api.js';
import { readStorage, writeStorage } from './dom.js';

const SELECTED_KEY = 'wpbm.selectedSites';

export const state = {
  sites: [],
  selected: new Set(readStorage(SELECTED_KEY, null) || []),
  hadSavedSelection: readStorage(SELECTED_KEY, null) !== null,
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  writeStorage(SELECTED_KEY, [...state.selected]);
  for (const fn of listeners) fn();
}

export function setSites(sites) {
  const firstLoad = state.sites.length === 0;
  state.sites = sites;
  const ids = new Set(sites.map((s) => s.id));
  for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
  // Nothing saved yet: start with every site selected.
  if (firstLoad && !state.hadSavedSelection) sites.forEach((s) => state.selected.add(s.id));
  emit();
}

export async function loadSites() {
  const { sites } = await GET('/api/sites');
  setSites(sites);
  return sites;
}

export function upsertSite(site, { select = false } = {}) {
  const i = state.sites.findIndex((s) => s.id === site.id);
  if (i >= 0) state.sites[i] = site;
  else state.sites.push(site);
  if (select) state.selected.add(site.id);
  emit();
}

export function removeSite(id) {
  state.sites = state.sites.filter((s) => s.id !== id);
  state.selected.delete(id);
  emit();
}

export function setSelected(ids, on) {
  for (const id of ids) {
    if (on) state.selected.add(id);
    else state.selected.delete(id);
  }
  emit();
}

export function replaceSelection(ids) {
  state.selected = new Set(ids);
  emit();
}

export function selectedSites() {
  return state.sites.filter((s) => state.selected.has(s.id));
}

export function siteById(id) {
  return state.sites.find((s) => s.id === id);
}

export function groupNames() {
  return [...new Set(state.sites.map((s) => s.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

export const ROLE_TEXT = {
  administrator: '管理员',
  editor: '编辑',
  author: '作者',
  contributor: '投稿者',
  subscriber: '订阅者',
};

export function roleText(site) {
  const roles = site.user?.roles || [];
  return roles.map((r) => ROLE_TEXT[r] || r).join('、') || '未知角色';
}
