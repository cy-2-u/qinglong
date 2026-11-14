const BASE = 'https://api005.dnshe.com/index.php?m=domain_hub';
const DAY = 86400;
export function truth(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}
export function expiry(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  const local = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/.exec(value);
  const time = local ? Date.UTC(+local[1], +local[2] - 1, +local[3], +(local[4] || 0), +(local[5] || 0), +(local[6] || 0)) - 8 * 3600000 : Date.parse(value);
  return Number.isFinite(time) ? time / 1000 : null;
}
function detail(data) {
  const hints = { auth_invalid_credentials: '请更新 API 密钥', auth_ip_not_allowed: '出口 IP 不在白名单', api_access_disabled: 'API 未启用', quota_exceeded: '积分不足', rate_limit_exceeded: '请求过于频繁' };
  return [data.message || data.error || '接口返回失败', data.error_code, hints[data.error_code]].filter(Boolean).join(' · ');
}
export async function run(ctx) {
  const p = ctx.params;
  if (!p.api_key || !p.api_secret) throw new Error('缺少 api_key / api_secret');
  const interval = Number(p.min_interval ?? 2);
  if (!Number.isFinite(interval) || interval < 0 || interval > 30) throw new Error('min_interval 须为 0–30 秒');
  let last = 0;
  const request = async (query, payload) => {
    if (last) await ctx.sleep(Math.max(0, interval * 1000 - (Date.now() - last)));
    last = Date.now();
    const response = await ctx.fetch(`${BASE}&${query}`, {
      method: payload ? 'POST' : 'GET',
      headers: { 'X-API-Key': p.api_key, 'X-API-Secret': p.api_secret, 'Content-Type': 'application/json' },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`DNSHE HTTP ${response.status}：非 JSON 响应`); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('DNSHE 响应格式异常');
    if (response.status >= 400 && data.error_code !== 'renewal_not_yet_available') throw new Error(detail(data));
    if (data.success === false && data.error_code !== 'renewal_not_yet_available') throw new Error(detail(data));
    return data;
  };
  let domains;
  if (Array.isArray(p._remaining)) {
    domains = p._remaining;
  } else {
    domains = [];
    const seen = new Set();
    let total = null;
    for (let page = 1; ; ) {
      if (!ctx.canStart(2)) throw new Error('域名列表超出本轮预算；未执行续期');
      const data = await request(`endpoint=subdomains&action=list&per_page=500&page=${page}&include_total=1&fields=id,full_domain,subdomain,status,expires_at,never_expires`);
      if (!Array.isArray(data.subdomains)) throw new Error('域名列表缺少 subdomains');
      if (page === 1 && data.pagination?.total != null) total = Number(data.pagination.total);
      for (const d of data.subdomains) {
        if (!d || !Number.isSafeInteger(Number(d.id)) || Number(d.id) <= 0) throw new Error('域名列表含无效 ID');
        if (!seen.has(String(d.id))) { seen.add(String(d.id)); domains.push(d); }
      }
      const more = data.pagination?.has_more == null ? data.subdomains.length === 500 : truth(data.pagination.has_more);
      if (!more) break;
      const next = Number(data.pagination?.next_page ?? page + 1);
      if (!Number.isInteger(next) || next <= page || next > 100) throw new Error('域名分页无法前进');
      page = next;
    }
    if (!domains.length && total !== 0) throw new Error('列表为空且未确认 total=0，未执行续期');
    if (total !== null && total !== domains.length) throw new Error(`域名列表不完整：应有 ${total}，收到 ${domains.length}，未执行续期`);
    if (p.only_ids) {
      const ids = new Set(String(p.only_ids).split(',').map(Number));
      domains = domains.filter(d => ids.has(Number(d.id)));
    }
  }
  const pending = [];
  const lines = [];
  let succeeded = 0, failed = 0, skipped = 0;
  const time = Math.floor(Date.now() / 1000);
  for (const domain of domains) {
    const label = String(domain.full_domain || domain.subdomain || domain.id);
    const expires = expiry(domain.expires_at);
    const abnormal = domain.status && !/^(registered|active)$/i.test(domain.status) ? `，状态 ${domain.status}` : '';
    if (truth(domain.never_expires) || (expires !== null && expires - time > 180 * DAY)) {
      skipped++;
      ctx.log(`${label}：${truth(domain.never_expires) ? '永久有效' : `剩余 ${Math.ceil((expires - time) / DAY)} 天`}${abnormal}`);
      continue;
    }
    if (!ctx.canStart(1)) { pending.push(domain); continue; }
    try {
      const data = await request('endpoint=subdomains&action=renew', { subdomain_id: Number(domain.id) });
      if (data.error_code === 'renewal_not_yet_available') {
        skipped++;
        ctx.log(`${label}：尚未进入续期窗口${abnormal}`);
      } else if (data.success === true || data.success === 1) {
        succeeded++;
        const line = `${label}：续期成功，新到期 ${data.new_expires_at || '未知'}，费用 ${data.charged_amount ?? '未知'}${abnormal}`;
        lines.push(line); ctx.log(line);
      } else { throw new Error(detail(data)); }
    } catch (error) {
      failed++;
      const line = `${label}：${error.message}；未自动重试，请核对结果`;
      lines.push(line); ctx.log(line, 'error');
    }
  }
  if (pending.length === domains.length && pending.length) throw new Error('本轮未处理任何域名，停止补跑以免循环');
  const clean = { ...p }; delete clean.only_ids; delete clean._remaining;
  if (pending.length) lines.push(`剩余 ${pending.length} 个域名一分钟后补跑`);
  return { failed: failed > 0, defer: pending.length ? { ...clean, _remaining: pending } : null,
    title: `DNSHE 续期 ${failed ? '需检查' : '完成'}`, content: [`成功 ${succeeded}，失败 ${failed}，跳过 ${skipped}`, ...lines].join('\n') };
}
