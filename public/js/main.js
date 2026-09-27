import { GET, POST, setUnauthorizedHandler } from './api.js';
import { h, clear, button, field, toast, withBusy, openModal, spinner } from './dom.js';
import { state, subscribe, loadSites, setSelected } from './store.js';
import * as sitesView from './views/sites.js';
import * as postsView from './views/posts.js';
import * as publishView from './views/publish.js';
import * as pluginsView from './views/plugins.js';
import * as settingsView from './views/settings.js';
import * as termsView from './views/terms.js';
import * as historyView from './views/history.js';

const TABS = [
  ['sites', '站点管理', sitesView],
  ['posts', '文章管理', postsView],
  ['publish', '批量发布', publishView],
  ['plugins', '插件管理', pluginsView],
  ['settings', '网站设置', settingsView],
  ['terms', '分类标签', termsView],
  ['history', '操作记录', historyView],
];

const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
const setupCode = params.get('setup');

// Coming back from WordPress' "authorize application" page (only when this console runs on HTTPS).
// WordPress appends the credentials as "?site_url=…&user_login=…&password=…"; accept them in the
// fragment too, in case a callback URL with a "#" was used.
const hashQuery = location.hash.includes('?') ? new URLSearchParams(location.hash.slice(location.hash.indexOf('?') + 1)) : null;
const connect = [params, hashQuery].find((p) => p?.get('site_url') && p.get('user_login') && p.get('password'));
if (connect) {
  state.pendingConnect = { url: connect.get('site_url'), username: connect.get('user_login'), appPassword: connect.get('password') };
}
// Drop setup codes and credentials from the address bar (and browser history).
if (connect) history.replaceState(null, '', `${location.pathname}#/sites`);
else if (location.search) history.replaceState(null, '', location.pathname + location.hash);

let version = '';
let cleanupView = null;
let appShown = false;
let shellCleanups = [];

function brand() {
  return h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), h('span', { class: 'brand-text' }, 'WP 批量管家'), version ? h('span', { class: 'version' }, `v${version}`) : null);
}

function authCard(...children) {
  appShown = false;
  return h('div', { class: 'auth-wrap' }, h('div', { class: 'card auth-card' }, brand(), ...children));
}

