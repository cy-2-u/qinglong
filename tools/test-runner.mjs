// runner.js 执行链的端到端测试——直接穿透 runTaskById（单元测试只调脚本，
// 覆盖不到 runOne 的收尾段；result 作用域 ReferenceError 事故就是从这漏掉的）。
// mock env.DB：内存版 tasks/logs 两表 + batch/prepare/first/all/run 最小实现。
// 用法: node tools/test-runner.mjs
import assert from 'node:assert';
import { runTaskById } from '../src/runner.js';
import { BUILTINS } from '../src/builtins.js';

// ---------- 内存 D1（只实现 runner 实际用到的 SQL） ----------
function makeEnv() {
  const tasks = [];
  const logs = [];
  let logId = 0;
  const find = (id) => tasks.find((t) => t.id === id);
  const env = {
    _seq: 1,
    tasks, logs,
    DB: {
      prepare(sql) {
        const s = sql.replace(/\s+/g, ' ').trim();
        const api = {
          sql: s,
          b: [],
          bind(...b) { api.b = b; return api; },
          async first() {
            if (/^SELECT \* FROM tasks WHERE id/.test(s)) return find(api.b[0]) || null;
            if (/^SELECT id FROM tasks WHERE name/.test(s)) { const r = tasks.find((t) => t.name === api.b[0]); return r ? { id: r.id } : null; }
            if (/SELECT value FROM settings WHERE key='seeded'/.test(s)) return { value: '1' }; // 跳过播种
            return null;
          },
          async all() {
            if (/WHERE enabled=1 AND next_run_at/.test(s)) return { results: tasks.filter((t) => t.enabled === 1 && t.next_run_at <= api.b[0] && t.last_status !== 'running') };
            if (/FROM logs WHERE task_id/.test(s)) return { results: logs.filter((l) => l.task_id === api.b[0]).sort((a, b) => b.id - a.id).slice(0, 200) };
            return { results: [] };
          },
          async run() {
            if (/^CREATE TABLE|^CREATE INDEX|^ALTER TABLE/.test(s)) return { meta: {} }; // DDL/迁移：no-op
            if (/^UPDATE tasks SET last_status='running' WHERE id/.test(s)) { const t = find(api.b[0]); if (t) t.last_status = 'running'; return { meta: {} }; }
            if (/^UPDATE tasks SET last_run_at=\?, last_status=\? WHERE/.test(s)) { const t = find(api.b[2]); if (t) { t.last_run_at = api.b[0]; t.last_status = api.b[1]; } return { meta: {} }; }
            if (/^UPDATE tasks SET last_run_at=\?, last_status=\?, next_run_at=\? WHERE/.test(s)) { const t = find(api.b[3]); if (t) { t.last_run_at = api.b[0]; t.last_status = api.b[1]; t.next_run_at = api.b[2]; } return { meta: {} }; }
            if (/^INSERT INTO logs/.test(s)) { logs.push({ id: ++logId, task_id: api.b[0], ts: api.b[1], level: api.b[2], text: api.b[3] }); return { meta: {} }; }
            if (/^DELETE FROM logs WHERE task_id=\?$/.test(s)) { for (let i = logs.length - 1; i >= 0; i--) if (logs[i].task_id === api.b[0]) logs.splice(i, 1); return { meta: {} }; }
            if (/^DELETE FROM tasks WHERE id=\?$/.test(s)) { const i = tasks.findIndex((t) => t.id === api.b[0]); if (i >= 0) tasks.splice(i, 1); return { meta: {} }; }
            if (/^INSERT INTO tasks/.test(s)) {
              const [name, enabled, script_key, params, ia, iu, rh, rm, rd, nr] = api.b;
              const row = { id: env._seq++, name, enabled, script_key, params, interval_amount: ia, interval_unit: iu, run_hour: rh, run_minute: rm, run_day: rd, next_run_at: nr, last_status: 'never', last_run_at: null };
              tasks.push(row);
              return { meta: { last_row_id: row.id } };
            }
            throw new Error('memDb: unsupported sql: ' + s);
          },
        };
        return api;
      },
      async batch(stmts) {
        const out = [];
        for (const s of stmts) {
          const sql = s.sql;
          if (/^INSERT INTO logs/.test(sql)) out.push(await s.run());
          else if (/^CREATE TABLE|^CREATE INDEX|^ALTER TABLE|^DELETE FROM logs WHERE task_id=\? AND id NOT IN/.test(sql)) { /* DDL 与环形裁剪在测试规模内无意义 */ }
          else throw new Error('memDb.batch: unsupported: ' + sql);
        }
        return out;
      },
    },
  };
  // ensureReady 的记忆化开关：直接绕过（测试不走 seed）
  return env;
}

