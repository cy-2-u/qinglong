/* 后端适配层：UI 与 Workers 后端之间的唯一接口（同源 HTTP + Cookie 会话）。 */
(function () {
  'use strict';

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

  window.API = {
    login: function (pw) { return call('/login', { method: 'POST', body: JSON.stringify({ password: pw }) }); },
    listTasks: function () { return call('/tasks').then(function (b) { return b.tasks; }); },
    saveTask: function (t) { return call('/tasks' + (t.id ? '/' + t.id : ''), { method: t.id ? 'PUT' : 'POST', body: JSON.stringify(t) }); },
    deleteTask: function (id) { return call('/tasks/' + id, { method: 'DELETE' }); },
    toggleTask: function (id, enabled) { return call('/tasks/' + id, { method: 'PATCH', body: JSON.stringify({ enabled: enabled ? 1 : 0 }) }); },
    runTask: function (id) { return call('/tasks/' + id + '/run', { method: 'POST' }); },
    listLogs: function (id) { return call('/tasks/' + id + '/logs').then(function (b) { return b.logs; }); },
    getBuiltins: function () { return call('/builtins'); },
    getSettings: function () { return call('/settings'); },
    saveSettings: function (s) { return call('/settings', { method: 'PUT', body: JSON.stringify(s) }); },
    testNotify: function (nick) { return call('/settings/test', { method: 'POST', body: JSON.stringify({ nickname: nick }) }); }
  };
})();
