const $ = s => document.querySelector(s);
const main = $('#main'), sheet = $('#sheet');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
let state, timer, generation = 0, refreshing, editing, toastTimer;
const paths = { run:'M9 5l11 7-11 7z', logs:'M5 3h10l4 4v14H5z M9 11h6 M9 15h6', edit:'M4 16L16 4l4 4L8 20H4z', del:'M4 7h16 M9 7V4h6v3 M6 7l1 14h10l1-14', settings:'M18 9a6 6 0 0 0-12 0c0 5-2 7-2 7h16s-2-2-2-7 M10 20h4', logout:'M9 4H4v16h5 M12 12h9 M17 8l4 4-4 4', theme:'M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10' };
const icon = key => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[key]}"></path></svg>`;
for (const key of ['settings','logout','theme']) $(`[data-action=${key}]`).innerHTML = icon(key);

// 自绘浮层提示：文本取 data-tip 或 aria-label，置于元素上方，贴边翻转。
const tip = document.createElement('div');
tip.className = 'qtip'; tip.setAttribute('role','tooltip'); document.body.appendChild(tip);
function showTip(target) {
  tip.textContent = target.dataset.tip || target.getAttribute('aria-label') || '';
  if (!tip.textContent) { hideTip(); return; }
  tip.classList.add('on');
  const r = target.getBoundingClientRect();
  const x = Math.max(8, Math.min(r.left + r.width / 2 - tip.offsetWidth / 2, innerWidth - tip.offsetWidth - 8));
  let y = r.top - tip.offsetHeight - 8;
  if (y < 8) y = r.bottom + 8;
  tip.style.left = `${Math.round(x)}px`; tip.style.top = `${Math.round(y)}px`;
}
const hideTip = () => tip.classList.remove('on');
document.addEventListener('mouseover', e => { const t = e.target.closest('button'); if (t) showTip(t); else hideTip(); });
document.addEventListener('mouseout', e => { if (e.target.closest('button')) hideTip(); });
document.addEventListener('scroll', hideTip, true);

