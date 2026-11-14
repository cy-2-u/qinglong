import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { platform } from './kernel.mjs';

const p=await platform();
const worker=(await import('../src/index.js')).default;
// 本地演练只返回假接口，永不发送真实签到、续期或通知。
globalThis.fetch=async(url,init)=>{
  const u=new URL(url);
  const body=u.pathname.endsWith('/checkin/challenge')?{code:0,nonce:'sim-nonce',ttl:300000,turnstile:null}:u.pathname.endsWith('/checkin')?{code:0,points:2,message:'模拟签到成功',streak:2,breakdown:[{label:'base',value:2}]}:u.pathname.endsWith('/status')?{code:0,data:{leftDays:100}}:u.pathname.endsWith('/points')?{points:30,history:[{change:1}]}:u.searchParams.get('action')==='list'?{subdomains:[],pagination:{total:0,has_more:false}}:{code:0,success:true};
  return Response.json(body);
};
let firing=false;
const alarmTimer=setInterval(async()=>{
  if(firing||p.alarm===null||p.alarm>Date.now())return;
  firing=true;try{await p.fire();}catch(error){console.error(error);}finally{firing=false;}
},100);
const root=new URL('../public/',import.meta.url);
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1:8791');
    if(url.pathname==='/health'||url.pathname.startsWith('/api/')){
      const chunks=[];for await(const c of req)chunks.push(c);
      const request=new Request(url,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
      const response=await worker.fetch(request,p.env);
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }else{
      const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/favicon.svg':'favicon.svg'};
      const file=files[url.pathname];if(!file){res.writeHead(404);res.end();return;}
      res.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.svg')?'image/svg+xml':'text/html; charset=utf-8'});res.end(await readFile(new URL(file,root)));
    }
  }catch(error){console.error(error);res.writeHead(500);res.end('simulation error');}
});
server.listen(8791,'127.0.0.1',()=>console.log('Simulation: http://127.0.0.1:8791 · password: local-test-password · no real outbound requests'));
function close(){clearInterval(alarmTimer);server.close(()=>{p.close();process.exit();});}
process.on('SIGINT',close);process.on('SIGTERM',close);
