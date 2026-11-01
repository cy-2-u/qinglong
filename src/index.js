// Worker 入口：面板静态资源之外的 API 路由 + cron 看门狗。
// 路由：
//   GET  /health                    公开，自暴露状态并给 DO 上弦
//   POST /api/login                 登录（PANEL_PASSWORD），下发签名 Cookie
//   GET  /api/health                公开探测（面板 api.js 用）
//   *    /api/tasks[...]            任务 CRUD / 运行 / 日志
//   *    /api/settings[...]         全局通知设置
import { ensureReady } from './seed.js';
import { getMeowNickname, meowPush, invalidateNickCache } from './notify.js';
import { initialNext, tzOffsetSec } from './nextrun.js';
import { TaskScheduler } from './scheduler.js';
import { BUILTINS } from './builtins.js';

export { TaskScheduler };

const SESSION_TTL = 30 * 86400;
const enc = new TextEncoder();

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

class HttpError extends Error {
  constructor(msg, status) {
    super(msg);
    this.status = status || 400;
  }
}

function schedulerStub(env) {
  return env.SCHEDULER.get(env.SCHEDULER.idFromName('default'));
}

// ---------- 鉴权：HMAC 签名 Cookie（ql_sess=exp.sig） ----------
function b64url(buf) {
  let s = btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacSign(password, msg) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode('ql:' + password),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

async function safeEqual(a, b) {
  const da = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(a))));
  const db = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(b))));
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(da, db);
  let d = 0;
  for (let i = 0; i < da.length; i++) d |= da[i] ^ db[i];
  return d === 0;
}

async function issueCookie(env) {
  const exp = String(Math.floor(Date.now() / 1000) + SESSION_TTL);
  return exp + '.' + (await hmacSign(env.PANEL_PASSWORD, exp));
}

