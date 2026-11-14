const DAY = 86400;
const LIMITS = { h: 1439, d: 30, m: 12 };
export const now = () => Math.floor(Date.now() / 1000);
export class HttpError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function offset(env) {
  const value = Number(env.TZ_OFFSET ?? 8);
  if (!Number.isFinite(value) || value < -12 || value > 14) throw new Error('TZ_OFFSET 无效');
  return value * 3600;
}
function integer(value, min, max, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(`请输入 ${min}–${max} 的整数`);
  return n;
}
export function normalize(body, builtins) {
  if (!body || Array.isArray(body) || typeof body !== 'object') throw new HttpError('需要 JSON 对象');
  const name = String(body.name ?? '').trim();
  if (!name || name.length > 100) throw new HttpError('名称长度须为 1–100');
  if (!Object.hasOwn(builtins, body.script_key)) throw new HttpError('未知脚本');
  const unit = body.interval_unit;
  if (!Object.hasOwn(LIMITS, unit)) throw new HttpError('未知频率');
  const params = body.params ?? {};
  if (typeof params !== 'object' || Array.isArray(params) || params === null) throw new HttpError('参数须为对象');
  if (new TextEncoder().encode(JSON.stringify(params)).length > 65536) throw new HttpError('参数超过 64KB');
  if (![true, false, 0, 1].includes(body.enabled)) throw new HttpError('启用状态无效');
  return {
    name, script_key: body.script_key, params,
    enabled: Number(Boolean(body.enabled)), interval_unit: unit,
    interval_amount: integer(body.interval_amount, 1, LIMITS[unit], 1),
    run_hour: unit === 'h' ? null : integer(body.run_hour, 0, 23, 9),
    run_minute: unit === 'h' ? null : integer(body.run_minute, 0, 59, 0),
    run_day: unit === 'm' ? integer(body.run_day, 1, 28, 1) : null,
  };
}
export function scheduleChanged(a, b) {
  return ['interval_unit', 'interval_amount', 'run_hour', 'run_minute', 'run_day']
    .some(key => (a[key] ?? null) !== (b[key] ?? null));
}
function calendar(task, time, tz, monthShift = 0) {
  const d = new Date((time + tz) * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + monthShift,
    task.interval_unit === 'm' ? task.run_day ?? 1 : d.getUTCDate(),
    task.run_hour ?? 9, task.run_minute ?? 0) / 1000 - tz;
}
export function initialNext(task, time, tz) {
  if (task.interval_unit === 'h') return time + task.interval_amount * 60;
  let at = calendar(task, time, tz);
  if (at <= time) at = task.interval_unit === 'd' ? at + DAY : calendar(task, time, tz, 1);
  return at;
}
export function nextRun(task, time, tz) {
  const n = task.interval_amount;
  if (n === 1 && task.interval_unit !== 'h') return initialNext(task, time, tz);
  const base = task.next_run_at;
  if (!(base > 0)) return initialNext(task, time, tz);
  if (task.interval_unit !== 'm') {
    const step = n * (task.interval_unit === 'h' ? 60 : DAY);
    return base + Math.max(1, Math.floor((time - base) / step) + 1) * step;
  }
  const from = new Date((base + tz) * 1000), to = new Date((time + tz) * 1000);
  const months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth();
  let shift = Math.max(1, Math.floor(months / n)) * n;
  let at = calendar(task, base, tz, shift);
  if (at <= time) at = calendar(task, base, tz, shift + n);
  return at;
}
