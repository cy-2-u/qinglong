// 本地试跑任务脚本：真实网络 + CPU 计量（凭据经环境变量传入，绝不写入仓库文件）
// 用法:
//   QL_PARAMS='{"cookie":"..."}' node live-run.mjs glados-checkin
//   QL_PARAMS_FILE=C:\temp\params.json node live-run.mjs dnshe-renew
//
// CPU 计量说明：Workers 免费版限制的是每次调用的 CPU 时间（10ms），
// 网络等待不计入。node 与 workerd 同为 V8，process.cpuUsage() 差值
// （只统计 CPU、不含网络等待）可直接映射到该预算。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const name = process.argv[2];
if (!name) { console.error('usage: node live-run.mjs <glados-checkin|dnshe-renew>'); process.exit(1); }

const code = readFileSync(join(__dirname, '..', 'src', 'scripts', name + '.txt'), 'utf8');
let params = {};
if (process.env.QL_PARAMS_FILE) {
  params = JSON.parse(readFileSync(process.env.QL_PARAMS_FILE, 'utf8'));
} else if (process.env.QL_PARAMS) {
  params = JSON.parse(process.env.QL_PARAMS);
}

let requests = 0;
const ctx = {
  params,
  log: (m) => console.log('[log] ' + String(m)),
  notify: async (title, content) => {
    console.log('[notify] title: ' + title);
    console.log('--- 推送内容开始 ---');
    console.log(String(content));
    console.log('--- 推送内容结束 ---');
  },
  fetch: async (url, init) => {
    requests++;
    const t = Date.now();
    const method = (init && init.method) || 'GET';
    try {
      const res = await fetch(url, Object.assign({}, init, { signal: AbortSignal.timeout(30000) }));
      console.log('[fetch #' + requests + '] ' + method + ' ' + url.slice(0, 110) + ' -> ' + res.status + ' (' + (Date.now() - t) + 'ms)');
      return res;
    } catch (e) {
      console.log('[fetch #' + requests + '] ' + method + ' ' + url.slice(0, 110) + ' -> ERROR: ' + ((e && e.message) || e));
      throw e;
    }
  },
};

const fn = new Function('ctx', '"use strict";\n' + code + '\nreturn main(ctx);');
const cpu0 = process.cpuUsage();
const wall0 = Date.now();
let ok = true;
try {
  await fn(ctx);
} catch (e) {
  ok = false;
  console.log('\n== 结果: 抛错 ==\n' + ((e && e.stack) || e));
}
const wall = Date.now() - wall0;
const cpu = process.cpuUsage(cpu0);

console.log('\n== 计量 (' + name + ') ==');
console.log('结果: ' + (ok ? '成功' : '失败'));
console.log('CPU user:   ' + (cpu.user / 1000).toFixed(2) + ' ms');
console.log('CPU system: ' + (cpu.system / 1000).toFixed(2) + ' ms');
console.log('CPU 合计:   ' + ((cpu.user + cpu.system) / 1000).toFixed(2) + ' ms');
console.log('墙钟:       ' + wall + ' ms');
console.log('请求数:     ' + requests);
