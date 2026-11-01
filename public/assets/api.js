/* 后端适配层：统一 UI 与后端之间的接口。
 * - 同源存在 /api/health（正式 Workers 后端）时走 live 模式（fetch /api/*）
 * - 否则自动落入 mock 模式（window.MockAPI，localStorage 演示数据）
 * UI 只依赖 window.API，不感知背后是哪一个。
 * 注意：http(s) 部署必定带后端，探测失败会重试而不是降级——
 * 静默降级会让整个面板悄悄换成假数据（曾因此出过线上 bug）。 */
(function () {
  'use strict';

  var mode = 'mock';            // 'live' | 'mock'
  var ready = false;
  var readyCbs = [];
  var readyPromise = null;

  function notifyReady() {
    if (ready) return;
    ready = true;
    readyCbs.forEach(function (cb) { try { cb(mode); } catch (e) { /* 忽略 */ } });
  }

  function settle(m) {
    mode = m;
    notifyReady();
    return m;
  }

  function initMode() {
    if (readyPromise) return readyPromise;
    // file:// 没有后端可言：直接演示模式
    if (location.protocol === 'file:') {
      readyPromise = Promise.resolve(settle('mock'));
      return readyPromise;
    }
    // http(s) 部署一定带后端：探测失败重试，只有彻底确认后端不存在才算 mock
    var attempts = 0;
    function attempt() {
      attempts++;
      return fetch('/api/health', { method: 'GET' }).then(function (r) {
        return r.ok ? 'live' : 'mock';
      }).catch(function () {
        if (attempts < 3) {
          return new Promise(function (res) { setTimeout(res, 600); }).then(attempt);
        }
        return 'mock';
      });
    }
    readyPromise = attempt().then(settle);
    return readyPromise;
  }

  function backend() { return mode === 'live' ? LiveAPI : window.MockAPI; }

  // ---------- live 实现（后端未部署前不会被调用到） ----------
  async function call(path, init) {
    var r = await fetch('/api' + path, Object.assign({
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin'
    }, init || {}));
    if (r.status === 401) {
      // 广播会话失效，由 UI 全局接管（自动弹回登录页）
      try { window.dispatchEvent(new CustomEvent('ql:unauthorized')); } catch (e) { /* 忽略 */ }
      throw new Error('UNAUTHORIZED');
    }
    var body = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
    return body;
  }

  var LiveAPI = {
    login: function (pw) { return call('/login', { method: 'POST', body: JSON.stringify({ password: pw }) }); },
    listTasks: function () { return call('/tasks').then(function (b) { return b.tasks; }); },
    saveTask: function (t) { return call('/tasks' + (t.id ? '/' + t.id : ''), { method: t.id ? 'PUT' : 'POST', body: JSON.stringify(t) }); },
    deleteTask: function (id) { return call('/tasks/' + id, { method: 'DELETE' }); },
    toggleTask: function (id, enabled) { return call('/tasks/' + id, { method: 'PATCH', body: JSON.stringify({ enabled: enabled ? 1 : 0 }) }); },
    runTask: function (id) { return call('/tasks/' + id + '/run', { method: 'POST' }); },
    listLogs: function (taskId) { return call('/tasks/' + taskId + '/logs').then(function (b) { return b.logs; }); },
    resetDemo: null,
    getBuiltins: function () { return call('/builtins'); },
    getSettings: function () { return call('/settings'); },
    saveSettings: function (s) { return call('/settings', { method: 'PUT', body: JSON.stringify(s) }); },
    testNotify: function (nickname) { return call('/settings/test', { method: 'POST', body: JSON.stringify({ nickname: nickname }) }); }
  };

  // ---------- 对外接口 ----------
  window.API = {
    get mode() { return mode; },
    ready: function () { return initMode(); },
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
    getBuiltins: function () { return backend().getBuiltins(); },
    getSettings: function () { return backend().getSettings(); },
    saveSettings: function (s) { return backend().saveSettings(s); },
    testNotify: function (nick) { return backend().testNotify(nick); }
  };
})();
