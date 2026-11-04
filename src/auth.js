// 鉴权：HMAC 签名 Cookie（ql_sess=exp.sig），密钥即面板密码。
// Cookie 30 天有效；签名绑定过期时间，改密码（换 PANEL_PASSWORD）后旧 Cookie 全部失效。
const SESSION_TTL = 30 * 86400;
const enc = new TextEncoder();

function b64url(buf) {
  let s = btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacSign(password, msg) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode('ql:' + password),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

// 常数时间比较（先哈希对齐长度，避免时序侧信道）
async function safeEqual(a, b) {
  const da = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(a))));
  const db = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(b))));
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(da, db);
  let d = 0;
  for (let i = 0; i < da.length; i++) d |= da[i] ^ db[i];
  return d === 0;
}

export async function issueCookie(env) {
  const exp = String(Math.floor(Date.now() / 1000) + SESSION_TTL);
  return exp + '.' + (await hmacSign(env.PANEL_PASSWORD, exp));
}

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
  return safeEqual(await hmacSign(env.PANEL_PASSWORD, exp), sig);
}

export function getSessionCookie(request) {
  const m = /(?:^|;\s*)ql_sess=([^;]+)/.exec(request.headers.get('cookie') || '');
  return m ? decodeURIComponent(m[1]) : '';
}

export { safeEqual };
