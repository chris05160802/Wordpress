// Batch jobs: start one, then show live progress and per-item results in a dialog.
import { GET, POST } from './api.js';
import { h, clear, openModal, button, badge, extLink, toast, formatDate } from './dom.js';

export const RESULT_STATUS = {
  ok: ['成功', 'ok'],
  warn: ['部分成功', 'warn'],
  error: ['失败', 'error'],
  skipped: ['跳过', ''],
};

const MAX_ROWS = 500;

/** Starts a job and shows its progress. Resolves with the finished job. Throws on validation errors. */
export async function runJob(payload) {
  const { job } = await POST('/api/jobs', payload);
  return trackJob(job, payload);
}

/** Rebuilds the request so only the items that failed are run again. */
function retryPayload(payload, results) {
  const failed = results.filter((r) => r.status === 'error');
  if (!payload || !failed.length || payload.action === 'posts.create') return null;
  if (Array.isArray(payload.targets)) {
    const keys = new Set(failed.map((r) => `${r.siteId}:${r.targetId}`));
    const targets = payload.targets.filter((t) => keys.has(`${t.siteId}:${t.id}`));
    return targets.length ? { ...payload, targets } : null;
  }
  if (Array.isArray(payload.siteIds)) {
    const ids = new Set(failed.map((r) => r.siteId));
    const labels = [...new Set(failed.map((r) => r.label))];
    const params = { ...payload.params };
    if (payload.action === 'plugins.install') params.slugs = labels;
    else if (payload.action.startsWith('plugins.')) params.plugins = labels;
    else if (payload.action.startsWith('terms.')) params.names = labels;
    const siteIds = payload.siteIds.filter((id) => ids.has(id));
    return siteIds.length ? { ...payload, siteIds, params } : null;
  }
  return null;
}

export function resultsTable(results) {
  const rows = results.slice(0, MAX_ROWS);
  return [
    h('table', { class: 'table' },
      h('thead', null, h('tr', null,
        h('th', null, '结果'), h('th', null, '站点'), h('th', null, '对象'), h('th', null, '说明'))),
      h('tbody', null, rows.map((r) => {
        const [text, kind] = RESULT_STATUS[r.status] || [r.status, ''];
        return h('tr', null,
          h('td', { class: 'nowrap' }, badge(text, kind)),
          h('td', { class: 'nowrap' }, r.siteName),
          h('td', null, r.label),
          h('td', null, r.message, r.data?.link ? [' ', extLink(r.data.link, '查看')] : null));
      }))),
    results.length > MAX_ROWS ? h('div', { class: 'muted small', style: { padding: '8px 10px' } }, `仅显示前 ${MAX_ROWS} 条（共 ${results.length} 条）`) : null,
  ];
}

/**
 * Shows a job in a dialog, polling while it runs. Resolves as soon as the job finishes
 * (so callers can refresh their data) – the dialog stays open until the user closes it.
 */
export function trackJob(job, payload = null) {
  return new Promise((resolve) => {
    let current = job;
    const results = [...job.results];
    let filter = 'all';
    let timer = null;
    let settled = false;

    const bar = h('div');
    const progress = h('div', { class: 'progress' }, bar);
    const progressText = h('span', { class: 'muted small' });
    const counts = h('div', { class: 'job-counts' });
    const filters = h('div', { class: 'filter-tabs' });
    const list = h('div', { class: 'results' });
    const cancelBtn = button('取消剩余任务', { kind: 'danger', size: 'sm' });
    const retryBtn = button('重试失败的项目', { size: 'sm' });
    const closeBtn = button('关闭', { kind: 'primary' });

    const modal = openModal({
      title: job.title,
      wide: true,
      body: [
        h('div', { class: 'stack' },
          h('div', { class: 'row' }, h('div', { class: 'grow' }, progress), progressText),
          counts,
          h('div', { class: 'row' }, filters, h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, `开始于 ${formatDate(job.startedAt)}`)),
          list),
      ],
      footer: [retryBtn, cancelBtn, closeBtn],
      onClose: () => {
        clearTimeout(timer);
        if (current.status === 'running') toast('任务仍在后台继续执行，可以在「操作记录」中查看结果');
        settle();
      },
    });

    closeBtn.addEventListener('click', () => modal.close());
    cancelBtn.addEventListener('click', async () => {
      cancelBtn.disabled = true;
      try {
        await POST(`/api/jobs/${job.id}/cancel`);
        toast('正在取消，已经开始的操作会执行完');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    retryBtn.addEventListener('click', async () => {
      const again = retryPayload(payload, results);
      if (!again) return;
      modal.close();
      try {
        await runJob(again);
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    function settle() {
      if (settled) return;
      settled = true;
      resolve({ ...current, results });
    }

    function render() {
      const running = current.status === 'running';
      const pct = current.total ? Math.round((current.done / current.total) * 100) : 100;
      bar.style.width = `${pct}%`;
      progress.className = `progress${running ? '' : ' done'}${current.counts.error ? ' has-error' : ''}`;
      progressText.textContent = running
        ? `进行中 ${current.done}/${current.total}`
        : current.status === 'cancelled' ? `已取消（${current.done}/${current.total}）` : `已完成 ${current.done}/${current.total}`;
      clear(counts,
        h('span', null, '成功 ', h('b', null, current.counts.ok)),
        current.counts.warn ? h('span', null, '部分成功 ', h('b', null, current.counts.warn)) : null,
        h('span', null, '失败 ', h('b', null, current.counts.error)),
        h('span', null, '跳过 ', h('b', null, current.counts.skipped)),
        h('span', { class: 'muted' }, `涉及 ${current.siteCount} 个站点`));

      const tabs = [['all', `全部 ${results.length}`], ['error', `失败 ${current.counts.error}`], ['ok', `成功 ${current.counts.ok + current.counts.warn}`], ['skipped', `跳过 ${current.counts.skipped}`]];
      clear(filters, tabs.map(([key, text]) => h('button', {
        type: 'button',
        class: filter === key ? 'active' : '',
        onClick: () => {
          filter = key;
          render();
        },
      }, text)));

      const shown = results.filter((r) => filter === 'all' || r.status === filter || (filter === 'ok' && r.status === 'warn'));
      clear(list, shown.length ? resultsTable(shown) : h('div', { class: 'empty' }, running ? '正在执行…' : '没有记录'));

      cancelBtn.classList.toggle('hidden', !running);
      retryBtn.classList.toggle('hidden', running || !retryPayload(payload, results));
      modal.setDismissible(true);
    }

    async function poll() {
      try {
        const { job: next } = await GET(`/api/jobs/${job.id}?since=${results.length}`);
        results.push(...next.results);
        current = next;
        render();
        if (next.status === 'running') timer = setTimeout(poll, 800);
        else settle();
      } catch {
        timer = setTimeout(poll, 2000);
      }
    }

    render();
    if (current.status === 'running') timer = setTimeout(poll, 500);
    else settle();
  });
}
