import { POST, PATCH, DELETE } from '../api.js';
import { h, clear, button, field, toast, withBusy, confirmDialog, openModal, badge, timeAgo, extLink, safeUrl, formatDate } from '../dom.js';
import { state, subscribe, upsertSite, removeSite, setSelected, setSites, loadSites, groupNames, roleText } from '../store.js';
import { trackJob } from '../jobs.js';

const APP_NAME = 'WP批量管家';
const APP_ID = '8a6f2f4e-3c1b-4d5e-9f07-6b2c1d3e4f50';

/** Link to WordPress' built-in "authorize application" screen, which creates an application password. */
function authorizeLink(authorizeUrl) {
  const u = new URL(authorizeUrl);
  // WordPress requires a unique name per application password, so reconnecting later must not reuse it.
  u.searchParams.set('app_name', `${APP_NAME} ${formatDate(new Date().toISOString())}`);
  u.searchParams.set('app_id', APP_ID);
  // WordPress only redirects back to HTTPS addresses; on plain http the password is shown for copying.
  // No "#fragment" here: WordPress appends "?site_url=…&password=…" to this URL as plain text.
  if (location.protocol === 'https:') u.searchParams.set('success_url', `${location.origin}/?connect=1`);
  return u.toString();
}

function helpBox() {
  return h('details', { class: 'notice info' },
    h('summary', null, h('b', null, '什么是"应用密码"？怎么获取？')),
    h('ol', null,
      h('li', null, '用管理员账号登录网站后台，进入「用户」→「个人资料」。'),
      h('li', null, '页面下方找到「应用程序密码」，名称填"批量管家"，点「添加新应用程序密码」。'),
      h('li', null, '复制生成的密码（形如 abcd efgh ijkl mnop qrst uvwx），粘贴到下面的"应用密码"里。')),
    h('p', { class: 'small', style: { marginTop: '6px' } },
      '也可以先填写网址并点「检测网站」，再点「打开授权页面」，在自己的网站上登录并同意即可生成。',
      '应用密码只能用来调用接口、不能登录后台，随时可以在网站后台撤销；本程序会把它加密保存在本机。'),
    h('p', { class: 'small' }, '注意：WordPress 默认只允许 HTTPS 网站使用应用密码；如果被 Wordfence 等安全插件关闭了，需要在插件设置里重新开启。'));
}

