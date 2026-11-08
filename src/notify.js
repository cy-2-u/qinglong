// 全局通知：TimelyNotify GET 直连（不限出口 IP），密钥存 settings 表，失败仅记日志。
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
  } catch (e) { key = ''; }
  cachedKey = key;
  cachedAt = now;
  return key;
}

export function invalidateKeyCache() {
  cachedKey = null;
  cachedAt = 0;
}

// URL 路径段对冒号/斜杠敏感，统一替换
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
  if (res.status === 200) return;
  const text = await res.text();
  throw new Error('通知推送未成功: HTTP ' + res.status + (text ? ': ' + text.slice(0, 200) : ''));
}
