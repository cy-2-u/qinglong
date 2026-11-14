import { initialNext, now, offset } from './schedule.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, script_key TEXT, params TEXT NOT NULL DEFAULT '{}',
    interval_amount INTEGER NOT NULL DEFAULT 1, interval_unit TEXT NOT NULL DEFAULT 'd',
    run_hour INTEGER, run_minute INTEGER, run_day INTEGER, last_run_at INTEGER,
    last_status TEXT NOT NULL DEFAULT 'never', next_run_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL,
    ts INTEGER NOT NULL, level TEXT NOT NULL DEFAULT 'info', text TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS idx_logs_task ON logs(task_id,id)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(enabled,next_run_at)',
  "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')",
  `CREATE TABLE IF NOT EXISTS jobs (task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    due INTEGER NOT NULL, params TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued')`,
];
const FIELDS = ['name','enabled','script_key','params','interval_amount','interval_unit','run_hour','run_minute','run_day','next_run_at'];
export class Store {
  constructor(db) { this.db = db; }
  query(sql, ...args) { return this.db.prepare(sql).bind(...args); }
  async init(env) {
    await this.db.batch(SCHEMA.map(s => this.db.prepare(s)));
    const { results } = await this.db.prepare('PRAGMA table_info(tasks)').all();
    if (!results.some(c => c.name === 'run_minute')) await this.db.prepare('ALTER TABLE tasks ADD COLUMN run_minute INTEGER').run();
    const seeded = await this.query("SELECT value FROM settings WHERE key='seeded'").first();
    if (!seeded) {
      const row = await this.query('SELECT COUNT(*) AS n FROM tasks').first();
      const statements = [];
      if (!row.n) for (const [name, key, unit] of [['GLaDOS 签到','glados-checkin','d'],['DNSHE 域名续期','dnshe-renew','m']]) {
        const t = { name, script_key: key, params: '{}', enabled: 0, interval_amount: 1, interval_unit: unit, run_hour: 9, run_minute: 0, run_day: unit === 'm' ? 1 : null };
        t.next_run_at = initialNext(t, now(), offset(env));
        statements.push(this.insert(t));
      }
      statements.push(this.query("INSERT OR IGNORE INTO settings(key,value) VALUES('seeded','1')"));
      await this.db.batch(statements);
    }
    if (!(await this.query("SELECT value FROM settings WHERE key='jobs_v1'").first())) {
      const legacy = "interval_unit='h' AND interval_amount=1 AND run_hour IS NULL AND run_day IS NULL AND ((script_key='glados-checkin' AND name='GLaDOS 签到（补跑）') OR (script_key='dnshe-renew' AND name='DNSHE 域名续期（补跑）'))";
      await this.db.batch([
        this.query(`INSERT INTO logs(task_id,ts,level,text) SELECT id,?,'error','旧版补跑行已暂停，请核对剩余项后手动处理；任务和凭据均已保留' FROM tasks WHERE enabled=1 AND ${legacy}`, now()),
        this.query(`UPDATE tasks SET enabled=0 WHERE ${legacy}`),
        this.query("INSERT INTO settings(key,value) VALUES('jobs_v1','1')"),
      ]);
    }
  }
  insert(task) { return this.query(`INSERT INTO tasks (${FIELDS.join(',')}) VALUES (${FIELDS.map(() => '?').join(',')})`, ...FIELDS.map(k => task[k])); }
  async list() {
    const { results } = await this.query(`SELECT t.*, j.due AS pending_at, j.kind AS pending_kind FROM tasks t
      LEFT JOIN jobs j ON j.task_id=t.id ORDER BY t.id`).all();
    return results.map(t => ({ ...t, params: JSON.parse(t.params) }));
  }
  task(id) { return this.query('SELECT * FROM tasks WHERE id=?', id).first(); }
  async create(t) {
    const result = await this.insert({ ...t, params: JSON.stringify(t.params) }).run();
    return Number(result.meta.last_row_id);
  }
  async update(id, t) {
    await this.query(`UPDATE tasks SET ${FIELDS.map(k => `${k}=?`).join(',')} WHERE id=?`,
      ...FIELDS.map(k => k === 'params' ? JSON.stringify(t[k]) : t[k]), id).run();
  }
  async remove(id) {
    await this.db.batch(['DELETE FROM jobs WHERE task_id=?','DELETE FROM logs WHERE task_id=?','DELETE FROM tasks WHERE id=?'].map(s => this.query(s, id)));
  }
  async toggle(id, enabled) {
    await this.db.batch([this.query('UPDATE tasks SET enabled=? WHERE id=?', enabled, id),
      ...(!enabled ? [this.query('DELETE FROM jobs WHERE task_id=?', id)] : [])]);
  }
  job(id) { return this.query('SELECT * FROM jobs WHERE task_id=?', id).first(); }
  async enqueue(task, kind, due, next = null) {
    const statements = [this.query('INSERT OR IGNORE INTO jobs(task_id,due,params,kind) VALUES(?,?,?,?)', task.id, due, task.params, kind)];
    if (next !== null) statements.push(this.query('UPDATE tasks SET next_run_at=? WHERE id=?', next, task.id));
    await this.db.batch(statements);
  }
  async due(time) { return (await this.query('SELECT * FROM tasks WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at,id', time).all()).results; }
  nextJob(time) { return this.query("SELECT j.*, t.script_key, t.name FROM jobs j JOIN tasks t ON t.id=j.task_id WHERE t.enabled=1 AND j.state='queued' AND j.due<=? ORDER BY j.due,j.task_id LIMIT 1", time).first(); }
  async earliest() {
    const row = await this.query(`SELECT MIN(at) AS at FROM (
      SELECT next_run_at AS at FROM tasks WHERE enabled=1
      UNION ALL SELECT due AS at FROM jobs WHERE state='queued')`).first();
    return row.at;
  }
  async recover() {
    await this.db.batch([
      this.query("INSERT INTO logs(task_id,ts,level,text) SELECT id,?,'error','上次执行中断；请检查结果后手动运行，避免重复提交' FROM tasks WHERE last_status='running'", now()),
      this.query("UPDATE tasks SET last_status='failed' WHERE last_status='running'"),
      this.query("DELETE FROM jobs WHERE state='running'"),
    ]);
  }
  async start(id) {
    await this.db.batch([this.query("UPDATE jobs SET state='running' WHERE task_id=?", id), this.query("UPDATE tasks SET last_status='running' WHERE id=?", id)]);
  }
  async finish(id, status, lines, remaining) {
    const statements = lines.map(l => this.query('INSERT INTO logs(task_id,ts,level,text) VALUES(?,?,?,?)', id, l.ts, l.level, l.text));
    statements.push(this.query('UPDATE tasks SET last_status=?,last_run_at=? WHERE id=?', status, now(), id));
    statements.push(remaining ? this.query("UPDATE jobs SET state='queued',due=?,params=?,kind='defer' WHERE task_id=?", now() + 60, JSON.stringify(remaining), id) : this.query('DELETE FROM jobs WHERE task_id=?', id));
    statements.push(this.query('DELETE FROM logs WHERE task_id=? AND id NOT IN (SELECT id FROM logs WHERE task_id=? ORDER BY id DESC LIMIT 200)', id, id));
    await this.db.batch(statements);
  }
  async logs(id) { return (await this.query('SELECT * FROM logs WHERE task_id=? ORDER BY id DESC LIMIT 200', id).all()).results; }
  async key() { return (await this.query("SELECT value FROM settings WHERE key='notify_key'").first())?.value || ''; }
  async setKey(key) { await this.query("INSERT INTO settings(key,value) VALUES('notify_key',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key).run(); }
}
