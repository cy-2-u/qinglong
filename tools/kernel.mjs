import { DatabaseSync } from 'node:sqlite';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url:'cloudflare:workers', shortCircuit:true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'cloudflare:workers') return { format:'module', source:'export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }', shortCircuit:true };
    return next(url, context);
  },
});
export function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  let reads=0, writes=0;
  function prepare(text) {
    let values=[];
    return {
      bind(...args){values=args;return this;},
      async first(){reads++;return sql.prepare(text).get(...values) || null;},
      async all(){reads++;return {results:sql.prepare(text).all(...values)};},
      async run(){writes++;const r=sql.prepare(text).run(...values);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};},
    };
  }
  return { sql, prepare,
    async batch(statements){sql.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}},
    get counts(){return {reads,writes};}, close(){sql.close();},
  };
}
export async function platform() {
  const { TaskScheduler } = await import('../src/scheduler.js');
  const db=database();let alarm=null, boot;
  const ctx={ storage:{async getAlarm(){return alarm;},async setAlarm(at){alarm=Number(at);},async deleteAlarm(){alarm=null;}}, blockConcurrencyWhile(fn){boot=fn();} };
  const env={DB:db,PANEL_PASSWORD:'local-test-password',TZ_OFFSET:'8'};
  const object=new TaskScheduler(ctx,env);await boot;
  env.SCHEDULER={idFromName:name=>name,get:()=>object};
  return {env,db,object,ctx,get alarm(){return alarm;},async fire(){alarm=null;return object.alarm();},close(){db.close();}};
}
