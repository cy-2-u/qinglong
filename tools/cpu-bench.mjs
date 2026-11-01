// 纯 JS CPU 基准：估算两个任务在 Workers 免费版 10ms CPU 预算内的真实开销。
// 原理：Workers 里 TLS/DNS/连接管理发生在边缘、不计入 isolate CPU；
// 计入 CPU 的是 JS 执行 + JSON 解析/序列化。本基准用进程内 mock fetch
// （零网络、零 TLS），process.cpuUsage 差值即为纯 JS 开销，可直接映射 10ms 预算。
// 用法: node cpu-bench.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, tmpdir } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run as runGlados } from '../src/tasks/glados-checkin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// DNSHE 模块带 2 秒限流睡眠（不耗 CPU，但会拖慢基准）——基准用打了补丁的临时副本
const dnsheSrc = readFileSync(join(__dirname, '..', 'src', 'tasks', 'dnshe-renew.js'), 'utf8');
const patched = dnsheSrc.replace('const minInterval = 2;', 'const minInterval = 0;');
const benchPath = join(tmpdir(), 'dnshe-bench.mjs');
writeFileSync(benchPath, patched);
const { run: runDnshe } = await import(pathToFileURL(benchPath));

function makeCtx(fetchFn) {
  return {
    params: {},
    logs: [],
    notified: [],
    log(m) { this.logs.push(String(m)); },
    async notify(t, c) { this.notified.push({ title: t, content: c }); },
    fetch: fetchFn,
  };
}

function jsonRes(status, body) {
  const text = JSON.stringify(body);
  return { status, json: async () => body, text: async () => text };
}

// ---------- GLaDOS mock（按真实响应形状） ----------
function gladosMock(points) {
  const routes = {
    '/api/user/checkin': { code: 0, message: "Today's observation logged. Return tomorrow for more points." },
    '/api/user/status': { code: 0, data: { email: '2671174616@qq.com', leftDays: 465 } },
    '/api/user/points': {
      points: points,
      history: [{ change: 7 }, { change: 5 }, { change: 6 }, { change: 7 }, { change: 5 }, { change: 7 }],
      plans: { plan100: { points: 100, days: 10 }, plan200: { points: 200, days: 30 }, plan500: { points: 500, days: 100 } },
    },
    '/api/user/exchange': { code: 0 },
  };
  return async (url) => {
    const path = new URL(url).pathname;
    if (!routes[path]) return jsonRes(404, {});
    return jsonRes(200, routes[path]);
  };
}

// ---------- DNSHE mock（10 个域名，混合续期结果） ----------
function dnsheMock(domainCount) {
  const domains = [];
  for (let i = 0; i < domainCount; i++) {
    domains.push({
      id: i + 1,
      subdomain: 'demo' + i,
      rootdomain: 'dnshe.com',
      full_domain: 'demo' + i + '.dnshe.com',
      status: i % 7 === 3 ? 'Registered' : 'Registered',
      expires_at: '2027-0' + ((i % 9) + 1) + '-15 09:00:00',
      never_expires: i === 2 ? '1' : '0',
    });
  }
  let renewN = 0;
  const outcomes = [
    () => jsonRes(200, { success: true, new_expires_at: '2027-10-15 09:00:00', charged_amount: 0, remaining_days: 180 }),
    () => jsonRes(422, { success: false, error_code: 'renewal_not_yet_available', message: '尚未进入续期窗口', details: { days_until_window: 12 } }),
    () => jsonRes(500, { success: false, error_code: 'internal_error', message: '内部错误' }),
    () => jsonRes(200, { success: true, new_expires_at: '2027-11-01 09:00:00', charged_amount: 2, remaining_days: 197 }),
  ];
  return async (url) => {
    if (url.includes('action=list')) {
      return jsonRes(200, { subdomains: domains, pagination: { total: domains.length, has_more: false }, count: domains.length });
    }
    if (url.includes('endpoint=quota')) return jsonRes(200, { quota: { available: 100, used: 5, total: 200 } });
    if (url.includes('action=renew')) return outcomes[renewN++ % outcomes.length]();
    return jsonRes(404, { success: false });
  };
}

function bench(label, runFn, fetchFn, ctxParams, iterations) {
  // 预热（JIT + 内联缓存稳定后再计量，模拟常驻 isolate 的真实状态）
  const warm = makeCtx(fetchFn);
  warm.params = ctxParams;
  // 脚本有失败项时会按设计抛错，属预期，捕获即可（抛错开销同样计入测量）
  return Promise.resolve(runFn(warm)).catch(() => undefined).then(() => {
    const cpu0 = process.cpuUsage();
    const t0 = Date.now();
    let chain = Promise.resolve();
    for (let i = 0; i < iterations; i++) {
      const c = makeCtx(fetchFn);
      c.params = ctxParams;
      chain = chain.then(() => runFn(c)).catch(() => undefined);
    }
    return chain.then(() => {
      const cpu = process.cpuUsage(cpu0);
      const wall = Date.now() - t0;
      const cpuMs = (cpu.user + cpu.system) / 1000;
      console.log(
        label.padEnd(46) +
        'CPU ' + (cpuMs / iterations).toFixed(3) + ' ms/次' +
        '   墙钟 ' + (wall / iterations).toFixed(1) + ' ms/次' +
        '   (' + iterations + ' 次均值)'
      );
      return cpuMs / iterations;
    });
  });
}

const COOKIE = 'gld:sess=gld_demo; gld:sess.sig=sigdemo';
const r1 = await bench('GLaDOS 单账号 · 485分(不兑换)', runGlados, gladosMock(485), { cookie: COOKIE }, 300);
const r2 = await bench('GLaDOS 单账号 · 520分(兑换+重查)', runGlados, gladosMock(520), { cookie: COOKIE }, 300);
const r3 = await bench('GLaDOS 3账号最坏(全部兑换)', runGlados, gladosMock(520), { cookie: COOKIE + '\n' + COOKIE + '\n' + COOKIE }, 100);
const r4 = await bench('DNSHE 10域名(2续期成功+1良性+1失败)', runDnshe, dnsheMock(10), { api_key: 'k', api_secret: 's' }, 100);
const r5 = await bench('DNSHE 30域名压测', runDnshe, dnsheMock(30), { api_key: 'k', api_secret: 's' }, 100);

console.log('\n== 心跳单次调用合计（两任务同一小时到期、串行共处一次 DO alarm 调用） ==');
console.log('最坏组合 = GLaDOS 3账号兑换 + DNSHE 30域名 ≈ ' + (r3 + r5).toFixed(3) + ' ms  vs  预算 10 ms');