async function validSession(env, value) {
  if (!value || !env.PANEL_PASSWORD) return false;
  const i = value.indexOf('.');
  if (i <= 0) return false;
  const exp = value.slice(0, i), sig = value.slice(i + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(await hmacSign(env.PANEL_PASSWORD, exp), sig);
}

function getSessionCookie(request) {
  const m = /(?:^|;\s*)ql_sess=([^;]+)/.exec(request.headers.get('cookie') || '');
  return m ? decodeURIComponent(m[1]) : '';
}

// ---------- 任务字段校验 ----------
const UNIT_MAX = { h: 23, d: 30, m: 12 };

function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

function normalizeTask(body) {
  const unit = ['h', 'd', 'm'].includes(body.interval_unit) ? body.interval_unit : 'd';
  const name = String(body.name || '').trim().slice(0, 100);
  const script_key = String(body.script_key || '');
  if (!name) throw new HttpError('名称不能为空');
  if (!BUILTINS[script_key]) throw new HttpError('未知内置脚本: ' + (script_key || '(未选择)'));
  const params = JSON.stringify(body.params && typeof body.params === 'object' ? body.params : {});
  if (params.length > 65536) throw new HttpError('参数过大（上限 64KB）');
  return {
    name,
    script_key: script_key,
    script_code: '',           // 旧列保留兼容，现已不再存放脚本文本
    params: params,
    interval_unit: unit,
    interval_amount: clamp(Math.round(Number(body.interval_amount)) || 1, 1, UNIT_MAX[unit]),
    run_hour: unit === 'h' ? null : clamp(Math.round(Number(body.run_hour)) || 0, 0, 23),
    run_day: unit === 'm' ? clamp(Math.round(Number(body.run_day)) || 1, 1, 28) : null,
    enabled: body.enabled ? 1 : 0,
  };
}

function scheduleChanged(a, b) {
  return a.interval_unit !== b.interval_unit ||
    a.interval_amount !== b.interval_amount ||
    a.run_hour !== b.run_hour ||
    a.run_day !== b.run_day;
}

// API 契约：params 一律以对象返回（D1 里存的是 JSON 字符串，原样返回会被
// 前端 Object.keys 逐字符拆开）。解析失败回退为空对象，绝不抛错。
function toClientTask(row) {
  if (!row) return row;
  let params = {};
  try { params = JSON.parse(row.params || '{}'); } catch (e) { params = {}; }
  if (!params || typeof params !== 'object') params = {};
  return Object.assign({}, row, { params: params });
}

async function bodyJson(request) {
  const b = await request.json().catch(() => null);
  if (!b || typeof b !== 'object') throw new HttpError('请求体须为 JSON');
  return b;
}

// ---------- 路由 ----------
async function route(request, env, url) {
  const method = request.method;
  const db = env.DB;

  // ----- 公开 -----
  if (url.pathname === '/api/health') return json({ ok: true, mode: 'live' });

  if (url.pathname === '/api/login' && method === 'POST') {
    if (!env.PANEL_PASSWORD) throw new HttpError('服务端未设置 PANEL_PASSWORD', 500);
    const body = await bodyJson(request);
    if (!(await safeEqual(body.password || '', env.PANEL_PASSWORD))) throw new HttpError('密码错误', 401);
    const cookie = 'ql_sess=' + encodeURIComponent(await issueCookie(env)) +
      '; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=' + SESSION_TTL;
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'set-cookie': cookie },
    });
  }

  // ----- 鉴权 -----
  if (!(await validSession(env, getSessionCookie(request)))) return json({ error: 'UNAUTHORIZED' }, 401);
  await ensureReady(env);

  const m = url.pathname.match(/^\/api\/tasks(?:\/(\d+)(?:\/(run|logs))?)?$/);

  if (m) {
    const id = m[1] ? Number(m[1]) : null;
    const sub = m[2] || null;

    if (!id && method === 'GET') {
      const { results } = await db.prepare('SELECT * FROM tasks ORDER BY id').all();
      return json({ tasks: (results || []).map(toClientTask) });
    }
    if (!id && method === 'POST') {
      const t = normalizeTask(await bodyJson(request));
      const next = initialNext(t, Math.floor(Date.now() / 1000), tzOffsetSec(env));
      const res = await db.prepare(
        'INSERT INTO tasks (name, enabled, script_key, script_code, params, interval_amount, interval_unit, run_hour, run_day, next_run_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
      ).bind(t.name, t.enabled, t.script_key, t.script_code, t.params, t.interval_amount, t.interval_unit, t.run_hour, t.run_day, next).run();
      const task = await db.prepare('SELECT * FROM tasks WHERE id=?').bind(res.meta.last_row_id).first();
      return json({ task: toClientTask(task) });
    }
    if (id && sub === 'run' && method === 'POST') {
      const status = await schedulerStub(env).runTask(id);
      return json({ ok: true, status });
    }
    if (id && sub === 'logs' && method === 'GET') {
      const { results } = await db.prepare(
        'SELECT id, task_id, ts, level, text FROM logs WHERE task_id=? ORDER BY id DESC LIMIT 200'
      ).bind(id).all();
      return json({ logs: results || [] });
    }
    if (id && method === 'PUT') {
      const old = await db.prepare('SELECT * FROM tasks WHERE id=?').bind(id).first();
      if (!old) throw new HttpError('任务不存在', 404);
      const t = normalizeTask(await bodyJson(request));
      const next = scheduleChanged(old, t)
        ? initialNext(t, Math.floor(Date.now() / 1000), tzOffsetSec(env))
        : old.next_run_at;
      await db.prepare(
        'UPDATE tasks SET name=?, enabled=?, script_key=?, script_code=?, params=?, interval_amount=?, interval_unit=?, run_hour=?, run_day=?, next_run_at=? WHERE id=?'
      ).bind(t.name, t.enabled, t.script_key, t.script_code, t.params, t.interval_amount, t.interval_unit, t.run_hour, t.run_day, next, id).run();
      const task = await db.prepare('SELECT * FROM tasks WHERE id=?').bind(id).first();
      return json({ task: toClientTask(task) });
    }
    if (id && method === 'PATCH') {
      const body = await bodyJson(request);
      await db.prepare('UPDATE tasks SET enabled=? WHERE id=?').bind(body.enabled ? 1 : 0, id).run();
      const task = await db.prepare('SELECT * FROM tasks WHERE id=?').bind(id).first();
      return json({ task: toClientTask(task) });
    }
    if (id && method === 'DELETE') {
      await db.batch([
        db.prepare('DELETE FROM logs WHERE task_id=?').bind(id),
        db.prepare('DELETE FROM tasks WHERE id=?').bind(id),
      ]);
      return json({ ok: true });
    }
    throw new HttpError('不支持的方法', 405);
  }

  if (url.pathname === '/api/builtins' && method === 'GET') {
    return json({
      builtins: Object.keys(BUILTINS).map(function (k) {
        const b = BUILTINS[k];
        return { key: k, name: b.name, params: b.params, code: b.run.toString() };
      }),
    });
  }

  if (url.pathname === '/api/settings') {
    if (method === 'GET') {
      const nick = await getMeowNickname(db);
      return json({ meow_nickname: nick });
    }
    if (method === 'PUT') {
      const body = await bodyJson(request);
      const nick = String(body.meow_nickname || '').trim().slice(0, 100);
      await db.prepare(
        "INSERT INTO settings (key, value) VALUES ('meow_nickname', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      ).bind(nick).run();
      invalidateNickCache();
      return json({ ok: true });
    }
  }

  if (url.pathname === '/api/settings/test' && method === 'POST') {
    const body = await bodyJson(request);
    let nick = String(body.nickname || '').trim();
    if (!nick) nick = await getMeowNickname(db);
    await meowPush(env, nick, '青龙面板', '测试推送：通知通道正常');
    return json({ ok: true });
  }

  throw new HttpError('not found', 404);
}

// ---------- /health（公开，给外部监控用） ----------
async function handleHealth(env) {
  let nextAlarm = null, taskCount = 0, lastRun = null, error = null;
  try {
    await ensureReady(env);
    const row = await env.DB.prepare('SELECT COUNT(*) AS c, MAX(last_run_at) AS m FROM tasks').first();
    taskCount = row ? row.c : 0;
    lastRun = row ? row.m : null;
    nextAlarm = (await schedulerStub(env).ensureAlarm()).nextAlarm;
  } catch (e) {
    error = (e && e.message) || String(e);
  }
  return json({
    healthy: !error,
    error,
    taskCount,
    lastRun,
    nextAlarm,
    serverTime: Math.floor(Date.now() / 1000),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/health') return await handleHealth(env);
      if (!url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
      return await route(request, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.log('api error:', (e && e.stack) || e);
      return json({ error: (e && e.message) || String(e) }, 500);
    }
  },

  // cron 看门狗：每小时确保 DO 闹钟活着（真调度在 DO alarm 里）
  async scheduled(event, env, ctx) {
    ctx.waitUntil(schedulerStub(env).ensureAlarm().catch((e) => console.log('ensureAlarm:', (e && e.stack) || e)));
  },
};
