import { TaskScheduler } from './scheduler.js';
import { cookie, issue, valid, passwordMatches } from './auth.js';
import { notify } from './runtime.js';
export { TaskScheduler };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const stub = env => env.SCHEDULER.get(env.SCHEDULER.idFromName('default'));
export default {
  async fetch(request, env) {
    const url = new URL(request.url), method = request.method;
    try {
      if (url.pathname === '/health' && method === 'GET') {
        const alarm = await stub(env).ensureAlarm();
        return json({ healthy: true, ...alarm, serverTime: Math.floor(Date.now() / 1000) });
      }
      if (!url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
      if (!['GET','POST','PUT','PATCH','DELETE'].includes(method)) return json({ error: '不支持的方法' }, 405);
      // CSRF 由 Cookie SameSite=Strict + JSON 专属 Content-Type 两道已命名的防线承担，不再重复校验 Origin。
      if (method !== 'GET' && !request.headers.get('content-type')?.startsWith('application/json')) return json({ error: '需要 application/json' }, 415);
      let body;
      if (method !== 'GET') {
        const text = await request.text();
        if (text.length > 100000) return json({ error: '请求过大' }, 413);
        try { body = JSON.parse(text); } catch { return json({ error: 'JSON 格式错误' }, 400); }
        if (!body || Array.isArray(body) || typeof body !== 'object') return json({ error: '需要 JSON 对象' }, 400);
      }
      if (url.pathname === '/api/login' && method === 'POST') {
        if (!env.PANEL_PASSWORD) return json({ error: '尚未设置面板密码' }, 503);
        if (!(await passwordMatches(body.password, env.PANEL_PASSWORD))) return json({ error: '密码错误' }, 401);
        return json({ ok: true }, 200, { 'set-cookie': cookie(await issue(env.PANEL_PASSWORD), url.protocol === 'https:') });
      }
      if (!(await valid(request, env.PANEL_PASSWORD))) return json({ error: '请登录' }, 401);
      if (url.pathname === '/api/logout' && method === 'POST') return json({ ok: true }, 200, { 'set-cookie': cookie('', url.protocol === 'https:', true) });
      if (url.pathname === '/api/settings/test' && method === 'POST') {
        const settings = await stub(env).request('GET', '/api/settings');
        const key = typeof body.notify_key === 'string' ? body.notify_key.trim() : settings.body.notify_key;
        if (!key) return json({ error: '请填写通知密钥' }, 400);
        await notify(key, '青龙面板', '通知通道正常');
        return json({ ok: true });
      }
      const result = await stub(env).request(method, url.pathname, body);
      return json(result.body, result.status);
    } catch (error) {
      console.error(error);
      return json({ error: '服务暂时不可用，请稍后重试' }, 503);
    }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(stub(env).ensureAlarm()); },
};