export function mount(el) {
  const cleanups = [];

  // ---- add one site ------------------------------------------------------------
  const url = h('input', { type: 'text', placeholder: 'https://www.example.com', autocomplete: 'off', spellcheck: 'false' });
  const username = h('input', { type: 'text', placeholder: '后台登录用的用户名', autocomplete: 'off', spellcheck: 'false' });
  const appPassword = h('input', { type: 'text', class: 'mono', placeholder: 'xxxx xxxx xxxx xxxx xxxx xxxx', autocomplete: 'off', spellcheck: 'false' });
  const group = h('input', { type: 'text', list: 'wpbm-groups', placeholder: '例如：新闻站（可选）', autocomplete: 'off' });
  const name = h('input', { type: 'text', placeholder: '默认使用网站标题（可选）', autocomplete: 'off' });
  const groupsList = h('datalist', { id: 'wpbm-groups' });
  const discoverInfo = h('div');
  const discoverBtn = button('检测网站', { size: 'sm' });
  const addBtn = button('添加站点', { kind: 'primary' });

  discoverBtn.addEventListener('click', () => {
    if (!url.value.trim()) return toast('请先填写网站网址', 'warn');
    withBusy(discoverBtn, async () => {
      try {
        const info = await POST('/api/sites/discover', { url: url.value });
        const authorize = info.appPasswords.authorizeUrl && safeUrl(info.appPasswords.authorizeUrl);
        clear(discoverInfo, info.appPasswords.available
          ? h('div', { class: 'notice ok row' },
            h('span', { class: 'grow' }, `找到网站：${info.name || info.home}（${info.home}），支持应用密码。`),
            authorize ? extLink(authorizeLink(authorize), '打开授权页面，生成应用密码 ↗', { class: 'btn sm primary' }) : null)
          : h('div', { class: 'notice warn' },
            `找到网站：${info.name || info.home}，但它没有开启"应用密码"功能。WordPress 默认只在 HTTPS 网站上开启；如果网站已经是 HTTPS，可能被安全插件关闭了。`));
        if (!url.value.startsWith('http')) url.value = info.home;
      } catch (err) {
        clear(discoverInfo, h('div', { class: 'notice error' }, err.message));
      }
    });
  });

  async function addSite(data) {
    const { site } = await POST('/api/sites', data);
    upsertSite(site, { select: true });
    toast(`已添加站点：${site.name}`, 'ok');
    return site;
  }

  addBtn.addEventListener('click', () => {
    if (!url.value.trim() || !username.value.trim() || !appPassword.value.trim()) {
      return toast('请填写网址、用户名和应用密码', 'warn');
    }
    withBusy(addBtn, async () => {
      try {
        await addSite({ url: url.value, username: username.value, appPassword: appPassword.value, group: group.value, name: name.value });
        url.value = '';
        username.value = '';
        appPassword.value = '';
        name.value = '';
        clear(discoverInfo);
      } catch (err) {
        toast(err.message, 'error', 8000);
      }
    });
  });

  const addCard = h('details', { class: 'card', open: state.sites.length === 0 },
    h('summary', { class: 'card-head' }, h('span', { class: 'chev' }, '▶'), h('h3', null, '添加站点')),
    h('div', { class: 'card-body stack' },
      helpBox(),
      h('div', { class: 'grid cols-2' },
        h('div', { class: 'field span-2' },
          h('label', null, '网站网址'),
          h('div', { class: 'row' }, h('div', { class: 'grow' }, url), discoverBtn)),
        h('div', { class: 'span-all' }, discoverInfo),
        field('用户名', username),
        field('应用密码', appPassword, '不是后台登录密码，见上方说明'),
        field('分组', group, '用来在左侧按分组批量选择站点'),
        field('显示名称', name)),
      h('div', { class: 'row' }, addBtn, groupsList)));

  // ---- batch import ----------------------------------------------------------------
  const importText = h('textarea', {
    class: 'code',
    rows: 6,
    placeholder: '每行一个站点：网址,用户名,应用密码,分组(可选)\nhttps://news1.com,admin,abcd efgh ijkl mnop qrst uvwx,新闻站\nhttps://blog2.com,editor,wxyz wxyz wxyz wxyz wxyz wxyz',
    spellcheck: 'false',
  });
  const importGroup = h('input', { type: 'text', list: 'wpbm-groups', placeholder: '行内没写分组时使用（可选）' });
  const importBtn = button('开始导入', { kind: 'primary' });
  importBtn.addEventListener('click', () => {
    if (!importText.value.trim()) return toast('请先粘贴要导入的站点', 'warn');
    withBusy(importBtn, async () => {
      try {
        const { job } = await POST('/api/sites/import', { text: importText.value, group: importGroup.value });
        const done = await trackJob(job);
        const sites = await loadSites();
        const added = done.results.filter((r) => r.status === 'ok').map((r) => r.data?.siteId).filter(Boolean);
        setSelected(added, true);
        if (added.length) importText.value = '';
        toast(`导入完成：成功 ${added.length} 个，现在共 ${sites.length} 个站点`, added.length ? 'ok' : 'warn');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
  const importCard = h('details', { class: 'card' },
    h('summary', { class: 'card-head' }, h('span', { class: 'chev' }, '▶'), h('h3', null, '批量导入站点')),
    h('div', { class: 'card-body stack' },
      h('p', { class: 'muted small' }, '每行一个站点，格式：网址,用户名,应用密码,分组。分隔符可以用英文逗号、中文逗号、竖线 | 或 Tab（从表格复制过来即可）。以 # 开头的行会被忽略。'),
      importText,
      h('div', { class: 'grid cols-2' }, field('默认分组', importGroup)),
      h('div', { class: 'row' }, importBtn)));

  // ---- site list -------------------------------------------------------------------
  const listCount = h('span', { class: 'muted small' });
  const testSelectedBtn = button('测试所选站点的连接', { size: 'sm' });
  const tableWrap = h('div', { class: 'table-wrap' });

  testSelectedBtn.addEventListener('click', () => {
    const ids = [...state.selected];
    if (!ids.length) return toast('请先在左侧选择站点', 'warn');
    withBusy(testSelectedBtn, async () => {
      try {
        const { results, sites } = await POST('/api/sites/test', { siteIds: ids });
        setSites(sites);
        const bad = results.filter((r) => !r.ok).length;
        toast(bad ? `${results.length} 个站点中有 ${bad} 个连接异常` : `${results.length} 个站点连接全部正常`, bad ? 'warn' : 'ok');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  async function testOne(site, btn) {
    await withBusy(btn, async () => {
      try {
        const { results, sites } = await POST('/api/sites/test', { siteIds: [site.id] });
        setSites(sites);
        toast(results[0].ok ? `${site.name}：连接正常` : `${site.name}：${results[0].message}`, results[0].ok ? 'ok' : 'error', 8000);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  function editSite(site) {
    const f = {
      name: h('input', { type: 'text', value: site.name }),
      group: h('input', { type: 'text', value: site.group || '', list: 'wpbm-groups' }),
      url: h('input', { type: 'text', value: site.url }),
      username: h('input', { type: 'text', value: site.username, autocomplete: 'off' }),
      appPassword: h('input', { type: 'text', class: 'mono', placeholder: '不修改请留空', autocomplete: 'off', spellcheck: 'false' }),
    };
    const save = button('保存', { kind: 'primary' });
    const m = openModal({
      title: `编辑站点：${site.name}`,
      body: [
        h('div', { class: 'grid cols-2' }, field('显示名称', f.name), field('分组', f.group)),
        field('网站网址', f.url),
        h('div', { class: 'grid cols-2' }, field('用户名', f.username), field('新的应用密码', f.appPassword, '修改网址、用户名或密码后会重新测试连接')),
      ],
      footer: [button('取消', { onClick: () => m.close() }), save],
    });
    save.addEventListener('click', () => withBusy(save, async () => {
      const body = { name: f.name.value, group: f.group.value };
      if (f.url.value.trim() !== site.url) body.url = f.url.value;
      if (f.username.value.trim() !== site.username) body.username = f.username.value;
      if (f.appPassword.value.trim()) body.appPassword = f.appPassword.value;
      try {
        const res = await PATCH(`/api/sites/${site.id}`, body);
        upsertSite(res.site);
        toast('已保存', 'ok');
        m.close();
      } catch (err) {
        toast(err.message, 'error', 8000);
      }
    }));
  }

  async function deleteSite(site) {
    const ok = await confirmDialog({
      title: '移除站点',
      message: `确定从管理列表中移除「${site.name}」吗？这不会影响网站本身；如果不再使用，建议同时在网站后台撤销对应的应用密码。`,
      confirmText: '移除',
      danger: true,
    });
    if (!ok) return;
    try {
      await DELETE(`/api/sites/${site.id}`);
      removeSite(site.id);
      toast('已移除', 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function renderList() {
    clear(groupsList, groupNames().map((g) => h('option', { value: g })));
    listCount.textContent = `共 ${state.sites.length} 个站点，已选 ${state.selected.size} 个`;
    if (!state.sites.length) {
      clear(tableWrap, h('div', { class: 'empty' }, '还没有站点。请在上方「添加站点」中添加你的第一个 WordPress 网站。'));
      return;
    }
    const allSelected = state.sites.every((s) => state.selected.has(s.id));
    const someSelected = state.sites.some((s) => state.selected.has(s.id));
    clear(tableWrap, h('table', { class: 'table' },
      h('thead', null, h('tr', null,
        h('th', { class: 'check-col' }, h('input', {
          type: 'checkbox',
          checked: allSelected,
          indeterminate: someSelected && !allSelected,
          title: '全选',
          onChange: (e) => setSelected(state.sites.map((s) => s.id), e.target.checked),
        })),
        h('th', null, '站点'),
        h('th', null, '分组'),
        h('th', null, '账号'),
        h('th', null, '连接状态'),
        h('th', null, '操作'))),
      h('tbody', null, state.sites.map((site) => {
        const testBtn = h('button', { type: 'button', class: 'link-btn' }, '测试');
        testBtn.addEventListener('click', () => testOne(site, testBtn));
        const check = site.lastCheck;
        return h('tr', { class: state.selected.has(site.id) ? 'selected' : '' },
          h('td', { class: 'check-col' }, h('input', { type: 'checkbox', checked: state.selected.has(site.id), onChange: (e) => setSelected([site.id], e.target.checked) })),
          h('td', { class: 'title-cell' },
            h('div', { class: 't' }, site.name),
            h('div', { class: 'sub' }, extLink(site.url, site.url), ' · ', extLink(site.adminUrl || `${site.url}/wp-admin/`, '后台'))),
          h('td', null, site.group ? badge(site.group) : h('span', { class: 'muted' }, '—')),
          h('td', null, site.username, h('div', { class: 'sub' }, roleText(site))),
          h('td', null,
            check ? badge(check.ok ? '正常' : '异常', check.ok ? 'ok' : 'error') : badge('未测试'),
            check ? h('div', { class: 'sub' }, timeAgo(check.at)) : null,
            check && !check.ok ? h('div', { class: 'small', style: { color: 'var(--danger)', maxWidth: '360px' } }, check.message) : null),
          h('td', { class: 'actions' },
            testBtn,
            h('button', { type: 'button', class: 'link-btn', onClick: () => editSite(site) }, '编辑'),
            h('button', { type: 'button', class: 'link-btn danger', onClick: () => deleteSite(site) }, '移除')));
      }))));
  }

  const listCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, '我的站点'), listCount, testSelectedBtn),
    tableWrap);

  clear(el,
    h('div', { class: 'view-head' }, h('h2', null, '站点管理')),
    addCard,
    importCard,
    listCard);

  renderList();
  cleanups.push(subscribe(renderList));

  // Returned from the WordPress authorization page with a new application password.
  if (state.pendingConnect) {
    const pending = state.pendingConnect;
    state.pendingConnect = null;
    url.value = pending.url;
    username.value = pending.username;
    appPassword.value = pending.appPassword;
    addCard.open = true;
    addBtn.click();
  }

  return () => cleanups.forEach((fn) => fn());
}