function showSetup() {
  const code = h('input', { type: 'text', value: setupCode || '', autocomplete: 'off', spellcheck: 'false' });
  const pw = h('input', { type: 'password', autocomplete: 'new-password' });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const submit = button('完成设置', { kind: 'primary', type: 'submit' });
  const form = h('form', { class: 'stack' },
    h('div', null,
      h('p', null, '欢迎使用！首次使用请先设置管理密码。'),
      h('p', { class: 'muted small' }, '本程序保存着你所有网站的管理权限，请设置一个足够强的密码（至少 8 位），以后打开本程序时需要输入它。')),
    setupCode ? null : field('设置码', code, '程序启动时，命令行窗口里会显示设置码'),
    field('管理密码', pw),
    field('再次输入管理密码', pw2),
    submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (pw.value.length < 8) return toast('管理密码至少需要 8 个字符', 'error');
    if (pw.value !== pw2.value) return toast('两次输入的密码不一致', 'error');
    withBusy(submit, async () => {
      try {
        await POST('/api/auth/setup', { password: pw.value, code: code.value });
        toast('管理密码设置完成', 'ok');
        showApp();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
  clear(app, authCard(form));
  (setupCode ? pw : code).focus();
}

function showLogin() {
  if (!appShown && app.querySelector('.auth-wrap form[data-login]')) return;
  const pw = h('input', { type: 'password', autocomplete: 'current-password' });
  const submit = button('登录', { kind: 'primary', type: 'submit' });
  const form = h('form', { class: 'stack', dataset: { login: '1' } }, field('管理密码', pw), submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    withBusy(submit, async () => {
      try {
        await POST('/api/auth/login', { password: pw.value });
        showApp();
      } catch (err) {
        toast(err.message, 'error');
        pw.select();
      }
    });
  });
  document.querySelectorAll('.modal-backdrop').forEach((m) => m.remove());
  cleanupView?.();
  cleanupView = null;
  shellCleanups.forEach((fn) => fn());
  shellCleanups = [];
  window.onhashchange = null;
  clear(app, authCard(form));
  pw.focus();
}

function changePassword() {
  const current = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password' });
  const next2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const save = button('保存', { kind: 'primary' });
  const m = openModal({
    title: '修改管理密码',
    body: [field('当前密码', current), field('新密码', next, '至少 8 个字符'), field('再次输入新密码', next2)],
    footer: [button('取消', { onClick: () => m.close() }), save],
  });
  save.addEventListener('click', () => {
    if (next.value !== next2.value) return toast('两次输入的新密码不一致', 'error');
    withBusy(save, async () => {
      try {
        await POST('/api/auth/password', { current: current.value, password: next.value });
        toast('管理密码已修改', 'ok');
        m.close();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

function groupBy(list, key) {
  const map = new Map();
  for (const item of list) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

function renderSidebar() {
  const search = h('input', { type: 'search', placeholder: '搜索站点名称、网址或分组' });
  const count = h('span', { class: 'muted small' });
  const list = h('div', { class: 'sb-list' });
  const visible = () => {
    const q = search.value.trim().toLowerCase();
    return state.sites.filter((s) => !q || [s.name, s.url, s.group].some((v) => String(v || '').toLowerCase().includes(q)));
  };
  const el = h('aside', { class: 'sidebar' },
    h('div', { class: 'sb-head' }, h('strong', null, '选择站点'), count),
    h('div', { class: 'sb-tools' },
      search,
      h('div', { class: 'row' },
        button('全选', { size: 'xs', onClick: () => setSelected(visible().map((s) => s.id), true) }),
        button('清空', { size: 'xs', onClick: () => setSelected(visible().map((s) => s.id), false) }),
        button('反选', {
          size: 'xs',
          onClick: () => {
            const v = visible();
            const on = v.filter((s) => !state.selected.has(s.id)).map((s) => s.id);
            setSelected(v.map((s) => s.id), false);
            setSelected(on, true);
          },
        }))),
    list);

  const siteRow = (s, grouped) => {
    const selected = state.selected.has(s.id);
    const status = s.lastCheck ? (s.lastCheck.ok ? 'ok' : 'error') : '';
    const tip = `${s.name}\n${s.url}${s.lastCheck && !s.lastCheck.ok ? `\n连接异常：${s.lastCheck.message}` : ''}`;
    const row = h('label', { class: `sb-site${selected ? ' selected' : ''}`, title: tip },
      h('input', { type: 'checkbox', checked: selected, onChange: (e) => setSelected([s.id], e.target.checked) }),
      h('span', { class: `dot ${status}` }),
      h('span', { class: 'name' }, s.name));
    if (!grouped) row.style.paddingLeft = '8px';
    return row;
  };

  function render() {
    count.textContent = `已选 ${state.selected.size} / ${state.sites.length}`;
    if (!state.sites.length) return clear(list, h('div', { class: 'sb-empty' }, '还没有添加站点。请先在「站点管理」中添加。'));
    const sites = visible();
    if (!sites.length) return clear(list, h('div', { class: 'sb-empty' }, '没有匹配的站点'));
    const groups = groupBy(sites, (s) => s.group || '');
    if (groups.size === 1 && groups.has('')) return clear(list, sites.map((s) => siteRow(s, false)));
    const names = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'zh-CN')));
    clear(list, names.map((g) => {
      const items = groups.get(g);
      const n = items.filter((s) => state.selected.has(s.id)).length;
      const box = h('input', {
        type: 'checkbox',
        checked: n === items.length,
        indeterminate: n > 0 && n < items.length,
        onChange: (e) => setSelected(items.map((s) => s.id), e.target.checked),
      });
      return h('div', { class: 'sb-group' },
        h('label', { class: 'sb-group-head' }, box, h('span', { class: 'grow' }, g || '未分组'), h('span', { class: 'count-pill' }, `${n}/${items.length}`)),
        items.map((s) => siteRow(s, true)));
    }));
  }

  search.addEventListener('input', render);
  shellCleanups.push(subscribe(render));
  render();
  return el;
}

async function showApp() {
  appShown = true;
  shellCleanups.forEach((fn) => fn());
  shellCleanups = [];
  cleanupView?.();
  cleanupView = null;
  clear(app, spinner('正在加载站点…'));
  try {
    await loadSites();
  } catch (err) {
    if (err.status === 401) return;
    toast(err.message, 'error');
  }

  const sidebar = renderSidebar();
  const tabsEl = h('nav', { class: 'tabs' });
  const viewEl = h('section', { class: 'view' });
  const pill = h('span', { class: 'badge info hide-mobile' });
  const toggle = button('☰ 站点', { kind: 'ghost', size: 'sm', onClick: () => sidebar.classList.toggle('open') });
  toggle.classList.add('sites-toggle');
  shellCleanups.push(subscribe(() => {
    pill.textContent = `已选 ${state.selected.size} 个站点`;
    toggle.textContent = `☰ 站点（${state.selected.size}）`;
  }));
  pill.textContent = `已选 ${state.selected.size} 个站点`;
  toggle.textContent = `☰ 站点（${state.selected.size}）`;

  const logout = async () => {
    try {
      await POST('/api/auth/logout');
    } finally {
      showLogin();
    }
  };

  const topbar = h('header', { class: 'topbar' },
    toggle,
    brand(),
    h('span', { class: 'spacer' }),
    pill,
    h('div', { class: 'row tight user-actions' },
      button('修改密码', { kind: 'ghost', size: 'sm', onClick: changePassword }),
      button('退出', { kind: 'ghost', size: 'sm', onClick: logout })));

  clear(app, topbar, h('div', { class: 'layout' }, sidebar, h('main', { class: 'main' }, tabsEl, viewEl)));

  function route() {
    const name = location.hash.replace(/^#\/?/, '');
    const tab = TABS.find(([key]) => key === name) || TABS.find(([key]) => key === (state.sites.length ? 'posts' : 'sites'));
    clear(tabsEl, TABS.map(([key, label]) => h('button', {
      type: 'button',
      class: `tab${key === tab[0] ? ' active' : ''}`,
      onClick: () => {
        location.hash = `#/${key}`;
      },
    }, label)));
    cleanupView?.();
    clear(viewEl);
    cleanupView = tab[2].mount(viewEl, { goto: (key) => { location.hash = `#/${key}`; } }) || null;
    sidebar.classList.remove('open');
    window.scrollTo(0, 0);
  }
  window.onhashchange = route;
  route();
}

async function boot() {
  setUnauthorizedHandler(() => {
    if (appShown) toast('登录已过期，请重新登录', 'warn');
    showLogin();
  });
  let status;
  try {
    status = await GET('/api/auth/status');
  } catch (err) {
    clear(app, h('div', { class: 'boot' }, err.message));
    return;
  }
  version = status.version;
  if (!status.configured) return showSetup();
  if (!status.authenticated) return showLogin();
  return showApp();
}

boot();
