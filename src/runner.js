// 任务执行器：编译脚本 → 注入 ctx → 限时执行 → 日志落 D1 → 推进 next_run_at。
import { ensureReady } from './seed.js';
import { getMeowNickname, meowPush } from './notify.js';
import { advanceNext, tzOffsetSec } from './nextrun.js';

const TASK_TIMEOUT_MS = 90_000;   // 单任务墙钟保险丝
const FETCH_TIMEOUT_MS = 30_000;  // ctx.fetch 单请求保险丝
const MAX_LOG_LINES = 200;        // 每任务日志环形上限

function compile(code) {
  return new Function(
    'ctx',
    '"use strict";\n' + code +
    '\n;if (typeof main !== "function") throw new Error("脚本缺少 main(ctx) 函数");\nreturn main(ctx);'
  );
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('脚本执行超时（' + ms / 1000 + 's）')), ms)),
  ]);
}

function parseParams(raw) {
  try {
    const p = JSON.parse(raw || '{}');
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

async function runOne(env, task) {
  const db = env.DB;
  const nowSec = () => Math.floor(Date.now() / 1000);
  const logs = [];
  const pushLog = (level, text) => {
    if (logs.length < 500) logs.push({ ts: nowSec(), level, text: String(text).slice(0, 2000) });
  };

  let status = 'ok';
  const startedAt = nowSec();
  pushLog('info', '开始执行');

  try {
    const fn = compile(task.script_code || '');
    const nick = await getMeowNickname(db);
    const ctx = {
      params: parseParams(task.params),
      log: (msg) => pushLog('info', msg),
      notify: async (title, content) => {
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
    await withTimeout(Promise.resolve(fn(ctx)), TASK_TIMEOUT_MS);
  } catch (e) {
    status = 'failed';
    pushLog('error', (e && e.message) || String(e));
  }

  const finishedAt = nowSec();
  pushLog('info', '执行结束: ' + (status === 'ok' ? '成功' : '失败') + '，用时 ' + (finishedAt - startedAt) + 's');

  const next = advanceNext(task, task.next_run_at, finishedAt, tzOffsetSec(env));
  await flushLogs(db, task.id, logs);
  await db.prepare('UPDATE tasks SET last_run_at=?, last_status=?, next_run_at=? WHERE id=?')
    .bind(finishedAt, status, next, task.id).run();
  return status;
}

// 心跳：执行所有到期任务
export async function heartbeat(env) {
  await ensureReady(env);
  const now = Math.floor(Date.now() / 1000);
  const { results } = await env.DB.prepare(
    "SELECT * FROM tasks WHERE enabled=1 AND next_run_at<=? AND last_status<>'running' ORDER BY next_run_at"
  ).bind(now).all();
  let ran = 0;
  for (const task of results || []) {
    await env.DB.prepare("UPDATE tasks SET last_status='running' WHERE id=?").bind(task.id).run();
    await runOne(env, Object.assign({}, task, { last_status: 'running' }));
    ran += 1;
  }
  return ran;
}

// 手动运行单个任务（不推进 next_run_at 以外的节奏；runOne 内部会正常推进锚点，
// 与“手动运行不打乱节奏”的语义一致：锚点基于旧 next_run_at 计算）
export async function runTaskById(env, id) {
  await ensureReady(env);
  const task = await env.DB.prepare('SELECT * FROM tasks WHERE id=?').bind(Number(id)).first();
  if (!task) throw new Error('任务不存在');
  if (task.last_status === 'running') return 'running';
  if (!task.enabled) throw new Error('任务已停用，请先启用');
  await env.DB.prepare("UPDATE tasks SET last_status='running' WHERE id=?").bind(task.id).run();
  return runOne(env, Object.assign({}, task, { last_status: 'running' }));
}
