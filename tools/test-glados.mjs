// GLaDOS 签到脚本的 mock 端到端测试（node 直接跑）
// 覆盖：签到成功 + 自动兑换 500 档、积分不足不兑换、认证失败不重试、
// 三种 Cookie 格式、推送无条件。曾借此抓出 pushLevel 残留导致的必崩 bug。
// 用法: node test-glados.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(__dirname, '..', 'src', 'scripts', 'glados-checkin.txt'), 'utf8');

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

// 造一个按路径路由的 mock：checkin 恒成功、status/points 可配、exchange 计数
function gladosMock(opts) {
  const state = { checkinAttempts: 0, exchangeCalls: [], pointsBody: opts.pointsBody };
  const fetchFn = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/api/user/checkin') {
      state.checkinAttempts++;
      return { status: 200, json: async () => ({ code: 0, message: 'checkin! got 100GB' }) };
    }
    if (path === '/api/user/status') {
      return { status: 200, json: async () => ({ code: 0, data: { email: 'a@b.c', leftDays: 30.5 } }) };
    }
    if (path === '/api/user/points') {
      return { status: 200, json: async () => state.pointsBody };
    }
    if (path === '/api/user/exchange') {
      state.exchangeCalls.push(String(init.body));
      return { status: 200, json: async () => ({ code: 0 }) };
    }
    return { status: 404, json: async () => ({}) };
  };
  return { fetchFn, state };
}

// ---------- 场景 1：签到成功 + 积分 520 自动兑换 500 档（Cookie-Editor JSON 输入） ----------
await t('签到成功、兑换 500 档、JSON Cookie 解析、无条件推送', async () => {
  const cookieJson = '[{"name":"gld:sess","value":"AAA"},{"name":"gld:sess.sig","value":"BBB"}]';
  const { fetchFn, state } = gladosMock({
    pointsBody: { points: 520, history: [{ change: 5 }], plans: { plan500: { points: 500, days: 100 } } },
  });
  const ctx = makeCtx({ cookie: cookieJson }, fetchFn);
  await runScript(ctx);

  assert.strictEqual(state.checkinAttempts, 1, '首次成功不应重试');
  assert.deepStrictEqual(state.exchangeCalls, ['planType=plan500'], '应兑换 plan500');
  assert.strictEqual(ctx.notified.length, 1, '推送一次');
  assert.strictEqual(ctx.notified[0].title, 'GLaDOS 签到 成功1/1');
  assert.ok(ctx.logs.some((l) => l.includes('兑换成功 +100天')), '兑换成功入日志');
  assert.ok(ctx.logs.some((l) => l.includes('积分: 520')), '积分入日志');
  assert.ok(ctx.notified[0].content.includes('签到结果: checkin! got 100GB'), '推送含签到结果');
  assert.ok(ctx.notified[0].content.includes('账号 a@b.c'), '推送含账号邮箱');
});

// ---------- 场景 2：积分不足 500 -> 不兑换只记日志，签到不受影响 ----------
await t('积分不足 -> 不调用兑换接口，照常推送', async () => {
  const { fetchFn, state } = gladosMock({
    pointsBody: { points: 120, history: [{ change: -5 }], plans: {} },
  });
  const ctx = makeCtx({ cookie: 'gld:sess=x; gld:sess.sig=y' }, fetchFn);
  await runScript(ctx);

  assert.deepStrictEqual(state.exchangeCalls, [], '积分不足不应调兑换');
  assert.ok(ctx.logs.some((l) => l.includes('积分不足(120/500分)')), '积分不足入日志');
  assert.strictEqual(ctx.notified[0].title, 'GLaDOS 签到 成功1/1');
  assert.ok(ctx.notified[0].content.includes('当前积分: 120 (-5)'), '负数积分变动带符号');
});

// ---------- 场景 3：认证失败 -> 不重试、不兑换、标题 0/1；旧 token 自动补 koa 前缀 ----------
await t('认证失败不重试，旧 token 格式自动补前缀并告警', async () => {
  const state2 = { checkinAttempts: 0, exchangeCalls: [] };
  const fetchFn = async (url) => {
    const path = new URL(url).pathname;
    if (path === '/api/user/checkin') {
      state2.checkinAttempts++;
      return { status: 200, json: async () => ({ code: -2, message: '没有权限' }) };
    }
    if (path === '/api/user/status') return { status: 200, json: async () => ({ code: -2, data: null }) };
    if (path === '/api/user/points') return { status: 200, json: async () => ({ code: -2 }) };
    return { status: 404, json: async () => ({}) };
  };
  // 旧版单 token（三段式、无 =、长度 > 50）
  const legacy = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.xxxxxxxxxxxxxxxxxxxx';
  const ctx = makeCtx({ cookie: legacy }, fetchFn);
  await runScript(ctx);

  assert.strictEqual(state2.checkinAttempts, 1, '认证失败不应重试');
  assert.deepStrictEqual(state2.exchangeCalls, [], 'points 查询失败时不应兑换');
  assert.ok(ctx.logs.some((l) => l.includes('认证失败，不再重试')), '认证失败入日志');
  assert.ok(ctx.logs.some((l) => l.includes('缺少 gld:sess')), '旧 token 触发 gld 前缀告警');
  assert.strictEqual(ctx.notified[0].title, 'GLaDOS 签到 成功0/1', '失败也推送');
  assert.ok(ctx.logs.some((l) => l.includes('积分不足(?/500分)')), 'points 未知时积分显示 ?');
});

console.log('\nALL ' + passed + ' GLADOS TESTS PASSED');
