const enc = new TextEncoder();
const TTL = 30 * 86400;
let cachedPassword, cachedKey;
async function key(password) {
  if (cachedPassword !== password) {
    cachedKey = await crypto.subtle.importKey('raw', enc.encode(`ql:${password}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign','verify']);
    cachedPassword = password;
  }
  return cachedKey;
}
const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function passwordMatches(input, password) {
  if (!password || typeof input !== 'string') return false;
  const digest = async s => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  const [a,b] = await Promise.all([digest(input),digest(password)]);
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
export async function issue(password) {
  const exp = String(Math.floor(Date.now() / 1000) + TTL);
  return `${exp}.${encode(await crypto.subtle.sign('HMAC', await key(password), enc.encode(exp)))}`;
}
export async function valid(request, password) {
  if (!password) return false;
  const raw = /(?:^|;\s*)ql_sess=([^;]+)/.exec(request.headers.get('cookie') || '')?.[1];
  if (!raw) return false;
  try {
    const value = decodeURIComponent(raw);
    const match = /^(\d{10})\.([\w-]{43})$/.exec(value);
    if (!match || Number(match[1]) <= Date.now() / 1000) return false;
    const signature = Uint8Array.from(atob(match[2].replace(/-/g, '+').replace(/_/g, '/') + '='), c => c.charCodeAt(0));
    return crypto.subtle.verify('HMAC', await key(password), signature, enc.encode(match[1]));
  } catch { return false; }
}
export function cookie(value, secure, clear = false) {
  return `ql_sess=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${clear ? 0 : TTL}${secure ? '; Secure' : ''}`;
}
