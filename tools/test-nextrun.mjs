// nextrun.js 调度数学的单元测试（node 直接跑，无 workerd 依赖）
// 用法: node tools/test-nextrun.mjs
import assert from 'node:assert';
import { nextDailyAnchor, nextMonthlyAnchor, advanceNext, initialNext, computeNext, healedAnchor, nextAlarmAt } from '../src/nextrun.js';

const TZ = 8 * 3600;
const DAY = 86400;

// 北京时间 y-m-d h:00 -> UTC 秒
function bj(y, m, d, h, min) {
  return Math.floor(Date.UTC(y, m - 1, d, h, min || 0, 0) / 1000) - TZ;
}

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log('ok -', name);
}

// ---- nextDailyAnchor ----
t('daily: 当天 9 点未到，返回今天 9 点（北京）', () => {
  const now = bj(2026, 10, 31, 8) + 60; // 北京 10-31 08:01
  assert.strictEqual(nextDailyAnchor(9, now, TZ), bj(2026, 10, 31, 9));
});
t('daily: 当天 9 点已过，返回明天 9 点', () => {
  const now = bj(2026, 10, 31, 9) + 1;
  assert.strictEqual(nextDailyAnchor(9, now, TZ), bj(2026, 11, 1, 9));
});
t('daily: now 恰好等于锚点，算已过期 -> 明天', () => {
  const now = bj(2026, 10, 31, 9);
  assert.strictEqual(nextDailyAnchor(9, now, TZ), bj(2026, 11, 1, 9));
});

// ---- nextMonthlyAnchor ----
t('monthly: 本月 1 号已过，返回下月 1 号', () => {
  const now = bj(2026, 10, 31, 12);
  assert.strictEqual(nextMonthlyAnchor(1, 9, now, TZ), bj(2026, 11, 1, 9));
});
t('monthly: run_day 大于当月天数时钳到月末', () => {
  const now = bj(2026, 1, 31, 12); // 北京 1-31 12:00，1 月 31 日 9 点已过
  // 2 月没有 31 号 -> 钳到 2-28
  assert.strictEqual(nextMonthlyAnchor(31, 9, now, TZ), bj(2026, 2, 28, 9));
});

// ---- initialNext ----
t('initial h: 整点创建，每 12 小时', () => {
  const now = bj(2026, 10, 31, 10);
  const task = { interval_unit: 'h', interval_amount: 12 };
  assert.strictEqual(initialNext(task, now, TZ), now + 12 * 3600);
});
t('initial h: 非整点创建锚点对齐整点（10:37 每 6 小时 -> 16:00）', () => {
  const now = bj(2026, 10, 31, 10) + 37 * 60;
  const task = { interval_unit: 'h', interval_amount: 6 };
  assert.strictEqual(initialNext(task, now, TZ), bj(2026, 10, 31, 16));
});
t('initial d: 每天 9 点', () => {
  const now = bj(2026, 10, 31, 20);
  const task = { interval_unit: 'd', interval_amount: 1, run_hour: 9 };
  assert.strictEqual(initialNext(task, now, TZ), bj(2026, 11, 1, 9));
});

