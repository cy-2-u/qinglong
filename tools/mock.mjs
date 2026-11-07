// 测试共享助手：ctx 造具 + 响应造具 + 极简用例跑批。
// 各 test-*.mjs 通过 import 复用，避免每个文件重复一份 harness。
export function makeCtx(params, fetchFn) {
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

export function jsonRes(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, text: async () => text };
}

// 串行跑用例并计数；任何断言失败直接抛出（node 非零退出码）
export async function runTests(cases) {
  let passed = 0;
  for (const [name, fn] of cases) {
    await fn();
    passed++;
    console.log('ok -', name);
  }
  return passed;
}
