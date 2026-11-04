// 全局通知：MeoW（https://api.chuckfang.com），昵称存 settings 表。
// MeoW 屏蔽 Cloudflare Workers 出口 IP，因此按序尝试多条通道，
// 任一成功即返回，全失败才抛错（错误信息带每次的响应体片段便于排错）：
//   1. 自建反代 POST  https://relay-nu-seven.vercel.app/api/meow/{昵称}   JSON body
//   2. 自建反代 GET   https://relay-nu-seven.vercel.app/api/meow/{昵称}/{标题}/{内容}
//   3. 中转 POST      https://down.nigx.cn/api.chuckfang.com/{昵称}       JSON body
//   4. 中转 GET       https://down.nigx.cn/api.chuckfang.com/{昵称}/{标题}/{内容}
//   5. 直连 POST      https://api.chuckfang.com/{昵称}                    JSON body
// 实测记录：down.nigx.cn 的 Cloudflare WAF 会按请求指纹拦截（本地全通、
// Worker 出口间歇 403 空 body），GET 指纹不同可通；Vercel 反代是自建函数
// 无 WAF 玄学（relay/ 目录，vercel --prod 部署，*.vercel.app 国内 DNS 被污染
// 但 Worker 在海外不受影响）。直连兜底给出口解禁时留活路。

let cachedNick = null;
let cachedAt = 0;
const CACHE_MS = 60_000;

const VERCEL_BASE = 'https://relay-nu-seven.vercel.app/api/meow/';
const RELAY_BASE = 'https://down.nigx.cn/api.chuckfang.com/';
const DIRECT_BASE = 'https://api.chuckfang.com/';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 10_000;

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

// 判定 MeoW 响应体：status===200 或 data===true 算成功
function parseMeowBody(res) {
  return res.text().then((text) => {
    if (!text) return { ok: false, detail: 'HTTP ' + res.status + '（空响应体）' };
    try {
      const j = JSON.parse(text);
      const ok = j.status === 200 || j.data === true;
      return { ok, detail: JSON.stringify(j).slice(0, 200) };
    } catch (e) {
      return { ok: false, detail: 'HTTP ' + res.status + ': ' + text.slice(0, 200) };
    }
  });
}

export async function meowPush(env, nickname, title, content) {
  if (!nickname) throw new Error('MeoW 昵称未配置');
  const nick = encodeURIComponent(nickname);
  const t = encodeURIComponent(safeTitle(title));
  const msg = encodeURIComponent(String(content).slice(0, 2000));
  const jsonBody = JSON.stringify({ title: safeTitle(title), msg: String(content).slice(0, 2000) });

  const attempts = [
    ['反代POST', VERCEL_BASE + nick, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: jsonBody,
    }],
    ['反代GET', VERCEL_BASE + nick + '/' + t + '/' + msg, {
      method: 'GET',
    }],
    ['中转POST', RELAY_BASE + nick, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': BROWSER_UA },
      body: jsonBody,
    }],
    ['中转GET', RELAY_BASE + nick + '/' + t + '/' + msg, {
      method: 'GET',
      headers: { 'user-agent': BROWSER_UA },
    }],
    ['直连POST', DIRECT_BASE + nick, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': BROWSER_UA },
      body: jsonBody,
    }],
  ];

  const errors = [];
  for (const [name, url, init] of attempts) {
    let res;
    try {
      res = await fetch(url, Object.assign({}, init, { signal: AbortSignal.timeout(TIMEOUT_MS) }));
    } catch (e) {
      errors.push(name + ': ' + ((e && e.message) || e));
      continue;
    }
    const { ok, detail } = await parseMeowBody(res);
    if (ok) return;
    errors.push(name + ': ' + detail);
  }
  throw new Error('MeoW 推送未成功 [' + errors.join(' | ') + ']');
}
