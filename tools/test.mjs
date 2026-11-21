import test from 'node:test';
import assert from 'node:assert/strict';
import { platform, database } from './kernel.mjs';
import { Store } from '../src/store.js';
import { initialNext, nextRun, normalize, offset, now } from '../src/schedule.js';
import { Engine, BUILTINS } from '../src/engine.js';
import { runtime, notify } from '../src/runtime.js';
import { run as dnshe, expiry, truth } from '../src/tasks/dnshe.js';
import { run as agentrouter, parseAccounts } from '../src/tasks/agentrouter.js';
import { valid, issue, cookie, passwordMatches } from '../src/auth.js';

const task = (extra={}) => ({name:'任务',script_key:'dnshe-renew',params:{api_key:'k',api_secret:'s'},enabled:1,interval_unit:'d',interval_amount:1,run_hour:9,run_minute:3,run_day:null,...extra});
const bj = (day,hour=9,minute=3) => Date.UTC(2026,10,day,hour-8,minute)/1000;
function context(params, fetcher, budget=40) {
  const logs=[];let calls=0;
  return {params,logs,signal:new AbortController().signal,log:(message,level)=>logs.push({message,level}),sleep:async()=>{},canStart:n=>calls+n<=budget,fetch:async(...args)=>{calls++;assert.ok(calls<=budget);return fetcher(...args);},get calls(){return calls;}};
}
const json = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

