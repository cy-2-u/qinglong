/* 面板主逻辑：视图渲染 + 事件分发。
   数据一律走 window.API；组件能力（下拉/弹窗/确认/toast）一律走 window.UI。
   列表 30s 刷新用 patchTaskCard 原地更新卡片统计，不重建 DOM（保输入焦点、不闪 tooltip）。 */
(function () {
  'use strict';

  var UI = window.UI, API = window.API;
  var $ = UI.$, $all = UI.$all, esc = UI.esc;

  // ---------- 常量 ----------
  var ICONS = {
    logo: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    run: '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.6 6.2c0-.9.95-1.4 1.7-1l5 3c.75.45.75 1.55 0 2l-5 3c-.75.4-1.7-.1-1.7-1z"/></svg>',
    pen: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>',
    doc: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8"/></svg>',
    gear: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    sun: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    out: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
  };
  UI.ICONS = ICONS;

  var UNITS = {
    h: { label: '小时', max: 23 },
    d: { label: '天', max: 30 },
    m: { label: '月', max: 12 },
  };

  var STATUS = {
    never: { label: '未运行', cls: 'status-never' },
    ok: { label: '成功', cls: 'status-ok' },
    failed: { label: '失败', cls: 'status-failed' },
    running: { label: '运行中', cls: 'status-running' },
  };

  // ---------- 状态 ----------
  var state = {
    view: 'login',       // login | list | editor | settings
    tasks: [],
    builtins: [],
    editing: null,       // 编辑中的任务（null = 新建）
    settings: { notify_key: '' },
    loaded: false,
  };

  // ---------- 小工具 ----------
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function fmtTime(sec, withSec) {
    if (!sec) return '从未';
    var d = new Date(sec * 1000), now = new Date();
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return withSec ? hm + ':' + pad(d.getSeconds()) : hm;
    return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + hm;
  }

  function freqText(t) {
    var n = t.interval_amount || 1;
    if (t.interval_unit === 'h') return n === 1 ? '每小时' : '每 ' + n + ' 小时';
    var h = t.run_hour == null ? 9 : t.run_hour;
    var hh = pad(h) + ':00';
    if (t.interval_unit === 'd') return (n === 1 ? '每天 ' : '每 ' + n + ' 天 ') + hh;
    var d = t.run_day == null ? 1 : t.run_day;
    return (n === 1 ? '每月 ' : '每 ' + n + ' 个月 ') + d + ' 日 ' + hh;
  }

  function builtinName(key) {
    for (var i = 0; i < state.builtins.length; i++) {
      if (state.builtins[i].key === key) return state.builtins[i].name;
    }
    return key || '未知脚本';
  }

  // ---------- 视图：登录 ----------
  function renderLogin(msg) {
    state.view = 'login';
    document.body.className = 'bg-login';
    document.getElementById('app').innerHTML =
      '<div class="login-wrap"><form class="login-card" id="login-form">' +
      '<div class="login-logo">' + ICONS.logo + '</div>' +
      '<h1>青龙面板</h1>' +
      '<p class="muted">输入访问密码进入</p>' +
      '<input id="login-pw" type="password" placeholder="访问密码" autocomplete="current-password">' +
      '<button id="login-btn" class="btn btn-primary btn-block" type="submit">进 入</button>' +
      (msg ? '<p class="login-err">' + esc(msg) + '</p>' : '') +
      '</form></div>';
    $('#login-form').addEventListener('submit', function (e) { e.preventDefault(); doLogin(); });
    $('#login-pw').focus();
  }

  async function doLogin() {
    var btn = $('#login-btn'), pw = $('#login-pw').value;
    if (!pw) return;
    btn.disabled = true; btn.textContent = '验证中…';
    try {
      await API.login(pw);
      await enterPanel();
    } catch (e) {
      renderLogin(e.message === 'UNAUTHORIZED' ? '密码错误' : e.message);
    }
  }

  // ---------- 视图：外壳 ----------
  function renderShell() {
    document.body.className = '';
    document.getElementById('app').innerHTML =
      '<header class="topbar"><div class="brand">' + ICONS.logo + '<span>青龙面板</span></div>' +
      '<div class="top-actions">' +
      '<button class="icon-btn" id="theme-btn" title="切换主题"></button>' +
      '<button class="icon-btn" id="settings-btn" title="通知设置">' + ICONS.gear + '</button>' +
      '<button class="icon-btn" id="logout-btn" title="退出登录">' + ICONS.out + '</button>' +
      '</div></header>' +
      '<main class="container">' +
      '<div class="toolbar"><button class="btn btn-primary" id="new-btn">' + ICONS.plus + ' 新建任务</button><div class="strip" id="strip"></div></div>' +
      '<div id="view"></div>' +
      '</main>';
    $('#theme-btn').addEventListener('click', toggleTheme);
    $('#logout-btn').addEventListener('click', function () {
      document.cookie = 'ql_sess=; Max-Age=0; Path=/';
      renderLogin();
    });
    $('#settings-btn').addEventListener('click', function () { openSettings(); });
    $('#new-btn').addEventListener('click', function () { openEditor(null); });
    applyTheme();
  }

  function toggleTheme() {
    var dark = document.documentElement.classList.toggle('dark');
    try { localStorage.setItem('ql_theme', dark ? 'dark' : 'light'); } catch (e) { /* 忽略 */ }
    applyTheme();
  }

  function applyTheme() {
    var pref = 'light';
    try { pref = localStorage.getItem('ql_theme') || 'light'; } catch (e) { /* 忽略 */ }
    document.documentElement.classList.toggle('dark', pref === 'dark');
    var b = $('#theme-btn');
    if (b) b.innerHTML = pref === 'dark' ? ICONS.sun : ICONS.moon;
  }

  // ---------- 视图：列表 ----------
  function renderList() {
    state.view = 'list';
    var box = $('#view');
    if (!state.tasks.length) {
      box.innerHTML = '<div class="empty"><p>还没有任务</p><p class="muted">点右上「新建任务」，从内置任务库挑选一个开始</p></div>';
      return;
    }
    var h = '<div class="list">';
    for (var i = 0; i < state.tasks.length; i++) h += taskCard(state.tasks[i]);
    box.innerHTML = h + '</div>';
  }

  function taskCard(t) {
    var st = STATUS[t.last_status] || STATUS.never;
    return '<div class="card task' + (t.enabled ? '' : ' task-disabled') + '" data-id="' + t.id + '">' +
      '<div class="task-main">' +
      '<div class="task-head"><span class="task-name">' + esc(t.name) + '</span>' +
      '<span class="chip chip-script">' + esc(builtinName(t.script_key)) + '</span></div>' +
      '<div class="task-meta">' + metaText(t) + '</div>' +
      '</div>' +
      '<div class="task-side">' +
      '<span class="chip task-status ' + st.cls + '">' + st.label + '</span>' +
      '<label class="switch" title="启用/停用"><input type="checkbox" data-act="toggle"' + (t.enabled ? ' checked' : '') + '><span class="slider"></span></label>' +
      '<div class="task-actions">' +
      '<button class="icon-btn" data-act="run" title="立即运行">' + ICONS.run + '</button>' +
      '<button class="icon-btn" data-act="logs" title="日志">' + ICONS.doc + '</button>' +
      '<button class="icon-btn" data-act="edit" title="编辑">' + ICONS.pen + '</button>' +
      '<button class="icon-btn danger" data-act="del" title="删除">' + ICONS.trash + '</button>' +
      '</div></div></div>';
  }

  function metaText(t) {
    return freqText(t) +
      '<span class="meta-sep">·</span>上次 ' + fmtTime(t.last_run_at) +
      '<span class="meta-sep">·</span>下次 ' + (t.enabled ? fmtTime(t.next_run_at) : '已停用');
  }

  // 原地更新单张卡片的状态/统计（30s 刷新与运行后刷新都用它，不重建 DOM）
  function patchTaskCard(t) {
    var card = document.querySelector('.card.task[data-id="' + t.id + '"]');
    if (!card) return;
    var meta = card.querySelector('.task-meta');
    if (meta) meta.innerHTML = metaText(t);
    var st = STATUS[t.last_status] || STATUS.never;
    var chip = card.querySelector('.task-status');
    if (chip) { chip.className = 'chip task-status ' + st.cls; chip.textContent = st.label; }
    var sw = card.querySelector('input[data-act="toggle"]');
    if (sw) sw.checked = !!t.enabled;
    card.classList.toggle('task-disabled', !t.enabled);
  }

  function renderListStrip() {
    var el = $('#strip');
    if (!el) return;
    if (!state.tasks.length) { el.innerHTML = ''; return; }
    var enabled = 0, next = 0;
    for (var i = 0; i < state.tasks.length; i++) {
      var t = state.tasks[i];
      if (t.enabled) {
        enabled++;
        if (t.next_run_at && (!next || t.next_run_at < next)) next = t.next_run_at;
      }
    }
    el.innerHTML = '共 ' + state.tasks.length + ' 个任务 · ' + enabled + ' 个已启用' +
      (next ? ' · 下次 ' + fmtTime(next) : '');
  }

  // ---------- 视图：编辑器 ----------
  function unitItems() {
    return [
      { v: 'h', label: '每小时' }, { v: 'd', label: '每天' }, { v: 'm', label: '每月' },
    ];
  }

  function openEditor(task) {
    state.view = 'editor';
    state.editing = task ? Object.assign({}, task) : null;
    var t = state.editing;
    var unit = t ? t.interval_unit : 'd';
    var key = t ? t.script_key : (state.builtins.length ? state.builtins[0].key : '');
    var h = '<div class="form-card" id="editor">' +
      '<h2 id="edit-title">' + (t ? '编辑任务' : '新建任务') + '</h2>' +

      '<div class="form-sec"><label>任务名称</label>' +
      '<input id="f-name" type="text" maxlength="100" placeholder="例如：GLaDOS 每日签到" value="' + esc(t ? t.name : '') + '"></div>' +

      '<div class="form-sec"><label>内置脚本</label>' + UI.ddHtml('script', builtinItems(), key) +
      '<p class="muted">Workers 平台禁止运行时编译脚本，任务只能引用随构建打包的内置库；' +
      '新增脚本 = src/tasks/ 下加模块并在 builtins.js 注册一行。</p></div>' +

      '<div class="form-sec" id="f-params"><label>脚本参数</label>' + paramsHtml(key, t) + '</div>' +

      '<div class="form-sec"><label>执行频率</label><div class="freq-row">' +
      UI.ddHtml('unit', unitItems(), unit) +
      '<span class="freq-t">间隔</span><input id="f-amount" class="freq-num" type="number" min="1" value="' + (t ? t.interval_amount : 1) + '">' +
      '<span class="freq-t" id="f-hour-wrap">时刻<input id="f-hour" class="freq-num" type="number" min="0" max="23" value="' + (t && t.run_hour != null ? t.run_hour : 9) + '"></span>' +
      '<span class="freq-t" id="f-day-wrap">日期<input id="f-day" class="freq-num" type="number" min="1" max="28" value="' + (t && t.run_day != null ? t.run_day : 1) + '"></span>' +
      '</div><div class="freq-preview" id="freq-preview"></div></div>' +

      '<div class="form-sec form-sec-inline"><label>启用</label>' +
      '<label class="switch"><input type="checkbox" id="f-enabled"' + (!t || t.enabled ? ' checked' : '') + '><span class="slider"></span></label></div>' +

      '<div class="form-foot">' +
      '<button class="btn" id="cancel-btn">取消</button>' +
      '<button class="btn btn-primary" id="save-btn">保存</button>' +
      '</div></div>';
    $('#view').innerHTML = h;
    syncUnitFields();
    updateFreqPreview();
    $('#cancel-btn').addEventListener('click', function () { showList(); });
    $('#save-btn').addEventListener('click', saveEditor);
  }

  function builtinItems() {
    var items = [];
    for (var i = 0; i < state.builtins.length; i++) {
      items.push({ v: state.builtins[i].key, label: state.builtins[i].name });
    }
    return items;
  }

  function paramsHtml(key, t) {
    var b = builtinOf(key);
    if (!b || !b.params || !b.params.length) return '<p class="muted">该脚本无需参数</p>';
    var cur = (t && t.params) || {};
    var h = '';
    for (var i = 0; i < b.params.length; i++) {
      var name = b.params[i];
      h += '<div class="param-row"><label>' + esc(name) + '</label>' +
        '<input type="text" data-param="' + esc(name) + '" value="' + esc(cur[name] != null ? cur[name] : '') + '" placeholder="' + esc(name) + '"></div>';
    }
    return h;
  }

  function builtinOf(key) {
    for (var i = 0; i < state.builtins.length; i++) {
      if (state.builtins[i].key === key) return state.builtins[i];
    }
    return null;
  }

  function syncUnitFields() {
    var unit = UI.ddValue('unit') || 'd';
    var hw = $('#f-hour-wrap'), dw = $('#f-day-wrap');
    if (hw) hw.classList.toggle('hidden', unit === 'h');
    if (dw) dw.classList.toggle('hidden', unit !== 'm');
    var amount = $('#f-amount');
    if (amount) amount.max = UNITS[unit] ? UNITS[unit].max : 30;
  }

  function updateFreqPreview() {
    var el = $('#freq-preview');
    if (!el) return;
    var unit = UI.ddValue('unit') || 'd';
    var n = Math.max(1, Math.round(Number($('#f-amount').value) || 1));
    var hour = Math.min(23, Math.max(0, parseInt($('#f-hour').value, 10) || 0));
    var day = Math.min(28, Math.max(1, parseInt($('#f-day').value, 10) || 1));
    var u = UNITS[unit] || UNITS.d;
    var text;
    if (unit === 'h') text = (n === 1 ? '每小时' : '每 ' + n + ' 小时') + '运行一次';
    else if (unit === 'd') text = (n === 1 ? '每天' : '每 ' + n + ' 天') + ' · 北京时间 ' + pad(hour) + ':00 运行';
    else text = (n === 1 ? '每月' : '每 ' + n + ' 个月') + ' ' + day + ' 日 ' + pad(hour) + ':00（北京时间）运行';
    el.textContent = text;
  }

  function harvestParams() {
    var obj = {};
    $all('#f-params input[data-param]').forEach(function (inp) {
      obj[inp.getAttribute('data-param')] = inp.value.trim();
    });
    return obj;
  }

  function harvestSchedule() {
    var unit = UI.ddValue('unit') || 'd';
    var max = UNITS[unit] ? UNITS[unit].max : 30;
    var amount = Math.min(max, Math.max(1, Math.round(Number($('#f-amount').value) || 1)));
    var hour = Math.min(23, Math.max(0, parseInt($('#f-hour').value, 10) || 0));
    var day = Math.min(28, Math.max(1, parseInt($('#f-day').value, 10) || 1));
    return { interval_unit: unit, interval_amount: amount, run_hour: unit === 'h' ? 0 : hour, run_day: unit === 'm' ? day : 1 };
  }

  async function saveEditor() {
    var name = $('#f-name').value.trim();
    if (!name) { UI.toast('任务名称不能为空', 'err'); $('#f-name').focus(); return; }
    var key = UI.ddValue('script');
    if (!key) { UI.toast('请选择内置脚本', 'err'); return; }
    var body = Object.assign(
      { id: state.editing ? state.editing.id : undefined, name: name, script_key: key, params: harvestParams(), enabled: $('#f-enabled').checked ? 1 : 0 },
      harvestSchedule()
    );
    try {
      await API.saveTask(body);
      UI.toast('已保存', 'ok');
      await loadTasks();
      showList();
    } catch (e) { UI.toast(e.message, 'err'); }
  }

  // ---------- 视图：设置 ----------
  async function openSettings() {
    state.view = 'settings';
    try { state.settings = await API.getSettings(); } catch (e) { /* 沿用旧值 */ }
    $('#view').innerHTML =
      '<div class="form-card"><h2>通知设置</h2>' +
      '<div class="form-sec"><label>TimelyNotify 推送密钥</label>' +
      '<input id="s-key" type="text" placeholder="推送服务的密钥（URL path 第一段）" value="' + esc(state.settings.notify_key || '') + '">' +
      '<p class="muted">任务脚本调用 ctx.notify 时推送通知；留空则跳过推送，不影响任务运行。</p></div>' +
      '<div class="form-foot">' +
      '<button class="btn" id="test-notify-btn">发送测试推送</button>' +
      '<button class="btn btn-primary" id="save-settings-btn">保存</button>' +
      '</div></div>';
    $('#save-settings-btn').addEventListener('click', async function () {
      try {
        await API.saveSettings({ notify_key: $('#s-key').value.trim() });
        UI.toast('通知设置已保存', 'ok');
      } catch (e) { UI.toast(e.message, 'err'); }
    });
    $('#test-notify-btn').addEventListener('click', async function () {
      try {
        await API.testNotify($('#s-key').value.trim());
        UI.toast('测试推送已发送，请查收', 'ok');
      } catch (e) { UI.toast('推送失败: ' + e.message, 'err'); }
    });
  }

  // ---------- 日志 ----------
  async function openLogs(id) {
    var t = taskOf(id);
    var ov = UI.openModal(
      '<div class="modal-head"><h3>日志 · ' + esc(t ? t.name : '#' + id) + '</h3>' +
      '<div class="modal-head-btns"><button class="btn btn-sm" id="logs-refresh">刷新</button>' +
      '<button class="icon-btn modal-x" title="关闭">✕</button></div></div>' +
      '<div class="logs" id="logs-body"><p class="muted">加载中…</p></div>'
    );
    var load = async function () {
      var body = $('#logs-body', ov);
      try {
        var logs = await API.listLogs(id);
        if (!logs.length) { body.innerHTML = '<p class="muted">暂无日志</p>'; return; }
        var h = '';
        for (var i = 0; i < logs.length; i++) {
          var l = logs[i];
          h += '<div class="log-line' + (l.level === 'error' ? ' log-err' : '') + '">' +
            '<span class="log-ts">' + esc(fmtTime(l.ts, true)) + '</span>' +
            '<span class="log-lv">' + esc(l.level) + '</span>' +
            '<span class="log-tx">' + esc(l.text) + '</span></div>';
        }
        body.innerHTML = h;
      } catch (e) { body.innerHTML = '<p class="muted">加载失败: ' + esc(e.message) + '</p>'; }
    };
    $('#logs-refresh', ov).addEventListener('click', load);
    load();
  }

  function taskOf(id) {
    for (var i = 0; i < state.tasks.length; i++) {
      if (state.tasks[i].id === id) return state.tasks[i];
    }
    return null;
  }

  // ---------- 动作 ----------
  var ACTIONS = {
    run: async function (id, btn) {
      var t = taskOf(id);
      if (t) { t.last_status = 'running'; patchTaskCard(t); }
      if (btn) btn.disabled = true;
      try {
        var res = await API.runTask(id);
        UI.toast(res.status === 'ok' ? '运行成功' : '运行失败，看日志详情', res.status === 'ok' ? 'ok' : 'err');
      } catch (e) { UI.toast(e.message, 'err'); }
      if (btn) btn.disabled = false;
      await refreshStats();
    },
    edit: function (id) { openEditor(taskOf(id)); },
    logs: function (id) { openLogs(id); },
    del: async function (id) {
      var t = taskOf(id);
      var yes = await UI.confirmDialog({
        title: '删除任务', danger: true, yes: '删除',
        message: '确定删除「' + (t ? t.name : '#' + id) + '」？其日志会一并清除，不可恢复。',
      });
      if (!yes) return;
      try {
        await API.deleteTask(id);
        state.tasks = state.tasks.filter(function (x) { return x.id !== id; });
        renderList(); renderListStrip();
        UI.toast('已删除', 'ok');
      } catch (e) { UI.toast(e.message, 'err'); }
    },
  };

  // ---------- 全局事件 ----------
  function onClick(e) {
    var actEl = e.target.closest('[data-act]');
    if (actEl && actEl.tagName !== 'INPUT') {
      var card = actEl.closest('.card.task');
      if (card && ACTIONS[actEl.getAttribute('data-act')]) {
        ACTIONS[actEl.getAttribute('data-act')](Number(card.getAttribute('data-id')), actEl);
      }
    }
  }

  function onChange(e) {
    var el = e.target;
    if (el.getAttribute && el.getAttribute('data-act') === 'toggle') {
      var card = el.closest('.card.task');
      if (!card) return;
      var id = Number(card.getAttribute('data-id'));
      API.toggleTask(id, el.checked).then(function (b) {
        var t = taskOf(id);
        if (t) { Object.assign(t, b.task); patchTaskCard(t); }
        renderListStrip();
        UI.toast(el.checked ? '已启用' : '已停用', 'ok');
      }).catch(function (err) {
        el.checked = !el.checked;
        UI.toast(err.message, 'err');
      });
      return;
    }
    if (el.id === 'f-enabled') return; // 保存时读取
  }

  function onInput(e) {
    var el = e.target;
    if (el.id === 'f-amount' || el.id === 'f-hour' || el.id === 'f-day') updateFreqPreview();
  }

  function onDdChange(ddId) {
    if (ddId === 'unit') { syncUnitFields(); updateFreqPreview(); }
    if (ddId === 'script') {
      var key = UI.ddValue('script');
      var box = $('#f-params');
      if (box) box.innerHTML = '<label>脚本参数</label>' + paramsHtml(key, state.editing);
    }
  }

  // ---------- 数据 ----------
  async function loadTasks() {
    state.tasks = await API.listTasks();
  }

  async function refreshStats() {
    if (state.view !== 'list' || document.querySelector('.overlay')) return;
    try {
      await loadTasks();
      for (var i = 0; i < state.tasks.length; i++) patchTaskCard(state.tasks[i]);
      renderListStrip();
    } catch (e) { /* 静默：下一轮再试 */ }
  }

  function showList() {
    renderList();
    renderListStrip();
  }

  async function enterPanel() {
    state.loaded = true;
    var b = await API.getBuiltins();
    state.builtins = b.builtins || [];
    await loadTasks();
    renderShell();
    showList();
    setInterval(refreshStats, 30000);
  }

  // ---------- 启动 ----------
  function init() {
    UI.wire({ onDdChange: onDdChange });
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    document.addEventListener('input', onInput);
    window.addEventListener('ql:unauthorized', function () {
      if (state.view !== 'login') renderLogin('登录已过期，请重新输入密码');
    });
    // 开屏先探会话：401 → 登录页，已登录 → 直进面板
    API.listTasks().then(enterPanel).catch(function () { renderLogin(); });
  }

  init();
})();
