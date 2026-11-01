// 任务执行器：按 script_key 调用内置库 → 注入 ctx → 限时执行 → 日志落 D1 → 推进 next_run_at。
// 注意：Workers 运行时禁止字符串编译（new Function/eval），脚本一律来自打包的内置库模块。
import { ensureReady } from './seed.js';
import { getMeowNickname, meowPush } from './notify.js';
import { advanceNext, nextDailyAnchor, nextMonthlyAnchor, tzOffsetSec } from './nextrun.js';
import { BUILTINS } from './builtins.js';

const TASK_TIMEOUT_MS = 90_000;   // 单任务墙钟保险丝
const FETCH_TIMEOUT_MS = 30_000;  // ctx.fetch 单请求保险丝
const MAX_LOG_LINES = 200;        // 每任务日志环形上限
const MAX_NOTIFY = 10;            // 单次运行推送上限（防脚本失控刷通知）

// 下一个调度槽位：天/月的单次（N=1）任务完全由时刻规则决定——
// 手动运行推走的漂移会在下一次计算时自愈；其余沿用锚点推进
function computeNext(task, prevAnchor, nowSec, tz) {
  const n = Math.max(1, task.interval_amount | 0);
  if (n === 1 && task.interval_unit === 'd') {
    return nextDailyAnchor(task.run_hour == null ? 9 : task.run_hour, nowSec, tz);
  }
  if (n === 1 && task.interval_unit === 'm') {
    return nextMonthlyAnchor(task.run_day == null ? 1 : task.run_day, task.run_hour == null ? 9 : task.run_hour, nowSec, tz);
  }
  return advanceNext(task, prevAnchor, nowSec, tz);
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('脚本执行超时（' + ms / 1000 + 's）')), ms)),
  ]);
}

function parseParams(raw) {
  try {
    const p = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
    return p && typeof p === 'object' ? p : {};
  } catch (e) {
    return {};
  }
}

async function flushLogs(db, taskId, logs) {
  if (!logs.length) return;
  const stmts = logs.map((l) =>
    db.prepare('INSERT INTO logs (task_id, ts, level, text) VALUES (?,?,?,?)').bind(taskId, l.ts, l.level, l.text)
  );
  stmts.push(
    db.prepare(
      'DELETE FROM logs WHERE task_id=? AND id NOT IN (SELECT id FROM logs WHERE task_id=? ORDER BY id DESC LIMIT ?)'
    ).bind(taskId, taskId, MAX_LOG_LINES)
  );
  await db.batch(stmts);
}

async function runOne(env, task, isManual) {
  const db = env.DB;
  const nowSec = () => Math.floor(Date.now() / 1000);
  const logs = [];
  const pushLog = (level, text) => {
    if (logs.length < 500) logs.push({ ts: nowSec(), level, text: String(text).slice(0, 2000) });
  };

  let status = 'ok';
  const startedAt = nowSec();
  pushLog('info', '开始执行');

  const builtin = BUILTINS[task.script_key];
  if (!builtin || typeof builtin.run !== 'function') {
    pushLog('error', '未知内置脚本: ' + (task.script_key || '(空)'));
    await flushLogs(db, task.id, logs);
    await db.prepare('UPDATE tasks SET last_status=?, last_run_at=? WHERE id=?')
      .bind('failed', nowSec(), task.id).run();
    return 'failed';
  }

  try {
    const nick = await getMeowNickname(db);
    let notifyCount = 0;
    const ctx = {
      params: parseParams(task.params),
      log: (msg) => pushLog('info', msg),
      notify: async (title, content) => {
        if (++notifyCount > MAX_NOTIFY) {
          pushLog('info', '推送次数超过上限（' + MAX_NOTIFY + ' 次），跳过');
          return;
        }
        if (!nick) { pushLog('info', '未配置全局通知，跳过推送'); return; }
        try {
          await meowPush(env, nick, title, content);
          pushLog('info', 'MeoW 推送成功');
        } catch (e) {
          pushLog('error', '推送失败: ' + ((e && e.message) || e));
        }
      },
      fetch: (url, init) => fetch(url, Object.assign({}, init, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })),
    };
    await withTimeout(Promise.resolve(builtin.run(ctx)), TASK_TIMEOUT_MS);
  } catch (e) {
    status = 'failed';
    pushLog('error', (e && e.message) || String(e));
  }

  const finishedAt = nowSec();
  pushLog('info', '执行结束: ' + (status === 'ok' ? '成功' : '失败') + '，用时 ' + (finishedAt - startedAt) + 's');

  await flushLogs(db, task.id, logs);
  if (isManual) {
    // 手动运行不打乱调度节奏：只记录结果，不推进 next_run_at
    await db.prepare('UPDATE tasks SET last_run_at=?, last_status=? WHERE id=?')
      .bind(finishedAt, status, task.id).run();
  } else {
    const next = computeNext(task, task.next_run_at, finishedAt, tzOffsetSec(env));
    await db.prepare('UPDATE tasks SET last_run_at=?, last_status=?, next_run_at=? WHERE id=?')
      .bind(finishedAt, status, next, task.id).run();
  }
  return status;
}

