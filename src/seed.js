// D1 建表 + 内置脚本播种。ensureReady 在每个入口（API / 心跳）调用，
// isolate 内记忆化，成功一次后不再打数据库。
import GLADOS_SCRIPT from './scripts/glados-checkin.txt';
import DNSHE_SCRIPT from './scripts/dnshe-renew.txt';
import { initialNext, tzOffsetSec } from './nextrun.js';

const DDL = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    script_code TEXT NOT NULL DEFAULT '',
    params TEXT NOT NULL DEFAULT '{}',
    interval_amount INTEGER NOT NULL DEFAULT 1,
    interval_unit TEXT NOT NULL DEFAULT 'd',
    run_hour INTEGER,
    run_day INTEGER,
    last_run_at INTEGER,
    last_status TEXT NOT NULL DEFAULT 'never',
    next_run_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    text TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_logs_task ON logs(task_id, id)',
  "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')",
];

const BUILTINS = [
  {
    name: 'GLaDOS 签到',
    script_code: GLADOS_SCRIPT,
    params: { cookie: '', exchange_plan: '', push_level: 'all' },
    interval_unit: 'd', interval_amount: 1, run_hour: 9, run_day: null,
  },
  {
    name: 'DNSHE 域名续期',
    script_code: DNSHE_SCRIPT,
    params: { api_key: '', api_secret: '', threshold_days: '180', min_interval: '2', tz_offset: '8', push_level: 'all' },
    interval_unit: 'm', interval_amount: 1, run_hour: 9, run_day: 1,
  },
];

let ready = false;

export async function ensureReady(env) {
  if (ready) return;
  const db = env.DB;
  if (!db) throw new Error('D1 未绑定（检查 wrangler.toml 的 database_id）');
  await db.batch(DDL.map((sql) => db.prepare(sql)));

  const seeded = await db.prepare("SELECT value FROM settings WHERE key='seeded'").first();
  if (!seeded) {
    const cnt = await db.prepare('SELECT COUNT(*) AS c FROM tasks').first();
    if (!cnt || cnt.c === 0) {
      const now = Math.floor(Date.now() / 1000);
      const tz = tzOffsetSec(env);
      for (const t of BUILTINS) {
        const next = initialNext(t, now, tz);
        await db.prepare(
          'INSERT INTO tasks (name, enabled, script_code, params, interval_amount, interval_unit, run_hour, run_day, next_run_at) VALUES (?,?,?,?,?,?,?,?,?)'
        ).bind(t.name, 1, t.script_code, JSON.stringify(t.params), t.interval_amount, t.interval_unit, t.run_hour, t.run_day, next).run();
      }
    }
    await db.prepare("INSERT INTO settings (key, value) VALUES ('seeded','1') ON CONFLICT(key) DO NOTHING").run();
  }
  ready = true;
}