// 临时注册测试专用内置脚本（直接挂 BUILTINS，node 进程结束即消失）
function addTestBuiltin(key, impl) {
  BUILTINS[key] = { name: '测试脚本', params: [], run: impl };
}

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

t('手动运行：日志落库 + 状态 ok + next_run_at 不被推进', async () => {
  const env = makeEnv();
  env.tasks.push({ id: 1, name: 'T', enabled: 1, script_key: 'tb-ok', params: '{}', last_status: 'never', last_run_at: null, next_run_at: 999999 });
  addTestBuiltin('tb-ok', async (ctx) => { ctx.log('干完了'); });
  const status = await runTaskById(env, 1);
  assert.strictEqual(status, 'ok');
  assert.strictEqual(env.tasks[0].last_status, 'ok', '状态翻 ok');
  assert.ok(env.tasks[0].last_run_at > 0, 'last_run_at 更新');
  assert.strictEqual(env.tasks[0].next_run_at, 999999, '手动运行不动锚点');
  assert.ok(env.logs.some((l) => l.text === '开始执行'), '日志落库：开始');
  assert.ok(env.logs.some((l) => l.text === '干完了'), '日志落库：脚本行');
  assert.ok(env.logs.some((l) => /执行结束: 成功/.test(l.text)), '日志落库：收尾');
});

t('脚本抛错：状态 failed、错误入日志（通知之后炸也必须收尾）', async () => {
  const env = makeEnv();
  env.tasks.push({ id: 1, name: 'T', enabled: 1, script_key: 'tb-throw', params: '{}', last_status: 'never', next_run_at: 999999 });
  addTestBuiltin('tb-throw', async (ctx) => { await ctx.notify('标题', '内容'); throw new Error('通知之后炸'); });
  const status = await runTaskById(env, 1);
  assert.strictEqual(status, 'failed');
  assert.strictEqual(env.tasks[0].last_status, 'failed', '状态翻 failed——今天的事故就是这里没执行');
  assert.ok(env.logs.some((l) => l.level === 'error' && l.text === '通知之后炸'), '错误落库');
  assert.ok(env.logs.some((l) => /执行结束: 失败/.test(l.text)), '收尾行落库');
});

t('defer 载荷：60 秒后的补跑任务被创建', async () => {
  const env = makeEnv();
  env.tasks.push({ id: 1, name: '主任务', enabled: 1, script_key: 'tb-defer', params: '{}', last_status: 'never', next_run_at: 999999 });
  addTestBuiltin('tb-defer', async () => ({ defer: { cookie: 'leftovers' } }));
  const status = await runTaskById(env, 1);
  assert.strictEqual(status, 'ok');
  const temp = env.tasks.find((t) => t.name === '主任务（补跑）');
  assert.ok(temp, '补跑任务行已建');
  assert.strictEqual(temp.interval_unit, 'h', '临时任务单位 h');
  const p = JSON.parse(temp.params);
  assert.strictEqual(p.cookie, 'leftovers', '载荷透传');
  assert.ok(temp.next_run_at - 60 <= Math.floor(Date.now() / 1000) + 5, '60 秒后触发');
});

t('running 短路：手动运行撞上运行中任务直接返回 running', async () => {
  const env = makeEnv();
  env.tasks.push({ id: 1, name: 'T', enabled: 1, script_key: 'tb-ok', params: '{}', last_status: 'running', next_run_at: 999999 });
  const status = await runTaskById(env, 1);
  assert.strictEqual(status, 'running');
  assert.strictEqual(env.logs.length, 0, '短路不产生日志');
});

const passed = await (async function () {
  let n = 0;
  for (const [name, fn] of cases) {
    await fn();
    n++;
    console.log('ok -', name);
  }
  return n;
})();
console.log('\nALL ' + passed + ' RUNNER TESTS PASSED');
