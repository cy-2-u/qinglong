/* UI 组件层：自定义下拉、分段控件、弹层/确认框、toast、全局事件接线。
   app.js 只依赖 window.UI 与 window.API，视图代码不直接操作组件内部状态。 */
(function () {
  'use strict';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- 自定义下拉 ----------
  // items: [{v, label}]，current 为选中值。值从 .dd-item.sel 的 data-value 读取。
  function ddHtml(id, items, current) {
    var cur = null;
    for (var i = 0; i < items.length; i++) if (items[i].v === current) cur = items[i];
    if (!cur && items.length) cur = items[0];
    var h = '<div class="dd" data-dd="' + esc(id) + '">';
    h += '<button type="button" class="dd-head"><span class="dd-label">' + esc(cur ? cur.label : '') + '</span><span class="dd-arrow">&#9662;</span></button>';
    h += '<div class="dd-menu">';
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      h += '<button type="button" class="dd-item' + (cur && it.v === cur.v ? ' sel' : '') + '" data-dd="' + esc(id) + '" data-value="' + esc(it.v) + '">' + esc(it.label) + '</button>';
    }
    h += '</div></div>';
    return h;
  }

  function ddValue(id) {
    var el = $('.dd[data-dd="' + id + '"] .dd-item.sel');
    return el ? el.getAttribute('data-value') : null;
  }

  function closeAllDd() { $all('.dd.open').forEach(function (d) { d.classList.remove('open'); }); }

  // ---------- 弹层 / 确认框 ----------
  var confirmResolve = null;

  function fireModalClose(opts) {
    if (opts && opts.onModalClose) opts.onModalClose();
  }

  function openModal(inner) {
    closeModal();
    var ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = '<div class="modal">' + inner + '</div>';
    document.body.appendChild(ov);
    return ov;
  }

  function closeModal() {
    $all('.overlay').forEach(function (o) { o.remove(); });
    confirmResolve = null;
  }

  // Promise<boolean>：点「yes」resolve(true)，「no」/关闭 resolve(false)
  function confirmDialog(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      openModal(
        '<div class="confirm">' +
        '<h3>' + esc(opts.title || '确认') + '</h3>' +
        '<p>' + esc(opts.message || '') + '</p>' +
        '<div class="sheet-foot">' +
        '<button type="button" class="btn" data-confirm="no">' + esc(opts.no || '取消') + '</button>' +
        '<button type="button" class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '" data-confirm="yes">' + esc(opts.yes || '确定') + '</button>' +
        '</div></div>'
      );
      confirmResolve = resolve;
    });
  }

  // ---------- toast ----------
  function toast(msg, type) {
    var box = $('#toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
    var t = document.createElement('div');
    t.className = 'toast' + (type === 'err' ? ' toast-err' : type === 'ok' ? ' toast-ok' : '');
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(function () {
      t.classList.add('toast-out');
      setTimeout(function () { t.remove(); }, 300);
    }, 3200);
  }

  // ---------- 全局事件接线（app 启动时调用一次） ----------
  function wire(opts) {
    document.addEventListener('click', function (e) {
      // 确认框按钮（组件内部消化，不进 app 的 action 分发）
      var c = e.target.closest('[data-confirm]');
      if (c) {
        var r = confirmResolve;
        closeModal();
        if (r) r(c.getAttribute('data-confirm') === 'yes');
        return;
      }
      // 弹窗右上角关闭（sheet-x：推送设置/日志/编辑器共用）
      if (e.target.closest('.sheet-x')) { closeModal(); fireModalClose(opts); return; }
      // 点遮罩关闭弹窗
      if (e.target.classList && e.target.classList.contains('overlay')) { closeModal(); fireModalClose(opts); return; }
      // 分段控件：选中项（mac 风格 seg）
      var segBtn = e.target.closest('.seg-btn');
      if (segBtn) {
        var seg = segBtn.closest('.seg');
        $all('.seg-btn', seg).forEach(function (b) { b.classList.toggle('on', b === segBtn); });
        if (opts && opts.onSegChange) opts.onSegChange(seg.getAttribute('data-seg'), segBtn.getAttribute('data-value'));
        return;
      }
      // 下拉：展开/收起
      var head = e.target.closest('.dd-head');
      if (head) {
        var dd = head.closest('.dd');
        var open = dd.classList.contains('open');
        closeAllDd();
        if (!open) dd.classList.add('open');
        return;
      }
      // 下拉：选中项
      var item = e.target.closest('.dd-item');
      if (item) {
        var box = item.closest('.dd');
        $all('.dd-item', box).forEach(function (x) { x.classList.toggle('sel', x === item); });
        var lab = box.querySelector('.dd-label');
        if (lab) lab.textContent = item.textContent;
        closeAllDd();
        if (opts && opts.onDdChange) opts.onDdChange(item.getAttribute('data-dd'), item.getAttribute('data-value'));
        return;
      }
      // 点击空白：收起下拉
      closeAllDd();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (document.querySelector('.overlay')) {
          closeModal();
          fireModalClose(opts);
        }
        closeAllDd();
      }
    });
  }

  window.UI = {
    $: $, $all: $all, esc: esc,
    ddHtml: ddHtml, ddValue: ddValue,
    openModal: openModal, closeModal: closeModal, confirmDialog: confirmDialog,
    toast: toast,
    wire: wire,
  };
})();