// ---- advanceNext：补跑只补一次，锚点不漂移 ----
t('daily catch-up: 锚点落后 3 天，直接追到下一个未来 9 点', () => {
  const anchor = bj(2026, 10, 1, 9);
  const now = bj(2026, 10, 31, 10); // 锚点已过去 30 天
  const task = { interval_unit: 'd', interval_amount: 1, run_hour: 9 };
  assert.strictEqual(advanceNext(task, anchor, now, TZ), bj(2026, 11, 1, 9));
});
t('daily every-3-days: 锚点 + 3 天仍过期则继续前进', () => {
  const anchor = bj(2026, 10, 1, 9);
  const now = bj(2026, 10, 20, 10);
  const task = { interval_unit: 'd', interval_amount: 3, run_hour: 9 };
  // 10-4, 10-7 ... 全部过期，最近未来槽位 10-22 9:00
  assert.strictEqual(advanceNext(task, anchor, now, TZ), bj(2026, 10, 22, 9));
});
t('hourly catch-up: 每 6 小时，过期多个槽位追平', () => {
  const anchor = bj(2026, 10, 31, 0);
  const now = bj(2026, 10, 31, 23);
  const task = { interval_unit: 'h', interval_amount: 6 };
  // 0 点锚点，6h 步进：... 18, 次日 0 点 > 23 点
  assert.strictEqual(advanceNext(task, anchor, now, TZ), bj(2026, 11, 1, 0));
});
t('monthly catch-up: 每 2 月 1 号 9 点，跳过过期月份', () => {
  const anchor = bj(2026, 2, 1, 9);
  const now = bj(2026, 10, 15, 12);
  const task = { interval_unit: 'm', interval_amount: 2, run_hour: 9, run_day: 1 };
  // 4-1, 6-1, 8-1, 10-1 都过期 -> 12-1
  assert.strictEqual(advanceNext(task, anchor, now, TZ), bj(2026, 12, 1, 9));
});
t('monthly: 1 月 31 日 + 1 月 = 2 月末（锚点 31 号、run_day 28 以内不触发，但钳制仍在）', () => {
  const anchor = bj(2026, 1, 28, 9);
  const now = bj(2026, 1, 29, 12);
  const task = { interval_unit: 'm', interval_amount: 1, run_hour: 9, run_day: 28 };
  assert.strictEqual(advanceNext(task, anchor, now, TZ), bj(2026, 2, 28, 9));
});

// ---- computeNext：单次天/月任务从规则锚点重算（自愈），其余走锚点推进 ----
t('computeNext: 单次日任务走规则锚点（漂移被拉回）', () => {
  const now = bj(2026, 10, 31, 10);
  const task = { interval_unit: 'd', interval_amount: 1, run_hour: 9 };
  // 旧锚点漂移到 08:00 也不影响：结果严格按规则 = 明天 9 点
  assert.strictEqual(computeNext(task, bj(2026, 10, 31, 8), now, TZ), bj(2026, 11, 1, 9));
});
t('computeNext: 每 3 天任务走锚点推进', () => {
  const anchor = bj(2026, 10, 20, 9);
  const now = bj(2026, 10, 20, 10);
  const task = { interval_unit: 'd', interval_amount: 3, run_hour: 9 };
  assert.strictEqual(computeNext(task, anchor, now, TZ), bj(2026, 10, 23, 9));
});
t('computeNext: 小时任务走锚点推进', () => {
  const anchor = bj(2026, 10, 31, 0);
  const now = bj(2026, 10, 31, 1);
  const task = { interval_unit: 'h', interval_amount: 6 };
  assert.strictEqual(computeNext(task, anchor, now, TZ), bj(2026, 10, 31, 6));
});
t('computeNext: 单次月任务走规则锚点', () => {
  const now = bj(2026, 10, 31, 12);
  const task = { interval_unit: 'm', interval_amount: 1, run_hour: 9, run_day: 1 };
  assert.strictEqual(computeNext(task, bj(2026, 10, 1, 9), now, TZ), bj(2026, 11, 1, 9));
});

