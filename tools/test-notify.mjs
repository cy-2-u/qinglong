// notify.js 单元测试：URL 组装 + 响应判定 + 清洗规则（全程 mock fetch，零真实请求）
// 用法: node tools/test-notify.mjs
import assert from 'node:assert';
import { notifyPush, safeTitle } from '../src/notify.js';

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('ok -', name); };

function res(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, text: async () => text };
}

await t('成功推送：GET 路径格式 + key/title/body 各自编码 + group 参数', async () => {
  let captured = null;
  globalThis.fetch = async (url, init) => { captured = { url: String(url), init }; return res(200, { ok: true }); };
  await notifyPush({}, 'KEY123', '签到 成功', '内容第一行\n第二行');
  assert.strictEqual(captured.init.method, 'GET');
  assert.ok(captured.url.startsWith('https://timelynotify.oicode.cn/KEY123/'), '密钥在路径首段');
  assert.ok(captured.url.includes('/' + encodeURIComponent('签到 成功') + '/'), 'title 单独编码');
  assert.ok(captured.url.includes(encodeURIComponent('内容第一行\n第二行')), 'body 单独编码');
  assert.ok(captured.url.includes('?group=qinglong'), 'group 参数');
});

await t('非 200 抛错且错误带响应体片段', async () => {
  globalThis.fetch = async () => res(500, 'server error');
  await assert.rejects(() => notifyPush({}, 'K', 't', 'c'), /通知推送未成功: HTTP 500: server error/);
});

await t('200 但带 body 也算成功（服务端只看状态码）', async () => {
  globalThis.fetch = async () => res(200, 'whatever');
  await notifyPush({}, 'K', 't', 'c');
});

await t('网络异常向上抛出', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  await assert.rejects(() => notifyPush({}, 'K', 't', 'c'), /network down/);
});

await t('空密钥 fail-fast 且不发请求', async () => {
  let called = 0;
  globalThis.fetch = async () => { called++; return res(200, {}); };
  await assert.rejects(() => notifyPush({}, '', 't', 'c'), /密钥未配置/);
  assert.strictEqual(called, 0, '未发任何请求');
});

await t('safeTitle 清洗：中英文冒号和斜杠替换、截断 64', () => {
  assert.strictEqual(safeTitle('a:b/c：d'), 'a-b-c-d');
  assert.strictEqual(safeTitle('x'.repeat(100)).length, 64);
});

console.log('\nALL ' + passed + ' NOTIFY TESTS PASSED');
