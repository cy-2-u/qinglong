import { run as glados } from './tasks/glados.js';
import { run as dnshe } from './tasks/dnshe.js';
import { runtime, notify } from './runtime.js';
import { now, nextRun, offset } from './schedule.js';

export const BUILTINS = {
  'glados-checkin': { name: 'GLaDOS 签到', params: ['cookie'], run: glados },
  'dnshe-renew': { name: 'DNSHE 域名续期', params: ['api_key','api_secret'], run: dnshe },
};
export class Engine {
  constructor(store, env, { builtins = BUILTINS, fetcher = fetch } = {}) {
    this.store = store; this.env = env; this.builtins = builtins; this.fetcher = fetcher;
  }
  async tick() {
    const time = now();
    for (const task of await this.store.due(time)) {
      await this.store.enqueue(task, 'scheduled', time, nextRun(task, time, offset(this.env)));
    }
    const job = await this.store.nextJob(time);
    if (!job) return false;
    await this.execute(job);
    return true;
  }
  async execute(job) {
    const id = job.task_id;
    const lines = [];
    const log = (text, level = 'info') => {
      if (lines.length >= 199) lines.shift();
      lines.push({ ts: now(), level, text: String(text).slice(0, 2000) });
    };
    await this.store.start(id);
    log(job.kind === 'defer' ? '开始补跑剩余项' : '开始执行');
    let result, status = 'ok';
    let rt;
    try {
      const params = JSON.parse(job.params);
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('任务参数格式无效');
      const budget = Number(params.sub_budget ?? 40);
      rt = runtime({ fetcher: this.fetcher, budget: Number.isFinite(budget) ? Math.max(6, Math.min(40, Math.floor(budget))) : 40 });
      const script = this.builtins[job.script_key];
      if (!script) throw new Error('未知内置脚本');
      result = await script.run({ params, log, fetch: rt.fetch, sleep: rt.sleep, canStart: rt.canStart, signal: rt.signal });
      if (result?.failed) status = 'failed';
    } catch (error) {
      status = 'failed';
      log(error.message, 'error');
      result = { title: `${job.name} 失败`, content: error.message };
    } finally { rt?.close(); }
    const remaining = result?.defer || null;
    if (remaining) log('一分钟后仅补跑剩余项');
    log(`执行结束：${status === 'ok' ? '成功' : '失败'}，请求 ${rt?.requests ?? 0} 次`);
    // 先原子保存结果与剩余集，再发通知；通知失败不会丢掉执行日志或重跑业务。
    await this.store.finish(id, status, lines, remaining);
    try {
      if (result?.title) await notify(await this.store.key(), result.title, result.content || '', this.fetcher);
    } catch (error) {
      await this.store.query('INSERT INTO logs(task_id,ts,level,text) VALUES(?,?,?,?)', id, now(), 'error', error.message).run();
    }
  }
}
