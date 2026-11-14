import { DurableObject } from 'cloudflare:workers';
import { Store } from './store.js';
import { Engine, BUILTINS } from './engine.js';
import { HttpError, initialNext, nextRun, scheduleChanged, normalize, now, offset } from './schedule.js';

export class TaskScheduler extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env; this.store = new Store(env.DB); this.tail = Promise.resolve();
    ctx.blockConcurrencyWhile(async () => { await this.store.init(env); await this.store.recover(); });
  }
  serial(fn) {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  async ensureAlarm() {
    const earliest = await this.store.earliest();
    const target = earliest == null ? null : Math.max(Date.now() + 1000, earliest * 1000 + 1000);
    const current = await this.ctx.storage.getAlarm();
    if (target === null) { if (current !== null) await this.ctx.storage.deleteAlarm(); }
    else if (current === null || current > target || current < Date.now()) await this.ctx.storage.setAlarm(target);
    return { nextAlarm: target === null ? null : await this.ctx.storage.getAlarm() };
  }
  async alarm() {
    return this.serial(async () => {
      try { await new Engine(this.store, this.env).tick(); }
      catch (error) { await this.store.recover(); throw error; }
      finally { await this.ensureAlarm(); }
    });
  }
  async request(method, path, body) {
    const handle = async () => {
      try { return { status: 200, body: await this.route(method, path, body) }; }
      catch (error) {
        if (!(error instanceof HttpError)) console.error(error);
        return { status: error.status || 500, body: { error: error.status ? error.message : '服务暂时不可用，请重试' } };
      }
    };
    return method === 'GET' ? handle() : this.serial(handle);
  }
  async route(method, path, body) {
    const store = this.store;
    if (path === '/api/state' && method === 'GET') return { tasks: await store.list(), builtins: Object.entries(BUILTINS).map(([key, b]) => ({ key, name: b.name, params: b.params })), timezone: Number(this.env.TZ_OFFSET ?? 8) };
    if (path === '/api/settings' && method === 'GET') return { notify_key: await store.key() };
    if (path === '/api/settings' && method === 'PUT') {
      if (typeof body?.notify_key !== 'string' || body.notify_key.length > 100) throw new HttpError('通知密钥无效');
      await store.setKey(body.notify_key.trim()); return { ok: true };
    }
    const match = /^\/api\/tasks(?:\/([1-9]\d*)(?:\/(run|logs))?)?$/.exec(path);
    if (!match) throw new HttpError('接口不存在', 404);
    const id = Number(match[1]); const action = match[2];
    if (!match[1] && method === 'GET') return { tasks: await store.list() };
    if (!match[1] && method === 'POST') {
      const t = normalize(body, BUILTINS); t.next_run_at = initialNext(t, now(), offset(this.env));
      const newId = await store.create(t); await this.ensureAlarm(); return { id: newId };
    }
    if (!match[1]) throw new HttpError('不支持的方法', 405);
    const task = await store.task(id);
    if (!task) throw new HttpError('任务不存在', 404);
    if (action === 'logs' && method === 'GET') return { logs: await store.logs(id) };
    if (action === 'run' && method === 'POST') {
      if (!task.enabled) throw new HttpError('请先启用任务');
      const queued = await store.job(id);
      if (!queued) {
        const next = task.next_run_at <= now() ? nextRun(task, now(), offset(this.env)) : null;
        await store.enqueue(task, 'manual', now(), next);
      }
      await this.ensureAlarm(); return { queued: true, duplicate: Boolean(queued) };
    }
    if (action) throw new HttpError('不支持的方法', 405);
    if (method === 'PUT') {
      const t = normalize(body, BUILTINS);
      if (await store.job(id)) throw new HttpError('任务已排队，请完成后再编辑', 409);
      t.next_run_at = scheduleChanged(task, t) ? initialNext(t, now(), offset(this.env)) : task.next_run_at;
      await store.update(id, t);
    } else if (method === 'PATCH') {
      if (![true,false,0,1].includes(body?.enabled)) throw new HttpError('启用状态无效');
      await store.toggle(id, Number(Boolean(body.enabled)));
    } else if (method === 'DELETE') await store.remove(id);
    else throw new HttpError('不支持的方法', 405);
    await this.ensureAlarm(); return { ok: true };
  }
}
