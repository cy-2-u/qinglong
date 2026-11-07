// TaskScheduler DO：真正的调度器。
// - 闹钟对齐任务锚点：ensureAlarm() 把闹钟重算为 min(最近启用任务 next_run_at + 5s,
//   now + 1h)——任务在锚点后几秒准点执行；无任务/太远/查询失败退化为每小时看门狗。
//   cron trigger 与 /health 每小时调 ensureAlarm 兜底重算，任务增删改后也会触发。
// - alarm() 心跳：跑到期任务，finally 无条件重算下一班闹钟（本轮崩溃也不丢调度）。
// - runTask(id) 手动运行，与心跳共用单飞锁，互不并发。
// 单飞协调器（思路来自 UptimeFlare）：DO 同名 id 是单实例，进程内锁即全局锁。
//   run()    同一时刻只允许一个心跳在跑，后来的调用共享同一个进行中的 Promise；
//   mutate() 配置类操作串行排队，不并发。
import { DurableObject } from 'cloudflare:workers';
import { heartbeat, runTaskById } from './runner.js';
import { nextAlarmAt } from './nextrun.js';

const HOUR_MS = 3600_000;    // 看门狗兜底间隔
const ANCHOR_EPS_MS = 5000;  // 闹钟落在锚点后 5 秒，避开边界

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

  // 重算闹钟：永远以"最近启用任务的锚点"为准（任务增删改后靠它把闹钟拉近/推远）
  async ensureAlarm() {
    const nowMs = Date.now();
    let minNext = null;
    try {
      const row = await this.env.DB.prepare(
        "SELECT MIN(next_run_at) AS t FROM tasks WHERE enabled=1 AND last_status<>'running'"
      ).first();
      minNext = row && row.t ? Number(row.t) : null;
    } catch (e) { /* D1 未就绪/查询失败 → 走看门狗兜底 */ }
    const nextAlarm = nextAlarmAt(minNext, nowMs, HOUR_MS, ANCHOR_EPS_MS);
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
          await this.ensureAlarm();
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
