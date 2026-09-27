import { newId, pool, groupBy } from './util.js';

const RESULT_STATUSES = new Set(['ok', 'warn', 'error', 'skipped']);
const STATUS_TEXT = { ok: '成功', warn: '部分成功', error: '失败', skipped: '跳过' };
const KEEP_FINISHED_MS = 60 * 60 * 1000;

/**
 * Runs batch tasks in the background. Tasks are grouped by site: up to `siteConcurrency`
 * sites are worked on at once, with `perSite` concurrent requests each, so a big batch
 * never floods a single WordPress server.
 */
export class JobManager {
  constructor({ store = null, siteConcurrency = 4 } = {}) {
    this.store = store;
    this.siteConcurrency = siteConcurrency;
    this.jobs = new Map();
    this.running = new Map();
  }

  start({ action, title, tasks, perSite = 2 }) {
    const job = {
      id: newId(8),
      action,
      title,
      status: 'running',
      total: tasks.length,
      done: 0,
      counts: { ok: 0, warn: 0, error: 0, skipped: 0 },
      siteCount: new Set(tasks.map((t) => t.siteId)).size,
      results: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    const state = { job, cancelRequested: false };
    this.jobs.set(job.id, state);
    this.running.set(job.id, this.#run(state, tasks, perSite));
    return job;
  }

  async #run(state, tasks, perSite) {
    const { job } = state;
    try {
      const groups = [...groupBy(tasks, (t) => t.siteId).values()];
      await pool(groups, this.siteConcurrency, (group) => pool(group, perSite, (task) => this.#runTask(state, task)));
    } finally {
      job.status = state.cancelRequested ? 'cancelled' : 'done';
      job.finishedAt = new Date().toISOString();
      this.running.delete(job.id);
      try {
        this.store?.addHistory(structuredClone(job));
      } catch (err) {
        console.error('保存操作记录失败：', err);
      }
      setTimeout(() => this.jobs.delete(job.id), KEEP_FINISHED_MS).unref?.();
    }
  }

  async #runTask(state, task) {
    let result;
    if (state.cancelRequested) {
      result = { status: 'skipped', message: '已取消' };
    } else {
      try {
        result = { status: 'ok', ...(await task.run()) };
      } catch (err) {
        result = { status: 'error', message: err?.message || String(err) };
      }
    }
    const status = RESULT_STATUSES.has(result.status) ? result.status : 'ok';
    const { job } = state;
    job.results.push({
      siteId: task.siteId,
      siteName: task.siteName,
      label: task.label,
      targetId: task.targetId ?? null,
      status,
      message: result.message || STATUS_TEXT[status],
      data: result.data ?? null,
    });
    job.counts[status]++;
    job.done++;
  }

  /** Job with results[since..] only, so pollers don't re-download everything. */
  view(id, since = 0) {
    const job = this.jobs.get(id)?.job || this.store?.getHistory(id);
    if (!job) return null;
    const from = Math.max(0, Math.min(Number(since) || 0, job.results.length));
    return { ...job, results: job.results.slice(from), resultsFrom: from };
  }

  cancel(id) {
    const state = this.jobs.get(id);
    if (!state || state.job.status !== 'running') return false;
    state.cancelRequested = true;
    return true;
  }

  /** Resolves when the job has finished (used by tests). */
  wait(id) {
    return this.running.get(id) || Promise.resolve();
  }

  list() {
    const running = [...this.jobs.values()].map((s) => s.job).filter((j) => j.status === 'running');
    const history = this.store ? this.store.history : [];
    return [...running, ...history].map(({ results, ...summary }) => summary);
  }
}
