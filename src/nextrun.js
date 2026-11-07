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
// 小时任务锚点规范化到整点：界面没有分钟概念，锚点一律落在 H:00。
// 从"当前整点 + N 小时"起算（创建于 09:37、每 6 小时 → 首跑 15:00），
// advanceNext 的整步推进保持 :00 相位不再漂移。
export function initialNext(task, nowSec, tzOff) {
  if (task.interval_unit === 'h') {
    const hourStart = Math.floor(nowSec / 3600) * 3600;
    return hourStart + Math.max(1, task.interval_amount | 0) * 3600;
  }
  if (task.interval_unit === 'd') {
    return nextDailyAnchor(task.run_hour == null ? 9 : task.run_hour, nowSec, tzOff);
  }
  return nextMonthlyAnchor(task.run_day == null ? 1 : task.run_day, task.run_hour == null ? 9 : task.run_hour, nowSec, tzOff);
}

// 执行后统一推进：单次天/月任务的下一锚点完全由规则决定（自愈式），不再依赖
// 旧锚点连加，从根上消除累积漂移；多天/小时/多月仍走锚点推进（advanceNext）。
export function computeNext(task, prevAnchor, nowSec, tzOff) {
  const n = Math.max(1, task.interval_amount | 0);
  if (n === 1 && task.interval_unit === 'd') {
    return nextDailyAnchor(task.run_hour == null ? 9 : task.run_hour, nowSec, tzOff);
  }
  if (n === 1 && task.interval_unit === 'm') {
    return nextMonthlyAnchor(task.run_day == null ? 1 : task.run_day, task.run_hour == null ? 9 : task.run_hour, nowSec, tzOff);
  }
  return advanceNext(task, prevAnchor, nowSec, tzOff);
}

// 心跳期漂移自愈：单次天/月任务重算规则锚点、每小时任务对齐整点；若 next_run_at
// 与规则不符（时钟回拨、创建时刻带入的 :xx 相位、历史版本漂移值），返回纠正值；
// 一致或不宜触碰返回 null。多天 / 多月 / 多小时任务锚点相位合法，不碰。
export function healedAnchor(task, nowSec, tzOff) {
  if (!task.enabled || task.interval_amount !== 1) return null;
  if (!(task.next_run_at > nowSec)) return null; // 已到期 → 交给执行路径，不抢
  let correct;
  if (task.interval_unit === 'd') {
    correct = nextDailyAnchor(task.run_hour == null ? 9 : task.run_hour, nowSec, tzOff);
  } else if (task.interval_unit === 'm') {
    correct = nextMonthlyAnchor(task.run_day == null ? 1 : task.run_day, task.run_hour == null ? 9 : task.run_hour, nowSec, tzOff);
  } else if (task.interval_unit === 'h') {
    correct = (Math.floor(nowSec / 3600) + 1) * 3600; // 下一个整点
  } else {
    return null;
  }
  return correct !== task.next_run_at ? correct : null;
}

// DO 闹钟时刻 = min(最近任务锚点 + eps, now + cap)，全部毫秒：
// - 锚点未来 → 定到锚点后几秒，任务准点执行
// - 锚点已过期 → now + 1s，立刻唤醒补跑
// - 无启用任务 / 锚点太远 / 查询失败 → now + cap（每小时看门狗兜底）
export function nextAlarmAt(minNextRunSec, nowMs, capMs, epsMs) {
  let at = nowMs + capMs;
  const t = Number(minNextRunSec);
  if (t > 0) {
    const dueMs = t * 1000 + epsMs;
    if (dueMs <= nowMs) return nowMs + 1000;
    at = Math.min(Math.max(dueMs, nowMs + 1000), nowMs + capMs);
  }
  return at;
}