// ---- healedAnchor：心跳期漂移纠正 ----
t('healedAnchor: 漂移的单次日任务给纠正值', () => {
  const now = bj(2026, 10, 31, 10);
  const task = { enabled: 1, interval_unit: 'd', interval_amount: 1, run_hour: 9, next_run_at: bj(2026, 11, 1, 8) };
  assert.strictEqual(healedAnchor(task, now, TZ), bj(2026, 11, 1, 9));
});
t('healedAnchor: 锚点正确返回 null', () => {
  const now = bj(2026, 10, 31, 10);
  const task = { enabled: 1, interval_unit: 'd', interval_amount: 1, run_hour: 9, next_run_at: bj(2026, 11, 1, 9) };
  assert.strictEqual(healedAnchor(task, now, TZ), null);
});
t('healedAnchor: 已到期的任务不碰（交给执行路径）', () => {
  const now = bj(2026, 10, 31, 10);
  const task = { enabled: 1, interval_unit: 'd', interval_amount: 1, run_hour: 9, next_run_at: bj(2026, 10, 31, 9) };
  assert.strictEqual(healedAnchor(task, now, TZ), null);
});
t('healedAnchor: 多天任务不碰（相位合法）', () => {
  const now = bj(2026, 10, 31, 10);
  assert.strictEqual(healedAnchor({ enabled: 1, interval_unit: 'd', interval_amount: 3, run_hour: 9, next_run_at: bj(2026, 11, 1, 9) }, now, TZ), null);
  assert.strictEqual(healedAnchor({ enabled: 0, interval_unit: 'd', interval_amount: 1, run_hour: 9, next_run_at: bj(2026, 11, 1, 9) }, now, TZ), null);
});
t('healedAnchor: 每小时任务漂移到 :37 -> 对齐下一个整点', () => {
  const now = bj(2026, 10, 31, 10);
  const task = { enabled: 1, interval_unit: 'h', interval_amount: 1, next_run_at: now + 37 * 60 };
  assert.strictEqual(healedAnchor(task, now, TZ), bj(2026, 10, 31, 11));
});
t('healedAnchor: 每小时任务锚点已是整点 -> null', () => {
  const now = bj(2026, 10, 31, 10);
  const task = { enabled: 1, interval_unit: 'h', interval_amount: 1, next_run_at: bj(2026, 10, 31, 11) };
  assert.strictEqual(healedAnchor(task, now, TZ), null);
});

// ---- nextAlarmAt：DO 闹钟 = min(最近锚点 + eps, now + cap) ----
const CAP = 3600_000, EPS = 5000;
t('nextAlarmAt: 未来锚点定到锚点后 5 秒（:30 的锚点也能准点）', () => {
  const nowMs = bj(2026, 11, 1, 8) * 1000;
  const anchor = bj(2026, 11, 1, 8, 30); // 半小时外，不被封顶钳掉
  assert.strictEqual(nextAlarmAt(anchor, nowMs, CAP, EPS), anchor * 1000 + EPS);
});
t('nextAlarmAt: 锚点远于 1 小时封顶为 now + 1h（看门狗兜底）', () => {
  const nowMs = bj(2026, 11, 1, 9, 0) * 1000;
  const anchor = bj(2026, 11, 2, 9); // 明天，远超 1 小时
  assert.strictEqual(nextAlarmAt(anchor, nowMs, CAP, EPS), nowMs + CAP);
});
t('nextAlarmAt: 锚点已过期 -> now + 1s 立即补跑', () => {
  const nowMs = bj(2026, 11, 1, 10) * 1000;
  const anchor = bj(2026, 11, 1, 9); // 已过期
  assert.strictEqual(nextAlarmAt(anchor, nowMs, CAP, EPS), nowMs + 1000);
});
t('nextAlarmAt: 无启用任务 -> now + 1h', () => {
  const nowMs = bj(2026, 11, 1, 10) * 1000;
  assert.strictEqual(nextAlarmAt(null, nowMs, CAP, EPS), nowMs + CAP);
  assert.strictEqual(nextAlarmAt(0, nowMs, CAP, EPS), nowMs + CAP);
});
t('nextAlarmAt: 锚点近在眼前 -> 仍定到锚点 + eps（now+2s），不早于锚点空响', () => {
  const nowMs = bj(2026, 11, 1, 9) * 1000;
  const anchor = bj(2026, 11, 1, 9) - 3; // 差 3 秒到锚点，锚点+5s = now+2s
  assert.strictEqual(nextAlarmAt(anchor, nowMs, CAP, EPS), nowMs + 2000);
});

console.log('\nALL ' + passed + ' TESTS PASSED');
