import test from 'node:test';
import assert from 'node:assert/strict';
import { platform, database } from './kernel.mjs';
import { Store } from '../src/store.js';
import { initialNext, nextRun, normalize, offset, now } from '../src/schedule.js';
import { Engine, BUILTINS } from '../src/engine.js';
import { runtime, notify } from '../src/runtime.js';
import { parseCookies, run as glados } from '../src/tasks/glados.js';
import { run as dnshe, expiry, truth } from '../src/tasks/dnshe.js';
import { valid, issue, cookie, passwordMatches } from '../src/auth.js';

const task = (extra={}) => ({name:'任务',script_key:'glados-checkin',params:{cookie:'gld:sess=a; gld:sess.sig=b'},enabled:1,interval_unit:'d',interval_amount:1,run_hour:9,run_minute:3,run_day:null,...extra});
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
  assert.ok(nextRun(monthly,bj(13),28800)>bj(13));
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
    const id=await s.create({...task({name:'GLaDOS 签到（补跑）',interval_unit:'h',interval_amount:1,run_hour:null,run_minute:null,run_day:null}),next_run_at:now()});
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
  const engine=new Engine(s,p.env,{builtins:{'glados-checkin':{run:async ctx=>{ctx.log('业务完成');return ctx.params.step===0?{defer:{step:1},failed:true}:{title:'done',content:'ok'};}}}});
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
  let count=0;const engine=new Engine(s,p.env,{builtins:{'glados-checkin':{run:async()=>{count++;return {};}}}});
  await engine.tick();await engine.tick();assert.equal(count,1);assert.ok((await s.task(id)).next_run_at>now());p.close();
});
test('资源：全局预算截断、结束后请求被取消、通知状态检查',async()=>{
  let count=0;const rt=runtime({fetcher:async()=>{count++;return json({});},budget:2});
  await rt.fetch('https://local.test');await rt.fetch('https://local.test');await assert.rejects(()=>rt.fetch('https://local.test'),/预算/);rt.close();await assert.rejects(()=>rt.fetch('https://local.test'));assert.equal(count,2);
  await assert.rejects(()=>notify('x','test','body',async()=>json({},500)),/500/);
});
const sha256hex = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2,'0')).join('');
const challenge = body => json({code:0,nonce:'n0nce123',ttl:300000,...(body??{turnstile:'sitekey'})});
test('GLaDOS：JSON Cookie、镜像浏览器协议（挑战+SHA-256 证明+指纹头）、自动兑换',async()=>{
  const cookies=parseCookies('[\n{"name":"gld:sess","value":"a"},\n{"name":"gld:sess.sig","value":"b"}\n]');assert.equal(cookies.length,1);
  const posts=[];let points=520;
  const ctx=context({cookie:cookies[0]},async(url,init)=>{
    assert.equal(init.headers['user-agent'].includes('Edg/154'),true);
    if(url.endsWith('/checkin/challenge'))return challenge();
    if(url.endsWith('/checkin')){
      const body=JSON.parse(init.body);posts.push(body);
      if(posts.length===1){
        assert.equal(body.token,'glados.cloud');assert.equal(body.nonce,'n0nce123');assert.equal(body.tsState,'timeout');
        assert.equal(body.proof,await sha256hex('n0nce123.glados-observe-v1'));
        return json({code:0,points:2,message:'Checkin! Got 2 Points',streak:4,breakdown:[{label:'base',value:1}]});
      }
      return json({code:0});
    }
    if(url.endsWith('/status'))return json({code:0,data:{leftDays:30}});
    if(url.endsWith('/points'))return json({points,history:[{change:2}]});
    points=20;return json({code:0});
  });
  const result=await glados(ctx);assert.equal(result.failed,false);assert.match(result.content,/积分 20/);
  assert.ok(ctx.logs.some(l=>l.message.includes('Got 2 Points')));assert.ok(ctx.logs.some(l=>l.message.includes('积分构成')));assert.ok(ctx.logs.some(l=>l.message.includes('连续签到 4 天')));
  assert.equal(posts.length,1);
});
test('GLaDOS：人机验证拒绝 → 回退标准签到',async()=>{
  let checkins=0;
  const ctx=context({cookie:'gld:sess=a; gld:sess.sig=b'},async(url,init)=>{
    if(url.endsWith('/checkin/challenge'))return challenge();
    if(url.endsWith('/checkin')){checkins++;return checkins===1?json({code:7,reason:'turnstile',message:'verify human'}):json({code:0,points:1,message:'Checkin! Got 1 Points'});}
    if(url.endsWith('/status'))return json({code:0,data:{leftDays:30}});
    return json({points:10,history:[{change:1}]});
  });
  const result=await glados(ctx);assert.equal(result.failed,false);assert.equal(checkins,2);
  assert.ok(ctx.logs.some(l=>l.message.includes('回退标准签到')));
});
test('GLaDOS：挑战接口故障 → 浏览器同款降级（直接签到）',async()=>{
  let checkins=0;
  const ctx=context({cookie:'gld:sess=a; gld:sess.sig=b'},async(url,init)=>{
    if(url.endsWith('/checkin/challenge'))return json({},503);
    if(url.endsWith('/checkin')){checkins++;assert.equal(JSON.parse(init.body).nonce,undefined);return json({code:0,points:1,message:'ok'});}
    if(url.endsWith('/status'))return json({code:0,data:{leftDays:30}});
    return json({points:10,history:[{change:1}]});
  });
  const result=await glados(ctx);assert.equal(result.failed,false);assert.equal(checkins,1);
});
test('GLaDOS：风控/设备不匹配立即停止并标失败，不跨域重试',async()=>{
  const ctx=context({cookie:'gld:sess=x; gld:sess.sig=y'},async url=>{
    if(url.endsWith('/checkin/challenge'))return challenge({turnstile:null});
    return json({code:4,reason:'device-mismatch',message:'Device mismatch'});
  });
  const result=await glados(ctx);assert.equal(result.failed,true);assert.equal(ctx.calls,2);
});
test('GLaDOS：预算后剩余集只含未处理账号',async()=>{
  const ctx=context({cookie:'gld:sess=a; gld:sess.sig=b\ngld:sess=c; gld:sess.sig=d'},async url=>{
    if(url.endsWith('/checkin/challenge'))return challenge({turnstile:null});
    if(url.endsWith('/checkin'))return json({code:0,points:1,message:'ok'});
    if(url.endsWith('/status'))return json({code:0,data:{leftDays:20}});
    return json({points:10});
  },10);
  const result=await glados(ctx);assert.equal(result.defer.cookie,'gld:sess=c; gld:sess.sig=d');assert.equal(ctx.calls,4);
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
test('GLaDOS：坏 Cookie 不阻断后续账号，null 状态码不算成功',async()=>{
  const ctx=context({cookie:'invalid\ngld:sess=a; gld:sess.sig=b'},async url=>{
    if(url.endsWith('/checkin/challenge'))return challenge({turnstile:null});
    return json({code:null,message:'unknown'});
  });
  const result=await glados(ctx);assert.equal(result.failed,true);assert.equal(ctx.calls,2);assert.match(result.content,/账号 1.*缺少会话/);assert.match(result.content,/账号 2.*unknown/);
});
test('持久化顺序：通知发送前结果已提交，通知失败不回滚业务',async()=>{
  const p=await platform(),s=p.object.store;
  try {
    const id=await s.create({...task(),next_run_at:now()+86400});await s.setKey('simulation');await s.enqueue(await s.task(id),'manual',now());
    await new Engine(s,p.env,{builtins:{'glados-checkin':{run:async()=>({title:'done'})}},fetcher:async()=>{
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
  } finally {p.close();}
});

test('DNSHE：多轮补跑使用快照，不重复拉全量，失败不丢其他剩余项',async()=>{
  const domains=Array.from({length:9},(_,i)=>({id:i+1,full_domain:`d${i+1}`,expires_at:'2020-01-01'}));
  const ctx=context({api_key:'k',api_secret:'s',min_interval:0},async(url,init)=>url.includes('action=list')?json({pagination:{total:9,has_more:false},subdomains:domains}):json({success:true,new_expires_at:'2027-01-01'}),6);
  const first=await dnshe(ctx);assert.equal(first.defer._remaining.length,4);
  const ids=[];const second=context(first.defer,async(url,init)=>{assert.ok(!url.includes('action=list'));ids.push(JSON.parse(init.body).subdomain_id);return json({success:true});});await dnshe(second);assert.deepEqual(ids,[6,7,8,9]);
});
