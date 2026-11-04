// 全局通知：MeoW（https://api.chuckfang.com），昵称存 settings 表。
// POST /{昵称}，body {"title": ..., "msg": ...}，与 DNSHE 脚本现行用法一致。
// MeoW 屏蔽 Cloudflare IP（Worker 出口全是 CF 段），故走 down.nigx.cn
// URL 中转（去掉协议头拼路径，POST/JSON 原样透传，已实测）。

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

// 中转前缀：MeoW 屏蔽 CF IP，Worker 出口走这里；格式为去协议头拼路径。
// UA 伪装成浏览器：中转在 Cloudflare 上，Workers 默认 UA 可能被其 WAF 拦。
const MEOW_BASE = 'https://down.nigx.cn/api.chuckfang.com/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function meowPush(env, nickname, title, content) {
  if (!nickname) throw new Error('MeoW 昵称未配置');
  const res = await fetch(MEOW_BASE + encodeURIComponent(nickname), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
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
    // 非 JSON 响应（如中转/WAF 拦截页）保留状态码 + 响应体片段便于排错
    try {
      const text = await res.text();
      if (text) detail = 'HTTP ' + res.status + ': ' + text.slice(0, 200);
    } catch (_) { /* 保持 HTTP 状态码 */ }
  }
  if (!ok) throw new Error('MeoW 推送未成功: ' + detail);
}
