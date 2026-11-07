/* 面板主逻辑：视图渲染 + 事件分发。
   数据一律走 window.API；组件能力（下拉/弹窗/确认/toast）一律走 window.UI。
   列表 30s 刷新用 patchTaskCard 原地更新卡片统计，不重建 DOM。 */
(function () {
  'use strict';

  var UI = window.UI, API = window.API;
  var $ = UI.$, $all = UI.$all, esc = UI.esc;

  // ---------- 图标（stroke 风格，viewBox 24） ----------
  // 品牌：与 favicon.svg 同款（弧线 + 圆点），避免"加载圈"歧义
  var BRAND = '<svg viewBox="0 0 64 64" width="22" height="22" aria-hidden="true"><circle cx="32" cy="32" r="17" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-dasharray="80 27" transform="rotate(115 32 32)"/><circle cx="32" cy="32" r="5" fill="currentColor" stroke="none"/></svg>';
  var ICONS = {
    plus: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    // 运行：圆环描边 + 质心居中的实心三角（三角略右移补偿视觉重心）
    run: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10.2 8.6v6.8c0 .5.55.8.98.53l5.1-3.06a.62.62 0 0 0 0-1.06l-5.1-3.06a.62.62 0 0 0-.98.53z" fill="currentColor" stroke="none"/></svg>',
    doc: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9.5 13h5M9.5 16.5h5"/></svg>',
    pen: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3.5a2.6 2.6 0 1 1 3.7 3.7L7.5 20.4 2.5 21.7l1.3-5z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M18.5 7l-.8 12a2 2 0 0 1-2 1.9H8.3a2 2 0 0 1-2-1.9L5.5 7M10 11v5.5M14 11v5.5"/></svg>',
    bell: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 9a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16S18 14 18 9"/><path d="M10 19a2.2 2.2 0 0 0 4 0"/></svg>',
    sun: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.8 6.8 0 0 0 9.7 9.7z"/></svg>',
    out: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3M15.5 16.5 20 12l-4.5-4.5M20 12H9.5"/></svg>',
    x: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };

  var UNITS = {
    h: { label: '小时', max: 23 },
    d: { label: '天', max: 30 },
    m: { label: '月', max: 12 },
  };

  var STATUS = {
    never: { label: '待运行', cls: 'st-wait' },
    ok: { label: '成功', cls: 'st-ok' },
    failed: { label: '失败', cls: 'st-err' },
    running: { label: '运行中', cls: 'st-run' },
  };

  // ---------- 状态 ----------
  var state = {
    view: 'login',       // login | list | editor
    tasks: [],
    builtins: [],
    editing: null,       // 编辑中的任务（null = 新建）
    settings: { notify_key: '' },
    timer: null,         // 30s 刷新定时器（防重复登录叠加）
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
    if (t.interval_unit === 'h') {
      // 小时间隔 amount 为总分钟数
      var h = Math.floor(n / 60), m = n % 60;
      if (h && m) return '每 ' + h + ' 小时 ' + m + ' 分钟';
      if (h) return '每 ' + h + ' 小时';
      return '每 ' + Math.max(1, m) + ' 分钟';
    }
    var mm = t.run_minute == null ? 0 : t.run_minute;
    var hm = pad(t.run_hour == null ? 9 : t.run_hour) + ':' + pad(mm);
    if (t.interval_unit === 'd') return (n === 1 ? '每天 ' : '每 ' + n + ' 天 ') + hm;
    var d = t.run_day == null ? 1 : t.run_day;
    return (n === 1 ? '每月 ' : '每 ' + n + ' 个月 ') + d + ' 日 ' + hm;
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
    UI.closeModal(); // 退出/会话过期时若有弹窗开着，一并清掉
    document.body.className = 'bg-login';
    document.getElementById('app').innerHTML =
      '<div class="login-wrap"><form class="login-card" id="login-form">' +
      '<div class="login-logo">' + BRAND + '</div>' +
      '<h1>青龙面板</h1>' +
      '<input id="login-pw" type="password" placeholder="访问密码" autocomplete="current-password">' +
      '<button id="login-btn" class="btn btn-primary btn-block" type="submit">进入</button>' +
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
      var msg = e.message === 'UNAUTHORIZED' ? '密码错误'
        : (e.message && e.message.indexOf('Failed to fetch') >= 0 ? '网络错误，请重试' : e.message);
      renderLogin(msg);
    }
  }

  // ---------- 视图：外壳 ----------
  function renderShell() {
    document.body.className = '';
    document.getElementById('app').innerHTML =
      '<header class="topbar"><div class="brand">' + BRAND + '<span>青龙面板</span></div>' +
      '<div class="top-actions">' +
      '<button class="icon-btn" id="theme-btn" title="切换主题"></button>' +
      '<button class="icon-btn" id="notify-btn" title="推送设置">' + ICONS.bell + '</button>' +
      '<button class="icon-btn" id="logout-btn" title="退出登录">' + ICONS.out + '</button>' +
      '</div></header>' +
      '<main class="container">' +
      '<div class="toolbar"><button class="btn btn-primary" id="new-btn">' + ICONS.plus + '新建任务</button><div class="strip" id="strip"></div></div>' +
      '<div id="view"></div>' +
      '</main>';
    $('#theme-btn').addEventListener('click', toggleTheme);
    $('#logout-btn').addEventListener('click', function () {
      document.cookie = 'ql_sess=; Max-Age=0; Path=/';
      renderLogin();
    });
    // 推送设置 = 弹窗：点铃铛开，再点（或点 X / 遮罩 / Esc）返回。
    // 关闭统一走 closeEditor（含 state.view 复位），避免编辑器开着时点铃铛留下残留状态
    $('#notify-btn').addEventListener('click', function () {
      if (document.querySelector('.overlay')) closeEditor();
      else openNotifySheet();
    });
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
      box.innerHTML = '<div class="empty"><p>还没有任务</p><p class="muted">点「新建任务」开始</p></div>';
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
      '<span class="chip">' + esc(builtinName(t.script_key)) + '</span></div>' +
      '<div class="task-meta">' + metaText(t) + '</div>' +
      '</div>' +
      '<div class="task-side">' +
      '<span class="dot ' + st.cls + '" title="' + st.label + '"></span>' +
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
    var dot = card.querySelector('.dot');
    if (dot) { dot.className = 'dot ' + st.cls; dot.setAttribute('title', st.label); }
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
    el.innerHTML = state.tasks.length + ' 个任务 · ' + enabled + ' 启用' +
      (next ? ' · 下次 ' + fmtTime(next) : '');
  }

  // ---------- 视图：编辑器（弹层） ----------
  function segHtml(id, items, current) {
    var h = '<div class="seg" data-seg="' + id + '">';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      h += '<button type="button" class="seg-btn' + (it.v === current ? ' on' : '') + '" data-seg="' + id + '" data-value="' + it.v + '">' + it.label + '</button>';
    }
    return h + '</div>';
  }

  function segValue(id) {
    var el = document.querySelector('.seg[data-seg="' + id + '"] .seg-btn.on');
    return el ? el.getAttribute('data-value') : null;
  }

  function openEditor(task) {
    state.view = 'editor';
    state.editing = task ? Object.assign({}, task) : null;
    var t = state.editing;
    var unit = t ? t.interval_unit : 'd';
    var key = t ? t.script_key : (state.builtins.length ? state.builtins[0].key : '');
    // 小时间隔 amount 为总分钟数，编辑器拆成 小时/分钟 两个输入；
    // 非小时任务切到每小时时给默认 1 小时 0 分
    var hh = t && t.interval_unit === 'h' ? Math.floor((t.interval_amount || 60) / 60) : 1;
    var hm = t && t.interval_unit === 'h' ? ((t.interval_amount || 60) % 60) : 0;
    var mm = t && t.run_minute != null ? t.run_minute : 0;
    var ov = UI.openModal(
      '<div class="sheet-head"><h2>' + (t ? '编辑任务' : '新建任务') + '</h2>' +
      '<button class="icon-btn sheet-x" title="关闭">' + ICONS.x + '</button></div>' +

      '<div class="sec"><label>名称</label>' +
      '<input id="f-name" type="text" maxlength="100" placeholder="任务名称" value="' + esc(t ? t.name : '') + '"></div>' +

      '<div class="sec"><label>脚本</label>' + UI.ddHtml('script', builtinItems(), key) + paramsHtml(key, t) + '</div>' +

      '<div class="sec"><label>频率</label>' +
      segHtml('unit', [{ v: 'h', label: '每小时' }, { v: 'd', label: '每天' }, { v: 'm', label: '每月' }], unit) +
      '<div class="freq-cfg">' +
      '<span class="freq-part" id="f-h-part">间隔<input id="f-hh" class="freq-num" type="number" min="0" max="23" value="' + hh + '">小时' +
      '<input id="f-hm" class="freq-num" type="number" min="0" max="59" value="' + hm + '">分钟</span>' +
      '<span class="freq-part" id="f-dm-part">间隔<input id="f-amount" class="freq-num" type="number" min="1" value="' + (t ? t.interval_amount : 1) + '"><span id="f-unit-word">天</span></span>' +
      '<span class="freq-part" id="f-day-part">日期<input id="f-day" class="freq-num" type="number" min="1" max="28" value="' + (t && t.run_day != null ? t.run_day : 1) + '">日</span>' +
      '<span class="freq-part" id="f-hm-part">时刻<input id="f-hour" class="freq-num" type="number" min="0" max="23" value="' + (t && t.run_hour != null ? t.run_hour : 9) + '">:' +
      '<input id="f-minute" class="freq-num" type="number" min="0" max="59" value="' + mm + '"></span>' +
      '</div><div class="freq-preview" id="freq-preview"></div></div>' +

      '<div class="sec sec-inline"><label>启用</label>' +
      '<label class="switch"><input type="checkbox" id="f-enabled"' + (!t || t.enabled ? ' checked' : '') + '><span class="slider"></span></label></div>' +

      '<div class="sheet-foot">' +
      '<button class="btn" id="cancel-btn">取消</button>' +
      '<button class="btn btn-primary" id="save-btn">保存</button>' +
      '</div>'
    );
    syncUnitFields();
    updateFreqPreview();
    $('#cancel-btn', ov).addEventListener('click', closeEditor);
    $('#save-btn', ov).addEventListener('click', saveEditor);
  }

  function closeEditor() {
    UI.closeModal();
    state.view = 'list';
    state.editing = null;
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
    if (!b || !b.params || !b.params.length) return '';
    var cur = (t && t.params) || {};
    var h = '<div id="f-params" class="params">';
    for (var i = 0; i < b.params.length; i++) {
      var name = b.params[i];
      h += '<input type="text" data-param="' + esc(name) + '" value="' + esc(cur[name] != null ? cur[name] : '') + '" placeholder="' + esc(name) + '">';
    }
    return h + '</div>';
  }

  function builtinOf(key) {
    for (var i = 0; i < state.builtins.length; i++) {
      if (state.builtins[i].key === key) return state.builtins[i];
    }
    return null;
  }

  function showPart(id, show) {
    var el = $(id);
    if (el) el.classList.toggle('hidden', !show);
  }

  function syncUnitFields() {
    var unit = segValue('unit') || 'd';
    showPart('#f-h-part', unit === 'h');
    showPart('#f-dm-part', unit !== 'h');
    showPart('#f-day-part', unit === 'm');
    showPart('#f-hm-part', unit !== 'h');
    var word = $('#f-unit-word');
    if (word) word.textContent = unit === 'm' ? '月' : '天';
    var amount = $('#f-amount');
    if (amount) amount.max = UNITS[unit] ? UNITS[unit].max : 30;
  }

  function fmtHM(h, m) { return pad(h) + ':' + pad(m); }

  function updateFreqPreview() {
    var el = $('#freq-preview');
    if (!el) return;
    var unit = segValue('unit') || 'd';
    var hour = Math.min(23, Math.max(0, parseInt($('#f-hour').value, 10) || 0));
    var minute = Math.min(59, Math.max(0, parseInt($('#f-minute').value, 10) || 0));
    var day = Math.min(28, Math.max(1, parseInt($('#f-day').value, 10) || 1));
    var text;
    if (unit === 'h') {
      var hh = Math.min(23, Math.max(0, parseInt($('#f-hh').value, 10) || 0));
      var hm = Math.min(59, Math.max(0, parseInt($('#f-hm').value, 10) || 0));
      text = '自保存时刻起，每 ' + spanText(hh, hm) + '运行一次';
    } else if (unit === 'd') {
      var n = Math.max(1, Math.round(Number($('#f-amount').value) || 1));
      text = (n === 1 ? '每天' : '每 ' + n + ' 天') + ' · 北京时间 ' + fmtHM(hour, minute);
    } else {
      var nm = Math.max(1, Math.round(Number($('#f-amount').value) || 1));
      text = (nm === 1 ? '每月' : '每 ' + nm + ' 个月') + ' ' + day + ' 日 ' + fmtHM(hour, minute);
    }
    el.textContent = text;
  }

  function spanText(hh, hm) {
    if (hh && hm) return hh + ' 小时 ' + hm + ' 分钟';
    if (hh) return hh + ' 小时';
    return Math.max(1, hm) + ' 分钟';
  }

  function harvestParams() {
    var obj = {};
    $all('#f-params input[data-param]').forEach(function (inp) {
      obj[inp.getAttribute('data-param')] = inp.value.trim();
    });
    return obj;
  }

  function harvestSchedule() {
    var unit = segValue('unit') || 'd';
    var hour = Math.min(23, Math.max(0, parseInt($('#f-hour').value, 10) || 0));
    var minute = Math.min(59, Math.max(0, parseInt($('#f-minute').value, 10) || 0));
    var day = Math.min(28, Math.max(1, parseInt($('#f-day').value, 10) || 1));
    if (unit === 'h') {
      // 间隔 = 小时 + 分钟，合计至少 1 分钟；amount 存总分钟数
      var hh = Math.min(23, Math.max(0, parseInt($('#f-hh').value, 10) || 0));
      var hm = Math.min(59, Math.max(0, parseInt($('#f-hm').value, 10) || 0));
      var total = Math.min(1439, Math.max(1, hh * 60 + hm));
      return { interval_unit: unit, interval_amount: total, run_hour: 0, run_minute: 0, run_day: 1 };
    }
    var max = UNITS[unit] ? UNITS[unit].max : 30;
    var amount = Math.min(max, Math.max(1, Math.round(Number($('#f-amount').value) || 1)));
    return { interval_unit: unit, interval_amount: amount, run_hour: hour, run_minute: minute, run_day: unit === 'm' ? day : 1 };
  }

  async function saveEditor() {
    var name = $('#f-name').value.trim();
    if (!name) { UI.toast('名称不能为空', 'err'); $('#f-name').focus(); return; }
    var key = UI.ddValue('script');
    if (!key) { UI.toast('请选择脚本', 'err'); return; }
    var btn = $('#save-btn');
    btn.disabled = true; btn.textContent = '保存中…';
    var body = Object.assign(
      { id: state.editing ? state.editing.id : undefined, name: name, script_key: key, params: harvestParams(), enabled: $('#f-enabled').checked ? 1 : 0 },
      harvestSchedule()
    );
    try {
      await API.saveTask(body);
      UI.toast('已保存', 'ok');
      closeEditor();
      await loadTasks();
      renderList();
      renderListStrip();
    } catch (e) {
      UI.toast(e.message, 'err');
      btn.disabled = false; btn.textContent = '保存';
    }
  }

  // ---------- 推送设置弹层（右上铃铛 → 弹窗，再点/X/遮罩/Esc 返回） ----------
  async function openNotifySheet() {
    try { state.settings = await API.getSettings(); } catch (e) { /* 沿用旧值 */ }
    var ov = UI.openModal(
      '<div class="sheet-head"><h2>推送设置</h2>' +
      '<button class="icon-btn sheet-x" title="关闭">' + ICONS.x + '</button></div>' +
      '<div class="sec"><label>TimelyNotify 密钥</label>' +
      '<input id="s-key" type="text" placeholder="推送服务密钥" value="' + esc(state.settings.notify_key || '') + '">' +
      '<p class="hint">任务运行时用它推送通知；留空则不推送。</p></div>' +
      '<div class="sheet-foot">' +
      '<button class="btn" id="test-notify-btn">测试推送</button>' +
      '<button class="btn btn-primary" id="save-settings-btn">保存</button>' +
      '</div>'
    );
    $('#save-settings-btn', ov).addEventListener('click', async function () {
      var btn = $('#save-settings-btn', ov);
      btn.disabled = true;
      try {
        await API.saveSettings({ notify_key: $('#s-key', ov).value.trim() });
        UI.closeModal();
        UI.toast('已保存', 'ok');
      } catch (e) {
        UI.toast(e.message, 'err');
        btn.disabled = false;
      }
    });
    // 测试推送是真发一条，busy 态防连点
    $('#test-notify-btn', ov).addEventListener('click', async function () {
      var btn = $('#test-notify-btn', ov);
      btn.disabled = true; btn.textContent = '发送中…';
      try {
        await API.testNotify($('#s-key', ov).value.trim());
        UI.toast('测试推送已发送', 'ok');
      } catch (e) {
        UI.toast('推送失败: ' + e.message, 'err');
      }
      btn.disabled = false; btn.textContent = '测试推送';
    });
  }

  // ---------- 日志 ----------
  async function openLogs(id) {
    var t = taskOf(id);
    var ov = UI.openModal(
      '<div class="sheet-head"><h3>' + esc(t ? t.name : '#' + id) + '</h3>' +
      '<div class="head-btns"><button class="btn btn-sm" id="logs-refresh">刷新</button>' +
      '<button class="icon-btn sheet-x" title="关闭">' + ICONS.x + '</button></div></div>' +
      '<div class="logs" id="logs-body"><p class="hint">加载中…</p></div>'
    );
    var load = async function () {
      var body = $('#logs-body', ov);
      try {
        var logs = await API.listLogs(id);
        if (!logs.length) { body.innerHTML = '<p class="hint">暂无日志</p>'; return; }
        var h = '';
        for (var i = 0; i < logs.length; i++) {
          var l = logs[i];
          h += '<div class="log-line' + (l.level === 'error' ? ' log-err' : '') + '">' +
            '<span class="log-ts">' + esc(fmtTime(l.ts, true)) + '</span>' +
            '<span class="log-tx">' + esc(l.text) + '</span></div>';
        }
        body.innerHTML = h;
      } catch (e) { body.innerHTML = '<p class="hint">加载失败</p>'; }
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
        if (res.status === 'running') UI.toast('任务已在运行中');
        else UI.toast(res.status === 'ok' ? '运行成功' : '运行失败', res.status === 'ok' ? 'ok' : 'err');
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
        message: '「' + (t ? t.name : '#' + id) + '」及其日志将被删除，不可恢复。',
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
      }).catch(function (err) {
        el.checked = !el.checked;
        UI.toast(err.message, 'err');
      });
    }
  }

  function onInput(e) {
    var el = e.target;
    if (el.id === 'f-amount' || el.id === 'f-hour' || el.id === 'f-minute' || el.id === 'f-day' || el.id === 'f-hh' || el.id === 'f-hm') updateFreqPreview();
  }

  function onDdChange(ddId) {
    if (ddId === 'script') {
      var key = UI.ddValue('script');
      var box = $('#f-params');
      if (box) box.remove();
      var t = state.editing;
      var ph = paramsHtml(key, t);
      if (ph) {
        var anchor = document.querySelector('.dd[data-dd="script"]');
        if (anchor && anchor.parentElement) anchor.insertAdjacentHTML('afterend', ph);
      }
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

  async function enterPanel() {
    var b = await API.getBuiltins();
    state.builtins = b.builtins || [];
    await loadTasks();
    renderShell();
    renderList();
    renderListStrip();
    if (!state.timer) state.timer = setInterval(refreshStats, 30000);
  }

  // ---------- 启动 ----------
  function init() {
    UI.wire({
      onDdChange: onDdChange,
      onSegChange: function (segId) {
        if (segId === 'unit') { syncUnitFields(); updateFreqPreview(); }
      },
      // X / 遮罩 / Esc 关闭编辑器时复位视图状态，否则 30s 刷新会一直被跳过
      onModalClose: function () { if (state.view === 'editor') closeEditor(); },
    });
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