test('调度：零时区、分钟、跨日月、长期停机常数步进',()=>{
  assert.equal(offset({TZ_OFFSET:'0'}),0);
  assert.equal(initialNext(task(),bj(13,8),28800),bj(13));
  assert.equal(initialNext(task(),bj(13),28800),bj(14));
  assert.equal(nextRun(task({next_run_at:bj(1),interval_amount:3}),bj(13,10),28800),bj(16));
  assert.equal(nextRun(task({next_run_at:1,interval_unit:'h',interval_amount:1}),2e9,28800),2000000041);
  const monthly=task({interval_unit:'m',run_day:28,interval_amount:2,next_run_at:Date.UTC(2020,0,28,1,3)/1000});
  assert.equal(nextRun(monthly,bj(13),28800),bj(28));
});
test('字段校验：拒绝 NaN/无穷/数组/原型键，保留隐藏参数',()=>{
  assert.throws(()=>normalize(task({interval_amount:Infinity}),BUILTINS));
  assert.throws(()=>normalize(task({script_key:'toString'}),BUILTINS));
  assert.throws(()=>normalize(task({params:[]}),BUILTINS));
  assert.throws(()=>normalize(task({enabled:'false'}),BUILTINS));
  assert.equal(normalize(task({params:{min_interval:0}}),BUILTINS).params.min_interval,0);
});
test('认证：旧格式兼容、退出 Cookie、过期/畸形/改密码失效',async()=>{
  const token=await issue('secret');
  const request=new Request('https://local.test',{headers:{cookie:'ql_sess='+token}});
  assert.equal(await valid(request,'secret'),true);
  assert.equal(await valid(request,'other'),false);
  assert.equal(await valid(new Request('https://local.test',{headers:{cookie:'ql_sess=%GG'}}),'secret'),false);
  assert.match(cookie('',true,true),/HttpOnly.*Max-Age=0.*Secure/);
  assert.equal(await passwordMatches('secret','secret'),true);
  assert.equal(await passwordMatches('bad','secret'),false);
});
test('SQLite 迁移：保留旧表任务/凭据/日志；播种只做一次',async()=>{
  const db=database();
  db.sql.exec("CREATE TABLE tasks(id INTEGER PRIMARY KEY,name TEXT,enabled INTEGER,script_key TEXT,params TEXT,interval_amount INTEGER,interval_unit TEXT,run_hour INTEGER,run_day INTEGER,last_run_at INTEGER,last_status TEXT,next_run_at INTEGER); INSERT INTO tasks VALUES(7,'旧名',1,'glados-checkin','{\"cookie\":\"private\"}',1,'d',9,NULL,NULL,'ok',123)");
  const store=new Store(db);await store.init({});await store.init({});
  assert.equal((await store.list()).length,1);
  assert.equal((await store.task(7)).params,'{"cookie":"private"}');
  assert.equal((await store.task(7)).run_minute,null);db.close();
});
test('迁移：旧补跑结构只暂停不删除，新版同名任务不再误判',async()=>{
  const db=database(),s=new Store(db);await s.init({});
  try {
    await s.query("DELETE FROM settings WHERE key='jobs_v1'").run();
    const id=await s.create({...task({name:'GLaDOS 签到（补跑）',script_key:'glados-checkin',interval_unit:'h',interval_amount:1,run_hour:null,run_minute:null,run_day:null}),next_run_at:now()});
    await s.init({});assert.equal((await s.task(id)).enabled,0);assert.ok((await s.logs(id)).some(l=>/暂停/.test(l.text)));
    await s.toggle(id,1);await s.init({});assert.equal((await s.task(id)).enabled,1);
  } finally {db.close();}
});
test('API：路由、登录、退出、SameSite 防线、HTTP 状态',async()=>{
  const p=await platform();const worker=(await import('../src/index.js')).default;
  const call=(path,method='GET',body,headers={})=>worker.fetch(new Request('https://local.test'+path,{method,headers:{...(method!=='GET'?{'content-type':'application/json'}:{}),...headers},...(method!=='GET'?{body:JSON.stringify(body??{})}:{})}),p.env);
  assert.equal((await call('/api/state')).status,401);
  assert.equal((await call('/api/login','POST',{password:'bad'})).status,401);
  const login=await call('/api/login','POST',{password:'local-test-password'});assert.equal(login.status,200);
  assert.match(login.headers.get('set-cookie'),/SameSite=Strict/);
  const c=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/api/state','GET',null,{cookie:c})).status,200);
  // 跨站请求由浏览器 SameSite=Strict 拦截凭据，服务端不再重复校验 Origin（冗余防御已删）。
  assert.equal((await call('/api/logout','POST',{}, {cookie:c,origin:'https://evil.test'})).status,200);
  assert.match((await call('/api/logout','POST',{}, {cookie:c})).headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await call('/api/tasks/0','DELETE',{}, {cookie:c})).status,404);
  p.close();
});
test('平台：任务 CRUD、手动去重、运行期间禁编辑、停用取消作业',async()=>{
  const p=await platform();
  const created=await p.object.request('POST','/api/tasks',task());const id=created.body.id;assert.ok(id);
  await p.object.request('POST',`/api/tasks/${id}/run`,{});
  const second=await p.object.request('POST',`/api/tasks/${id}/run`,{});assert.equal(second.body.duplicate,true);
  assert.equal((await p.object.request('PUT',`/api/tasks/${id}`,task())).status,409);
  await p.object.request('PATCH',`/api/tasks/${id}`,{enabled:false});assert.equal(await p.object.store.job(id),null);
  await p.object.request('DELETE',`/api/tasks/${id}`,{});assert.equal(await p.object.store.task(id),null);p.close();
});
test('执行链：名称碰撞不自删，同脚本不同任务补跑独立，多轮收窄并保留失败日志',async()=>{
  const p=await platform();const s=p.object.store;
  const a=await s.create({...task({name:'GLaDOS 签到（补跑）'}),params:{step:0},next_run_at:now()+86400});
  const b=await s.create({...task({name:'另一个账号'}),params:{step:10},next_run_at:now()+86400});
  await s.enqueue(await s.task(a),'manual',now());await s.enqueue(await s.task(b),'manual',now());
  const engine=new Engine(s,p.env,{builtins:{'dnshe-renew':{run:async ctx=>{ctx.log('业务完成');return ctx.params.step===0?{defer:{step:1},failed:true}:{title:'done',content:'ok'};}}}});
  await engine.tick();assert.equal(JSON.parse((await s.job(a)).params).step,1);assert.equal((await s.task(a)).last_status,'failed');
  await engine.tick();assert.equal(await s.job(b),null);
  assert.ok(await s.task(a));await s.query('UPDATE jobs SET due=? WHERE task_id=?',now(),a).run();
  await engine.tick();assert.equal(await s.job(a),null);assert.ok(await s.task(a));
  assert.ok((await s.logs(a)).some(l=>l.text==='业务完成'));p.close();
});
test('事务：落库失败整批回滚，日志与状态不半成功',async()=>{
  const p=await platform(),s=p.object.store;
  const id=await s.create({...task(),next_run_at:now()+86400});await s.enqueue(await s.task(id),'manual',now());await s.start(id);
  await assert.rejects(()=>s.finish(id,'ok',[{ts:now(),level:null,text:'bad'}],null));
  assert.equal((await s.task(id)).last_status,'running');assert.equal((await s.job(id)).state,'running');assert.equal((await s.logs(id)).length,0);p.close();
});
test('崩溃恢复：未知结果留痕、不自动重发有副作用请求',async()=>{
  const p=await platform(),s=p.object.store;const id=await s.create({...task(),next_run_at:now()+86400});await s.enqueue(await s.task(id),'manual',now());await s.start(id);await s.recover();
  assert.equal((await s.task(id)).last_status,'failed');assert.equal(await s.job(id),null);assert.match((await s.logs(id))[0].text,/中断/);p.close();
});
test('定时队列：每 tick 只执行一个，到期锚点推进、不反复请求',async()=>{
  const p=await platform(),s=p.object.store;const id=await s.create({...task(),next_run_at:now()-100});
  let count=0;const engine=new Engine(s,p.env,{builtins:{'dnshe-renew':{run:async()=>{count++;return {};}}}});
  await engine.tick();await engine.tick();assert.equal(count,1);assert.ok((await s.task(id)).next_run_at>now());p.close();
});
test('资源：重定向拒绝、预算截断、结束后请求被取消、通知状态检查',async()=>{
  let count=0;const rt=runtime({fetcher:async(url,init)=>{count++;assert.equal(init.redirect,'manual');return count===1?new Response(null,{status:302,headers:{location:'https://elsewhere.test'}}):json({});},budget:3});
  await assert.rejects(()=>rt.fetch('https://local.test'),/重定向/);
  await rt.fetch('https://local.test');await rt.fetch('https://local.test');
  await assert.rejects(()=>rt.fetch('https://local.test'),/预算/);rt.close();
  await assert.rejects(()=>rt.fetch('https://local.test'));assert.equal(count,3);
  await assert.rejects(()=>notify('x','test','body',async()=>json({},500)),/500/);
});
test('DNSHE：窗口精确、字符串 false、成功/未到窗口、保留错误',async()=>{
  assert.equal(truth('0'),false);assert.equal(truth('false'),false);assert.equal(expiry('2026-11-13 09:00:00'),Date.UTC(2026,10,13,1)/1000);
  const ctx=context({api_key:'k',api_secret:'s',min_interval:0},async(url,init)=>{
    if(url.includes('action=list'))return json({pagination:{total:3,has_more:'false'},subdomains:[{id:1,full_domain:'a',never_expires:'0',expires_at:'2020-01-01'},{id:2,full_domain:'b',never_expires:'1'},{id:3,full_domain:'c',expires_at:'2099-01-01'}]});
    assert.equal(JSON.parse(init.body).subdomain_id,1);return json({success:true,new_expires_at:'2027-01-01',charged_amount:0});
  });const result=await dnshe(ctx);assert.equal(ctx.calls,2);assert.match(result.content,/成功 1.*跳过 2/);
});
test('DNSHE：分页不完整拒绝续期，错误时无隐式重试',async()=>{
  const ctx=context({api_key:'k',api_secret:'s'},async()=>json({pagination:{total:3,has_more:false},subdomains:[{id:1}]}));await assert.rejects(()=>dnshe(ctx),/不完整/);assert.equal(ctx.calls,1);
});
test('持久化顺序：通知发送前结果已提交，通知失败不回滚业务',async()=>{
  const p=await platform(),s=p.object.store;
  try {
    const id=await s.create({...task(),next_run_at:now()+86400});await s.setKey('simulation');await s.enqueue(await s.task(id),'manual',now());
    await new Engine(s,p.env,{builtins:{'dnshe-renew':{run:async()=>({title:'done'})}},fetcher:async()=>{
      assert.equal((await s.task(id)).last_status,'ok');assert.equal(await s.job(id),null);return json({},500);
    }}).tick();
    assert.equal((await s.task(id)).last_status,'ok');assert.ok((await s.logs(id)).some(l=>/通知失败/.test(l.text)));
  } finally {p.close();}
});
test('执行边界：损坏参数也落失败日志并释放作业',async()=>{
  const p=await platform(),s=p.object.store;
  try {
    const id=await s.create({...task(),next_run_at:now()+86400});
    await s.enqueue(await s.task(id),'manual',now());
    await s.query('UPDATE jobs SET params=? WHERE task_id=?','{broken',id).run();
    await new Engine(s,p.env).tick();
    assert.equal((await s.task(id)).last_status,'failed');
    assert.equal(await s.job(id),null);
    assert.ok((await s.logs(id)).some(l=>l.level==='error'));
  } finally {p.close();}
});
test('平台并发：长任务期间状态可读，写操作等待执行结束',async()=>{
  const p=await platform();let release;
  const gate=new Promise(resolve=>{release=resolve;});
  try {
    const running=p.object.serial(()=>gate);
    const state=await p.object.request('GET','/api/state');
    assert.equal(state.status,200);
    let written=false;
    const write=p.object.request('PUT','/api/settings',{notify_key:'test'}).then(()=>{written=true;});
    await Promise.resolve();assert.equal(written,false);
    release();await running;await write;assert.equal(written,true);
  } finally {release();p.close();}
});
test('闹钟：空面板不唤醒，健康检查不会推迟已安排时间',async()=>{
  const p=await platform();
  try {
    await p.object.ensureAlarm();assert.equal(p.alarm,null);
    await p.object.store.create({...task(),next_run_at:now()+600});
    await p.object.ensureAlarm();const first=p.alarm;
    await p.object.ensureAlarm();assert.equal(p.alarm,first);
    await p.ctx.storage.setAlarm(Date.now()-10000);
    await p.object.ensureAlarm();assert.ok(p.alarm!==null&&p.alarm>Date.now());
  } finally {p.close();}
});

