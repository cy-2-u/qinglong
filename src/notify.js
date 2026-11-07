// 全局通知：TimelyNotify（https://timelynotify.oicode.cn），密钥存 settings 表。
// GET /{key}/{title}/{body}?group=qinglong，title/body 均 URL 编码。
// 该服务不限出口 IP，Worker 直连即可，无需中转/兜底链。
// 发送失败仅记日志（ctx.notify 捕获），不影响任务结果判定。

let cachedKey = null;
let cachedAt = 0;
const CACHE_MS = 60_000;

const BASE = 'https://timelynotify.oicode.cn/';
const GROUP = 'qinglong';

export async function getNotifyKey(db) {
  const now = Date.now();
  if (cachedKey !== null && now - cachedAt < CACHE_MS) return cachedKey;
  let key = '';
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key='notify_key'").first();
    key = row && row.value ? String(row.value) : '';
  } catch (e) {
    key = '';
  }
  cachedKey = key;
  cachedAt = now;
  return key;
}

export function invalidateKeyCache() {
  cachedKey = null;
  cachedAt = 0;
}

// URL 路径段对冒号/斜杠敏感，统一替换为 '-'
export function safeTitle(t) {
  return String(t).replace(/[:：/]/g, '-').slice(0, 64);
}

export async function notifyPush(env, key, title, content) {
  if (!key) throw new Error('通知密钥未配置');
  const url = BASE + encodeURIComponent(key) +
    '/' + encodeURIComponent(safeTitle(title)) +
    '/' + encodeURIComponent(String(content).slice(0, 2000)) +
    '?group=' + GROUP;
  const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10_000) });
  let detail = 'HTTP ' + res.status;
  try {
    const text = await res.text();
    if (text) detail = 'HTTP ' + res.status + ': ' + text.slice(0, 200);
  } catch (e) { /* 保持状态码 */ }
  if (res.status !== 200) throw new Error('通知推送未成功: ' + detail);
}
