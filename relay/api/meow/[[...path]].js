// MeoW 反向代理：把 /api/meow/* 原样转发到 https://api.chuckfang.com/*
// 用途：MeoW 屏蔽 Cloudflare Workers 出口 IP，Worker 的推送经本函数中转
// （Vercel 出口非 CF 段）。个人自用，无鉴权：URL 不公开、MeoW 自带频控、
// 免费额度对每天几条推送绰绰有余。
export default async function handler(req, res) {
  const path = (req.query.path || []).join('/');
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  try {
    const upstream = await fetch('https://api.chuckfang.com/' + path, {
      method: req.method,
      headers: { 'content-type': 'application/json' },
      body: hasBody && req.body ? JSON.stringify(req.body) : undefined,
      redirect: 'follow',
    });
    const text = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json');
    res.end(text);
  } catch (e) {
    res.statusCode = 502;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ relay: 'error', msg: String((e && e.message) || e) }));
  }
}