test('DNSHE：多轮补跑使用快照，不重复拉全量，失败不丢其他剩余项',async()=>{
  const domains=Array.from({length:9},(_,i)=>({id:i+1,full_domain:`d${i+1}`,expires_at:'2020-01-01'}));
  const ctx=context({api_key:'k',api_secret:'s',min_interval:0},async(url,init)=>url.includes('action=list')?json({pagination:{total:9,has_more:false},subdomains:domains}):json({success:true,new_expires_at:'2027-01-01'}),6);
  const first=await dnshe(ctx);assert.equal(first.defer._remaining.length,4);
  const ids=[];const second=context(first.defer,async(url,init)=>{assert.ok(!url.includes('action=list'));ids.push(JSON.parse(init.body).subdomain_id);return json({success:true});});await dnshe(second);assert.deepEqual(ids,[6,7,8,9]);
});
test('日志裁剪：finish 后每任务最多保留 200 行且最新的在前',async()=>{
  const p=await platform(),s=p.object.store;
  const id=await s.create({...task(),next_run_at:now()+86400});
  await s.enqueue(await s.task(id),'manual',now());
  await s.finish(id,'ok',Array.from({length:250},(_,i)=>({ts:now(),level:'info',text:'line'+i})),null);
  const logs=await s.logs(id);
  assert.equal(logs.length,200);
  assert.equal(logs[0].text,'line249');
  assert.equal(logs.at(-1).text,'line50');
  p.close();
});
test('AgentRouter：账号解析（密码含逗号/空行/CRLF/无效行）',()=>{
  assert.deepEqual(parseAccounts('a@qq.com,p1\n\n b@qq.com,p,2 '),[{email:'a@qq.com',password:'p1'},{email:'b@qq.com',password:'p,2'}]);
  assert.deepEqual(parseAccounts('a@qq.com,p1\r\nb@qq.com,p2\r\n'),[{email:'a@qq.com',password:'p1'},{email:'b@qq.com',password:'p2'}]);
  assert.throws(()=>parseAccounts('a@qq.com'),/格式无效/);
  assert.throws(()=>parseAccounts('\n'),/无有效账号/);
});
test('AgentRouter：登录签到、密码错隔离、镜像头与 session 传递',async()=>{
  let calls=[];
  const ctx=context({accounts:'a@qq.com,p1\nb@qq.com,bad\nc@qq.com,p3'},async(url,init)=>{
    calls.push(url);
    // 浏览器镜像：全部请求带 UA/sec-fetch 形状，POST 带 Origin，GET 不带。
    assert.match(init.headers['user-agent'],/Chrome\/154/);
    assert.equal(init.headers['sec-fetch-site'],'same-origin');
    if (url.includes('/api/user/login')) {
      assert.equal(init.headers.origin,'https://ps.air-outer.com');
      assert.match(init.headers.referer,/\/login$/);
      const body=JSON.parse(init.body);
      if (body.password==='bad') return json({success:false,message:'密码错误'});
      return new Response(JSON.stringify({success:true,data:{id:body.username==='a@qq.com'?7:8,quota:0}}),{status:200,headers:{'content-type':'application/json','set-cookie':'session=s'+body.username.charCodeAt(0)+'; Path=/; HttpOnly'}});
    }
    if (url.includes('/api/user/self')) {
      // 双因素：session cookie 缺失或 New-Api-User 缺失都必须在这里炸出来。
      assert.ok(init.headers.cookie&&/^session=s\d+/.test(init.headers.cookie),'self 请求缺 session cookie');
      assert.ok(init.headers['New-Api-User'],'self 请求缺 New-Api-User 头');
      assert.equal(init.headers.referer,'https://ps.air-outer.com/console/log');
      assert.equal(init.headers.origin,undefined);
      return json({success:true,data:{id:Number(init.headers['New-Api-User']),quota:500000}});
    }
    return json({});
  });
  const result=await agentrouter(ctx);
  assert.equal(result.failed,true);
  assert.match(result.content,/成功 2，失败 1/);
  assert.ok(result.content.includes('a@qq.com：登录签到成功，quota 500000'));
  assert.ok(result.content.includes('c@qq.com：登录签到成功，quota 500000'));
  assert.ok(result.content.includes('b@qq.com：密码错误'));
  assert.equal(calls.filter(u=>u.includes('login')).length,3);
  assert.equal(calls.filter(u=>u.includes('self')).length,2);
});
test('AgentRouter：预算截断走补跑快照，补跑不重跑已成功账号',async()=>{
  const accounts=Array.from({length:4},(_,i)=>`u${i+1}@qq.com,p${i+1}`).join('\n');
  const ctx=context({accounts},async(url,init)=>{
    assert.ok(JSON.parse(init.body).password);
    return new Response(JSON.stringify({success:true,data:{id:1,quota:0}}),{status:200,headers:{'content-type':'application/json','set-cookie':'session=s1; Path=/'}});
  },5);
  const first=await agentrouter(ctx);
  assert.equal(first.defer._remaining.length,2);
  const ids=first.defer._remaining.map(a=>a.email);
  assert.deepEqual(ids,['u3@qq.com','u4@qq.com']);
  const second=context(first.defer,async()=>json({success:true,data:{id:1,quota:0}}));
  const final=await agentrouter(second);
  assert.equal(final.failed,false);
  assert.ok(final.content.includes('成功 2，失败 0'));
  assert.ok(!final.content.includes('u1@qq.com'));
});
test('AgentRouter：全账号超预算时防循环抛错而非空 defer',async()=>{
  const ctx=context({accounts:'a@qq.com,p1\nb@qq.com,p2'},async()=>json({success:true,data:{id:1,quota:0}}),1);
  await assert.rejects(()=>agentrouter(ctx),/未处理任何账号/);
});
test('调度语义：PUT 不改频率保留锚点，改频率按规则重算',async()=>{
  const p=await platform();const s=p.object.store;
  const id=(await p.object.request('POST','/api/tasks',task())).body.id;
  const before=(await s.task(id)).next_run_at;
  await p.object.request('PUT',`/api/tasks/${id}`,task({name:'仅改名'}));
  assert.equal((await s.task(id)).name,'仅改名');
  assert.equal((await s.task(id)).next_run_at,before);
  await p.object.request('PUT',`/api/tasks/${id}`,task({run_hour:10}));
  assert.equal((await s.task(id)).next_run_at-before,3600);
  p.close();
});
