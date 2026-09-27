// Tiny DOM helpers. Everything coming from WordPress sites is inserted as text,
// never as HTML, so a malicious post title can't run script in the console.

const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'indeterminate', 'hidden', 'multiple', 'readOnly', 'required', 'open']);

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (PROPS.has(key)) el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

/** Only http(s) links from remote data are rendered as links. */
export function safeUrl(url) {
  try {
    const u = new URL(url, location.href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function extLink(url, text, props = {}) {
  const href = safeUrl(url);
  if (!href) return h('span', null, text);
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer', ...props }, text);
}

export function button(text, { kind = '', size = '', onClick, disabled, title, type = 'button' } = {}) {
  return h('button', { type, class: ['btn', kind, size].filter(Boolean).join(' '), onClick, disabled, title }, text);
}

/** Disables a button and shows a spinner while fn runs. */
export async function withBusy(btn, fn) {
  const original = [...btn.childNodes];
  btn.disabled = true;
  btn.replaceChildren(h('span', { class: 'spin' }), ...original.map((n) => n.cloneNode(true)));
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.replaceChildren(...original);
  }
}

export function field(label, control, hint) {
  return h('div', { class: 'field' },
    h('label', null, label),
    control,
    hint ? h('div', { class: 'hint' }, hint) : null);
}

export function checkbox(label, props = {}) {
  const input = h('input', { type: 'checkbox', ...props });
  return { el: h('label', { class: 'check' }, input, label), input };
}

export function select(options, value, props = {}) {
  return h('select', props, options.map(([v, text]) => h('option', { value: v, selected: v === value }, text)));
}

/** Radio group: returns { el, get() }. */
export function radios(name, options, value) {
  const inputs = [];
  const el = h('div', { class: 'radio-group' }, options.map(([v, text]) => {
    const input = h('input', { type: 'radio', name, value: v, checked: v === value });
    inputs.push(input);
    return h('label', { class: 'check' }, input, text);
  }));
  return { el, get: () => inputs.find((i) => i.checked)?.value, inputs };
}

export function badge(text, kind = '') {
  return h('span', { class: `badge ${kind}` }, text);
}

export function spinner(text = '加载中…') {
  return h('div', { class: 'loading-row' }, h('span', { class: 'spin' }), text);
}

export function toast(message, type = 'info', timeout = 4000) {
  const box = document.getElementById('toasts');
  const el = h('div', { class: `toast ${type}` }, message);
  box.appendChild(el);
  setTimeout(() => el.remove(), timeout);
}

export function pad(n) {
  return String(n).padStart(2, '0');
}

/** "2026-09-28T01:16:16" (WordPress site time) or an ISO timestamp -> "2026-09-28 01:16". */
export function formatDate(value) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return value.slice(0, 16).replace('T', ' ');
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function timeAgo(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return formatDate(iso);
}

let modalDepth = 0;

/**
 * Opens a modal. body/footer are nodes (or arrays). Returns { el, body, foot, close }.
 * onClose runs whenever it closes (button, Esc, backdrop).
 */
export function openModal({ title, body, footer, wide = false, onClose, dismissible = true }) {
  const bodyEl = h('div', { class: 'modal-body' }, body);
  const footEl = footer ? h('div', { class: 'modal-foot' }, footer) : null;
  const closeBtn = h('button', { type: 'button', class: 'modal-close', title: '关闭', 'aria-label': '关闭' }, '×');
  const modal = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-head' }, h('h3', null, title), closeBtn),
    bodyEl,
    footEl);
  const backdrop = h('div', { class: 'modal-backdrop' }, modal);
  let closed = false;
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissible && backdrop.dataset.depth === String(modalDepth)) close();
  };
  function close() {
    if (closed) return;
    closed = true;
    modalDepth--;
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  }
  closeBtn.addEventListener('click', () => dismissible && close());
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop && dismissible) close();
  });
  document.addEventListener('keydown', onKey);
  modalDepth++;
  backdrop.dataset.depth = String(modalDepth);
  document.body.appendChild(backdrop);
  const focusable = bodyEl.querySelector('input:not([type=checkbox]):not([type=radio]), textarea, select');
  (focusable || closeBtn).focus();
  return {
    el: modal,
    body: bodyEl,
    foot: footEl,
    close,
    setDismissible(v) {
      dismissible = v;
      closeBtn.disabled = !v;
    },
  };
}

/**
 * Confirmation dialog. With requireText the user must type that word first
 * (used for permanent deletes). Resolves true/false.
 */
export function confirmDialog({ title = '请确认', message, details, confirmText = '确定', danger = false, requireText = null }) {
  return new Promise((resolve) => {
    let result = false;
    const typed = requireText ? h('input', { type: 'text', placeholder: requireText, autocomplete: 'off' }) : null;
    const ok = button(confirmText, { kind: danger ? 'danger-solid' : 'primary', disabled: Boolean(requireText) });
    const cancel = button('取消');
    if (typed) typed.addEventListener('input', () => { ok.disabled = typed.value.trim() !== requireText; });
    const m = openModal({
      title,
      body: [
        typeof message === 'string' ? h('p', null, message) : message,
        details || null,
        typed ? field(`请输入"${requireText}"以确认`, typed) : null,
      ],
      footer: [cancel, ok],
      onClose: () => resolve(result),
    });
    cancel.addEventListener('click', () => m.close());
    ok.addEventListener('click', () => {
      result = true;
      m.close();
    });
    if (typed) typed.focus();
    else ok.focus();
  });
}

/** Shift-click range selection for a list of checkboxes. */
export function rangeSelect(checkboxes, onChange) {
  let last = null;
  checkboxes.forEach((cb, i) => {
    cb.addEventListener('click', (e) => {
      if (e.shiftKey && last !== null && last !== i) {
        const [a, b] = last < i ? [last, i] : [i, last];
        for (let j = a; j <= b; j++) checkboxes[j].checked = cb.checked;
      }
      last = i;
      onChange();
    });
  });
}

export function readStorage(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable (private mode etc.) – not critical
  }
}
