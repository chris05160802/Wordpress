import { GET, POST } from '../api.js';
import { h, clear, button, field, toast, withBusy, confirmDialog, checkbox, spinner, extLink, safeUrl, rangeSelect } from '../dom.js';
import { subscribe, selectedSites, siteById } from '../store.js';
import { runJob } from '../jobs.js';

function installs(n) {
  if (!n) return '少于 10';
  if (n >= 10000) return `${n / 10000} 万+`;
  return `${n}+`;
}

export function mount(el) {
  const cleanups = [];
  let loaded = null; // { plugins, sites } from /api/plugins/query
  let selectedPlugins = new Set();

  // ---- install -------------------------------------------------------------------------
  const search = h('input', { type: 'search', placeholder: '搜索 WordPress.org 插件，例如：SEO、缓存、表单、安全' });
  const searchBtn = button('搜索', { kind: 'primary' });
  const slugInput = h('input', { type: 'text', placeholder: '插件英文名称（slug），多个用逗号分隔，例如：wordpress-seo, wp-super-cache', spellcheck: 'false' });
  const slugBtn = button('安装到所选站点', { kind: 'primary' });
  const activate = checkbox('安装后立即启用', { checked: true });
  const searchResults = h('div');
  const scope = h('span', { class: 'muted small' });

  const renderScope = () => {
    const n = selectedSites().length;
    scope.textContent = n ? `操作对象：左侧已选的 ${n} 个站点` : '请先在左侧选择站点';
  };
  renderScope();
  cleanups.push(subscribe(renderScope));

  async function install(slugs, btn) {
    const sites = selectedSites();
    if (!sites.length) return toast('请先在左侧选择站点', 'warn');
    const ok = await confirmDialog({
      title: '安装插件',
      message: `在 ${sites.length} 个站点上安装：${slugs.join('、')}${activate.input.checked ? '，并立即启用' : ''}？`,
      confirmText: '开始安装',
    });
    if (!ok) return;
    await withBusy(btn, async () => {
      try {
        await runJob({ action: 'plugins.install', siteIds: sites.map((s) => s.id), params: { slugs, activate: activate.input.checked } });
        if (loaded) await loadInstalled();
      } catch (err) {
        toast(err.message, 'error', 8000);
      }
    });
  }

  slugBtn.addEventListener('click', () => {
    const slugs = slugInput.value.split(/[,，\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!slugs.length) return toast('请填写插件英文名称', 'warn');
    install(slugs, slugBtn);
  });

  async function doSearch() {
    clear(searchResults, spinner('正在搜索 WordPress.org…'));
    try {
      const res = await GET(`/api/wporg/plugins?search=${encodeURIComponent(search.value.trim())}`);
      if (!res.plugins.length) return clear(searchResults, h('div', { class: 'empty' }, '没有找到插件'));
      clear(searchResults, h('div', { class: 'plugin-grid' }, res.plugins.map((p) => {
        const btn = button('安装', { size: 'sm', kind: 'primary' });
        btn.addEventListener('click', () => install([p.slug], btn));
        const icon = safeUrl(p.icon);
        return h('div', { class: 'plugin-card' },
          icon ? h('img', { src: icon, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('div', { class: 'ph' }),
          h('div', { class: 'body' },
            h('div', { class: 'name' }, extLink(`https://wordpress.org/plugins/${encodeURIComponent(p.slug)}/`, p.name)),
            h('div', { class: 'muted small' }, `${p.slug} · v${p.version || '?'} · ${installs(p.activeInstalls)} 次安装${p.rating ? ` · 评分 ${(p.rating / 20).toFixed(1)}` : ''}`),
            h('div', { class: 'desc' }, p.shortDescription),
            h('div', { class: 'row' }, btn)));
      })));
    } catch (err) {
      clear(searchResults, h('div', { class: 'notice error' }, err.message));
    }
  }
  searchBtn.addEventListener('click', () => withBusy(searchBtn, doSearch));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchBtn.click();
  });

  const installCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, '安装新插件'), scope),
    h('div', { class: 'card-body stack' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, search), searchBtn, activate.el),
      searchResults,
      field('直接按名称安装', h('div', { class: 'row' }, h('div', { class: 'grow' }, slugInput), slugBtn),
        '名称就是 WordPress.org 插件网址中的那一段，例如 wordpress.org/plugins/wordpress-seo/ 的名称是 wordpress-seo'),
      h('div', { class: 'notice' }, 'WordPress 官方接口只支持从 WordPress.org 插件目录安装插件。付费插件或 zip 安装包需要在各网站后台上传；插件升级也需要在后台进行（或开启自动更新）。')));

  // ---- installed -------------------------------------------------------------------------
  const loadBtn = button('读取所选站点的插件', { kind: 'primary', size: 'sm' });
  const installedBody = h('div', { class: 'card-body stack' }, h('div', { class: 'muted' }, '点击右上角按钮，读取左侧已选站点上安装的所有插件。'));
  const batchBar = h('div', { class: 'batch-bar hidden' });

  async function loadInstalled() {
    const sites = selectedSites();
    if (!sites.length) return toast('请先在左侧选择站点', 'warn');
    clear(installedBody, spinner('正在读取插件列表…'));
    await withBusy(loadBtn, async () => {
      try {
        loaded = await POST('/api/plugins/query', { siteIds: sites.map((s) => s.id) });
        const ids = new Set(loaded.plugins.map((p) => p.plugin));
        selectedPlugins = new Set([...selectedPlugins].filter((p) => ids.has(p)));
        renderInstalled();
      } catch (err) {
        clear(installedBody, h('div', { class: 'notice error' }, err.message));
      }
    });
  }
  loadBtn.addEventListener('click', loadInstalled);

  async function pluginAction(action, verb, danger = false) {
    const plugins = [...selectedPlugins];
    const siteIds = loaded.sites.filter((s) => !s.error).map((s) => s.siteId);
    const names = plugins.map((id) => loaded.plugins.find((p) => p.plugin === id)?.name || id);
    const ok = await confirmDialog({
      title: `${verb}插件`,
      message: `在 ${siteIds.length} 个站点上${verb}：${names.join('、')}？`,
      details: action === 'plugins.delete'
        ? h('div', { class: 'notice warn' }, '删除会同时删除插件文件；很多插件在删除时还会清除自己的设置和数据。启用中的插件会先被停用再删除。')
        : null,
      confirmText: verb,
      danger,
      requireText: action === 'plugins.delete' ? '删除' : null,
    });
    if (!ok) return;
    try {
      await runJob({ action, siteIds, params: { plugins } });
      selectedPlugins = new Set();
      await loadInstalled();
    } catch (err) {
      toast(err.message, 'error', 8000);
    }
  }

  function renderBatchBar() {
    batchBar.classList.toggle('hidden', selectedPlugins.size === 0);
    clear(batchBar,
      h('span', { class: 'count' }, `已选 ${selectedPlugins.size} 个插件`),
      button('启用', { size: 'sm', onClick: () => pluginAction('plugins.activate', '启用') }),
      button('停用', { size: 'sm', onClick: () => pluginAction('plugins.deactivate', '停用') }),
      button('删除', { size: 'sm', kind: 'danger', onClick: () => pluginAction('plugins.delete', '删除', true) }),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted small' }, '操作会作用于下表中读取成功的所有站点'));
  }

  function renderInstalled() {
    const okSites = loaded.sites.filter((s) => !s.error);
    const failed = loaded.sites.filter((s) => s.error);
    const boxes = [];
    const rows = loaded.plugins.map((p) => {
      const states = okSites.map((s) => ({ site: siteById(s.siteId), info: p.sites[s.siteId] }));
      const installed = states.filter((x) => x.info).length;
      const active = states.filter((x) => x.info && x.info.status !== 'inactive').length;
      const versions = [...new Set(states.filter((x) => x.info).map((x) => x.info.version))];
      const box = h('input', { type: 'checkbox', checked: selectedPlugins.has(p.plugin), dataset: { id: p.plugin } });
      boxes.push(box);
      return h('tr', { class: selectedPlugins.has(p.plugin) ? 'selected' : '' },
        h('td', { class: 'check-col' }, box),
        h('td', { class: 'title-cell' }, h('div', { class: 't' }, p.name), h('div', { class: 'sub' }, p.plugin), p.description ? h('div', { class: 'sub' }, p.description.slice(0, 120)) : null),
        h('td', { class: 'nowrap' },
          h('div', null, `已安装 ${installed}/${okSites.length}`),
          h('div', { class: 'sub' }, `启用 ${active} · 停用 ${installed - active}`)),
        h('td', { class: 'nowrap' }, versions.join(' / ')),
        h('td', null, h('div', { class: 'chips' }, states.map(({ site, info }) => h('span', {
          class: 'chip',
          title: info ? `版本 ${info.version}` : '未安装',
          style: info ? (info.status === 'inactive' ? {} : { color: 'var(--ok)' }) : { opacity: '0.5', textDecoration: 'line-through' },
        }, `${site?.name || '?'}：${info ? (info.status === 'inactive' ? '停用' : '启用') : '未安装'}`)))));
    });
    const all = h('input', { type: 'checkbox', title: '全选' });
    const sync = () => {
      selectedPlugins = new Set(boxes.filter((b) => b.checked).map((b) => b.dataset.id));
      for (const b of boxes) b.closest('tr').classList.toggle('selected', b.checked);
      all.checked = boxes.length > 0 && selectedPlugins.size === boxes.length;
      all.indeterminate = selectedPlugins.size > 0 && selectedPlugins.size < boxes.length;
      renderBatchBar();
    };
    all.addEventListener('change', () => {
      for (const b of boxes) b.checked = all.checked;
      sync();
    });
    rangeSelect(boxes, sync);
    clear(installedBody,
      failed.length ? h('div', { class: 'notice error' }, failed.map((s) => h('div', null, `${siteById(s.siteId)?.name || s.siteId}：${s.error}`))) : null,
      loaded.plugins.length
        ? h('div', { class: 'table-wrap table-scroll' }, h('table', { class: 'table' },
          h('thead', null, h('tr', null, h('th', { class: 'check-col' }, all), h('th', null, '插件'), h('th', null, '安装情况'), h('th', null, '版本'), h('th', null, '各站点状态'))),
          h('tbody', null, rows)))
        : h('div', { class: 'empty' }, '没有读取到插件'));
    sync();
  }

  clear(el,
    h('div', { class: 'view-head' }, h('h2', null, '插件管理')),
    installCard,
    batchBar,
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', null, '已安装的插件'), loadBtn),
      installedBody));

  return () => cleanups.forEach((fn) => fn());
}
