// TaskScheduler DO：真调度器。闹钟 = min(最近启用任务锚点+5s, now+1h)，
// 任务在锚点后几秒准点执行；cron / /health 兜底重算；增删改后接口层触发 rearm。
// 单飞：DO 同名 id 单实例，一条 Promise 队列即全局锁——心跳与手动运行严格串行。
import { DurableObject } from 'cloudflare:workers';
import { heartbeat, runTaskById } from './runner.js';
import { nextAlarmAt } from './nextrun.js';

const HOUR_MS = 3600_000;

export class TaskScheduler extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.tail = Promise.resolve();
  }

  // 排队执行，不并发。不用"加入进行中"的 run()——那会让心跳附身到手动运行的
  // Promise 上直接返回，闹钟不再续期，只能等 cron 兜底。
  mutate(task) {
    const next = this.tail.then(task);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }

  async ensureAlarm() {
    let minNext = null;
    try {
      const row = await this.env.DB.prepare(
        "SELECT MIN(next_run_at) AS t FROM tasks WHERE enabled=1 AND last_status<>'running'"
      ).first();
      minNext = row && row.t ? Number(row.t) : null;
    } catch (e) { /* D1 未就绪 → 看门狗兜底 */ }
    const nextAlarm = nextAlarmAt(minNext, Date.now(), HOUR_MS, 5000);
    await this.ctx.storage.setAlarm(nextAlarm);
    return { nextAlarm };
  }

  async alarm() {
    let ran = 0;
    await this.mutate(async () => {
      try {
        ran = await heartbeat(this.env);
      } catch (e) {
        console.log('heartbeat error:', (e && e.stack) || e);
      } finally {
        try { await this.ensureAlarm(); } catch (e) { console.log('re-arm error:', (e && e.stack) || e); }
      }
    });
    return { ran };
  }

  async runTask(id) {
    await this.ensureAlarm();
    const status = await this.mutate(() => runTaskById(this.env, id));
    // 手动运行可能产生 60 秒后的补跑任务，收尾重算让闹钟立刻吸附过去
    await this.ensureAlarm();
    return status;
  }
}
