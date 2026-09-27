import { POST } from '../api.js';
import { h, clear, button, field, toast, withBusy, confirmDialog, radios, spinner, rangeSelect } from '../dom.js';
import { subscribe, selectedSites, siteById } from '../store.js';
import { runJob } from '../jobs.js';

export function mount(el) {
  const cleanups = [];
  let loaded = null;
  let chosen = new Set();

  const taxonomy = radios('taxonomy', [['categories', '分类目录'], ['tags', '标签']], 'categories');
  const label = () => (taxonomy.get() === 'tags' ? '标签' : '分类');
  const scope = h('span', { class: 'muted small' });
  const renderScope = () => {
    const n = selectedSites().length;
    scope.textContent = n ? `操作对象：左侧已选的 ${n} 个站点` : '请先在左侧选择站点';
  };
  renderScope();
  cleanups.push(subscribe(renderScope));

  // ---- create ----------------------------------------------------------------------------
  const names = h('textarea', { rows: 4, placeholder: '每行一个，或用逗号分隔，例如：\n国内新闻\n国际新闻\n科技' });
  const createBtn = button('在所选站点创建', { kind: 'primary' });
  createBtn.addEventListener('click', async () => {
    const sites = selectedSites();
    if (!sites.length) return toast('请先在左侧选择站点', 'warn');
    if (!names.value.trim()) return toast(`请填写${label()}名称`, 'warn');
    await withBusy(createBtn, async () => {
      try {
        await runJob({ action: 'terms.create', siteIds: sites.map((s) => s.id), params: { taxonomy: taxonomy.get(), names: names.value } });
        names.value = '';
        if (loaded) await load();
      } catch (err) {
        toast(err.message, 'error', 8000);
      }
    });
  });

  // ---- existing ----------------------------------------------------------------------------
  const loadBtn = button('读取', { kind: 'primary', size: 'sm' });
  const listBody = h('div', { class: 'card-body' }, h('div', { class: 'muted' }, '读取所选站点现有的分类或标签，可以看到每个名称在哪些站点存在，并批量删除。'));
  const batchBar = h('div', { class: 'batch-bar hidden' });

  async function load() {
    const sites = selectedSites();
    if (!sites.length) return toast('请先在左侧选择站点', 'warn');
    clear(listBody, spinner());
    await withBusy(loadBtn, async () => {
      try {
        loaded = await POST('/api/terms/query', { siteIds: sites.map((s) => s.id), taxonomy: taxonomy.get() });
        chosen = new Set();
        render();
      } catch (err) {
        clear(listBody, h('div', { class: 'notice error' }, err.message));
      }
    });
  }
  loadBtn.addEventListener('click', load);
  taxonomy.inputs.forEach((i) => i.addEventListener('change', () => {
    loaded = null;
    chosen = new Set();
    batchBar.classList.add('hidden');
    clear(listBody, h('div', { class: 'muted' }, `点击「读取」查看所选站点的${label()}。`));
  }));

  async function removeChosen() {
    const list = [...chosen];
    const siteIds = loaded.sites.filter((s) => !s.error).map((s) => s.siteId);
    const ok = await confirmDialog({
      title: `删除${label()}`,
      message: `从 ${siteIds.length} 个站点删除${label()}：${list.join('、')}？`,
      details: h('div', { class: 'notice warn' }, loaded.taxonomy === 'categories'
        ? '删除分类不会删除文章，文章会自动归入网站的默认分类。'
        : '删除标签不会删除文章，只是文章上不再有这个标签。'),
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await runJob({ action: 'terms.delete', siteIds, params: { taxonomy: loaded.taxonomy, names: list } });
      await load();
    } catch (err) {
      toast(err.message, 'error', 8000);
    }
  }

  function render() {
    const okSites = loaded.sites.filter((s) => !s.error);
    const failed = loaded.sites.filter((s) => s.error);
    const boxes = [];
    const rows = loaded.terms.map((t) => {
      const box = h('input', { type: 'checkbox', dataset: { name: t.name } });
      boxes.push(box);
      const present = okSites.filter((s) => t.sites[s.siteId]);
      const posts = present.reduce((n, s) => n + (t.sites[s.siteId].count || 0), 0);
      return h('tr', null,
        h('td', { class: 'check-col' }, box),
        h('td', null, h('b', null, t.name)),
        h('td', { class: 'nowrap' }, `${present.length}/${okSites.length} 个站点`, h('div', { class: 'sub' }, `共 ${posts} 篇文章`)),
        h('td', null, h('div', { class: 'chips' }, present.map((s) => h('span', { class: 'chip' }, `${siteById(s.siteId)?.name || '?'}：${t.sites[s.siteId].count}`)))));
    });
    const all = h('input', { type: 'checkbox', title: '全选' });
    const sync = () => {
      chosen = new Set(boxes.filter((b) => b.checked).map((b) => b.dataset.name));
      for (const b of boxes) b.closest('tr').classList.toggle('selected', b.checked);
      all.checked = boxes.length > 0 && chosen.size === boxes.length;
      all.indeterminate = chosen.size > 0 && chosen.size < boxes.length;
      batchBar.classList.toggle('hidden', chosen.size === 0);
      clear(batchBar,
        h('span', { class: 'count' }, `已选 ${chosen.size} 个${label()}`),
        button('从这些站点删除', { size: 'sm', kind: 'danger', onClick: removeChosen }));
    };
    all.addEventListener('change', () => {
      for (const b of boxes) b.checked = all.checked;
      sync();
    });
    rangeSelect(boxes, sync);
    const truncated = okSites.some((s) => s.total > s.count);
    clear(listBody,
      failed.length ? h('div', { class: 'notice error' }, failed.map((s) => h('div', null, `${siteById(s.siteId)?.name || s.siteId}：${s.error}`))) : null,
      truncated ? h('div', { class: 'muted small' }, '提示：数量太多时每个站点只读取使用最多的 1000 个。') : null,
      loaded.terms.length
        ? h('div', { class: 'table-wrap table-scroll' }, h('table', { class: 'table' },
          h('thead', null, h('tr', null, h('th', { class: 'check-col' }, all), h('th', null, '名称'), h('th', null, '分布'), h('th', null, '各站点文章数'))),
          h('tbody', null, rows)))
        : h('div', { class: 'empty' }, `没有${label()}`));
    sync();
  }

  clear(el,
    h('div', { class: 'view-head' }, h('h2', null, '分类标签'), taxonomy.el),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', null, '批量创建'), scope),
      h('div', { class: 'card-body stack' },
        field('名称', names, '已经存在的会自动跳过'),
        h('div', { class: 'row' }, createBtn))),
    batchBar,
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', null, '现有的分类 / 标签'), loadBtn),
      listBody));

  return () => cleanups.forEach((fn) => fn());
}
