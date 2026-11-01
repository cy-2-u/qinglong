/* 青龙 —— 面板逻辑
 * 纯 vanilla：事件委托 + 模板字符串渲染。视图：登录 / 任务列表 / 编辑器；
 * 弹窗：日志 / 通知设置 / 删除确认。任务脚本来自仓库内置库，面板不存脚本文本。 */
(function () {
  'use strict';

  // ---------- 工具 ----------
  function $(sel, el) { return (el || document).querySelector(sel); }
  function $all(sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

  // 时间戳（秒）
  function fmtTime(ts) {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false });
  }
  function fmtShort(ts) {
    if (!ts) return '—';
    var d = new Date(ts * 1000);
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function fmtRel(ts) {
    var ms = ts * 1000 - Date.now();
    if (ms <= 0) return '待执行';
    var m = Math.round(ms / 60000), h = Math.round(m / 60), d = Math.round(h / 24);
    if (m < 60) return m + ' 分钟后';
    if (h < 48) return h + ' 小时后';
    return d + ' 天后';
  }

  var STATUS = {
    ok: ['成功', 'chip-ok'],
    failed: ['失败', 'chip-fail'],
    running: ['运行中', 'chip-run'],
    never: ['未运行', 'chip-idle']
  };

  var ICONS = {
    play: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>',
    edit: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M11.3 2.2l2.5 2.5L5.5 13H3v-2.5z"/></svg>',
    log: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01"/></svg>',
    trash: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.8 7v4M9.2 7v4"/></svg>',
    plus: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',
    refresh: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v2.6h-2.6"/></svg>',
    sun: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="3.2"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1"/></svg>',
    moon: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 9.7A6.2 6.2 0 1 1 6.3 2.5a4.9 4.9 0 0 0 7.2 7.2z"/></svg>',
    gear: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/><circle cx="10.5" cy="4.5" r="1.7" fill="var(--panel)"/><circle cx="5.5" cy="8" r="1.7" fill="var(--panel)"/><circle cx="9" cy="11.5" r="1.7" fill="var(--panel)"/></svg>',
    close: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    chev: '<svg viewBox="0 0 10 6" width="10" height="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 1l4 4 4-4"/></svg>',
    back: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg>'
  };

  var UNITS = [
    { key: 'h', label: '时', max: 23 },
    { key: 'd', label: '天', max: 30 },
    { key: 'm', label: '月', max: 12 }
  ];
  function unitInfo(key) { return UNITS.find(function (u) { return u.key === key; }) || UNITS[1]; }

  function scheduleText(t) {
    var hh = pad2(t.run_hour == null ? 0 : t.run_hour) + ':00';
    if (t.interval_unit === 'h') return '每 ' + t.interval_amount + ' 小时';
    if (t.interval_unit === 'd') return (t.interval_amount === 1 ? '每天 ' : '每 ' + t.interval_amount + ' 天 ') + hh;
    return (t.interval_amount === 1 ? '每月 ' : '每 ' + t.interval_amount + ' 月 ') + (t.run_day == null ? 1 : t.run_day) + ' 日 ' + hh;
  }

  // ---------- 全局状态 ----------
  var App = {
    authed: localStorage.getItem('ql.auth') === '1',
    theme: localStorage.getItem('ql.theme') || 'light',
    view: 'list',
    tasks: [],
    builtins: [],          // 内置任务库（key/name/params），登录后加载
    editing: null,
    confirmResolver: null
  };

  function builtinByKey(key) {
    return App.builtins.find(function (b) { return b.key === key; }) || null;
  }

  // ---------- 自绘下拉组件（替代原生 select，弹层样式可控） ----------
  function ddHtml(id, items, value, cls) {
    var cur = items.filter(function (it) { return String(it.value) === String(value); })[0];
    var opts = items.map(function (it) {
      return '<div class="dd-opt' + (String(it.value) === String(value) ? ' active' : '') + '" data-value="' + esc(it.value) + '">' + esc(it.label) + '</div>';
    }).join('');
    return (
      '<div class="dd ' + (cls || '') + '" id="' + id + '" data-value="' + esc(value) + '">' +
      '  <button type="button" class="dd-btn">' +
      '    <span class="dd-label">' + esc(cur ? cur.label : '') + '</span>' +
      '    <span class="dd-chevron">' + ICONS.chev + '</span>' +
      '  </button>' +
      '  <div class="dd-list hidden">' + opts + '</div>' +
      '</div>'
    );
  }
  function ddValue(id) {
    var dd = $('#' + id);
    return dd ? dd.dataset.value : null;
  }
  function closeAllDd(except) {
    $all('.dd').forEach(function (dd) {
      if (dd !== except) {
        $('.dd-list', dd).classList.add('hidden');
        dd.classList.remove('open');
      }
    });
  }

  // ---------- 登录 ----------
  function renderLogin() {
    $('#app').innerHTML =
      '<div class="login-wrap">' +
      '  <form class="login-card" id="loginForm">' +
      '    <div class="win-dots"><span class="d1"></span><span class="d2"></span><span class="d3"></span></div>' +
      '    <h1>青龙</h1>' +
      '    <input type="password" id="loginPw" placeholder="面板密码" autocomplete="current-password" required>' +
      '    <button class="btn primary block" type="submit">进入</button>' +
      '  </form>' +
      '</div>';
    $('#loginPw').focus();
  }

  // ---------- 外壳 ----------
  function renderShell() {
    $('#app').innerHTML =
      '<header class="topbar">' +
      '  <div class="brand">青龙</div>' +
      '  <div class="top-actions">' +
      '    <button class="btn ghost icon-btn" data-action="settings" data-tip="通知设置">' + ICONS.gear + '</button>' +
      '    <button class="btn ghost icon-btn" id="btnTheme" data-action="toggle-theme" data-tip="切换主题"></button>' +
      '    <button class="btn ghost" data-action="logout">退出</button>' +
      '  </div>' +
      '</header>' +
      '<main class="container" id="main"></main>';
    syncThemeIcon();
  }

  function syncThemeIcon() {
    var btn = $('#btnTheme');
    if (btn) btn.innerHTML = App.theme === 'dark' ? ICONS.sun : ICONS.moon;
  }

  // ---------- 任务列表 ----------
  function renderList() {
    App.view = 'list';
    var main = $('#main');
    if (!main) return;

    var enabled = App.tasks.filter(function (t) { return t.enabled; });
    var next = null;
    enabled.forEach(function (t) {
      if (t.next_run_at && (!next || t.next_run_at < next.next_run_at)) next = t;
    });

    var cards = App.tasks.map(taskCard).join('');
    var strip =
      '<div class="strip">' +
      '  <span>共 ' + App.tasks.length + ' 个任务 · 启用 ' + enabled.length + '</span>' +
      (next
        ? '<span class="dot">·</span><span>下一次 <b>' + esc(next.name) + '</b> ' + fmtShort(next.next_run_at) + '（' + fmtRel(next.next_run_at) + '）</span>'
        : '') +
      '</div>';

    if (!App.tasks.length) {
      cards =
        '<div class="card empty">' +
        '  <div class="empty-t">还没有任务</div>' +
        '  <div class="empty-s">点右上角「新建任务」，把内置脚本绑定到一份运行计划</div>' +
        '</div>';
      strip = '';
    }

    main.innerHTML =
      '<div class="toolbar">' +
      '  <h2>定时任务</h2>' +
      '  <div class="toolbar-ops">' +
      '    <button class="btn ghost icon-btn" data-action="refresh" data-tip="刷新">' + ICONS.refresh + '</button>' +
      '    <button class="btn primary" data-action="new-task">' + ICONS.plus + ' 新建任务</button>' +
      '  </div>' +
      '</div>' + strip + cards;
  }

  function taskCard(t) {
    var st = STATUS[t.last_status] || STATUS.never;
    var lastVal = t.last_run_at ? fmtShort(t.last_run_at) : '—';
    return (
      '<div class="card task">' +
      '  <div class="task-top">' +
      '    <div class="task-title"><span class="tname">' + esc(t.name) + '</span>' +
      (t.enabled ? '' : '<span class="chip chip-idle">停用</span>') +
      '    </div>' +
      '    <label class="switch" data-tip="启用 / 停用">' +
      '      <input type="checkbox" data-action="toggle" data-id="' + t.id + '"' + (t.enabled ? ' checked' : '') + '>' +
      '      <span class="slider-knob"></span>' +
      '    </label>' +
      '  </div>' +
      '  <div class="task-stats">' +
      '    <div class="stat"><div class="stat-label">频率</div><div class="stat-value">' + esc(scheduleText(t)) + '</div></div>' +
      '    <div class="stat"><div class="stat-label">上次运行</div><div class="stat-value">' + lastVal +
      '      <span class="chip ' + st[1] + '">' + st[0] + '</span></div></div>' +
      '    <div class="stat"><div class="stat-label">下次运行</div><div class="stat-value">' + fmtShort(t.next_run_at) +
      '      <span class="stat-sub">' + fmtRel(t.next_run_at) + '</span></div></div>' +
      '  </div>' +
      '  <div class="task-foot"><div class="task-actions">' +
      '    <button class="btn ghost icon-btn" data-action="run" data-id="' + t.id + '" data-tip="立即运行">' + ICONS.play + '</button>' +
      '    <button class="btn ghost icon-btn" data-action="logs" data-id="' + t.id + '" data-tip="运行日志">' + ICONS.log + '</button>' +
      '    <button class="btn ghost icon-btn" data-action="edit" data-id="' + t.id + '" data-tip="编辑">' + ICONS.edit + '</button>' +
      '    <button class="btn ghost icon-btn danger-ghost" data-action="del" data-id="' + t.id + '" data-tip="删除">' + ICONS.trash + '</button>' +
      '  </div></div>' +
      '</div>'
    );
  }

  // ---------- 编辑器 ----------
  function newEditing(t) {
    return {
      id: t ? t.id : null,
      name: t ? t.name : '',
      unit: t ? t.interval_unit : 'd',
      amount: t ? t.interval_amount : 1,
      hour: t && t.run_hour != null ? t.run_hour : 9,
      day: t && t.run_day != null ? t.run_day : 1,
      enabled: t ? !!t.enabled : true,
      params: t ? Object.keys(t.params || {}).map(function (k) { return { k: k, v: String(t.params[k]) }; }) : [{ k: '', v: '' }],
      script_key: t && t.script_key ? t.script_key : (App.builtins[0] ? App.builtins[0].key : '')
    };
  }

  function previewText(unit, amount, hour, day) {
    var hh = pad2(hour) + ':00';
    if (unit === 'h') return '每 ' + amount + ' 小时';
    if (unit === 'd') return (amount === 1 ? '每天 ' : '每 ' + amount + ' 天 ') + hh;
    return (amount === 1 ? '每月 ' : '每 ' + amount + ' 月 ') + day + ' 日 ' + hh;
  }

  // ---------- 自绘浮层提示（替代浏览器原生 title tooltip） ----------
  // 跟随鼠标坐标定位（元素矩形在 30s 静默刷新重渲染时会失效，不可依赖）
  var qtipEl = null;
  var qtipTarget = null;
  function hideQtip() {
    if (qtipEl) { if (qtipEl.remove) qtipEl.remove(); qtipEl = null; qtipTarget = null; }
  }
  function positionQtip(ev) {
    if (!qtipEl) return;
    var x = ev.clientX + 14, y = ev.clientY + 16;
    var w = qtipEl.offsetWidth, h = qtipEl.offsetHeight;
    if (x + w > window.innerWidth - 8) x = ev.clientX - w - 12;
    if (y + h > window.innerHeight - 8) y = ev.clientY - h - 12;
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    qtipEl.style.left = x + 'px';
    qtipEl.style.top = y + 'px';
  }
  function showQtip(target, ev) {
    if (qtipTarget === target && qtipEl) { positionQtip(ev); return; }
    hideQtip();
    var text = target.getAttribute('data-tip');
    if (!text) return;
    qtipTarget = target;
    qtipEl = document.createElement('div');
    qtipEl.className = 'qtip';
    qtipEl.textContent = text;
    document.body.appendChild(qtipEl);
    positionQtip(ev);
  }

  function mergeBuiltinParams() {
    var e = App.editing;
    var b = builtinByKey(e.script_key);
    if (!b || !b.params) return;
    var have = {};
    e.params.forEach(function (p) { if (p.k) have[p.k] = true; });
    b.params.forEach(function (k) {
      if (!have[k]) { e.params.push({ k: k, v: '' }); have[k] = true; }
    });
  }

  async function loadBuiltins() {
    try {
      var r = await API.getBuiltins();
      App.builtins = r && r.builtins ? r.builtins : [];
    } catch (e) {
      App.builtins = [];
    }
  }

  function renderEditor() {
    App.view = 'editor';
    var e = App.editing;
    var isNew = e.id == null;
    var info = unitInfo(e.unit);

    var builtinItems = App.builtins.map(function (b) { return { value: b.key, label: b.name }; });
    var hourItems = [];
    for (var h = 0; h <= 23; h++) hourItems.push({ value: h, label: pad2(h) + ':00' });

    $('#main').innerHTML =
      '<div class="toolbar">' +
      '  <h2>' + (isNew ? '新建任务' : '编辑任务') + '</h2>' +
      '  <div class="toolbar-ops">' +
      '    <button class="btn" data-action="cancel-edit">' + ICONS.back + ' 返回</button>' +
      (isNew ? '' : '<button class="btn danger-ghost icon-btn" data-action="del-task-edit" data-id="' + e.id + '" data-tip="删除任务">' + ICONS.trash + '</button>') +
      '  </div>' +
      '</div>' +

      '<div class="card form-card">' +

      // 名称
      '  <div class="form-sec">' +
      '    <div class="field"><label>名称</label>' +
      '      <input id="fName" style="width:100%" placeholder="任务名称" value="' + esc(e.name) + '">' +
      '    </div>' +
      '  </div>' +

      // 运行频率
      '  <div class="form-sec">' +
      '    <div class="sec-head"><span class="sec-title">运行频率</span></div>' +
      '    <div class="freq-row">' +
      '      <input type="number" id="fAmount" class="freq-num" min="1" max="' + info.max + '" value="' + e.amount + '">' +
      '      <div class="seg" id="segUnit" data-idx="' + UNITS.indexOf(info) + '">' +
      '        <div class="seg-thumb"></div>' +
      UNITS.map(function (u) {
        return '        <button type="button" data-action="unit" data-unit="' + u.key + '"' + (u.key === e.unit ? ' class="active"' : '') + '>' + u.label + '</button>';
      }).join('') +
      '      </div>' +
      '      <span id="rowHour" class="freq-opt' + (e.unit === 'h' ? ' hidden' : '') + '">时刻' +
              ddHtml('ddHour', hourItems, e.hour, 'freq-hour') +
      '      </span>' +
      '      <span id="rowDay" class="freq-opt' + (e.unit === 'm' ? '' : ' hidden') + '">每月' +
      '        <input type="number" id="fDay" class="freq-day" min="1" max="28" value="' + e.day + '">日' +
      '      </span>' +
      '    </div>' +
      '    <div class="freq-preview" id="freqPreview"></div>' +
      '  </div>' +

      // 参数
      '  <div class="form-sec">' +
      '    <div class="sec-head"><span class="sec-title">参数</span>' +
      '      <button class="btn ghost" data-action="add-param">' + ICONS.plus + ' 添加</button>' +
      '    </div>' +
      '    <div id="paramRows">' + e.params.map(paramRowHtml).join('') + '</div>' +
      '  </div>' +

      // 脚本（新建时选一次内置脚本；编辑时锁定不可更换）
      '  <div class="form-sec">' +
      '    <div class="sec-head"><span class="sec-title">脚本</span>' +
      (isNew
        ? ddHtml('fBuiltin', builtinItems, e.script_key, 'dd-wide')
        : '      <span class="muted">' + esc((builtinByKey(e.script_key) || {}).name || e.script_key || '未知') + '</span>') +
      '    </div>' +
      '  </div>' +

      // 底部操作
      '  <div class="form-foot">' +
      (isNew ? '<span></span>' : '<button class="btn danger-ghost" data-action="del-task-edit" data-id="' + e.id + '">' + ICONS.trash + ' 删除</button>') +
      '    <div class="foot-right">' +
      '      <button class="btn" data-action="cancel-edit">取消</button>' +
      '      <button class="btn primary" data-action="save-task">' + (isNew ? '创建' : '保存') + '</button>' +
      '    </div>' +
      '  </div>' +
      '</div>';

    syncUnitFields();
  }

  function paramRowHtml(p, i) {
    return (
      '<div class="param-row" data-idx="' + i + '">' +
      '  <input class="pk" placeholder="参数名" value="' + esc(p.k) + '">' +
      '  <textarea class="pv" rows="1" placeholder="参数值">' + esc(p.v) + '</textarea>' +
      '  <button class="btn ghost icon-btn danger-ghost" data-action="del-param" data-tip="删除">' + ICONS.trash + '</button>' +
      '</div>'
    );
  }

  function harvestParams() {
    var e = App.editing;
    if (!e) return;
    e.params = $all('#paramRows .param-row').map(function (row) {
      return { k: $('.pk', row).value.trim(), v: $('.pv', row).value };
    });
  }

  // 把未保存的频率数值收进 editing——切单位/增删参数会重渲染编辑器，
  // 不收割的话用户刚输入的数值会被旧值覆盖（丢输入）
  function harvestSchedule() {
    var e = App.editing;
    if (!e) return;
    var amountEl = $('#fAmount');
    if (amountEl) e.amount = clamp(Math.round(+amountEl.value) || e.amount, 1, unitInfo(e.unit).max);
    if ($('#rowHour') && !$('#rowHour').classList.contains('hidden')) e.hour = clamp(+ddValue('ddHour') || 0, 0, 23);
    if ($('#rowDay') && !$('#rowDay').classList.contains('hidden')) e.day = clamp(+$('#fDay').value || 1, 1, 28);
  }

  function syncUnitFields() {
    var e = App.editing;
    var info = unitInfo(e.unit);
    var seg = $('#segUnit');
    seg.dataset.idx = String(UNITS.indexOf(info));
    $all('#segUnit button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.unit === e.unit);
    });
    var amount = $('#fAmount');
    amount.max = String(info.max);
    if (+amount.value > info.max) amount.value = String(info.max);
    $('#rowHour').classList.toggle('hidden', e.unit === 'h');
    $('#rowDay').classList.toggle('hidden', e.unit !== 'm');
    updateFreqPreview();
  }

  function updateFreqPreview() {
    var el = $('#freqPreview');
    if (!el || !App.editing) return;
    var amount = clamp(+$('#fAmount').value || 1, 1, +$('#fAmount').max);
    var hour = clamp(+ddValue('ddHour') || 0, 0, 23);
    var day = clamp(+$('#fDay').value || 1, 1, 28);
    el.innerHTML = '运行于 <b>' + esc(previewText(App.editing.unit, amount, hour, day)) + '</b>，心跳每小时检查一次';
  }

  // ---------- 数据 ----------
  async function loadTasks() {
    App.tasks = await API.listTasks();
  }
  function findTask(id) {
    return App.tasks.find(function (t) { return String(t.id) === String(id); });
  }

  // ---------- 弹窗 / 提示 ----------
  function openModal(html, narrow) {
    var ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = '<div class="modal' + (narrow ? ' narrow' : '') + '">' + html + '</div>';
    ov.addEventListener('mousedown', function (ev) {
      if (ev.target === ov) closeModal(false);
    });
    document.body.appendChild(ov);
    return ov;
  }

  function closeModal(result) {
    var ov = $('.overlay');
    if (ov && ov.remove) ov.remove();
    if (App.confirmResolver) {
      var r = App.confirmResolver;
      App.confirmResolver = null;
      r(!!result);
    }
  }

  function confirmDelete(name) {
    return new Promise(function (resolve) {
      App.confirmResolver = resolve;
      openModal(
        '<div class="modal-head"><b>删除任务</b></div>' +
        '<div class="modal-body"><p class="confirm-text">删除「' + esc(name) + '」？日志将一并删除。</p></div>' +
        '<div class="modal-foot">' +
        '  <button class="btn" data-action="confirm-no">取消</button>' +
        '  <button class="btn danger" data-action="confirm-yes">删除</button>' +
        '</div>', true
      );
    });
  }

  function toast(msg, type) {
    var box = $('#toasts');
    var el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () { if (el.remove) el.remove(); }, 2400);
  }

  // ---------- 日志 ----------
  async function openLogs(id) {
    var t = findTask(id);
    openModal(
      '<div class="modal-head"><b>' + esc(t ? t.name : '') + '</b>' +
      '  <div class="ops">' +
      '    <button class="btn ghost icon-btn" data-action="refresh-logs" data-id="' + id + '" data-tip="刷新">' + ICONS.refresh + '</button>' +
      '    <button class="btn ghost icon-btn" data-action="close-modal" data-tip="关闭">' + ICONS.close + '</button>' +
      '  </div>' +
      '</div>' +
      '<div class="modal-body logs" id="logsBody" style="padding-top:12px">加载中…</div>'
    );
    await fillLogs(id);
  }

  async function fillLogs(id) {
    var body = $('#logsBody');
    if (!body) return;
    try {
      var logs = await API.listLogs(id);
      if (!$('#logsBody')) return;
      body.innerHTML = logs.length
        ? logs.map(logLine).join('')
        : '<p class="muted" style="text-align:center;padding:30px 0">暂无日志</p>';
    } catch (err) {
      body.innerHTML = '<p class="muted">加载失败：' + esc(err.message) + '</p>';
    }
  }

  function logLine(l) {
    var cls = l.level === 'error' ? ' level-error' : '';
    return (
      '<div class="log-line' + cls + '">' +
      '  <span class="lt">' + fmtTime(l.ts) + '</span>' +
      '  <span class="chip ' + (l.level === 'error' ? 'chip-fail' : 'chip-idle') + '">' + esc(l.level) + '</span>' +
      '  <span class="lx">' + esc(l.text) + '</span>' +
      '</div>'
    );
  }

  // ---------- 通知设置（全局 MeoW 推送） ----------
  async function actionSettings() {
    var s = await API.getSettings();
    openModal(
      '<div class="modal-head"><b>通知设置</b></div>' +
      '<div class="modal-body">' +
      '  <div class="field" style="margin-bottom:12px">' +
      '    <label>MeoW 昵称</label>' +
      '    <input id="setMeow" style="width:100%" placeholder="chuckfang.com 绑定的昵称" value="' + esc(s.meow_nickname || '') + '">' +
      '    <div class="modal-hint">所有脚本的推送都发往该昵称；留空则不推送。</div>' +
      '  </div>' +
      '</div>' +
      '<div class="modal-foot">' +
      '  <button class="btn" data-action="test-notify" style="margin-right:auto">测试推送</button>' +
      '  <button class="btn" data-action="close-modal">取消</button>' +
      '  <button class="btn primary" data-action="save-settings">保存</button>' +
      '</div>', true
    );
  }

  // ---------- 动作 ----------
  async function actionRun(id, btn) {
    var t = findTask(id);
    if (!t) return;
    btn.classList.add('busy');
    try {
      await API.runTask(id);
      toast('「' + t.name + '」运行完成', 'ok');
    } catch (err) {
      toast('运行失败：' + err.message, 'fail');
    }
    btn.classList.remove('busy');
    await loadTasks();
    if (App.view === 'list') renderList();
  }

  async function actionDelete(id) {
    var t = findTask(id);
    if (!t) return;
    var yes = await confirmDelete(t.name);
    if (!yes) return;
    await API.deleteTask(id);
    toast('已删除', 'ok');
    await loadTasks();
    renderList();
  }

  async function actionSave() {
    var e = App.editing;
    harvestParams();

    var name = $('#fName').value.trim();
    if (!name) { toast('请填写名称', 'fail'); $('#fName').focus(); return; }

    var amount = clamp(Math.round(+$('#fAmount').value || 1), 1, unitInfo(e.unit).max);
    var run_hour = (e.unit === 'h') ? null : clamp(+ddValue('ddHour') || 0, 0, 23);
    var run_day = (e.unit === 'm') ? clamp(+$('#fDay').value || 1, 1, 28) : null;

    var params = {};
    e.params.forEach(function (p) { if (p.k) params[p.k] = p.v; });

    if (!e.script_key || !builtinByKey(e.script_key)) { toast('请选择内置脚本', 'fail'); return; }

    var task = {
      id: e.id,
      name: name,
      enabled: e.enabled ? 1 : 0,
      interval_amount: amount,
      interval_unit: e.unit,
      run_hour: run_hour,
      run_day: run_day,
      params: params,
      script_key: e.script_key
    };

    try {
      await API.saveTask(task);
      toast(e.id == null ? '已创建' : '已保存', 'ok');
      await loadTasks();
      renderList();
    } catch (err) {
      toast('保存失败：' + err.message, 'fail');
    }
  }

  // ---------- 事件路由 ----------
  function onClick(ev) {
    // 自绘下拉：选项选择
    var ddOpt = ev.target.closest('.dd-opt');
    if (ddOpt) {
      var dd2 = ddOpt.closest('.dd');
      dd2.dataset.value = ddOpt.dataset.value;
      $('.dd-label', dd2).textContent = ddOpt.textContent;
      $all('.dd-opt', dd2).forEach(function (o) { o.classList.toggle('active', o === ddOpt); });
      $('.dd-list', dd2).classList.add('hidden');
      dd2.classList.remove('open');
      if (dd2.id === 'fBuiltin' && App.editing && App.editing.id == null) {
        harvestSchedule();
        harvestParams();
        App.editing.script_key = dd2.dataset.value;
        mergeBuiltinParams();
        renderEditor();
      } else if (dd2.id === 'ddHour') {
        if (App.editing) App.editing.hour = +dd2.dataset.value || 0;
        updateFreqPreview();
      }
      return;
    }
    // 自绘下拉：开合
    var ddBtn = ev.target.closest('.dd-btn');
    if (ddBtn) {
      var dd = ddBtn.closest('.dd');
      var wasOpen = dd.classList.contains('open');
      closeAllDd();
      if (!wasOpen) {
        dd.classList.add('open');
        $('.dd-list', dd).classList.remove('hidden');
      }
      return;
    }

    var el = ev.target.closest('[data-action]');
    if (!el) return;
    var action = el.dataset.action;
    var id = el.dataset.id;

    switch (action) {
      case 'unit':
        if (App.view === 'editor') {
          harvestSchedule();
          App.editing.unit = el.dataset.unit;
          harvestParams();
          renderEditor();
        }
        break;
      case 'add-param':
        harvestSchedule();
        harvestParams();
        App.editing.params.push({ k: '', v: '' });
        renderEditor();
        break;
      case 'del-param': {
        harvestSchedule();
        harvestParams();
        var row = el.closest('.param-row');
        App.editing.params.splice(+row.dataset.idx, 1);
        if (!App.editing.params.length) App.editing.params.push({ k: '', v: '' });
        renderEditor();
        break;
      }
      case 'save-task': actionSave(); break;
      case 'cancel-edit': renderList(); break;
      case 'del-task-edit': actionDelete(id); break;

      case 'new-task':
        App.editing = newEditing(null);
        renderEditor();
        break;
      case 'edit': {
        var t = findTask(id);
        if (t) { App.editing = newEditing(JSON.parse(JSON.stringify(t))); renderEditor(); }
        break;
      }
      case 'run': actionRun(id, el); break;
      case 'logs': openLogs(id); break;
      case 'del': actionDelete(id); break;
      case 'refresh': loadTasks().then(renderList); break;

      case 'toggle': break; // change 事件处理

      case 'logout':
        App.authed = false;
        localStorage.removeItem('ql.auth');
        renderLogin();
        break;

      case 'toggle-theme':
        App.theme = App.theme === 'dark' ? 'light' : 'dark';
        localStorage.setItem('ql.theme', App.theme);
        applyTheme();
        syncThemeIcon();
        break;

      case 'close-modal': closeModal(false); break;
      case 'refresh-logs': fillLogs(id); break;
      case 'confirm-yes': closeModal(true); break;
      case 'confirm-no': closeModal(false); break;

      case 'settings': actionSettings().catch(function (err) { toast('加载失败：' + err.message, 'fail'); }); break;
      case 'save-settings':
        API.saveSettings({ meow_nickname: ($('#setMeow').value || '').trim() })
          .then(function () { closeModal(false); toast('已保存', 'ok'); })
          .catch(function (err) { toast('保存失败：' + err.message, 'fail'); });
        break;
      case 'test-notify':
        API.testNotify(($('#setMeow').value || '').trim())
          .then(function () { toast('测试推送已发送', 'ok'); })
          .catch(function (err) { toast('推送失败：' + err.message, 'fail'); });
        break;
    }
  }

  function onChange(ev) {
    var el = ev.target;
    if (el.matches('[data-action="toggle"]')) {
      var id = el.dataset.id;
      API.toggleTask(id, el.checked)
        .then(function () {
          var t = findTask(id);
          if (t) t.enabled = el.checked ? 1 : 0;
          toast(el.checked ? '已启用' : '已停用', 'ok');
        })
        .catch(function (err) { toast('操作失败：' + err.message, 'fail'); el.checked = !el.checked; });
      return;
    }
    if (el.id === 'fDay') updateFreqPreview();
  }

  function onInput(ev) {
    var id = ev.target.id;
    if (id === 'fAmount' || id === 'fDay') updateFreqPreview();
  }

  function onSubmit(ev) {
    if (ev.target.id !== 'loginForm') return;
    ev.preventDefault();
    var pw = $('#loginPw').value;
    API.login(pw)
      .then(function (ok) {
        if (!ok) { toast('密码错误', 'fail'); return; }
        App.authed = true;
        localStorage.setItem('ql.auth', '1');
        enterPanel();
      })
      .catch(function (err) {
        if (err.message === 'UNAUTHORIZED') toast('密码错误', 'fail');
        else toast('登录失败：' + err.message, 'fail');
      });
  }

  function onKeyDown(ev) {
    if (ev.key === 'Escape') { closeModal(false); hideQtip(); closeAllDd(); return; }
  }

  // ---------- 入口 ----------
  function applyTheme() {
    // dark 类挂在 html 上：CSS 变量在 :root 重定义后连画布底色一起换
    //（挂 body 上时 html 底色不变，页面内容短就会露出米白）
    document.documentElement.classList.toggle('dark', App.theme === 'dark');
  }

  async function enterPanel() {
    renderShell();
    await Promise.all([loadBuiltins(), loadTasks()]);
    renderList();
  }

  function init() {
    applyTheme();
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    document.addEventListener('input', onInput);
    document.addEventListener('submit', onSubmit);
    document.addEventListener('keydown', onKeyDown);
    // 自绘浮层提示：悬停带 data-tip 的元素时显示，移开/滚动/按下即隐藏
    document.addEventListener('mouseover', function (ev) {
      var t = ev.target.closest ? ev.target.closest('[data-tip]') : null;
      if (t) showQtip(t, ev); else hideQtip();
    });
    document.addEventListener('mousedown', function (ev) {
      if (!ev.target.closest('.dd')) closeAllDd();
    });
    document.addEventListener('mousedown', hideQtip);
    window.addEventListener('scroll', hideQtip, true);
    // 会话过期（Cookie 30 天后失效）时全局接管：弹回登录页
    window.addEventListener('ql:unauthorized', function () {
      if (!App.authed) return;
      App.authed = false;
      localStorage.removeItem('ql.auth');
      renderLogin();
      toast('登录已过期，请重新输入密码', 'fail');
    });
    // 未登录先渲染登录页；已登录直接进入面板（数据加载失败由各调用方提示）
    if (App.authed) {
      enterPanel();
    } else {
      renderLogin();
    }

    setInterval(function () {
      if (!App.authed || App.view !== 'list' || $('.overlay')) return;
      loadTasks().then(function () {
        if (App.view === 'list' && !$('.overlay')) renderList();
      });
    }, 30000);
  }

  init();
})();
