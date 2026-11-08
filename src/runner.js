// 任务执行器：按 script_key 调用内置库 → 注入 ctx → 限时执行 → 日志落 D1 → 推进 next_run_at。
// Workers 运行时禁止字符串编译（new Function/eval），脚本一律来自打包的内置库模块。
import { ensureReady } from './seed.js';
import { getNotifyKey, notifyPush } from './notify.js';
import { computeNext, healedAnchor, tzOffsetSec } from './nextrun.js';
import { BUILTINS } from './builtins.js';

const TASK_TIMEOUT_MS = 90_000;   // 单任务墙钟保险丝
const FETCH_TIMEOUT_MS = 30_000;  // ctx.fetch 单请求保险丝
const MAX_LOG_LINES = 200;        // 每任务日志环形上限（写内存与落库同一把尺子）
const MAX_NOTIFY = 10;            // 单次运行推送上限（防脚本失控刷通知）

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('脚本执行超时（' + ms / 1000 + 's）')), ms)),
  ]);
}

// 先插本批日志、再环形截断该任务 200 行以外的旧行（D1 无 TRIGGER，两步一个 batch）
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
    if (logs.length < MAX_LOG_LINES) logs.push({ ts: nowSec(), level, text: String(text).slice(0, 2000) });
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
    const key = await getNotifyKey(db);
    let notifyCount = 0;
    // params 由 normalizeTask 写入，恒为合法 JSON；坏库让它在这里响亮失败
    const ctx = {
      params: JSON.parse(task.params || '{}'),
      log: (msg) => pushLog('info', msg),
      notify: async (title, content) => {
        if (++notifyCount > MAX_NOTIFY) {
          pushLog('info', '推送次数超过上限（' + MAX_NOTIFY + ' 次），跳过');
          return;
        }
        if (!key) { pushLog('info', '未配置通知密钥，跳过推送'); return; }
        try {
          await notifyPush(env, key, title, content);
          pushLog('info', '通知推送成功');
        } catch (e) {
          pushLog('error', '推送失败: ' + ((e && e.message) || e));
        }
      },
      fetch: (url, init) => fetch(url, Object.assign({}, init, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })),
    };
    await withTimeout(builtin.run(ctx), TASK_TIMEOUT_MS);
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
  const db = env.DB;
  // 崩溃恢复：单飞锁保证这里不会有真在跑的任务，running 是上次 isolate 被逐出的
  // 残留——置为 failed，其 next_run_at 早已过期，本轮立即补跑。
  await db.prepare("UPDATE tasks SET last_status='failed' WHERE last_status='running'").run();
  // 漂移自愈：单次天/月任务的正确锚点完全由规则决定（healedAnchor），逐个纠正
  const { results: anchored } = await db.prepare(
    "SELECT id, enabled, interval_unit, interval_amount, run_hour, run_minute, run_day, next_run_at FROM tasks WHERE enabled=1 AND interval_amount=1 AND interval_unit IN ('d','m') AND last_status<>'running'"
  ).all();
  for (const t of anchored || []) {
    const correct = healedAnchor(t, now, tz);
    if (correct !== null) {
      await db.prepare('UPDATE tasks SET next_run_at=? WHERE id=?').bind(correct, t.id).run();
    }
  }
  const { results } = await db.prepare(
    "SELECT * FROM tasks WHERE enabled=1 AND next_run_at<=? AND last_status<>'running' ORDER BY next_run_at"
  ).bind(now).all();
  let ran = 0;
  for (const task of results || []) {
    await db.prepare("UPDATE tasks SET last_status='running' WHERE id=?").bind(task.id).run();
    await runOne(env, task, false);
    ran++;
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
  return runOne(env, task, true);
}
