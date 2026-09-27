import { GET, POST, PUT } from '../api.js';
import {
  h, clear, button, field, toast, withBusy, confirmDialog, openModal, badge, extLink, select, radios, checkbox,
  formatDate, spinner, rangeSelect, readStorage, writeStorage,
} from '../dom.js';
import { subscribe, selectedSites, siteById } from '../store.js';
import { runJob } from '../jobs.js';

const STATUS = {
  publish: ['已发布', 'ok'],
  draft: ['草稿', ''],
  pending: ['待审核', 'warn'],
  private: ['私密', 'info'],
  future: ['定时发布', 'info'],
  trash: ['回收站', 'error'],
};
const FILTER_KEY = 'wpbm.postFilters';

function statusBadge(status) {
  const [text, kind] = STATUS[status] || [status, ''];
  return badge(text, kind);
}

function chips(list) {
  if (!list?.length) return h('span', { class: 'muted' }, '—');
  return h('div', { class: 'chips' }, list.map((t) => h('span', { class: 'chip' }, t)));
}

export function mount(el) {
  const cleanups = [];
  const saved = readStorage(FILTER_KEY, {});
  let items = [];
  let siteResults = [];
  let lastQuery = null;
  let resultType = 'posts';
  let resultStatus = 'any';
  let selected = new Set();

  // ---- filters -----------------------------------------------------------------------
  const type = select([['posts', '文章'], ['pages', '页面']], saved.type || 'posts');
  const status = select([
    ['any', '全部（不含回收站）'], ['publish', '已发布'], ['draft', '草稿'], ['pending', '待审核'],
    ['private', '私密'], ['future', '定时发布'], ['trash', '回收站'],
  ], saved.status || 'any');
  const search = h('input', { type: 'search', placeholder: '标题或正文中的关键词', value: saved.search || '' });
  const category = h('input', { type: 'text', placeholder: '分类名称（可选）', value: saved.category || '' });
  const tag = h('input', { type: 'text', placeholder: '标签名称（可选）', value: saved.tag || '' });
  const after = h('input', { type: 'date', value: saved.after || '' });
  const before = h('input', { type: 'date', value: saved.before || '' });
  const limit = select([['50', '50 篇'], ['100', '100 篇'], ['200', '200 篇'], ['500', '500 篇'], ['1000', '1000 篇'], ['2000', '2000 篇']], saved.limit || '100');
  const queryBtn = button('查询', { kind: 'primary' });
  const scope = h('span', { class: 'muted small' });
  const categoryField = field('分类', category);
  const tagField = field('标签', tag);

  const syncType = () => {
    const isPosts = type.value === 'posts';
    categoryField.classList.toggle('hidden', !isPosts);
    tagField.classList.toggle('hidden', !isPosts);
  };
  type.addEventListener('change', syncType);
  syncType();
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') queryBtn.click();
  });

  const renderScope = () => {
    const n = selectedSites().length;
    scope.textContent = n ? `将查询左侧已选的 ${n} 个站点` : '请先在左侧选择站点';
  };
  renderScope();
  cleanups.push(subscribe(renderScope));

  const filterCard = h('div', { class: 'card' }, h('div', { class: 'card-body stack' },
    h('div', { class: 'grid cols-4' },
      field('类型', type), field('状态', status), field('关键词', search), field('每个站点最多读取', limit),
      categoryField, tagField, field('发布日期从', after), field('发布日期到', before)),
    h('div', { class: 'row' }, queryBtn, scope)));

  // ---- results -----------------------------------------------------------------------
  const summary = h('div');
  const batchBar = h('div', { class: 'batch-bar hidden' });
  const tableCard = h('div', { class: 'card hidden' });

  async function runQuery({ quiet = false } = {}) {
    const sites = selectedSites();
    if (!quiet && !sites.length) return toast('请先在左侧选择站点', 'warn');
    const body = quiet && lastQuery ? lastQuery : {
      siteIds: sites.map((s) => s.id),
      type: type.value,
      status: status.value,
      search: search.value.trim(),
      category: type.value === 'posts' ? category.value.trim() : '',
      tag: type.value === 'posts' ? tag.value.trim() : '',
      after: after.value,
      before: before.value,
      limit: Number(limit.value),
    };
    if (!quiet) {
      writeStorage(FILTER_KEY, { type: body.type, status: body.status, search: body.search, category: body.category, tag: body.tag, after: body.after, before: body.before, limit: String(body.limit) });
      tableCard.classList.remove('hidden');
      clear(tableCard, spinner(`正在从 ${sites.length} 个站点读取内容…`));
      clear(summary);
      batchBar.classList.add('hidden');
    }
    lastQuery = body;
    await withBusy(queryBtn, async () => {
      try {
        const res = await POST('/api/posts/query', body);
        items = res.items;
        siteResults = res.sites;
        resultType = res.type;
        resultStatus = body.status;
        const keys = new Set(items.map((p) => `${p.siteId}:${p.id}`));
        selected = new Set([...selected].filter((k) => keys.has(k)));
        render();
      } catch (err) {
        clear(tableCard, h('div', { class: 'empty' }, err.message));
        toast(err.message, 'error');
      }
    });
  }
  queryBtn.addEventListener('click', () => {
    selected.clear();
    runQuery();
  });

  function selectedTargets() {
    return items.filter((p) => selected.has(`${p.siteId}:${p.id}`)).map((p) => ({ siteId: p.siteId, id: p.id, title: p.title }));
  }

  function renderSummary() {
    const total = siteResults.reduce((n, s) => n + (s.total || 0), 0);
    const failed = siteResults.filter((s) => s.error);
    clear(summary, h('div', { class: 'stack' },
      h('div', { class: 'row' },
        h('b', null, `共读取 ${items.length} 条`),
        h('span', { class: 'muted small' }, `（所选站点共有 ${total} 条符合条件）`),
        h('span', { class: 'chips' }, siteResults.filter((s) => !s.error).map((s) => h('span', { class: 'chip' },
          `${siteById(s.siteId)?.name || s.siteId}：${s.count}${s.total > s.count ? ` / ${s.total}` : ''}${s.note ? `（${s.note}）` : ''}`)))),
      failed.length ? h('div', { class: 'notice error' }, failed.map((s) => h('div', null, `${siteById(s.siteId)?.name || s.siteId}：${s.error}`))) : null,
      items.length && siteResults.some((s) => s.total > s.count)
        ? h('div', { class: 'muted small' }, '提示：有站点的内容没有全部读取，可以调大"每个站点最多读取"，或用关键词、日期缩小范围。')
        : null));
  }

  function renderBatchBar() {
    const n = selected.size;
    batchBar.classList.toggle('hidden', n === 0);
    if (!n) return;
    const isTrash = resultStatus === 'trash';
    const isPosts = resultType === 'posts';
    clear(batchBar,
      h('span', { class: 'count' }, `已选 ${n} 条`),
      isTrash
        ? [
          button('恢复为草稿', { size: 'sm', onClick: restorePosts }),
          button('永久删除', { size: 'sm', kind: 'danger', onClick: deletePosts }),
        ]
        : [
          button('修改状态', { size: 'sm', onClick: statusModal }),
          isPosts ? button('分类', { size: 'sm', onClick: () => termsModal('categories') }) : null,
          isPosts ? button('标签', { size: 'sm', onClick: () => termsModal('tags') }) : null,
          button('评论开关', { size: 'sm', onClick: commentModal }),
          isPosts ? button('置顶', { size: 'sm', onClick: stickyModal }) : null,
          button('查找替换', { size: 'sm', onClick: replaceModal }),
          button('移到回收站', { size: 'sm', kind: 'danger', onClick: trashPosts }),
          button('永久删除', { size: 'sm', kind: 'danger', onClick: deletePosts }),
        ],
      h('span', { class: 'spacer' }),
      button('取消选择', {
        size: 'sm',
        kind: 'ghost',
        onClick: () => {
          selected.clear();
          render();
        },
      }));
  }

  function render() {
    renderSummary();
    tableCard.classList.remove('hidden');
    if (!items.length) {
      clear(tableCard, h('div', { class: 'empty' }, '没有找到符合条件的内容'));
      renderBatchBar();
      return;
    }
    const isPosts = resultType === 'posts';
    const boxes = [];
    const rows = items.map((p) => {
      const key = `${p.siteId}:${p.id}`;
      const box = h('input', { type: 'checkbox', checked: selected.has(key), dataset: { key } });
      boxes.push(box);
      const site = siteById(p.siteId);
      return h('tr', { class: selected.has(key) ? 'selected' : '', dataset: { key } },
        h('td', { class: 'check-col' }, box),
        h('td', { class: 'title-cell' },
          h('div', { class: 't' }, extLink(p.link, p.title || '（无标题）'), p.sticky ? [' ', badge('置顶', 'info')] : null),
          p.slug ? h('div', { class: 'sub' }, `/${p.slug}`) : null),
        h('td', { class: 'nowrap' }, site?.name || p.siteId),
        h('td', null, statusBadge(p.status)),
        isPosts ? h('td', null, chips(p.categories)) : null,
        isPosts ? h('td', null, chips(p.tags)) : null,
        h('td', { class: 'nowrap small' }, formatDate(p.date), p.author ? h('div', { class: 'sub' }, p.author) : null),
        h('td', { class: 'actions' }, h('button', { type: 'button', class: 'link-btn', onClick: () => editPost(p) }, '编辑')));
    });
    const all = h('input', { type: 'checkbox', title: '全选' });
    const sync = () => {
      selected = new Set(boxes.filter((b) => b.checked).map((b) => b.dataset.key));
      for (const b of boxes) b.closest('tr').classList.toggle('selected', b.checked);
      all.checked = selected.size === boxes.length;
      all.indeterminate = selected.size > 0 && selected.size < boxes.length;
      renderBatchBar();
    };
    all.addEventListener('change', () => {
      for (const b of boxes) b.checked = all.checked;
      sync();
    });
    rangeSelect(boxes, sync);
    clear(tableCard, h('div', { class: 'table-wrap table-scroll' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null,
        h('th', { class: 'check-col' }, all),
        h('th', null, '标题'),
        h('th', null, '站点'),
        h('th', null, '状态'),
        isPosts ? h('th', null, '分类') : null,
        isPosts ? h('th', null, '标签') : null,
        h('th', null, '日期'),
        h('th', null, ''))),
      h('tbody', null, rows))),
    h('div', { class: 'card-foot muted small' }, '提示：按住 Shift 键点击复选框，可以一次选中一个范围。'));
    sync();
  }

  // ---- batch actions -----------------------------------------------------------------

  async function run(action, params = {}, { refresh = true } = {}) {
    const targets = selectedTargets();
    if (!targets.length) return null;
    try {
      const job = await runJob({ action, type: resultType, targets, params });
      if (refresh) {
        // Start the next action from a clean selection, so a later (possibly destructive)
        // action can't silently apply to items picked for an earlier one.
        selected.clear();
        await runQuery({ quiet: true });
      }
      return job;
    } catch (err) {
      toast(err.message, 'error', 8000);
      return null;
    }
  }

  function actionModal(title, body, onApply, applyText = '应用') {
    const ok = button(applyText, { kind: 'primary' });
    const m = openModal({ title, body, footer: [button('取消', { onClick: () => m.close() }), ok] });
    ok.addEventListener('click', () => {
      if (onApply() !== false) m.close();
    });
    return m;
  }

  function statusModal() {
    const r = radios('post-status', [['publish', '发布'], ['draft', '草稿'], ['pending', '待审核'], ['private', '私密']], 'draft');
    actionModal(`修改状态（${selected.size} 条）`, [h('p', null, '把所选内容的状态改为：'), r.el], () => {
      run('posts.update', { status: r.get() });
    });
  }

  function termsModal(taxonomy) {
    const label = taxonomy === 'categories' ? '分类' : '标签';
    const known = [...new Set(items.flatMap((p) => p[taxonomy] || []))].filter((t) => !t.startsWith('#'));
    const listId = `known-${taxonomy}`;
    const mode = radios(`${taxonomy}-mode`, [['add', `添加${label}（保留原有的）`], ['set', `替换${label}（去掉原有的）`], ['remove', `移除${label}`]], 'add');
    const names = h('input', { type: 'text', list: listId, placeholder: `${label}名称，多个用逗号分隔` });
    const create = checkbox(`${label}不存在时自动创建`, { checked: true });
    const syncMode = () => create.el.classList.toggle('hidden', mode.get() === 'remove');
    mode.inputs.forEach((i) => i.addEventListener('change', syncMode));
    actionModal(`批量设置${label}（${selected.size} 条）`, [
      mode.el,
      field(`${label}名称`, h('div', null, names, h('datalist', { id: listId }, known.map((k) => h('option', { value: k })))),
        '按名称匹配，每个站点会分别找到（或创建）同名的' + label),
      create.el,
    ], () => {
      if (!names.value.trim() && mode.get() !== 'set') {
        toast(`请填写${label}名称`, 'warn');
        return false;
      }
      run('posts.update', { [taxonomy]: { mode: mode.get(), names: names.value, createMissing: create.input.checked } });
      return true;
    });
  }

  function commentModal() {
    const r = radios('comment', [['open', '允许评论'], ['closed', '关闭评论']], 'closed');
    actionModal(`评论开关（${selected.size} 条）`, [r.el], () => {
      run('posts.update', { commentStatus: r.get() });
    });
  }

  function stickyModal() {
    const r = radios('sticky', [['yes', '置顶'], ['no', '取消置顶']], 'yes');
    actionModal(`置顶（${selected.size} 条）`, [r.el], () => {
      run('posts.update', { sticky: r.get() === 'yes' });
    });
  }

  function replaceModal() {
    const find = h('textarea', { rows: 2, placeholder: '要查找的文字' });
    const replace = h('textarea', { rows: 2, placeholder: '替换成（留空表示删除找到的文字）' });
    const fTitle = checkbox('标题', { checked: true });
    const fContent = checkbox('正文', { checked: true });
    const fExcerpt = checkbox('摘要');
    const caseSensitive = checkbox('区分大小写', { checked: true });
    const regex = checkbox('使用正则表达式（高级）');
    const params = () => ({
      find: find.value,
      replace: replace.value,
      fields: [fTitle.input.checked && 'title', fContent.input.checked && 'content', fExcerpt.input.checked && 'excerpt'].filter(Boolean),
      caseSensitive: caseSensitive.input.checked,
      regex: regex.input.checked,
    });
    const check = () => {
      if (!find.value) {
        toast('请填写要查找的文字', 'warn');
        return false;
      }
      if (!params().fields.length) {
        toast('请至少选择一个替换位置', 'warn');
        return false;
      }
      return true;
    };
    const previewBtn = button('预览（不修改）');
    const applyBtn = button('开始替换', { kind: 'primary' });
    const m = openModal({
      title: `查找替换（${selected.size} 条）`,
      body: [
        field('查找', find),
        field('替换为', replace),
        h('div', { class: 'field' }, h('span', { class: 'label' }, '替换位置'), h('div', { class: 'row' }, fTitle.el, fContent.el, fExcerpt.el)),
        h('div', { class: 'row' }, caseSensitive.el, regex.el),
        h('div', { class: 'notice' }, '建议先点「预览」，看看每篇文章能匹配到几处，确认无误再替换。替换直接修改文章原文（包括 HTML 代码），请谨慎操作。'),
      ],
      footer: [button('取消', { onClick: () => m.close() }), previewBtn, applyBtn],
    });
    previewBtn.addEventListener('click', () => {
      if (check()) run('posts.replace', { ...params(), dryRun: true }, { refresh: false });
    });
    applyBtn.addEventListener('click', async () => {
      if (!check()) return;
      const ok = await confirmDialog({
        title: '确认替换',
        message: `将在 ${selected.size} 条内容中，把「${find.value}」替换为「${replace.value || '（空）'}」。确定吗？`,
        confirmText: '开始替换',
      });
      if (!ok) return;
      m.close();
      run('posts.replace', params());
    });
  }

  async function trashPosts() {
    const ok = await confirmDialog({
      title: '移到回收站',
      message: `将所选的 ${selected.size} 条内容移到各自网站的回收站。之后可以在"状态：回收站"中恢复。`,
      confirmText: '移到回收站',
      danger: true,
    });
    if (ok) run('posts.trash');
  }

  async function deletePosts() {
    const ok = await confirmDialog({
      title: '永久删除',
      message: `将永久删除所选的 ${selected.size} 条内容，删除后无法恢复！`,
      confirmText: '永久删除',
      danger: true,
      requireText: '删除',
    });
    if (ok) run('posts.delete');
  }

  async function restorePosts() {
    const ok = await confirmDialog({ title: '恢复', message: `把所选的 ${selected.size} 条内容从回收站恢复为草稿？`, confirmText: '恢复' });
    if (ok) run('posts.restore');
  }

  // ---- single post editing -------------------------------------------------------------

  function editPost(item) {
    const site = siteById(item.siteId);
    const typeParam = `type=${resultType}`;
    const save = button('保存', { kind: 'primary', disabled: true });
    const adminLink = site ? extLink(`${site.adminUrl || `${site.url}/wp-admin/`}post.php?post=${item.id}&action=edit`, '在 WordPress 后台编辑 ↗', { class: 'btn' }) : null;
    const m = openModal({
      title: `编辑：${item.title || '（无标题）'}`,
      wide: true,
      body: [spinner()],
      footer: [adminLink, h('span', { class: 'spacer' }), button('取消', { onClick: () => m.close() }), save],
    });
    GET(`/api/sites/${item.siteId}/posts/${item.id}?${typeParam}`).then((post) => {
      const f = {
        title: h('input', { type: 'text', value: post.title }),
        status: select([['publish', '已发布'], ['draft', '草稿'], ['pending', '待审核'], ['private', '私密'],
          ...(['future', 'trash'].includes(post.status) ? [[post.status, STATUS[post.status][0]]] : [])], post.status),
        slug: h('input', { type: 'text', value: post.slug }),
        commentStatus: select([['open', '允许评论'], ['closed', '关闭评论']], post.commentStatus),
        excerpt: h('textarea', { rows: 3 }),
        content: h('textarea', { rows: 16, class: 'code' }),
      };
      f.excerpt.value = post.excerpt;
      f.content.value = post.content;
      clear(m.body,
        h('div', { class: 'muted small' }, `站点：${site?.name || item.siteId} · ID ${post.id} · ${formatDate(post.date)}`),
        field('标题', f.title),
        h('div', { class: 'grid cols-3' }, field('状态', f.status), field('别名（网址）', f.slug), field('评论', f.commentStatus)),
        field('摘要', f.excerpt),
        field('正文（HTML / 区块代码）', f.content));
      save.disabled = false;
      save.addEventListener('click', () => withBusy(save, async () => {
        const body = {};
        for (const key of Object.keys(f)) if (f[key].value !== post[key]) body[key] = f[key].value;
        if (!Object.keys(body).length) {
          m.close();
          return;
        }
        try {
          const updated = await PUT(`/api/sites/${item.siteId}/posts/${item.id}?${typeParam}`, body);
          Object.assign(item, { title: updated.title, status: updated.status, slug: updated.slug });
          toast('已保存', 'ok');
          m.close();
          render();
        } catch (err) {
          toast(err.message, 'error', 8000);
        }
      }));
    }).catch((err) => {
      clear(m.body, h('div', { class: 'notice error' }, err.message));
    });
  }

  clear(el,
    h('div', { class: 'view-head' }, h('h2', null, '文章管理'), h('span', { class: 'muted small' }, '跨站点查询文章/页面，勾选后批量修改或删除')),
    filterCard,
    summary,
    batchBar,
    tableCard);

  return () => cleanups.forEach((fn) => fn());
}
