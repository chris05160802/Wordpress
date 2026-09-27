import { POST } from '../api.js';
import { h, clear, button, toast, withBusy, confirmDialog, select, spinner } from '../dom.js';
import { subscribe, selectedSites, siteById } from '../store.js';
import { runJob } from '../jobs.js';

const COMMON_TIMEZONES = ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Singapore', 'Asia/Kuala_Lumpur', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Bangkok', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'UTC'];
const WEEKDAYS = [['1', '星期一'], ['0', '星期日'], ['2', '星期二'], ['3', '星期三'], ['4', '星期四'], ['5', '星期五'], ['6', '星期六']];
const OPEN_CLOSED = [['open', '允许'], ['closed', '不允许']];

// Settings exposed by WordPress core through /wp/v2/settings.
const FIELDS = [
  { key: 'title', label: '站点标题', kind: 'text', hint: '注意：所有所选站点会被改成同一个标题' },
  { key: 'description', label: '副标题', kind: 'text' },
  { key: 'timezone', label: '时区', kind: 'timezone' },
  { key: 'date_format', label: '日期格式', kind: 'text', options: ['Y年n月j日', 'Y-m-d', 'Y/m/d', 'm/d/Y', 'd/m/Y', 'F j, Y'], hint: '例如 Y年n月j日 显示为 2025年1月8日' },
  { key: 'time_format', label: '时间格式', kind: 'text', options: ['H:i', 'G:i', 'g:i a', 'g:i A'] },
  { key: 'start_of_week', label: '一周开始于', kind: 'select', options: WEEKDAYS, number: true },
  { key: 'posts_per_page', label: '每页显示文章数', kind: 'number' },
  { key: 'default_comment_status', label: '新文章默认允许评论', kind: 'select', options: OPEN_CLOSED },
  { key: 'default_ping_status', label: '允许 Pingback / Trackback', kind: 'select', options: OPEN_CLOSED },
  { key: 'use_smilies', label: '把表情符号转换为图片', kind: 'bool' },
  { key: 'language', label: '站点语言', kind: 'text', options: ['zh_CN', 'zh_TW', 'zh_HK', 'en_US', 'ja'], hint: '语言代码，例如 zh_CN。网站必须已经安装了该语言包才会生效' },
  { key: 'email', label: '管理员邮箱', kind: 'text' },
];

const SHOWN_COLUMNS = ['title', 'description', 'timezone', 'date_format', 'posts_per_page', 'default_comment_status', 'language', 'email'];

