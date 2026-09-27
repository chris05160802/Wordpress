import { GET, DELETE } from '../api.js';
import { h, clear, button, toast, confirmDialog, badge, formatDate, spinner } from '../dom.js';
import { trackJob } from '../jobs.js';

const JOB_STATUS = { running: ['进行中', 'info'], done: ['已完成', 'ok'], cancelled: ['已取消', 'warn'] };

export function mount(el) {
  const body = h('div', { class: 'card' }, spinner());
  const refreshBtn = button('刷新', { size: 'sm' });
  const clearBtn = button('清空记录', { size: 'sm', kind: 'danger' });

  async function load() {
    try {
      const { jobs } = await GET('/api/history');
      if (!jobs.length) return clear(body, h('div', { class: 'empty' }, '还没有操作记录'));
      clear(body, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, '时间'), h('th', null, '操作'), h('th', null, '站点数'), h('th', null, '结果'), h('th', null, '状态'), h('th', null, ''))),
        h('tbody', null, jobs.map((job) => {
          const [text, kind] = JOB_STATUS[job.status] || [job.status, ''];
          return h('tr', null,
            h('td', { class: 'nowrap small' }, formatDate(job.startedAt)),
            h('td', { class: 'title-cell' }, job.title),
            h('td', null, job.siteCount),
            h('td', { class: 'nowrap small' },
              `成功 ${job.counts.ok + (job.counts.warn || 0)}`,
              job.counts.error ? h('span', { style: { color: 'var(--danger)' } }, ` · 失败 ${job.counts.error}`) : null,
              job.counts.skipped ? ` · 跳过 ${job.counts.skipped}` : null),
            h('td', null, badge(text, kind)),
            h('td', { class: 'actions' }, h('button', { type: 'button', class: 'link-btn', onClick: () => show(job.id) }, '查看详情')));
        })))));
    } catch (err) {
      clear(body, h('div', { class: 'notice error' }, err.message));
    }
  }

  async function show(id) {
    try {
      const { job } = await GET(`/api/jobs/${id}`);
      await trackJob(job);
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  refreshBtn.addEventListener('click', load);
  clearBtn.addEventListener('click', async () => {
    if (!(await confirmDialog({ message: '清空所有操作记录？（不会影响网站上的内容）', confirmText: '清空', danger: true }))) return;
    try {
      await DELETE('/api/history');
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  clear(el,
    h('div', { class: 'view-head' }, h('h2', null, '操作记录'), h('span', { class: 'muted small' }, '最近 100 次批量操作'), refreshBtn, clearBtn),
    body);
  load();
}
