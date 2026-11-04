// notify.js 单元测试：多通道兜底顺序 + 响应体判定 + 错误详情
// 用法: node tools/test-notify.mjs
import { meowPush, safeTitle } from '../src/notify.js';

let passed = 0, failed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log('ok - ' + name); }
  else { failed++; console.log('FAIL - ' + name); }
};

// 可编程 mock fetch：按调用序号返回脚本注入的响应/异常，并记录每次请求
function makeFetchScript() {
  const calls = [];
  const steps = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step && step.throw) throw new Error(step.throw);
    return {
      status: step ? step.status : 200,
      text: async () => (step && step.body !== undefined ? step.body : '{"status":200,"data":true,"msg":"ok"}'),
    };
  };
  return { fetch, calls, steps };
}

const env = {}; // meowPush 不读 env，占位

// 1) 通道 1（反代POST）成功：只发一次，不继续尝试
{
  const s = makeFetchScript();
  s.steps.push({ status: 200, body: '{"status":200,"data":true,"msg":"发送成功"}' });
  globalThis.fetch = s.fetch;
  await meowPush(env, 'nick', '标题', '内容');
  ok(s.calls.length === 1, '通道1成功只发一次');
  ok(s.calls[0].url.startsWith('https://relay-nu-seven.vercel.app/api/meow/nick'), '通道1走Vercel反代POST地址');
  ok(s.calls[0].init.method === 'POST' && s.calls[0].init.body.includes('"title"'), '通道1是 POST + JSON body');
}

// 2) 通道1失效（403 空 body）→ 通道2（反代GET）成功
{
  const s = makeFetchScript();
  s.steps.push({ status: 403, body: '' });
  s.steps.push({ status: 200, body: '{"status":200,"data":true,"msg":"发送成功"}' });
  globalThis.fetch = s.fetch;
  await meowPush(env, 'nick', '标题', '内容');
  ok(s.calls.length === 2, '通道1被拦后落到通道2');
  ok(s.calls[1].url.includes('/api/meow/nick/'), '通道2是反代GET路径格式');
  ok(s.calls[1].init.method === 'GET' && s.calls[1].init.body === undefined, '通道2无请求体');
}

// 3) 反代整体失效（两通道都 403）→ 通道3（中转POST）成功
{
  const s = makeFetchScript();
  s.steps.push({ status: 403, body: '' });
  s.steps.push({ status: 403, body: '' });
  s.steps.push({ status: 200, body: '{"status":200,"data":true,"msg":"发送成功"}' });
  globalThis.fetch = s.fetch;
  await meowPush(env, 'nick', '标题', '内容');
  ok(s.calls.length === 3, '反代两通道都挂后落到通道3');
  ok(s.calls[2].url.startsWith('https://down.nigx.cn/api.chuckfang.com/nick'), '通道3走中转POST');
}

// 4) 中转也失效 → 通道4（中转GET）成功
{
  const s = makeFetchScript();
  s.steps.push({ status: 403, body: '' });
  s.steps.push({ status: 403, body: '' });
  s.steps.push({ status: 403, body: '' });
  s.steps.push({ status: 200, body: '{"status":200,"data":true,"msg":"发送成功"}' });
  globalThis.fetch = s.fetch;
  await meowPush(env, 'nick', '标题', '内容');
  ok(s.calls.length === 4, '反代+中转POST都挂后落到通道4');
  ok(s.calls[3].url.includes('down.nigx.cn/api.chuckfang.com/nick/'), '通道4是中转GET路径格式');
}

// 5) 前四通道全挂 → 通道5（直连POST）兜底
{
  const s = makeFetchScript();
  for (let i = 0; i < 4; i++) s.steps.push({ status: 403, body: '' });
  s.steps.push({ status: 200, body: '{"status":200,"data":true,"msg":"发送成功"}' });
  globalThis.fetch = s.fetch;
  await meowPush(env, 'nick', '标题', '内容');
  ok(s.calls.length === 5, '前四通道都挂后落到通道5');
  ok(s.calls[4].url.startsWith('https://api.chuckfang.com/nick'), '通道5直连 MeoW');
}

// 6) 全部失败：抛错且错误带各通道详情（含空响应体标记）
{
  const s = makeFetchScript();
  s.steps.push({ status: 403, body: '' });
  s.steps.push({ status: 502, body: '<html>bad gateway</html>' });
  s.steps.push({ status: 403, body: '' });
  s.steps.push({ status: 200, body: '{"status":404,"data":false,"msg":"昵称不存在"}' });
  s.steps.push({ throw: 'network down' });
  globalThis.fetch = s.fetch;
  let err = null;
  try { await meowPush(env, 'nick', '标题', '内容'); } catch (e) { err = e; }
  ok(err !== null, '全通道失败时抛错');
  ok(/反代POST.*空响应体/.test(err.message), '错误详情含通道1空响应体说明');
  ok(/反代GET.*bad gateway/.test(err.message), '错误详情含通道2响应体片段');
  ok(/中转GET.*昵称不存在/.test(err.message), '错误详情含通道4业务错误');
  ok(/直连POST.*network down/.test(err.message), '错误详情含通道5异常信息');
}

// 7) MeoW 业务失败（status!=200）也按失败继续兜底
{
  const s = makeFetchScript();
  s.steps.push({ status: 200, body: '{"status":404,"data":false,"msg":"该昵称没有注册"}' });
  s.steps.push({ status: 200, body: '{"status":200,"data":true,"msg":"发送成功"}' });
  globalThis.fetch = s.fetch;
  await meowPush(env, 'nick', '标题', '内容');
  ok(s.calls.length === 2, 'MeoW 业务错误(body status!=200)也会兜底到通道2');
}

// 8) 无昵称 fail-fast
{
  let err = null;
  try { await meowPush(env, '', 't', 'c'); } catch (e) { err = e; }
  ok(err && /昵称未配置/.test(err.message), '空昵称直接报错且不发请求');
}

// 9) safeTitle 冒号/斜杠替换 + 截断
{
  ok(safeTitle('a:b/c：d') === 'a-b-c-d', 'safeTitle 替换中英文冒号和斜杠');
  ok(safeTitle('x'.repeat(100)).length === 64, 'safeTitle 截断到 64');
}

console.log((failed === 0 ? 'ALL ' + passed + ' NOTIFY TESTS PASSED' : failed + ' FAILED'));
process.exit(failed === 0 ? 0 : 1);