function display(value) {
  if (value === true) return '是';
  if (value === false) return '否';
  if (value === 'open') return '允许';
  if (value === 'closed') return '不允许';
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

export function mount(el) {
  const cleanups = [];
  let current = null;

  // ---- current values --------------------------------------------------------------
  const loadBtn = button('读取所选站点的当前设置', { kind: 'primary', size: 'sm' });
  const currentBody = h('div', { class: 'card-body' }, h('div', { class: 'muted' }, '可以先读取各站点当前的设置，方便对比。'));
  const copyFrom = h('select', { class: 'hidden' });

  async function load() {
    const sites = selectedSites();
    if (!sites.length) return toast('请先在左侧选择站点', 'warn');
    clear(currentBody, spinner('正在读取设置…'));
    await withBusy(loadBtn, async () => {
      try {
        current = await POST('/api/settings/query', { siteIds: sites.map((s) => s.id) });
        renderCurrent();
      } catch (err) {
        clear(currentBody, h('div', { class: 'notice error' }, err.message));
      }
    });
  }
  loadBtn.addEventListener('click', load);

  function renderCurrent() {
    const label = (key) => FIELDS.find((f) => f.key === key)?.label || key;
    clear(currentBody, h('div', { class: 'table-wrap table-scroll' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, '站点'), SHOWN_COLUMNS.map((k) => h('th', null, label(k))))),
      h('tbody', null, current.sites.map((s) => h('tr', null,
        h('td', { class: 'nowrap' }, siteById(s.siteId)?.name || s.siteId),
        s.error
          ? h('td', { colspan: SHOWN_COLUMNS.length, class: 'small', style: { color: 'var(--danger)' } }, s.error)
          : SHOWN_COLUMNS.map((k) => h('td', { class: 'small' }, display(s.settings[k])))))))));
    const usable = current.sites.filter((s) => !s.error);
    clear(copyFrom,
      h('option', { value: '' }, '从某个站点复制当前值到下面的表单…'),
      usable.map((s) => h('option', { value: s.siteId }, siteById(s.siteId)?.name || s.siteId)));
    copyFrom.classList.toggle('hidden', !usable.length);
  }

  // ---- edit form ------------------------------------------------------------------------
  const tzList = h('datalist', { id: 'wpbm-timezones' },
    [...new Set([...COMMON_TIMEZONES, ...(Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [])])].map((tz) => h('option', { value: tz })));
  const controls = new Map();

  function makeControl(f) {
    if (f.kind === 'select') return select(f.options, f.options[0][0]);
    if (f.kind === 'bool') return select([['true', '是'], ['false', '否']], 'true');
    if (f.kind === 'number') return h('input', { type: 'number', min: 1, max: 200, value: 10 });
    if (f.kind === 'timezone') return h('input', { type: 'text', list: 'wpbm-timezones', placeholder: '例如 Asia/Shanghai' });
    const input = h('input', { type: 'text' });
    if (f.options) {
      const id = `opts-${f.key}`;
      input.setAttribute('list', id);
      return h('div', null, input, h('datalist', { id }, f.options.map((o) => h('option', { value: o }))));
    }
    return input;
  }

  const inputOf = (control) => (control.tagName === 'DIV' ? control.querySelector('input') : control);

  const rows = FIELDS.map((f) => {
    const enabled = h('input', { type: 'checkbox', title: '勾选后才会修改这一项' });
    const control = makeControl(f);
    const input = inputOf(control);
    input.addEventListener('input', () => { enabled.checked = true; });
    input.addEventListener('change', () => { enabled.checked = true; });
    controls.set(f.key, { f, enabled, input });
    return h('tr', null,
      h('td', { class: 'check-col' }, enabled),
      h('td', { class: 'nowrap' }, h('b', null, f.label), h('div', { class: 'sub' }, f.key)),
      h('td', null, control, f.hint ? h('div', { class: 'sub' }, f.hint) : null));
  });

  const custom = h('textarea', { rows: 3, class: 'code', placeholder: '{"某个设置项": "值"}' });
  const applyBtn = button('应用到所选站点', { kind: 'primary' });
  const scope = h('span', { class: 'muted small' });
  const renderScope = () => {
    const n = selectedSites().length;
    scope.textContent = n ? `将修改左侧已选的 ${n} 个站点` : '请先在左侧选择站点';
  };
  renderScope();
  cleanups.push(subscribe(renderScope));

  copyFrom.addEventListener('change', () => {
    const src = current?.sites.find((s) => s.siteId === copyFrom.value);
    if (!src) return;
    for (const { f, input } of controls.values()) {
      const v = src.settings[f.key];
      if (v !== undefined && v !== null) input.value = String(v);
    }
    toast(`已填入「${siteById(src.siteId)?.name}」的当前值；勾选需要统一的项目后点击应用`, 'ok', 6000);
    copyFrom.value = '';
  });

  function collect() {
    const settings = {};
    for (const { f, enabled, input } of controls.values()) {
      if (!enabled.checked) continue;
      let v = input.value;
      if (f.kind === 'bool') v = v === 'true';
      else if (f.kind === 'number' || f.number) {
        v = Number(v);
        if (!Number.isInteger(v)) throw new Error(`「${f.label}」需要填写整数`);
      } else v = v.trim();
      if (f.key === 'title' && !v) throw new Error('站点标题不能为空');
      settings[f.key] = v;
    }
    if (custom.value.trim()) {
      let extra;
      try {
        extra = JSON.parse(custom.value);
      } catch {
        throw new Error('其他设置不是有效的 JSON');
      }
      if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('其他设置必须是 JSON 对象，例如 {"key": "value"}');
      Object.assign(settings, extra);
    }
    return settings;
  }

  applyBtn.addEventListener('click', async () => {
    const sites = selectedSites();
    if (!sites.length) return toast('请先在左侧选择站点', 'warn');
    let settings;
    try {
      settings = collect();
    } catch (err) {
      return toast(err.message, 'warn');
    }
    const keys = Object.keys(settings);
    if (!keys.length) return toast('请勾选要修改的设置项', 'warn');
    const ok = await confirmDialog({
      title: '批量修改设置',
      message: `将在 ${sites.length} 个站点上修改以下设置：`,
      details: h('ul', { class: 'small' }, keys.map((k) => h('li', null, `${FIELDS.find((f) => f.key === k)?.label || k}：${display(settings[k])}`))),
      confirmText: '应用',
    });
    if (!ok) return;
    await withBusy(applyBtn, async () => {
      try {
        await runJob({ action: 'settings.update', siteIds: sites.map((s) => s.id), params: { settings } });
        if (current) await load();
      } catch (err) {
        toast(err.message, 'error', 8000);
      }
    });
  });

  clear(el,
    h('div', { class: 'view-head' }, h('h2', null, '网站设置')),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', null, '当前设置'), loadBtn),
      currentBody),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', null, '批量修改'), copyFrom),
      h('div', { class: 'card-body stack' },
        h('div', { class: 'notice info' }, '只有勾选的项目会被修改，没勾选的保持各站点原样。修改输入框时会自动勾选。'),
        h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('tbody', null, rows))),
        h('div', { class: 'field' },
          h('label', null, '其他设置（高级，可选）'),
          custom,
          h('div', { class: 'hint' }, '插件通过 REST API 注册的设置项，可以用 JSON 填写，例如 {"some_option": "value"}。不支持的项目会在结果中提示。'))),
      h('div', { class: 'card-foot' }, applyBtn, scope)),
    tzList);

  return () => cleanups.forEach((fn) => fn());
}
