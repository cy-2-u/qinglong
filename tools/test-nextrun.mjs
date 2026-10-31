// nextrun.js 调度数学的单元测试（node 直接跑，无 workerd 依赖）
// 用法: node test-nextrun.mjs
import assert from 'node:assert';
import { nextDailyAnchor, nextMonthlyAnchor, advanceNext, initialNext } from '../src/nextrun.js';

const TZ = 8 * 3600;
const DAY = 86400;

// 北京时间 y-m-d h:00 -> UTC 秒
function bj(y, m, d, h) {
  return Math.floor(Date.UTC(y, m - 1, d, h, 0, 0) / 1000) - TZ;
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
t('initial h: 每 12 小时，从 now 起算', () => {
  const now = bj(2026, 10, 31, 10);
  const task = { interval_unit: 'h', interval_amount: 12 };
  assert.strictEqual(initialNext(task, now, TZ), now + 12 * 3600);
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

console.log('\nALL ' + passed + ' TESTS PASSED');
