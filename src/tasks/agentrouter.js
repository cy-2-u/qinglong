const BASE = 'https://ps.air-outer.com';
export function parseAccounts(raw) {
  const accounts = [];
  for (const line of String(raw ?? '').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(',');
    if (parts.length < 2) throw new Error(`账号行格式无效（应为 邮箱,密码）：${line.trim().slice(0, 4)}…`);
    accounts.push({ email: parts[0].trim(), password: parts.slice(1).join(',').trim() });
  }
  if (!accounts.length) throw new Error('accounts 无有效账号行');
  return accounts;
}
export async function run(ctx) {
  let accounts;
  if (Array.isArray(ctx.params._remaining)) {
    accounts = ctx.params._remaining;
  } else {
    if (!ctx.params.accounts) throw new Error('缺少 accounts 参数（每行一个：邮箱,密码）');
    accounts = parseAccounts(ctx.params.accounts);
  }
  const pending = [];
  const lines = [];
  let succeeded = 0, failed = 0, last = 0;
  for (const account of accounts) {
    if (!ctx.canStart(2)) { pending.push(account); continue; }
    if (last) await ctx.sleep(Math.max(0, 1500 - (Date.now() - last)));
    last = Date.now();
    try {
      const response = await ctx.fetch(`${BASE}/api/user/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: account.email, password: account.password }),
      });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { throw new Error(`HTTP ${response.status}：非 JSON 响应`); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('响应格式异常');
      if (data.success === false || response.status >= 400) throw new Error(data.message || `HTTP ${response.status}`);
      // 站点签到即每日登录；登录成功后带 New-Api-User 头查余额供对账。
      let extra = '';
      const id = data.data?.id;
      if (id != null && ctx.canStart(1)) {
        try {
          const self = await ctx.fetch(`${BASE}/api/user/self`, { headers: { 'New-Api-User': String(id) } });
          const info = await self.json();
          extra = info?.data && info.success !== false ? `，quota ${info.data.quota}` : '，余额查询未返回';
        } catch { extra = '，余额查询失败（不影响签到）'; }
      }
      succeeded++;
      const line = `${account.email}：登录签到成功${extra}`;
      lines.push(line); ctx.log(line);
    } catch (error) {
      failed++;
      const line = `${account.email}：${error.message}`;
      lines.push(line); ctx.log(line, 'error');
    }
  }
  if (pending.length === accounts.length && pending.length) throw new Error('本轮未处理任何账号，停止补跑以免循环');
  const clean = { ...ctx.params }; delete clean._remaining;
  if (pending.length) lines.push(`剩余 ${pending.length} 个账号一分钟后补跑`);
  return { failed: failed > 0, defer: pending.length ? { ...clean, _remaining: pending } : null,
    title: `AgentRouter 登录 ${failed ? '需检查' : '完成'}`, content: [`成功 ${succeeded}，失败 ${failed}`, ...lines].join('\n') };
}
