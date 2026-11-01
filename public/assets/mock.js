/* 演示数据层：用 localStorage 模拟后端，便于脱离 Workers 本地审计 UI。
 * 正式后端（Workers + D1）就绪后，本文件可整体删除。
 * 约定：时间戳一律为秒（与后端 D1 存储一致）。 */
(function () {
  'use strict';

  var KEY_TASKS = 'ql.mock.tasks';
  var KEY_LOGS = 'ql.mock.logs';
  var KEY_SETTINGS = 'ql.mock.settings';

  // ---------- 内置脚本示例（注意：内容里不能出现反引号和 ${}，避免与外层模板冲突） ----------
  var SAMPLE_GLADOS = [
    'async function main(ctx) {',
    '  const cookie = ctx.params.cookie;',
    "  if (!cookie) throw new Error('缺少参数：cookie');",
    '',
    "  const res = await ctx.fetch('https://glados.rocks/api/user/checkin', {",
    "    method: 'POST',",
    "    headers: { cookie: cookie, 'content-type': 'application/json' },",
    "    body: JSON.stringify({ token: 'checkin' }),",
    '  });',
    '  const data = await res.json();',
    "  ctx.log('签到结果：' + data.message);",
    "  await ctx.notify('GLaDOS 签到', String(data.message));",
    '}'
  ].join('\n');

  var SAMPLE_DNSHE = [
    '// DNSHE 域名续期（完整逻辑第二步从 Python 移植，当前为演示骨架）',
    'async function main(ctx) {',
    '  const apiKey = ctx.params.apiKey;',
    '  const apiSecret = ctx.params.apiSecret;',
    "  if (!apiKey || !apiSecret) throw new Error('缺少参数：apiKey / apiSecret');",
    '',
    "  ctx.log('拉取域名列表…');",
    '  // TODO: 分页拉取 + 阈值判断 + 逐个续期 + 汇总推送',
    "  ctx.log('本次无需续期的域名');",
    '}'
  ].join('\n');

  var SAMPLE_HEARTBEAT = [
    '// 最小示例：展示 ctx 的用法',
    'async function main(ctx) {',
    "  ctx.log('心跳测试，当前参数：' + JSON.stringify(ctx.params));",
    '}'
  ].join('\n');

  var DEFAULT_SCRIPT = [
    'async function main(ctx) {',
    '  // ctx.params  当前任务的参数（键值对）',
    '  // ctx.log(msg) 写入运行日志',
    '  // ctx.notify(title, content)  推送通知',
    '  // ctx.fetch(url, init)  带超时保险丝的 fetch',
    "  ctx.log('你好，青龙');",
    '}'
  ].join('\n');

  // ---------- 时间工具 ----------
  function nowSec() { return Math.floor(Date.now() / 1000); }

  // 今天/明天某点整（秒）
  // 演示种子时间：dailyAt(…,false)=最近一个已过去的整点（上次运行）；
  // dailyAt(…,true)=下一个未来整点（下次运行）
  function dailyAt(hour, next) {
    var d = new Date();
    d.setHours(hour, 0, 0, 0);
    if (next) { if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); }
    else if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1);
    return Math.floor(d.getTime() / 1000);
  }

  // 某月某日某点整（秒）；nextMonth=true 取下个月，否则取最近一个已过去的锚点
  function monthlyAt(day, hour, nextMonth) {
    var d = new Date();
    d.setDate(1);
    d.setHours(hour, 0, 0, 0);
    if (nextMonth) d.setMonth(d.getMonth() + 1);
    d.setDate(day);
    if (!nextMonth && d.getTime() > Date.now()) d.setMonth(d.getMonth() - 1);
    return Math.floor(d.getTime() / 1000);
  }

  // ---------- 种子数据 ----------
  function seed() {
    var tasks = [
      {
        id: 1,
        name: 'GLaDOS 签到',
        enabled: 1,
        interval_amount: 1,
        interval_unit: 'd',
        run_hour: 9,
        run_day: null,
        params: { cookie: 'koa:sess=eyJhbGciOi（演示数据，可编辑）' },
        script_code: SAMPLE_GLADOS,
        last_run_at: dailyAt(9, false),
        last_status: 'ok',
        next_run_at: dailyAt(9, true)
      },
      {
        id: 2,
        name: 'DNSHE 域名续期',
        enabled: 1,
        interval_amount: 1,
        interval_unit: 'm',
        run_hour: 9,
        run_day: 1,
        params: { apiKey: 'demo-key', apiSecret: 'demo-secret' },
        script_code: SAMPLE_DNSHE,
        last_run_at: monthlyAt(1, 9, false),
        last_status: 'ok',
        next_run_at: monthlyAt(1, 9, true)
      },
      {
        id: 3,
        name: '示例 · 每 12 小时心跳测试',
        enabled: 0,
        interval_amount: 12,
        interval_unit: 'h',
        run_hour: null,
        run_day: null,
        params: { env: 'demo' },
        script_code: SAMPLE_HEARTBEAT,
        last_run_at: null,
        last_status: 'never',
        next_run_at: nowSec() + 12 * 3600
      }
    ];

    var logs = {};
    logs[1] = [
      { ts: dailyAt(9, false) + 2, level: 'info', text: '定时触发（每天 09 点槽位）' },
      { ts: dailyAt(9, false) + 3, level: 'info', text: '请求 GLaDOS checkin 接口…' },
      { ts: dailyAt(9, false) + 5, level: 'info', text: '签到结果：Checkin for user OK! 100GB added' },
      { ts: dailyAt(9, false) + 6, level: 'info', text: 'MeoW 推送成功' },
      { ts: dailyAt(9, false) - 86400 + 2, level: 'info', text: '定时触发（每天 09 点槽位）' },
      { ts: dailyAt(9, false) - 86400 + 3, level: 'error', text: '签到失败：cookie 已过期（HTTP 401），请在参数中更新 cookie' },
      { ts: dailyAt(9, false) - 86400 + 4, level: 'info', text: '失败告警已推送' }
    ];
    logs[2] = [
      { ts: monthlyAt(1, 9, false) + 2, level: 'info', text: '定时触发（每月 1 号 09 点槽位）' },
      { ts: monthlyAt(1, 9, false) + 3, level: 'info', text: '账户下 3 个域名，其中 2 个进入续期窗口（<= 180 天）' },
      { ts: monthlyAt(1, 9, false) + 6, level: 'info', text: 'a.demo.dnshe.com 续期成功，新到期时间 2027-10-01' },
      { ts: monthlyAt(1, 9, false) + 9, level: 'info', text: 'b.demo.dnshe.com 续期成功，新到期时间 2027-10-01' },
      { ts: monthlyAt(1, 9, false) + 10, level: 'info', text: 'c.demo.dnshe.com 未到续期窗口（剩余 45 天），跳过' },
      { ts: monthlyAt(1, 9, false) + 11, level: 'info', text: '续期报告已推送（MeoW）' }
    ];
    logs[3] = [
      { ts: nowSec() - 7200, level: 'info', text: '手动触发' },
      { ts: nowSec() - 7199, level: 'info', text: '心跳测试，当前参数：{"env":"demo"}' }
    ];

    localStorage.setItem(KEY_TASKS, JSON.stringify(tasks));
    localStorage.setItem(KEY_LOGS, JSON.stringify(logs));
    return { tasks: tasks, logs: logs };
  }

  function load() {
    var tasks = null, logs = null;
    try { tasks = JSON.parse(localStorage.getItem(KEY_TASKS)); } catch (e) { /* 忽略 */ }
    try { logs = JSON.parse(localStorage.getItem(KEY_LOGS)); } catch (e) { /* 忽略 */ }
    if (!Array.isArray(tasks) || !logs) return seed();
    return { tasks: tasks, logs: logs };
  }

  function persistTasks(tasks) { localStorage.setItem(KEY_TASKS, JSON.stringify(tasks)); }
  function persistLogs(logs) { localStorage.setItem(KEY_LOGS, JSON.stringify(logs)); }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // 按调度配置粗算 next_run_at（演示用，真实计算在后端心跳里）
  function mockNext(t) {
    var u = t.interval_unit, n = Math.max(1, t.interval_amount | 0);
    if (u === 'h') return nowSec() + n * 3600;
    if (u === 'd') return dailyAt(t.run_hour == null ? 9 : t.run_hour, true);
    return monthlyAt(t.run_day == null ? 1 : t.run_day, t.run_hour == null ? 9 : t.run_hour, true);
  }

  // ---------- 模拟后端接口 ----------
  var MockAPI = {
    login: async function (pw) {
      await sleep(200);
      return typeof pw === 'string' && pw.length > 0; // 演示模式：任意非空密码
    },

    listTasks: async function () {
      await sleep(120);
      return load().tasks.slice();
    },

    saveTask: async function (task) {
      await sleep(150);
      var data = load();
      if (task.id) {
        var i = data.tasks.findIndex(function (t) { return t.id === task.id; });
        if (i < 0) throw new Error('任务不存在');
        task.next_run_at = data.tasks[i].next_run_at; // 保存不改节奏，与真实后端一致
        data.tasks[i] = task;
      } else {
        var maxId = data.tasks.reduce(function (m, t) { return Math.max(m, t.id); }, 0);
        task.id = maxId + 1;
        task.last_run_at = null;
        task.last_status = 'never';
        task.next_run_at = mockNext(task);
        data.tasks.push(task);
      }
      persistTasks(data.tasks);
      return task;
    },

    deleteTask: async function (id) {
      await sleep(120);
      var data = load();
      data.tasks = data.tasks.filter(function (t) { return t.id !== id; });
      delete data.logs[id];
      persistTasks(data.tasks); persistLogs(data.logs);
      return true;
    },

    toggleTask: async function (id, enabled) {
      await sleep(80);
      var data = load();
      var t = data.tasks.find(function (x) { return x.id === id; });
      if (t) { t.enabled = enabled ? 1 : 0; persistTasks(data.tasks); }
      return true;
    },

    // 模拟一次真实运行：running -> ok，并写入日志
    runTask: async function (id) {
      var data = load();
      var t = data.tasks.find(function (x) { return x.id === id; });
      if (!t) throw new Error('任务不存在');
      t.last_status = 'running';
      persistTasks(data.tasks);

      await sleep(1600);

      var isCheckin = t.name.indexOf('GLaDOS') >= 0;
      var isRenew = t.name.indexOf('DNSHE') >= 0;
      var lines = [{ ts: nowSec(), level: 'info', text: '手动触发运行' }];
      if (isCheckin) {
        lines.push({ ts: nowSec(), level: 'info', text: '请求 GLaDOS checkin 接口…' });
        lines.push({ ts: nowSec(), level: 'info', text: '签到结果：Checkin for user OK! 100GB added' });
        lines.push({ ts: nowSec(), level: 'info', text: 'ctx.notify 已调用' });
      } else if (isRenew) {
        lines.push({ ts: nowSec(), level: 'info', text: '账户下 3 个域名，本次无需续期' });
        lines.push({ ts: nowSec(), level: 'info', text: 'ctx.notify 已调用（续期报告）' });
      } else {
        lines.push({ ts: nowSec(), level: 'info', text: '脚本执行完成' });
      }

      // 全局通知：配置了 MeoW 昵称才实际推送
      var settings = {};
      try { settings = JSON.parse(localStorage.getItem(KEY_SETTINGS) || '{}'); } catch (e) { /* 忽略 */ }
      if (settings.meow_nickname) {
        lines.push({ ts: nowSec(), level: 'info', text: 'MeoW 推送成功（' + settings.meow_nickname + '）' });
      } else {
        lines.push({ ts: nowSec(), level: 'info', text: '未配置全局通知，跳过推送（顶栏齿轮可设置）' });
      }

      var fresh = load();
      var ft = fresh.tasks.find(function (x) { return x.id === id; });
      if (ft) { ft.last_run_at = nowSec(); ft.last_status = 'ok'; persistTasks(fresh.tasks); }
      fresh.logs[id] = (fresh.logs[id] || []).concat(lines);
      persistLogs(fresh.logs);
      return { ok: true };
    },

    listLogs: async function (taskId) {
      await sleep(100);
      var logs = load().logs;
      return (logs[taskId] || []).slice().reverse();
    },

    resetDemo: async function () {
      var data = seed();
      return data.tasks;
    },

    // ---------- 全局通知设置 ----------
    getSettings: async function () {
      await sleep(80);
      var s = {};
      try { s = JSON.parse(localStorage.getItem(KEY_SETTINGS) || '{}'); } catch (e) { /* 忽略 */ }
      return { meow_nickname: s.meow_nickname || '' };
    },

    saveSettings: async function (s) {
      await sleep(100);
      localStorage.setItem(KEY_SETTINGS, JSON.stringify({ meow_nickname: (s && s.meow_nickname) || '' }));
      return true;
    },

    testNotify: async function (nickname) {
      await sleep(700);
      if (!nickname) throw new Error('昵称为空，请先填写 MeoW 昵称');
      return { ok: true }; // 演示模式不真的请求 chuckfang.com
    }
  };

  window.MockAPI = MockAPI;
  window.QL_DEFAULT_SCRIPT = DEFAULT_SCRIPT;
})();
