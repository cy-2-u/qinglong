// TaskScheduler DO：真正的调度器。
// - alarm() 每小时心跳：跑到期任务，最后无条件续上下一班闹钟（先上弦再干活的变体：
//   即使本轮崩溃，finally 也把闹钟续上；闹钟丢失时由 cron trigger /health 兜底重新上弦）。
// - runTask(id) 手动运行，与心跳共用单飞锁，互不并发。
import { DurableObject } from 'cloudflare:workers';
import { ensureReady } from './seed.js';
import { heartbeat, runTaskById } from './runner.js';
import { RunCoordinator } from './coordinator.js';

const HOUR_MS = 3600_000;

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
