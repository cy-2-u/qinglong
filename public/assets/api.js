/* 后端适配层：统一 UI 与后端之间的接口。
 * - 同源存在 /api/health（正式 Workers 后端）时走 live 模式（fetch /api/*）
 * - 否则自动落入 mock 模式（window.MockAPI，localStorage 演示数据）
 * UI 只依赖 window.API，不感知背后是哪一个。 */
(function () {
  'use strict';

  var mode = 'mock';            // 'live' | 'mock'
  var ready = false;
  var readyCbs = [];

  function notifyReady() {
    if (ready) return;
    ready = true;
    readyCbs.forEach(function (cb) { try { cb(mode); } catch (e) { /* 忽略 */ } });
  }

  // 探测真实后端。file:// 或无后端时 fetch 会失败/404，保持 mock。
  (function probe() {
    var done = false;
    function settle(m) { if (!done) { done = true; mode = m; notifyReady(); } }
    // 兜底：800ms 内没有结果就按 mock 处理
    setTimeout(function () { settle(mode); }, 800);
    try {
      fetch('/api/health', { method: 'GET' })
        .then(function (r) { settle(r.ok ? 'live' : 'mock'); })
        .catch(function () { settle('mock'); });
    } catch (e) { settle('mock'); }
  })();

  function backend() { return mode === 'live' ? LiveAPI : window.MockAPI; }

  // ---------- live 实现（后端未部署前不会被调用到） ----------
  async function call(path, init) {
    var r = await fetch('/api' + path, Object.assign({
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin'
    }, init || {}));
    if (r.status === 401) { throw new Error('UNAUTHORIZED'); }
    var body = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
    return body;
  }

  var LiveAPI = {
    login: function (pw) { return call('/login', { method: 'POST', body: JSON.stringify({ password: pw }) }); },
    listTasks: function () { return call('/tasks').then(function (b) { return b.tasks; }); },
    saveTask: function (t) { return call('/tasks', { method: t.id ? 'PUT' : 'POST', body: JSON.stringify(t) }); },
    deleteTask: function (id) { return call('/tasks/' + id, { method: 'DELETE' }); },
    toggleTask: function (id, enabled) { return call('/tasks/' + id, { method: 'PATCH', body: JSON.stringify({ enabled: enabled ? 1 : 0 }) }); },
    runTask: function (id) { return call('/tasks/' + id + '/run', { method: 'POST' }); },
    listLogs: function (taskId) { return call('/tasks/' + taskId + '/logs').then(function (b) { return b.logs; }); },
    resetDemo: null,
    getSettings: function () { return call('/settings'); },
    saveSettings: function (s) { return call('/settings', { method: 'PUT', body: JSON.stringify(s) }); },
    testNotify: function (nickname) { return call('/settings/test', { method: 'POST', body: JSON.stringify({ nickname: nickname }) }); }
  };

  // ---------- 对外接口 ----------
  window.API = {
    get mode() { return mode; },
    onReady: function (cb) {
      if (ready) cb(mode); else readyCbs.push(cb);
    },
    login: function (pw) { return backend().login(pw); },
    listTasks: function () { return backend().listTasks(); },
    saveTask: function (t) { return backend().saveTask(t); },
    deleteTask: function (id) { return backend().deleteTask(id); },
    toggleTask: function (id, enabled) { return backend().toggleTask(id, enabled); },
    runTask: function (id) { return backend().runTask(id); },
    listLogs: function (id) { return backend().listLogs(id); },
    resetDemo: function () { return backend().resetDemo(); },
    getSettings: function () { return backend().getSettings(); },
    saveSettings: function (s) { return backend().saveSettings(s); },
    testNotify: function (nick) { return backend().testNotify(nick); }
  };
})();
