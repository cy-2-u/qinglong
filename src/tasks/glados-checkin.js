// GLaDOS 自动签到（内置库成员，移植自 reference/glados_checkin.py）
// 参数: cookie（多账号每行一个）· 积分≥500 自动兑换 100 天 · 每次运行推送汇总
export async function run(ctx) {
  const P = ctx.params || {};
  const raw = String(P.cookie || '').trim();
  if (!raw) throw new Error('缺少参数 cookie');

  const DOMAINS = ['https://glados.cloud', 'https://glados.rocks', 'https://glados.network'];
  const PLAN = ['plan500', 500, 100]; // 积分够 500 自动兑换 100 天
  const SUCCESS = ['checkin! got', 'checkin repeats! please try tomorrow', "today's observation logged"];
  const AUTH_FAIL = ['没有权限', 'permission', 'unauthorized', 'automated check-in detected'];
  const BROWSER = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    'Sec-CH-UA': '"Chromium";v="120", "Microsoft Edge";v="120", "Not_A Brand";v="99"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function sessionKind(cookie) {
    const names = new Set(cookie.split(';').filter((p) => p.includes('=')).map((p) => p.trim().split('=')[0]));
    if (names.has('gld:sess') && names.has('gld:sess.sig')) return 'gld';
    if (names.has('koa:sess') && names.has('koa:sess.sig')) return 'koa';
    return null;
  }

  // 兼容：请求头原串 / Cookie-Editor 导出 JSON / 旧版单 token
  function parseCookie(item) {
    let s = String(item || '').trim().replace(/^cookie\s*:\s*/i, '');
    if (!s) return null;
    if (['gld:sess=', 'gld:sess.sig=', 'koa:sess=', 'koa:sess.sig='].some((k) => s.includes(k))) return s;
    if (s.startsWith('{') || s.startsWith('[')) {
      try {
        const j = JSON.parse(s);
        if (Array.isArray(j)) {
          const pairs = j.filter((x) => x && x.name && x.value != null).map((x) => x.name + '=' + x.value);
          const cookie = pairs.join('; ');
          return sessionKind(cookie) ? cookie : null;
        }
        if (j && j.token) return 'koa:sess=' + j.token;
      } catch (e) { return null; }
      return null;
    }
    if (s.split('.').length === 3 && !s.includes('=') && s.length > 50) return 'koa:sess=' + s;
    return s;
  }

  const cookies = raw.split(/\n|&/).map(parseCookie).filter(Boolean);
  if (!cookies.length) throw new Error('cookie 参数解析失败，请粘贴完整 Cookie');

  ctx.log('已启用自动兑换: 500 积分 -> 100 天');

  function isAuthFailure(res) {
    if (!res || typeof res !== 'object') return false;
    const msg = String(res.message || '').toLowerCase();
    const reason = String(res.reason || '').toLowerCase();
    return res.code === -2 || reason === 'device-mismatch' || AUTH_FAIL.some((k) => msg.includes(k));
  }
  function isSuccess(res) {
    if (!res || typeof res !== 'object') return false;
    const msg = String(res.message || '').toLowerCase();
    return res.code === 0 || SUCCESS.some((k) => msg.includes(k));
  }

  function makeClient(cookie) {
    if (sessionKind(cookie) !== 'gld') ctx.log('Cookie 缺少 gld:sess/gld:sess.sig，新版接口可能返回没有权限');
    let pos = 0;
    async function request(method, path, payload, form) {
      for (let off = 0; off < DOMAINS.length; off++) {
        const idx = (pos + off) % DOMAINS.length;
        const domain = DOMAINS[idx];
        const headers = Object.assign({
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Cookie': cookie,
          'Origin': domain,
          'Referer': domain + '/console/checkin',
        }, BROWSER);
        let body;
        if (payload !== undefined) {
          if (form) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
            body = new URLSearchParams(payload).toString();
          } else {
            headers['Content-Type'] = 'application/json;charset=UTF-8';
            body = JSON.stringify(payload);
          }
        }
        let res;
        try {
          res = await ctx.fetch(domain + path, { method, headers, body });
        } catch (e) {
          ctx.log(domain + ' 请求失败: ' + (e && e.message));
          continue;
        }
        if (res.status !== 200) {
          ctx.log(domain + ' 返回 HTTP ' + res.status);
          continue;
        }
        pos = idx;
        try { return await res.json(); } catch (e) { ctx.log(domain + ' 响应解析失败'); }
      }
      return null;
    }
    return {
      checkin: () => request('POST', '/api/user/checkin', { token: 'glados.cloud' }),
      status: () => request('GET', '/api/user/status'),
      points: () => request('GET', '/api/user/points'),
      exchange: (planType) => request('POST', '/api/user/exchange', { planType }, true),
    };
  }

  async function fetchSummary(client) {
    const s = { email: '?', leftDays: '?', points: '?', change: '', options: '', basePoints: null };
    const st = await client.status();
    const data = (st && st.data) || {};
    if (data && Object.keys(data).length) {
      s.email = data.email || '?';
      s.leftDays = String(data.leftDays != null ? data.leftDays : '?').split('.')[0];
    }
    const res = await client.points();
    if (!res || res.points === undefined) return s;
    s.points = String(res.points != null ? res.points : '0').split('.')[0];
    const current = parseInt(s.points, 10) || 0;
    s.basePoints = current;
    const history = res.history || [];
    if (history.length) {
      const change = String(history[0].change != null ? history[0].change : '0').split('.')[0];
      s.change = change.startsWith('-') ? change : '+' + change;
    }
    const lines = [];
    const plans = res.plans || {};
    for (const k of Object.keys(plans)) {
      const need = plans[k].points || 0;
      const days = plans[k].days != null ? plans[k].days : '?';
      lines.push(current >= need
        ? need + '分->' + days + '天 (可兑换)'
        : need + '分->' + days + '天 (差' + (need - current) + '分)');
    }
    s.options = lines.join('\n');
    return s;
  }

  async function tryExchange(client, basePoints) {
    if (!basePoints || basePoints < PLAN[1]) return ['skip', '积分不足(' + (basePoints == null ? '?' : basePoints) + '/' + PLAN[1] + '分)'];
    const res = await client.exchange(PLAN[0]);
    if (res && String(res.code) === '0') return ['ok', '兑换成功 +' + PLAN[2] + '天'];
    const msg = String((res && res.message) || '未知错误').replace(/\s+/g, ' ').slice(0, 120);
    return ['fail', '兑换失败: ' + msg];
  }

  const blocks = [];
  let okCount = 0;
  for (let i = 0; i < cookies.length; i++) {
    const client = makeClient(cookies[i]);

    let result = null;
    let ok = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      result = await client.checkin();
      if (isSuccess(result)) { ok = true; break; }
      if (isAuthFailure(result)) {
        const msg = result && result.reason === 'device-mismatch'
          ? '登录设备不匹配，请重新登录并更新完整 Cookie'
          : (result && result.message) || '认证失败';
        ctx.log('账号 ' + (i + 1) + ' 认证失败，不再重试: ' + msg);
        break;
      }
      if (attempt < 3) { ctx.log('签到第 ' + attempt + '/3 次失败，5 秒后重试'); await sleep(5000); }
    }
    const message = result && result.message ? result.message : (result ? 'Failure' : 'Network Error');
    if (ok) okCount++;

    let summary = await fetchSummary(client);
    const st = await tryExchange(client, summary.basePoints);
    ctx.log('账号 ' + (i + 1) + ' | ' + st[1]);
    if (st[0] === 'ok') summary = await fetchSummary(client);
    else if (st[0] === 'fail') summary.options = (summary.options + '\n' + st[1]).trim();

    ctx.log('账号 ' + (i + 1) + ' | 积分: ' + summary.points + ' | 天数: ' + summary.leftDays + ' | 结果: ' + message);
    blocks.push(
      '账号 ' + summary.email + '\n' +
      '当前积分: ' + summary.points + ' (' + summary.change + ')\n' +
      '剩余天数: ' + summary.leftDays + ' 天\n' +
      '签到结果: ' + message + '\n' +
      '兑换选项:\n' + (summary.options || '-')
    );
  }

  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  const ts = bj.toISOString().replace('T', ' ').slice(0, 19);
  await ctx.notify(
    'GLaDOS 签到 成功' + okCount + '/' + cookies.length,
    blocks.join('\n\n') + '\n时间: ' + ts + ' (北京时间)'
  );
}
