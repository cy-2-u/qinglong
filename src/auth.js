// 鉴权：HMAC 签名 Cookie（ql_sess=exp.sig），密钥即面板密码；改密码全会话失效。
const SESSION_TTL = 30 * 86400;
const enc = new TextEncoder();

function b64url(buf) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(password, msg) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode('ql:' + password),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

// 先哈希到等长再比较——CF 的 timingSafeEqual 要求等长输入，且这层同时消了时序差
async function safeEqual(a, b) {
  const h = async (s) => crypto.subtle.digest('SHA-256', enc.encode(String(s)));
  return crypto.subtle.timingSafeEqual(await h(a), await h(b));
}

export async function issueCookie(env) {
  const exp = String(Math.floor(Date.now() / 1000) + SESSION_TTL);
  return exp + '.' + (await hmac(env.PANEL_PASSWORD, exp));
}

// secure=false 仅用于本地 http 调试（浏览器 localhost 对 Secure 有豁免，HTTP 客户端没有）
export function sessionCookieHeader(value, secure) {
  return 'ql_sess=' + encodeURIComponent(value) +
    '; HttpOnly' + (secure === false ? '' : '; Secure') + '; Path=/; SameSite=Lax; Max-Age=' + SESSION_TTL;
}

export async function validSession(env, value) {
  if (!value || !env.PANEL_PASSWORD) return false;
  const i = value.indexOf('.');
  if (i <= 0) return false;
  const exp = value.slice(0, i), sig = value.slice(i + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(await hmac(env.PANEL_PASSWORD, exp), sig);
}

export function getSessionCookie(request) {
  const m = /(?:^|;\s*)ql_sess=([^;]+)/.exec(request.headers.get('cookie') || '');
  return m ? decodeURIComponent(m[1]) : '';
}

export { safeEqual };
