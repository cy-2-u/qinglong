// next_run_at 计算：北京时间（UTC+8，可由 TZ_OFFSET 调整）锚定时刻。
// 所有时间为秒级 Unix 时间戳。

const DAY = 86400;

export function tzOffsetSec(env) {
  return (Number(env && env.TZ_OFFSET) || 8) * 3600;
}

function daysInMonth(y, m) {
  // m: 0-11
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

// 北京时间 run_hour 点整，严格晚于 nowSec 的第一个匹配
export function nextDailyAnchor(runHour, nowSec, tzOff) {
  const bj = new Date((nowSec + tzOff) * 1000);
  const y = bj.getUTCFullYear(), m = bj.getUTCMonth(), d = bj.getUTCDate();
  let t = Math.floor(Date.UTC(y, m, d, runHour, 0, 0) / 1000) - tzOff;
  if (t <= nowSec) t += DAY;
  return t;
}

// 北京时间 run_day 日 run_hour 点整，严格晚于 nowSec（runDay 1-28，天然避开月末钳制）
export function nextMonthlyAnchor(runDay, runHour, nowSec, tzOff) {
  const bj = new Date((nowSec + tzOff) * 1000);
  let y = bj.getUTCFullYear(), m = bj.getUTCMonth();
  for (let i = 0; i < 36; i++) {
    const d = Math.min(runDay, daysInMonth(y, m));
    const t = Math.floor(Date.UTC(y, m, d, runHour, 0, 0) / 1000) - tzOff;
    if (t > nowSec) return t;
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  return nowSec + DAY;
}

// 任务执行后推进 next_run_at：以旧锚点为基准前进 N 个单位，
// 用 while 跳过停摆期间错过的所有槽位（补跑一次、直接追到未来最新一档）。
export function advanceNext(task, prevAnchor, nowSec, tzOff) {
  const n = Math.max(1, task.interval_amount | 0);
  const unit = task.interval_unit;

  if (unit === 'h') {
    let t = (prevAnchor > 0 ? prevAnchor : nowSec) + n * 3600;
    while (t <= nowSec) t += n * 3600;
    return t;
  }

  if (unit === 'd') {
    const hour = task.run_hour == null ? 9 : task.run_hour;
    const base = prevAnchor > 0 ? prevAnchor : nextDailyAnchor(hour, nowSec, tzOff);
    let t = base + n * DAY;
    while (t <= nowSec) t += n * DAY;
    return t;
  }

  // 月：在旧锚点的北京日期上按日历推进，每步跨 N 个日历月
  const anchorDay = task.run_day == null ? 1 : task.run_day;
  const hour = task.run_hour == null ? 9 : task.run_hour;
  const base = prevAnchor > 0 ? prevAnchor : nowSec;
  const bj = new Date((base + tzOff) * 1000);
  let y = bj.getUTCFullYear(), m = bj.getUTCMonth();
  let t = 0;
  for (let i = 0; i < 60; i++) {
    m += n;
    while (m > 11) { m -= 12; y += 1; }
    const d = Math.min(anchorDay, daysInMonth(y, m));
    t = Math.floor(Date.UTC(y, m, d, hour, 0, 0) / 1000) - tzOff;
    if (t > nowSec) return t;
  }
  return t || nowSec + DAY;
}

// 新建任务的首个 next_run_at
export function initialNext(task, nowSec, tzOff) {
  if (task.interval_unit === 'h') {
    return nowSec + Math.max(1, task.interval_amount | 0) * 3600;
  }
  if (task.interval_unit === 'd') {
    return nextDailyAnchor(task.run_hour == null ? 9 : task.run_hour, nowSec, tzOff);
  }
  return nextMonthlyAnchor(task.run_day == null ? 1 : task.run_day, task.run_hour == null ? 9 : task.run_hour, nowSec, tzOff);
}