// 心跳：执行所有到期任务
export async function heartbeat(env) {
  await ensureReady(env);
  const now = Math.floor(Date.now() / 1000);
  const tz = tzOffsetSec(env);
  // 崩溃恢复：心跳与手动运行共用单飞锁（严格串行），走到这里时不可能有运行中的
  // 任务；仍是 running 状态的是上次 isolate 崩溃/被逐出的残留。重置为 failed，
  // 其 next_run_at 早已过期，本轮会立即补跑。
  await env.DB.prepare("UPDATE tasks SET last_status='failed' WHERE last_status='running'").run();
  // 漂移自愈：天/月的单次任务，下一次运行时刻完全由规则决定——把历史上被
  // 手动运行推走的 next_run_at 拉回正确槽位（跳过已到期待跑/运行中/停用的任务）
  const { results: anchored } = await env.DB.prepare(
    "SELECT id, interval_unit, run_hour, run_day, next_run_at FROM tasks WHERE enabled=1 AND interval_amount=1 AND interval_unit IN ('d','m') AND last_status<>'running'"
  ).all();
  for (const t of anchored || []) {
    if (!(t.next_run_at > now)) continue; // 已到期待跑的交给下面的执行流程
    const correct = t.interval_unit === 'd'
      ? nextDailyAnchor(t.run_hour == null ? 9 : t.run_hour, now, tz)
      : nextMonthlyAnchor(t.run_day == null ? 1 : t.run_day, t.run_hour == null ? 9 : t.run_hour, now, tz);
    if (t.next_run_at !== correct) {
      await env.DB.prepare('UPDATE tasks SET next_run_at=? WHERE id=?').bind(correct, t.id).run();
    }
  }
  const { results } = await env.DB.prepare(
    "SELECT * FROM tasks WHERE enabled=1 AND next_run_at<=? AND last_status<>'running' ORDER BY next_run_at"
  ).bind(now).all();
  let ran = 0;
  for (const task of results || []) {
    await env.DB.prepare("UPDATE tasks SET last_status='running' WHERE id=?").bind(task.id).run();
    await runOne(env, Object.assign({}, task, { last_status: 'running' }), false);
    ran += 1;
  }
  return ran;
}

// 手动运行单个任务：只记录结果，绝不改变 next_run_at（不打乱调度节奏）
export async function runTaskById(env, id) {
  await ensureReady(env);
  const task = await env.DB.prepare('SELECT * FROM tasks WHERE id=?').bind(Number(id)).first();
  if (!task) throw new Error('任务不存在');
  if (task.last_status === 'running') return 'running';
  if (!task.enabled) throw new Error('任务已停用，请先启用');
  await env.DB.prepare("UPDATE tasks SET last_status='running' WHERE id=?").bind(task.id).run();
  return runOne(env, Object.assign({}, task, { last_status: 'running' }), true);
}
