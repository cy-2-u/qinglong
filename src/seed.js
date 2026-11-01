// D1 建表 + 迁移 + 内置任务播种。ensureReady 在每个入口（API / 心跳）调用，
// isolate 内记忆化，成功一次后不再打数据库。
import { initialNext, tzOffsetSec } from './nextrun.js';

const DDL = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    script_code TEXT NOT NULL DEFAULT '',
    script_key TEXT,
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

const SEED_TASKS = [
  {
    name: 'GLaDOS 签到', script_key: 'glados-checkin',
    params: { cookie: '' },
    interval_unit: 'd', interval_amount: 1, run_hour: 9, run_day: null,
  },
  {
    name: 'DNSHE 域名续期', script_key: 'dnshe-renew',
    params: { api_key: '', api_secret: '' },
    interval_unit: 'm', interval_amount: 1, run_hour: 9, run_day: 1,
  },
];

let ready = false;

export async function ensureReady(env) {
  if (ready) return;
  const db = env.DB;
  if (!db) throw new Error('D1 未绑定（检查 wrangler.toml 的 database_id）');
  await db.batch(DDL.map((sql) => db.prepare(sql)));

  // 迁移：旧库可能没有 script_key 列；已有任务的 script_code 按内容回填
  try {
    await db.prepare('ALTER TABLE tasks ADD COLUMN script_key TEXT').run();
  } catch (e) { /* 列已存在 */ }
  await db.prepare("UPDATE tasks SET script_key='glados-checkin' WHERE script_key IS NULL AND script_code LIKE '%GLaDOS%'").run();
  await db.prepare("UPDATE tasks SET script_key='dnshe-renew' WHERE script_key IS NULL AND script_code LIKE '%DNSHE%'").run();

  const seeded = await db.prepare("SELECT value FROM settings WHERE key='seeded'").first();
  if (!seeded) {
    // 原子认领播种权：部署后并发冷启动的多个 isolate 都会走到这里，
    // INSERT OR IGNORE 只有一个能写入成功（meta.changes===1），避免内置任务被重复播种
    const claim = await db.prepare(
      "INSERT INTO settings (key, value) VALUES ('seeded','1') ON CONFLICT(key) DO NOTHING"
    ).run();
    if (claim.meta.changes === 1) {
      const cnt = await db.prepare('SELECT COUNT(*) AS c FROM tasks').first();
      if (!cnt || cnt.c === 0) {
        const now = Math.floor(Date.now() / 1000);
        const tz = tzOffsetSec(env);
        for (const t of SEED_TASKS) {
          const next = initialNext(t, now, tz);
          await db.prepare(
            'INSERT INTO tasks (name, enabled, script_key, params, interval_amount, interval_unit, run_hour, run_day, next_run_at) VALUES (?,?,?,?,?,?,?,?,?)'
          ).bind(t.name, 1, t.script_key, JSON.stringify(t.params), t.interval_amount, t.interval_unit, t.run_hour, t.run_day, next).run();
        }
      }
    }
  }
  ready = true;
}
