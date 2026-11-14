const HOST = 'glados.cloud';
const SALT = 'glados-observe-v1';
// 请求指纹逐字节镜像浏览器客户端（HAR 实测：Edge 154 / Windows，2026-11）。
// 签到协议：GET checkin/challenge 拿 nonce → proof = SHA-256(nonce.salt) → POST {token,nonce,proof,tsState}。
// Turnstile token 无法在 Worker 内求解；镜像真实浏览器在验证未完成时发出的 timeout 态（合法行为空间）。
// 被拒则按浏览器行为重试一次，再回退标准签到；全部被拒则响亮失败，不误报成功。
const BROWSER = {
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7,en-GB;q=0.6',
  'dnt': '1',
  'priority': 'u=1, i',
  'sec-ch-ua': '"Chromium";v="154", "Microsoft Edge";v="154", "Not A(Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0',
};

export function parseCookies(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('缺少 cookie');
  if (text.startsWith('[') || text.startsWith('{')) {
    const value = JSON.parse(text);
    if (!Array.isArray(value)) throw new Error('请填写完整 Cookie 或 Cookie-Editor 数组');
    return [value.filter(c => c && c.name && c.value != null).map(c => `${c.name}=${c.value}`).join('; ')];
  }
  return text.split(/\r?\n/).map(s => s.replace(/^cookie\s*:\s*/i, '').trim()).filter(Boolean);
}

function blocked(data) {
  return data?.reason === 'device-mismatch' || [4, -2].includes(Number(data?.code))
    || /automated|captcha|risk|permission|unauthorized|没有权限/i.test(String(data?.message || ''));
}

async function proofOf(nonce) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${nonce}.${SALT}`));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function run(ctx) {
  const cookies = parseCookies(ctx.params.cookie);
  const blocks = [];
  let failures = 0, processed = 0;
  // 服务端拒绝形态：显式 turnstile 理由，或"Cloudflare verification failed / Nothing was recorded"消息（11-13 实测）。
  const rejected = d => d?.reason === 'turnstile' || /cloudflare verification|nothing was recorded/i.test(String(d?.message || ''));
  // 接受形态：code 0，或重复签到消息（14 日实测：当日已签时服务端返回 code≠0 + "Today's observation logged"）。
  const accepted = d => d?.code === 0 || /today.s observation logged|checkin repeats|checkin! got/i.test(String(d?.message || ''));
  for (let index = 0; index < cookies.length; index++) {
    if (!ctx.canStart(10)) break;
    const cookie = cookies[index];
    const label = `账号 ${index + 1}`;
    const api = async (path, payload, form = false) => {
      const extra = payload ? {
        'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
        'origin': `https://${HOST}`,
        'referer': `https://${HOST}/console/checkin`,
      } : {};
      const res = await ctx.fetch(`https://${HOST}/api/user/${path}`, {
        method: payload ? 'POST' : 'GET',
        headers: { ...BROWSER, Cookie: cookie, ...extra },
        ...(payload ? { body: form ? new URLSearchParams(payload).toString() : JSON.stringify(payload) } : {}),
      });
      if (res.status !== 200) { await res.body?.cancel(); throw new Error(`HTTP ${res.status}，停止本账号请求`); }
      const data = await res.json();
      if (!data || typeof data !== 'object') throw new Error('响应格式异常');
      if (blocked(data)) throw new Error(`${data.message || data.reason}；请通过官方页面检查账号，本轮不重试`);
      return data;
    };
    // 镜像浏览器 solveChallenge()：取挑战 → 证明 → 签到；挑战不可用时浏览器直接 POST（载荷仅 token），行为一致。
    const attempt = async () => {
      const t0 = Date.now();
      let nonce = null, armed = false;
      try {
        const challenge = await api('checkin/challenge');
        nonce = challenge?.nonce || null;
        armed = Boolean(challenge?.turnstile);
      } catch { nonce = null; }
      if (!nonce) return api('checkin', { token: HOST });
      // 服务端按挑战年龄与操作节奏识别机器；镜像前端 2.5s 下限，声明 timeout 时对齐其 15s 等待窗口。
      const idle = (armed ? 16000 : 2600) - (Date.now() - t0);
      if (idle > 0) await ctx.sleep(idle);
      return api('checkin', { token: HOST, nonce, proof: await proofOf(nonce), tsState: armed ? 'timeout' : 'off' });
    };
    try {
      if (!/(?:^|;\s*)(gld|koa):sess=/.test(cookie)) throw new Error('Cookie 缺少会话，请重新登录并更新完整 Cookie');
      let data = await attempt();
      if (rejected(data)) {
        ctx.log(`${label}：人机验证未放行，按浏览器行为重试一次`);
        data = await attempt();
      }
      if (rejected(data)) {
        ctx.log(`${label}：仍未放行，回退标准签到`);
        data = await api('checkin', { token: HOST });
      }
      if (rejected(data)) throw new Error(`${data.message || '未知签到结果'}${data.reason ? `（${data.reason}）` : ''}；本轮未被服务端记录`);
      if (!accepted(data)) throw new Error(`${data.message || '未知签到结果'}${data.reason ? `（${data.reason}）` : ''}`);
      ctx.log(`${label}：${data.message || '签到完成'}${data.points != null ? `（+${Number(data.points)} 分）` : ''}`);
      if (data.repeated) ctx.log(`${label}：今日已签到，本轮为重复确认`);
      if (data.streak != null) ctx.log(`${label}：连续签到 ${data.streak} 天`);
      if (data.breakdown) ctx.log(`${label}：积分构成 ${JSON.stringify(data.breakdown).slice(0, 400)}`);
      let points = '?', days = '?', exchange = '';
      try {
        const status = await api('status');
        days = status.data?.leftDays == null ? '?' : Math.floor(Number(status.data.leftDays));
        let score = await api('points');
        points = score.points ?? '?';
        const change = score.history?.[0]?.change;
        if (change != null) ctx.log(`${label}：最近积分变动 ${change}（服务端记录）`);
        if (Number(points) >= 500) {
          const redeemed = await api('exchange', { planType: 'plan500' }, true);
          if (![0,'0'].includes(redeemed.code)) throw new Error(`兑换失败：${redeemed.message || '未知结果'}`);
          const renewed = await api('status');
          days = renewed.data?.leftDays == null ? '?' : Math.floor(Number(renewed.data.leftDays));
          exchange = '，兑换成功 +100天';
          score = await api('points');
          points = score.points ?? points;
        }
      } catch (error) { failures++; ctx.log(`${label} 汇总：${error.message}`, 'error'); }
      const line = `${label}：积分 ${points}，剩余 ${days} 天${exchange}\n${data.message || '签到完成'}`;
      blocks.push(line);
      ctx.log(line);
    } catch (error) {
      failures++;
      const line = `${label}：${error.message}`;
      blocks.push(line);
      ctx.log(line, 'error');
    }
    processed++;
  }
  if (!processed) throw new Error('本轮预算不足以处理一个账号');
  const remaining = processed < cookies.length ? { ...ctx.params, cookie: cookies.slice(processed).join('\n') } : null;
  if (remaining) blocks.push(`剩余 ${cookies.length - processed} 个账号将在一分钟后补跑`);
  return { failed: failures > 0, defer: remaining, title: `GLaDOS 签到 ${failures ? '需检查' : '完成'}`, content: blocks.join('\n\n') };
}
