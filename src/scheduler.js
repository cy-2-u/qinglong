// TaskScheduler DO：真正的调度器。
// - alarm() 每小时心跳：跑到期任务，finally 无条件续上下一班闹钟（本轮崩溃也不丢调度）；
//   闹钟丢失时由 cron trigger / /health 兜底重新上弦。
// - runTask(id) 手动运行，与心跳共用单飞锁，互不并发。
// 单飞协调器（思路来自 UptimeFlare）：DO 同名 id 是单实例，进程内锁即全局锁。
//   run()    同一时刻只允许一个心跳在跑，后来的调用共享同一个进行中的 Promise；
//   mutate() 配置类操作串行排队，不并发。
import { DurableObject } from 'cloudflare:workers';
import { heartbeat, runTaskById } from './runner.js';

const HOUR_MS = 3600_000;

class RunCoordinator {
  constructor() {
    this.pending = null;
    this.tail = Promise.resolve();
  }

  run(task) {
    if (this.pending) return this.pending;
    const p = this.tail.then(task);
    this.pending = p;
    p.finally(() => { if (this.pending === p) this.pending = null; }).catch(() => undefined);
    this.tail = p.catch(() => undefined);
    return p;
  }

  mutate(task) {
    const next = this.tail.then(task);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }
}

export class TaskScheduler extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.co = new RunCoordinator();
  }

  async ensureAlarm() {
    const existing = await this.ctx.storage.getAlarm();
    if (existing !== null && existing > Date.now()) return { nextAlarm: existing };
    const nextAlarm = Date.now() + 1000;
    await this.ctx.storage.setAlarm(nextAlarm);
    return { nextAlarm };
  }

  async alarm() {
    let ran = 0;
    // 用 mutate 排队而不是 run()：run() 会"加入"正在进行的手动运行（直接返回它的
    // Promise），导致这次心跳整个被跳过、闹钟也不再续期（只能等 cron 看门狗兜底）。
    // mutate 保证心跳排在手动运行之后完整执行。
    await this.co.mutate(async () => {
      try {
        ran = await heartbeat(this.env);
      } catch (e) {
        console.log('heartbeat error:', (e && e.stack) || e);
      } finally {
        try {
          await this.ctx.storage.setAlarm(Date.now() + HOUR_MS);
        } catch (e) {
          console.log('re-arm error:', (e && e.stack) || e);
        }
      }
    });
    return { ran };
  }

  async runTask(id) {
    await this.ensureAlarm();
    return this.co.mutate(() => runTaskById(this.env, id));
  }
}
