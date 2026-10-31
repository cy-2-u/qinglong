// DNSHE 续期脚本移植的 mock 端到端测试（node 直接跑）
// 用假 API 响应跑完整 main(ctx) 流程，覆盖：分页/去重、tinyint 布尔、
// 精确续期窗口边界、422 良性失败、5xx 业务失败、状态异常、5xx 重试、
// 空列表语义、缺参 fail-fast、凭据错误提示。
// 用法: node test-dnshe.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(__dirname, '..', 'src', 'scripts', 'dnshe-renew.txt'), 'utf8');

const TZ = 8;
const DAY = 86400000;

function bj(ms) {
  return new Date(ms + TZ * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function makeCtx(params, fetchFn) {
  const ctx = {
    params: params,
    logs: [],
    notified: [],
    log(m) { ctx.logs.push(String(m)); },
    async notify(title, content) { ctx.notified.push({ title, content }); },
    fetch: fetchFn,
  };
  return ctx;
}

function res(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, text: async () => text };
}

function runScript(ctx) {
  const fn = new Function('ctx', '"use strict";\n' + code + '\nreturn main(ctx);');
  return fn(ctx);
}

let passed = 0;
async function t(name, fn) {
  await fn();
  passed++;
  console.log('ok -', name);
}

const authed = { api_key: 'k', api_secret: 's' };

// ---------- 场景 1：happy path + tinyint + 精确窗口边界 + 汇总推送 ----------
await t('happy path: 临近到期续期、远期跳过、never_expires="0" 不误判、恰好 180 天可续期', async () => {
  const now = Date.now();
  const soon = bj(now + 30 * DAY);              // 30 天 -> renew
  const far = bj(now + 400 * DAY);              // 400 天 -> skip
  const edge = bj(now + 180 * DAY);             // 恰好 180 天 -> 精确判定 renew（非严格大于）
  const renewIds = [];
  const fetchFn = async (url, init) => {
    if (url.includes('action=list')) {
      return res(200, {
        subdomains: [
          { id: 1, full_domain: 'a.test.com', status: 'Registered', expires_at: soon, never_expires: '0' },
          { id: 2, full_domain: 'b.test.com', status: 'Registered', expires_at: far, never_expires: 0 },
          { id: 3, full_domain: 'c.test.com', status: 'Registered', expires_at: edge, never_expires: '0' },
        ],
        pagination: { total: 3, has_more: false },
        count: 3,
      });
    }
    if (url.includes('endpoint=quota')) return res(200, { quota: { available: 10, used: 5, total: 100 } });
    if (url.includes('action=renew')) {
      renewIds.push(JSON.parse(init.body).subdomain_id);
      return res(200, { success: true, new_expires_at: bj(now + 395 * DAY), charged_amount: 0, remaining_days: 180 });
    }
    return res(404, { success: false, error_code: 'not_found' });
  };
  const ctx = makeCtx(authed, fetchFn);
  await runScript(ctx);

  assert.deepStrictEqual(renewIds.sort(), [1, 3], '应续期 a(30天) 与 c(恰好180天)，跳过 b(400天)');
  assert.strictEqual(ctx.notified.length, 1, '推送一次');
  assert.strictEqual(ctx.notified[0].title, 'DNSHE 域名自动续期报告');
  const s = ctx.notified[0].content;
  assert.ok(s.includes('共 3 个域名：续期成功 2，失败 0，跳过 1'), s);
  assert.ok(s.includes('- a.test.com → 新到期'), s);
  assert.ok(s.includes('1 个未到 180 天窗口'), s);
  assert.ok(ctx.logs.some((l) => l.includes('[OK] a.test.com: 续期成功')), '日志含续期成功明细');
  assert.ok(ctx.logs.some((l) => l.includes('账户积分：可用 10')), '日志含积分');
});

// ---------- 场景 2：分页两页 + 去重 + 异常状态 + 422 良性失败 + 5xx 业务失败 ----------
await t('分页/去重/异常状态/422 良性/500 业务失败/never_expires="1"', async () => {
  const now = Date.now();
  const soon = bj(now + 10 * DAY);
  const benign422 = { success: false, error_code: 'renewal_not_yet_available', message: '尚未进入续期窗口', details: { days_until_window: 10 } };
  const pages = {
    1: {
      subdomains: [
        { id: 1, full_domain: 'x.test.com', status: 'Registered', expires_at: soon, never_expires: '1' }, // 永不过期
        { id: 2, full_domain: 'y.test.com', status: 'Suspended', expires_at: soon, never_expires: 0 },     // 状态异常 + 续期失败
        { id: 9, full_domain: 'dup.test.com', status: 'Registered', expires_at: soon, never_expires: 0 },
      ],
      pagination: { total: 3, has_more: true, next_page: 2 },
      count: 3,
    },
    2: {
      subdomains: [
        { id: 9, full_domain: 'dup.test.com', status: 'Registered', expires_at: soon, never_expires: 0 }, // 重复 id
        { id: 3, full_domain: 'z.test.com', status: 'Registered', expires_at: soon, never_expires: 0 },   // 422 未到窗口
      ],
      pagination: { total: 3, has_more: false },
      count: 2,
    },
  };
  const seenPages = [];
  const fetchFn = async (url, init) => {
    if (url.includes('action=list')) {
      const m = /page=(\d+)/.exec(url);
      seenPages.push(Number(m[1]));
      return res(200, pages[Number(m[1])]);
    }
    if (url.includes('endpoint=quota')) return res(200, { quota: { available: 0, used: 5, total: 10 } });
    if (url.includes('action=renew')) {
      const id = JSON.parse(init.body).subdomain_id;
      if (id === 3 || id === 9) return res(422, benign422);          // 良性：未到窗口
      return res(500, { success: false, error_code: 'internal_error', message: '内部错误' }); // 业务失败
    }
    return res(404, { success: false });
  };
  const ctx = makeCtx(authed, fetchFn);
  await assert.rejects(() => runScript(ctx), /存在 1 个失败项/, '有失败项时脚本按设计要抛错');

  assert.deepStrictEqual(seenPages, [1, 2], '应翻两页');
  assert.ok(ctx.logs.some((l) => l.includes('[SKIP] x.test.com: 已设置为永不过期')), 'never_expires="1" 应跳过');
  assert.ok(ctx.logs.some((l) => l.includes('[SKIP] z.test.com: 暂不可续期') && l.includes('还需等待 10 天')), '422 的等待天数要透出');
  assert.ok(ctx.logs.some((l) => l.includes('[X] y.test.com: 续期失败') && l.includes('internal_error')), '500+失败结构按业务失败处理');
  const s = ctx.notified[0].content;
  assert.ok(s.includes('共 4 个域名：续期成功 0，失败 1，跳过 3'), s);
  assert.ok(s.includes('y.test.com：内部错误 [internal_error] —— DNSHE 服务端内部错误'), '失败原因带 hint');
  assert.ok(s.includes('[!] 域名状态异常'), '摘要含状态异常段');
  assert.ok(s.includes('y.test.com：状态 Suspended'), '异常状态域名被点名');
  assert.ok(s.includes('跳过：2 个未到 180 天窗口，1 个永不过期'), '跳过聚合计数');
  assert.strictEqual(ctx.notified[0].title, 'DNSHE 域名续期失败', '有失败项时标题为失败');
  assert.ok(ctx.logs.some((l) => l.includes('积分已耗尽')), '积分为 0 的警示');
});

// ---------- 场景 3：列表接口 5xx 重试后成功 ----------
await t('列表接口 500 重试后成功，total=0 视为真没有域名', async () => {
  let listCalls = 0;
  const fetchFn = async (url) => {
    if (url.includes('action=list')) {
      listCalls++;
      if (listCalls === 1) return res(500, 'internal server error');
      return res(200, { subdomains: [], pagination: { total: 0, has_more: false }, count: 0 });
    }
    return res(200, { quota: { available: 1 } });
  };
  const ctx = makeCtx(authed, fetchFn);
  await runScript(ctx);
  assert.strictEqual(listCalls, 2, '500 后应重试');
  assert.ok(ctx.logs.some((l) => l.includes('账户下没有任何子域名')), 'total=0 是真没有域名');
});

// ---------- 场景 4：空列表但无 total -> 判定凭据失效并推送失败 ----------
await t('空列表且无 total -> 失败并推送失败标题', async () => {
  const fetchFn = async (url) => {
    if (url.includes('action=list')) return res(200, { subdomains: [] });
    return res(200, { quota: {} });
  };
  const ctx = makeCtx(authed, fetchFn);
  await assert.rejects(() => runScript(ctx), /未获取到任何子域名/);
  assert.strictEqual(ctx.notified[0].title, 'DNSHE 域名续期失败');
});

// ---------- 场景 5：缺密钥 fail-fast ----------
await t('缺少 api_key -> fail-fast 且推送失败', async () => {
  const ctx = makeCtx({}, async () => res(200, {}));
  await assert.rejects(() => runScript(ctx), /缺少必需参数/);
  assert.strictEqual(ctx.notified[0].title, 'DNSHE 域名续期失败');
});

// ---------- 场景 6：凭据错误 -> error_code 提示透出 ----------
await t('凭据无效 -> 描述含 hint', async () => {
  const fetchFn = async (url) => {
    if (url.includes('action=list')) {
      return res(401, { success: false, error_code: 'auth_invalid_credentials', message: '认证失败' });
    }
    return res(200, {});
  };
  const ctx = makeCtx(authed, fetchFn);
  await assert.rejects(() => runScript(ctx), /API Key\/Secret 无效/);
  assert.strictEqual(ctx.notified[0].title, 'DNSHE 域名续期失败');
});

console.log('\nALL ' + passed + ' DNSHE TESTS PASSED');