function toast(text) { clearTimeout(toastTimer); hideTip(); $('#toast').textContent = text; $('#toast').className = 'show'; toastTimer = setTimeout(() => $('#toast').className = '', 3500); }
async function api(path, method = 'GET', body = {}) {
  const response = await fetch('/api' + path, { method, credentials:'same-origin', ...(method !== 'GET' ? { headers:{'content-type':'application/json'}, body:JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (response.status === 401) login();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
function login() {
  generation++; state = null; clearTimeout(timer); hideTip(); sheet.close(); $('#nav').hidden = true;
  main.innerHTML = '<form class="login"><div class="dots"><i></i><i></i><i></i></div><h1>青龙面板</h1><label class="field">访问密码<input name="password" type="password" autocomplete="current-password" required></label><button class="primary">进入</button></form>';
  main.querySelector('form').onsubmit = async event => {
    event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
    try { await api('/login','POST',{ password:new FormData(event.target).get('password') }); await refresh(); }
    catch (error) { toast(error.message); button.disabled = false; }
  };
}
function fmt(time) {
  if (!time) return '从未';
  return new Intl.DateTimeFormat('zh-CN',{ timeZone:'UTC', month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false }).format(new Date((time + (state?.timezone ?? 8) * 3600) * 1000));
}
function frequency(t) {
  const n = t.interval_amount;
  if (t.interval_unit === 'h') return `每 ${Math.floor(n/60) ? `${Math.floor(n/60)} 小时 ` : ''}${n%60 ? `${n%60} 分钟` : ''}`.trim();
  const clock = `${String(t.run_hour ?? 9).padStart(2,'0')}:${String(t.run_minute ?? 0).padStart(2,'0')}`;
  return `${t.interval_unit === 'd' ? (n===1 ? '每天' : `每 ${n} 天`) : `${n===1 ? '每月' : `每 ${n} 月`} ${t.run_day} 日`} ${clock}`;
}
function render() {
  $('#nav').hidden = false;
  main.innerHTML = `<div class="toolbar"><button class="primary" data-action="new">＋ 新建任务</button><span class="muted">${state.tasks.length} 个任务 · UTC${state.timezone>=0?'+':''}${state.timezone}</span></div><div class="list">${state.tasks.map(t => {
    const status = t.pending_at ? (t.last_status === 'running' ? 'running' : 'queued') : t.last_status;
    const label = { never:'待运行',ok:'',failed:'失败',running:'运行中',queued:t.pending_kind==='defer'?'等待补跑':'已排队' }[status] || '';
    return `<article class="task ${t.enabled?'':'off'}" data-id="${t.id}"><div class="info"><h2>${esc(t.name)}</h2><div class="meta"><span>${esc(frequency(t))}</span><span>上次 ${fmt(t.last_run_at)}</span><span>下次 ${t.enabled?fmt(t.next_run_at):'已停用'}</span></div></div><div class="side"><span class="status ${status}">${label}</span><input type="checkbox" data-action="toggle" aria-label="启用 ${esc(t.name)}" ${t.enabled?'checked':''}><div class="actions">${['run','logs','edit','del'].map(key=>`<button data-action="${key}" aria-label="${{run:'立即运行',logs:'运行日志',edit:'编辑任务',del:'删除任务'}[key]} ${esc(t.name)}" ${key==='run'&&(!t.enabled||t.pending_at)?'disabled':''}>${icon(key)}</button>`).join('')}</div></div></article>`;
  }).join('') || '<p class="muted">还没有任务</p>'}</div>`;
}
async function refresh() {
  if (refreshing) await refreshing.catch(()=>{});
  const epoch = generation;
  const request = api('/state'); refreshing = request;
  try { const data = await request; if (epoch !== generation) return; state = data; render(); }
  finally { if (refreshing===request) refreshing = null; clearTimeout(timer); if (state && !document.hidden) timer = setTimeout(() => { if (!sheet.open) refresh().catch(error=>toast(error.message)); else scheduleRefresh(); }, state.tasks.some(t=>t.pending_at) ? 3000 : 120000); }
}
function scheduleRefresh() { clearTimeout(timer); if (state && !document.hidden) timer = setTimeout(()=>{ if (!sheet.open) refresh().catch(error=>toast(error.message)); else scheduleRefresh(); },30000); }
function open(title, content) {
  hideTip(); sheet.close(); sheet.innerHTML = `<div class="sheet-head"><h2>${esc(title)}</h2><button aria-label="关闭" data-action="close">×</button></div>${content}`;
  sheet.showModal();
}
function field(label, name, value = '', type = 'text') { return `<label class="field">${label}<input name="${name}" type="${type}" value="${esc(value)}" required></label>`; }
function editor(task) {
  editing = task || null;
  const t = task || { name:'',script_key:state.builtins[0].key,params:{},interval_unit:'d',interval_amount:1,run_hour:9,run_minute:0,run_day:1,enabled:1 };
  const locked = Boolean(task);
  // 编辑态锁定脚本：切换脚本会让参数失去意义，仅新建时选择一次。
  const scriptName = state.builtins.find(b => b.key === t.script_key)?.name || t.script_key;
  const scriptField = locked
    ? `<label class="field">脚本<div class="locked">${esc(scriptName)}</div></label>`
    : `<label class="field">脚本<select name="script_key">${state.builtins.map(b=>`<option value="${b.key}" ${t.script_key===b.key?'selected':''}>${esc(b.name)}</option>`).join('')}</select></label>`;
  const seg = `<div class="seg" role="group" aria-label="运行频率">${[['h','间隔'],['d','按天'],['m','按月']].map(([v,n])=>`<button type="button" data-unit="${v}" class="${t.interval_unit===v?'on':''}">${n}</button>`).join('')}</div><input type="hidden" name="interval_unit" value="${esc(t.interval_unit)}">`;
  open(task?'编辑任务':'新建任务', `<form id="editor">${field('名称','name',t.name)}${scriptField}<div id="params"></div><div class="field"><span>频率</span>${seg}</div><div id="schedule"></div><p class="preview" id="preview"></p><label class="inline">启用<input name="enabled" type="checkbox" ${t.enabled?'checked':''}></label><div class="foot"><button type="button" data-action="close">取消</button><button class="primary">保存</button></div></form>`);
  const form = $('#editor');
  let draft = { ...t.params };
  const keyOf = () => locked ? t.script_key : form.elements.script_key.value;
  function params() {
    $('#params').innerHTML = state.builtins.find(b=>b.key===keyOf()).params.map(name=>`<label class="field">${esc(name)}${name==='cookie'?`<textarea name="p_cookie" placeholder="多账号每行一个">${esc(draft[name]||'')}</textarea>`:`<input name="p_${name}" type="password" autocomplete="off" value="${esc(draft[name]||'')}">`}</label>`).join('');
  }
  function schedule() {
    const unit = form.elements.interval_unit.value;
    $('#schedule').innerHTML = unit === 'h' ? `<div class="schedule">间隔 <input aria-label="间隔小时" name="hours" type="number" min="0" max="23" value="${t.interval_unit==='h'?Math.floor(t.interval_amount/60):1}"> 小时 <input aria-label="间隔分钟" name="minutes" type="number" min="0" max="59" value="${t.interval_unit==='h'?t.interval_amount%60:0}"> 分钟</div>` : `<div class="schedule">每 <input aria-label="间隔数量" name="amount" type="number" min="1" max="${unit==='d'?30:12}" value="${t.interval_unit===unit?t.interval_amount:1}"> ${unit==='d'?'天':'月'} ${unit==='m'?`<input aria-label="日期" name="day" type="number" min="1" max="28" value="${t.run_day||1}"> 日`:''}<input aria-label="执行时刻" name="time" type="time" required value="${String(t.run_hour??9).padStart(2,'0')}:${String(t.run_minute??0).padStart(2,'0')}"></div>`;
    preview();
  }
  function harvest() {
    const unit = form.elements.interval_unit.value;
    if (unit==='h') return { interval_unit:unit,interval_amount:Number(form.elements.hours.value)*60+Number(form.elements.minutes.value) };
    const [h,m] = form.elements.time.value.split(':').map(Number);
    return { interval_unit:unit,interval_amount:Number(form.elements.amount.value),run_hour:h,run_minute:m,run_day:unit==='m'?Number(form.elements.day.value):null };
  }
  function preview() { const value=harvest(); $('#preview').textContent = `${frequency(value)}${value.interval_unit==='h'?' · 从保存时刻起计':' · 面板时区'}`; }
  if (!locked) form.elements.script_key.onchange = () => { draft={}; params(); };
  form.addEventListener('click', event => {
    const button = event.target.closest('.seg [data-unit]');
    if (!button) return;
    form.elements.interval_unit.value = button.dataset.unit;
    for (const item of form.querySelectorAll('.seg [data-unit]')) item.classList.toggle('on', item === button);
    schedule();
  });
  form.oninput = preview;
  params(); schedule();
  form.onsubmit = async event => {
    event.preventDefault(); const button=form.querySelector('.primary'); button.disabled=true;
    const params = { ...(editing ? editing.params : {}) };
    for (const input of form.querySelectorAll('[name^=p_]')) params[input.name.slice(2)] = input.value.trim();
    try { await api(`/tasks${editing?'/'+editing.id:''}`,editing?'PUT':'POST',{ name:form.elements.name.value.trim(),script_key:keyOf(),params,enabled:form.elements.enabled.checked,...harvest() }); sheet.close(); await refresh(); toast('已保存'); }
    catch(error) { toast(error.message); button.disabled=false; }
  };
}
async function settings() {
  open('推送设置','<p class="muted">加载中…</p>');
  try {
    const target=sheet.querySelector('p');
    const data=await api('/settings'); if (!sheet.open || !target?.isConnected) return;
    open('推送设置',`<form id="settings"><label class="field">TimelyNotify 密钥<input name="key" type="password" autocomplete="off" value="${esc(data.notify_key)}"></label><div class="foot"><button type="button" data-action="test">测试推送</button><button class="primary">保存</button></div></form>`);
    $('#settings').onsubmit=async event=>{ event.preventDefault(); const button=event.target.querySelector('.primary'); button.disabled=true; try { await api('/settings','PUT',{notify_key:event.target.elements.key.value.trim()}); sheet.close(); toast('已保存'); } catch(error) {toast(error.message);button.disabled=false;} };
  } catch(error) {sheet.close();toast(error.message);}
}
async function logs(id) {
  open('运行日志','<button data-action="reload-logs" data-id="'+id+'">刷新</button><div class="logs" id="log-content">加载中…</div>');
  const target=$('#log-content');
  try { const data=await api(`/tasks/${id}/logs`); if (!target.isConnected) return; target.innerHTML=data.logs.map(l=>`<div class="log ${l.level}"><time>${fmt(l.ts)}</time>${esc(l.text)}</div>`).join('')||'暂无日志'; }
  catch(error){if(target.isConnected)target.textContent=error.message;}
}
document.addEventListener('click', async event=>{
  hideTip();
  const button=event.target.closest('[data-action]'); if(!button)return;
  const action=button.dataset.action, id=Number(button.closest('[data-id]')?.dataset.id), task=state?.tasks.find(t=>t.id===id);
  try {
    if(action==='close')sheet.close();
    else if(action==='theme'){document.documentElement.classList.toggle('dark');try{localStorage.setItem('ql_theme',document.documentElement.classList.contains('dark')?'dark':'light');}catch{}}
    else if(action==='logout'){await api('/logout','POST');login();}
    else if(action==='new')editor();
    else if(action==='edit')editor(task);
    else if(action==='settings'){if(sheet.open)sheet.close();else await settings();}
    else if(action==='logs'||action==='reload-logs')await logs(id);
    else if(action==='run'){button.disabled=true;await api(`/tasks/${id}/run`,'POST');await refresh();toast('已排队');}
    else if(action==='toggle'){button.disabled=true;await api(`/tasks/${id}`,'PATCH',{enabled:button.checked});await refresh();}
    else if(action==='del'){
      open('删除任务',`<p>删除「${esc(task.name)}」及其日志？</p><div class="foot"><button data-action="close">取消</button><button class="danger" data-action="confirm-delete" data-id="${id}">删除</button></div>`);
    }else if(action==='confirm-delete'){button.disabled=true;await api(`/tasks/${id}`,'DELETE');sheet.close();await refresh();toast('已删除');}
    else if(action==='test'){button.disabled=true;await api('/settings/test','POST',{notify_key:$('#settings').elements.key.value.trim()});toast('测试推送已发送');button.disabled=false;}
  }catch(error){toast(error.message);button.disabled=false;if(action==='toggle')button.checked=!button.checked;}
});
sheet.addEventListener('click',event=>{if(event.target===sheet){const r=sheet.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)sheet.close();}});
sheet.addEventListener('close',()=>{if(state)refresh().catch(error=>toast(error.message));});
document.addEventListener('visibilitychange',()=>{clearTimeout(timer);if(!document.hidden&&state)refresh().catch(error=>toast(error.message));});
try{document.documentElement.classList.toggle('dark',localStorage.getItem('ql_theme')==='dark');}catch{}
refresh().catch(error=>{if(!state)login();else toast(error.message);});
