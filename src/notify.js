// 全局通知：MeoW（https://api.chuckfang.com），昵称存 settings 表。
// POST /{昵称}，body {"title": ..., "msg": ...}，与 DNSHE 脚本现行用法一致。

let cachedNick = null;
let cachedAt = 0;
const CACHE_MS = 60_000;

export async function getMeowNickname(db) {
  const now = Date.now();
  if (cachedNick !== null && now - cachedAt < CACHE_MS) return cachedNick;
  let nick = '';
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key='meow_nickname'").first();
    nick = row && row.value ? String(row.value) : '';
  } catch (e) {
    nick = '';
  }
  cachedNick = nick;
  cachedAt = now;
  return nick;
}

export function invalidateNickCache() {
  cachedNick = null;
  cachedAt = 0;
}

// MeoW 对标题里的冒号/斜杠敏感（参考 DNSHE 移植脚本的处理）
export function safeTitle(t) {
  return String(t).replace(/[:：/]/g, '-').slice(0, 64);
}

export async function meowPush(env, nickname, title, content) {
  if (!nickname) throw new Error('MeoW 昵称未配置');
  const res = await fetch('https://api.chuckfang.com/' + encodeURIComponent(nickname), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: safeTitle(title), msg: String(content).slice(0, 2000) }),
    signal: AbortSignal.timeout(10_000),
  });
  let ok = false;
  let detail = 'HTTP ' + res.status;
  try {
    const j = await res.json();
    ok = j.status === 200 || j.data === true;
    detail = JSON.stringify(j).slice(0, 200);
  } catch (e) {
    // 非 JSON 响应按 HTTP 状态处理
  }
  if (!ok) throw new Error('MeoW 推送未成功: ' + detail);
}
