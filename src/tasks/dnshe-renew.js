// DNSHE 免费子域名自动续期（内置库成员，移植自 reference/dnshe_renew_domains.py，接口依据官方 API 文档 V2.0）
// 参数: api_key, api_secret
// 流程：分页拉取全部子域名（含完整性校验）→ 按阈值判定 → 逐个续期 → 明细写日志 → 摘要推送（全局 MeoW）。
// 注意：免费版 Worker 单次调用最多 50 个子请求；域名较多时列表页 + 续期请求数要留意。
export async function run(ctx) {
  const P = ctx.params || {};
  const API_KEY = String(P.api_key || '').trim();
  const API_SECRET = String(P.api_secret || '').trim();
  const BASE_URL = 'https://api005.dnshe.com/index.php?m=domain_hub';
  const thresholdDays = 180;  // 续期窗口阈值（文档：到期前 180 天开窗）
  const minInterval = 2;      // 相邻 API 调用最小间隔（秒），防 60 次/分钟限流
  const tzOffSec = 8 * 3600;  // 到期时间按北京时间解读
  const tzLabel = 'UTC+8';
  const PAGE_SIZE = 500;   // 文档：per_page 上限 500，取上限减少翻页与限流
  const MAX_PAGES = 100;
  const LIST_FIELDS = 'id,subdomain,rootdomain,full_domain,status,expires_at,never_expires';
  const BENIGN = { renewal_not_yet_available: 1 };
  const NORMAL_STATUS = { active: 1, registered: 1 };  // 实测返回 "Registered"，文档写 active
  const TRUE_WORDS = { '1': 1, 'true': 1, 'yes': 1, 'y': 1, 'on': 1, 't': 1 };
  const FALSE_WORDS = { '0': 1, 'false': 1, 'no': 1, 'n': 1, 'off': 1, 'f': 1, '': 1, 'none': 1, 'null': 1 };
  const ERROR_HINTS = {
    auth_invalid_credentials: 'API Key/Secret 无效，请到 DNSHE 后台重新创建',
    auth_ip_not_allowed: '当前出口 IP 不在该密钥的白名单内',
    api_access_disabled: 'DNSHE 后台已关闭 API 访问',
    quota_exceeded: '账户额度不足',
    rate_limit_exceeded: '触发接口频率限制，请稍后再运行一次',
    provider_operation_failed: '上游 DNS 服务商操作失败，稍后重试',
    internal_error: 'DNSHE 服务端内部错误',
    subdomain_not_found: '域名不存在或不属于当前 API Key',
    not_found: '资源不存在',
    bad_request: '请求参数有误',
  };

  if (!API_KEY || !API_SECRET) {
    const msg = '缺少必需参数 api_key / api_secret，请在任务参数中填写 DNSHE API 密钥';
    ctx.log(msg);
    await ctx.notify('DNSHE 域名续期失败', msg);
    throw new Error(msg);
  }

  const START_MS = Date.now();
  function bjTime() {
    return new Date(START_MS + tzOffSec * 1000).toISOString().replace('T', ' ').slice(0, 19);
  }
  const runStamp = '运行时间：' + bjTime() + ' (' + tzLabel + ')';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- 限流：相邻两次 API 调用间隔 >= min_interval 秒（防 60 次/分钟限流） ----------
  let lastCall = 0;
  async function throttle() {
    if (minInterval <= 0) return;
    if (lastCall > 0) {
      const waitMs = minInterval * 1000 - (Date.now() - lastCall);
      if (waitMs > 0) await sleep(waitMs);
    }
    lastCall = Date.now();
  }

  const HEADERS = { 'X-API-Key': API_KEY, 'X-API-Secret': API_SECRET, 'Content-Type': 'application/json' };

  function isFailurePayload(d) {
    return d.success === false || !!d.error_code;
  }

  // 官方统一错误结构：message + error_code + details；422 的 days_until_window 是最有用的信息
  function describeError(d) {
    if (!d || typeof d !== 'object') return '未知错误';
    let text = String(d.message || d.error || '未知错误');
    if (d.error_code) text += ' [' + d.error_code + ']';
    const details = d.details && typeof d.details === 'object' ? d.details : {};
    function pick(key) { return details[key] != null ? details[key] : (d[key] != null ? d[key] : null); }
    const extra = [];
    ['limit', 'remaining', 'reset_at'].forEach(function (k) {
      if (pick(k) != null) extra.push(k + '=' + pick(k));
    });
    if (extra.length) text += ' (' + extra.join(', ') + ')';
    const days = pick('days_until_window');
    if (days != null) {
      text += '，还需等待 ' + days + ' 天';
    } else if (pick('seconds_until_window') != null) {
      text += '，还需等待约 ' + Math.max(1, Math.floor(Number(pick('seconds_until_window')) / 86400)) + ' 天';
    }
    const hint = ERROR_HINTS[d.error_code];
    if (hint) text += ' —— ' + hint;
    return text;
  }

  // 统一响应校验：body 里的 error_code 优先于 HTTP 状态码（丢弃 error_code 只剩
  // "401 Unauthorized" 会把 auth_invalid_credentials / rate_limit 这类可行动信息全埋掉）
  async function checked(res, what) {
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) {
      if (res.status >= 400) throw new Error(what + '失败 (HTTP ' + res.status + '): ' + (text.slice(0, 200) || '空响应'));
      throw new Error(what + '返回非 JSON 内容 (HTTP ' + res.status + '): ' + text.slice(0, 200));
    }
    if (!data || typeof data !== 'object') throw new Error(what + '响应格式异常: ' + String(data).slice(0, 200));
    if (isFailurePayload(data)) throw new Error(what + '返回失败: ' + describeError(data));
    if (res.status >= 400) throw new Error(what + '失败 (HTTP ' + res.status + '): ' + JSON.stringify(data).slice(0, 200));
    return data;
  }

  // GET：只读，连接错误 / 429 / 5xx 可安全重试
  async function apiGet(query, what) {
    let lastErr = '';
    for (let attempt = 1; attempt <= 4; attempt++) {
      await throttle();
      let res;
      try {
        res = await ctx.fetch(BASE_URL + query, { method: 'GET', headers: HEADERS });
      } catch (e) {
        lastErr = what + '网络异常: ' + ((e && e.message) || e);
        ctx.log('警告: ' + lastErr + '（第 ' + attempt + '/4 次）');
        if (attempt < 4) await sleep(2000 * attempt);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = what + '返回 HTTP ' + res.status;
        ctx.log('警告: ' + lastErr + '（第 ' + attempt + '/4 次，稍后重试）');
        if (attempt < 4) await sleep(2000 * attempt);
        continue;
      }
      return checked(res, what);
    }
    throw new Error(lastErr || (what + '多次重试后仍失败'));
  }

  // POST 续期：会扣积分且不保证幂等。仅 429（服务端明确拒收、无副作用）重试；
  // 网络异常/读超时无法区分请求是否已到达服务端，保守不重试，宁可报失败也不重复扣积分。
  async function apiRenew(subdomainId) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await throttle();
      const res = await ctx.fetch(BASE_URL + '&endpoint=subdomains&action=renew', {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ subdomain_id: subdomainId }),
      });
      if (res.status === 429) {
        ctx.log('续期被限流 (429)，2 秒后重试（第 ' + attempt + '/3 次）');
        await sleep(2000);
        continue;
      }
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch (e) {
        if (res.status >= 400) throw new Error('续期接口失败 (HTTP ' + res.status + '): ' + (text.slice(0, 200) || '空响应'));
        throw new Error('续期接口返回非 JSON 内容 (HTTP ' + res.status + '): ' + text.slice(0, 200));
      }
      if (!data || typeof data !== 'object') throw new Error('续期接口响应格式异常: ' + String(data).slice(0, 200));
      if (res.status >= 500 && !isFailurePayload(data)) {
        // 5xx 却给出成功结构，自相矛盾，按失败处理避免误报续期成功
        throw new Error('续期接口异常 (HTTP ' + res.status + '): ' + JSON.stringify(data).slice(0, 200));
      }
      return data;
    }
    throw new Error('续期多次被限流 (429)，请稍后再运行一次');
  }

  // PHP 后端常把 tinyint 序列化成字符串，bool("0") 是 true——never_expires 误判
  // 会让域名被永久跳过，属于最坏的静默失效，所以要有这层转换。
  function toBool(value, def, label) {
    if (typeof value === 'boolean') return value;
    if (value == null) return def;
    if (typeof value === 'number') return value !== 0;
    const t = String(value).trim().toLowerCase();
    if (TRUE_WORDS[t]) return true;
    if (FALSE_WORDS[t]) return false;
    ctx.log('警告: ' + label + '=' + JSON.stringify(value) + ' 无法识别，按 ' + def + ' 处理');
    return def;
  }

  function parseId(value) {
    if (typeof value === 'boolean' || value == null) return null;
    if (typeof value === 'number') return Number.isInteger(value) ? value : null;
    const s = String(value).trim();
    if (!/^-?\d+$/.test(s)) return null;
    return Number(s);
  }

  // 不带时区的字符串按 tz 解读；自带偏移的（ISO 8601）尊重其偏移。返回秒，失败返回 null。
  function parseExpiry(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const text = value.trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(text);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000 - tzOffSec;
    m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000 - tzOffSec;
    m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000 - tzOffSec;
    const t = Date.parse(text);
    if (!isNaN(t)) return t / 1000;
    ctx.log('警告: 无法解析到期时间 ' + JSON.stringify(value));
    return null;
  }

  function statusAbnormal(status) {
    if (!status) return null;
    const s = String(status).trim().toLowerCase();
    if (NORMAL_STATUS[s]) return null;
    return String(status);
  }

  function statusNote(view) {
    const ab = statusAbnormal(view.status);
    if (!ab) return '';
    if (ab.toLowerCase() === 'expired') return '  [!] 域名状态 expired（已过期，续期窗口可能已关闭）';
    return '  [!] 域名状态 ' + ab;
  }

  // 剩余天数（未满一天也算一天）；已过期显示 "已过期 N 天"（不足一天算一天）。
  // 与 decide 共用同一 nowSec，避免长循环内时间基准漂移。
  function describeRemaining(expiresAtSec, nowSec) {
    if (expiresAtSec == null) return null;
    const deltaDays = (expiresAtSec - nowSec) / 86400;
    if (deltaDays < 0) return '已过期 ' + (-Math.floor(deltaDays)) + ' 天';
    return '剩余 ' + Math.ceil(deltaDays) + ' 天';
  }

  function expiryLine(view, nowSec) {
    const note = statusNote(view);
    if (view.problem) return view.label + ': 到期时间 未知（记录异常）' + note;
    if (view.neverExpires) return view.label + ': 到期时间 永久有效' + note;
    const remaining = describeRemaining(view.expiresAtSec, nowSec);
    if (remaining) return view.label + ': 到期时间 ' + view.expiresRaw + ' (' + remaining + ')' + note;
    if (view.expiresRaw) return view.label + ': 到期时间 ' + view.expiresRaw + ' (无法解析剩余天数)' + note;
    return view.label + ': 到期时间 未知' + note;
  }

  // 判定：invalid / never / skip / renew。用精确时间差而非取整天数——
  // 剩余恰好 180 天时窗口已开（要续期），取整天数会把边界误判成跳过。
  function decide(view, nowSec) {
    if (view.problem) return 'invalid';
    if (view.neverExpires) return 'never';
    if (view.expiresAtSec != null) {
      return (view.expiresAtSec - nowSec) > thresholdDays * 86400 ? 'skip' : 'renew';
    }
    // 剩余时间未知也尝试续期：宁可撞一次 422，也不要漏掉真要过期的域名
    return 'renew';
  }

  function formatCharge(charged) {
    const v = Number(charged);
    if (charged == null || !isFinite(v)) return '费用未知';
    if (v === 0) return '免费';
    return '消耗 ' + charged + ' 积分';
  }

  function quotaLine(quota) {
    const available = quota ? quota.available : null;
    const parts = [];
    if (available != null) parts.push('可用 ' + available);
    if (quota && quota.used != null) parts.push('已用 ' + quota.used);
    if (quota && quota.total != null) parts.push('总额 ' + quota.total);
    const summary = parts.join('，') || JSON.stringify(quota || {}).slice(0, 120);
    const a = Number(available);
    if (available != null && isFinite(a) && a <= 0) return '[!] 账户积分：' + summary + '（积分已耗尽，付费续期将失败）';
    return '账户积分：' + summary;
  }

  // 续期单个域名：成功 / 良性失败（未到窗口）/ 真失败
  async function renewOne(view) {
    let payload;
    try {
      payload = await apiRenew(view.id);
    } catch (e) {
      return { line: '[X] ' + view.label + ': 请求异常 (' + ((e && e.message) || e) + ')', failed: true, brief: view.label + '：请求异常 (' + ((e && e.message) || e) + ')' };
    }
    if (payload.success) {
      const newExpiry = payload.new_expires_at || '';
      const charge = formatCharge(payload.charged_amount == null ? 0 : payload.charged_amount);
      const remaining = payload.remaining_days;
      const tail = remaining != null ? '，剩余 ' + remaining + ' 天' : '';
      const shown = newExpiry || '未知';
      return {
        line: '[OK] ' + view.label + ': 续期成功 (新到期 ' + shown + tail + ', ' + charge + ')',
        failed: false,
        newExpiry: newExpiry || null,
        brief: view.label + ' → 新到期 ' + shown + tail + '（' + charge + '）',
      };
    }
    const detail = describeError(payload);
    if (BENIGN[payload.error_code]) {
      return { line: '[SKIP] ' + view.label + ': 暂不可续期 (' + detail + ')', failed: false, notInWindow: true, brief: view.label + '：' + detail };
    }
    return { line: '[X] ' + view.label + ': 续期失败 (' + detail + ')', failed: true, brief: view.label + '：' + detail };
  }

  // ---------- 分页拉取全部子域名 ----------
  // 漏页 = 后面的域名静默过期，所以必须翻完，并用服务端 total 校验完整性。
  async function fetchSubdomains() {
    const collected = [];
    const seenIds = {};
    let reportedTotal = null;
    let page = 1;

    while (page <= MAX_PAGES) {
      let query = '&endpoint=subdomains&action=list&fields=' + LIST_FIELDS + '&page=' + page + '&per_page=' + PAGE_SIZE;
      if (page === 1) query += '&include_total=1';  // 首页付一次 COUNT 的成本拿总数

      const data = await apiGet(query, '域名列表');

      if (!('subdomains' in data)) {
        throw new Error('域名列表响应缺少 subdomains 字段（接口可能已变更），原始响应: ' + JSON.stringify(data).slice(0, 200));
      }
      const batch = data.subdomains;
      if (!Array.isArray(batch)) throw new Error('subdomains 字段不是列表: ' + JSON.stringify(batch).slice(0, 200));

      // 服务端总数只在首页采信；顶层 count 是"本页条数"，不能当总数
      const pag = data.pagination && typeof data.pagination === 'object' ? data.pagination : null;
      if (pag && pag.total != null && Number(pag.total) >= 0 && !isNaN(Number(pag.total))) {
        reportedTotal = Number(pag.total);
      } else if (page === 1 && data.count != null && Number(data.count) >= 0 && !isNaN(Number(data.count))) {
        reportedTotal = Number(data.count);
      }
      if (data.count != null && !isNaN(Number(data.count)) && Number(data.count) !== batch.length) {
        ctx.log('警告: 第 ' + page + ' 页声明 count=' + data.count + '，实际返回 ' + batch.length + ' 条，疑似响应被截断');
      }

      // 服务端若忽略 page 参数会反复返回同一页，按 id 去重防无限累积
      const fresh = [];
      for (const item of batch) {
        if (item && typeof item === 'object' && item.id != null) {
          const key = String(item.id);
          if (seenIds[key]) continue;
          seenIds[key] = 1;
        }
        fresh.push(item);
      }
      for (const item of fresh) collected.push(item);

      // 缺 pagination 字段时不能想当然认为取完，用"本页是否装满"推断
      let hasMore;
      if (pag && 'has_more' in pag) hasMore = !!pag.has_more;
      else hasMore = batch.length >= PAGE_SIZE && fresh.length > 0;
      if (!hasMore) break;

      let next = page + 1;
      if (pag && pag.next_page != null) {
        const n = Number(pag.next_page);
        if (!isNaN(n)) next = n;
      }
      if (!(next > page)) {
        // 说还有下一页却给不出能前进的页码：宁可失败告警，也不能静默截断
        throw new Error('域名列表分页异常：服务端标记 has_more=true，但第 ' + page + ' 页未能给出可前进的页码，已中止以免漏掉域名');
      }
      page = next;
    }
    if (page > MAX_PAGES) throw new Error('域名列表分页超过 ' + MAX_PAGES + ' 页，疑似接口异常，已中止');

    if (reportedTotal != null && collected.length !== reportedTotal) {
      ctx.log('警告: 域名数量不一致——服务端声明 ' + reportedTotal + ' 个，实际收到 ' + collected.length + ' 个，可能有域名未被处理，请人工核查');
    }

    if (!collected.length) {
      // 空列表极可能是凭据失效或接口变更，绝不能当作"无需续期"；
      // 但服务端明确给出 total=0 时，那是真的没有域名。
      if (reportedTotal === 0) {
        ctx.log('账户下没有任何子域名，本次无需续期');
        return [];
      }
      throw new Error('未获取到任何子域名，疑似凭据失效或接口变更，请人工核查');
    }
    return collected;
  }

  // ---------- 主流程 ----------
  let subdomains;
  try {
    subdomains = await fetchSubdomains();
  } catch (e) {
    const msg = '[X] 获取域名列表失败，本次未执行任何续期: ' + ((e && e.message) || e);
    ctx.log(msg);
    await ctx.notify('DNSHE 域名续期失败', runStamp + '\n\n' + msg);
    throw e;
  }

  // 积分只是辅助信息，查不到不该让整轮续期失败
  let quotaText = '账户积分：查询失败';
  try {
    const qdata = await apiGet('&endpoint=quota', '积分接口');
    const q = qdata && typeof qdata === 'object' ? qdata.quota : null;
    if (!q || typeof q !== 'object') throw new Error('积分接口响应缺少 quota 字段');
    quotaText = quotaLine(q);
  } catch (e) {
    quotaText = '账户积分：查询失败（' + ((e && e.message) || e) + '）';
  }

  const renewalResults = [];
  const expiryLines = [];
  const report = { total: subdomains.length, successes: [], failures: [], abnormal: [], notInWindow: 0, neverExpires: 0 };
  let hasFailure = false;
  const skipCount = () => report.notInWindow + report.neverExpires;
  const nowSec = Math.floor(Date.now() / 1000);

  for (let index = 0; index < subdomains.length; index++) {
    const raw = subdomains[index];
    const position = '<第' + (index + 1) + '条记录>';
    let view;
    if (!raw || typeof raw !== 'object') {
      view = { label: position, problem: '记录格式异常: ' + JSON.stringify(raw).slice(0, 80) };
    } else {
      const label = raw.full_domain || raw.subdomain || position;
      view = {
        label: label,
        id: parseId(raw.id),
        // 默认按 false（需要续期）处理：无法识别时宁可多撞一次 422，
        // 也不能把真正需要续期的域名误判成永不过期而永久跳过
        neverExpires: toBool(raw.never_expires == null ? 0 : raw.never_expires, false, label + '.never_expires'),
        expiresRaw: raw.expires_at == null ? null : String(raw.expires_at),
        status: raw.status == null ? null : String(raw.status),
        expiresAtSec: null,
        problem: null,
      };
      if (view.id == null) {
        view.problem = '响应缺少 id 字段，无法续期';
      } else if (!view.neverExpires) {
        view.expiresAtSec = parseExpiry(view.expiresRaw);
      }
    }

    expiryLines.push(expiryLine(view, nowSec));
    const action = decide(view, nowSec);
    // 状态异常与是否续期无关：被暂停/过期的域名即使远离续期窗口也要提醒
    const ab = statusAbnormal(view.status);
    if (ab) report.abnormal.push(view.label + '：状态 ' + ab);

    if (action === 'invalid') {
      hasFailure = true;
      renewalResults.push('[X] ' + view.label + ': ' + view.problem);
      report.failures.push(view.label + '：' + view.problem);
    } else if (action === 'never') {
      renewalResults.push('[SKIP] ' + view.label + ': 已设置为永不过期，跳过续期' + statusNote(view));
      report.neverExpires += 1;
    } else if (action === 'skip') {
      renewalResults.push('[SKIP] ' + view.label + ': ' + describeRemaining(view.expiresAtSec, nowSec) + ' > ' + thresholdDays + ' 天，尚未进入续期窗口，跳过' + statusNote(view));
      report.notInWindow += 1;
    } else {
      const outcome = await renewOne(view);
      renewalResults.push(outcome.line + statusNote(view));
      hasFailure = hasFailure || !!outcome.failed;
      if (outcome.failed) {
        report.failures.push(outcome.brief || view.label);
      } else if (outcome.notInWindow) {
        report.notInWindow += 1;
      } else {
        report.successes.push(outcome.brief || view.label);
      }
      if (outcome.newExpiry) {
        // 续期成功后刷新到期清单，避免第二段显示续期前的旧时间
        view.expiresRaw = outcome.newExpiry;
        view.expiresAtSec = parseExpiry(outcome.newExpiry);
        expiryLines[expiryLines.length - 1] = expiryLine(view, nowSec);
      }
    }
  }

  // ---------- 日志（完整明细） ----------
  ctx.log(runStamp);
  ctx.log(quotaText);
  ctx.log('=== 本次续期结果 ===');
  if (renewalResults.length) renewalResults.forEach(function (l) { ctx.log(l); });
  else ctx.log('（所有域名剩余天数 >= ' + thresholdDays + ' 天，本次无需续期）');
  if (hasFailure) ctx.log('[!] 存在失败项，请查看上方日志并人工处理');
  ctx.log('=== 所有域名到期时间 ===');
  expiryLines.forEach(function (l) { ctx.log(l); });
  ctx.log('（共 ' + expiryLines.length + ' 个域名；到期时间按 ' + tzLabel + ' 解读）');

  // ---------- 推送摘要（只发需要人看的结论） ----------
  const summaryParts = [runStamp, '', quotaText, ''];
  summaryParts.push('共 ' + report.total + ' 个域名：续期成功 ' + report.successes.length + '，失败 ' + report.failures.length + '，跳过 ' + skipCount());
  if (report.successes.length) {
    summaryParts.push('', '[OK] 续期成功');
    report.successes.forEach(function (l) { summaryParts.push('- ' + l); });
  }
  if (report.failures.length) {
    summaryParts.push('', '[X] 需要处理');
    report.failures.forEach(function (l) { summaryParts.push('- ' + l); });
  }
  if (report.abnormal.length) {
    summaryParts.push('', '[!] 域名状态异常');
    report.abnormal.forEach(function (l) { summaryParts.push('- ' + l); });
  }
  const skipNotes = [];
  if (report.notInWindow) skipNotes.push(report.notInWindow + ' 个未到 ' + thresholdDays + ' 天窗口');
  if (report.neverExpires) skipNotes.push(report.neverExpires + ' 个永不过期');
  if (skipNotes.length) summaryParts.push('', '跳过：' + skipNotes.join('，'));
  if (report.failures.length) summaryParts.push('', '完整明细见面板运行日志');

  const title = hasFailure ? 'DNSHE 域名续期失败' : 'DNSHE 域名自动续期报告';
  await ctx.notify(title, summaryParts.join('\n'));

  if (hasFailure) throw new Error('存在 ' + report.failures.length + ' 个失败项，详见运行日志');
}
