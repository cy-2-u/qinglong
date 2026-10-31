// 单飞协调器（移植自 UptimeFlare worker/src/coordinator.ts）：
// run()   同一时刻只允许一个心跳在跑，后来的调用共享同一个进行中的 Promise；
// mutate() 配置类操作串行排队，不并发。
// DO 同名 id 是单实例，因此进程内锁即全局锁。
export class RunCoordinator {
  constructor() {
    this.pending = null;
    this.tail = Promise.resolve();
  }

  run(task) {
    if (this.pending) return this.pending;
    const p = this.tail.then(task);
    this.pending = p;
    p.finally(() => { if (this.pending === p) this.pending = null; }).catch(() => undefined);
    this.tail = p.catch(() => undefined);
    return p;
  }

  mutate(task) {
    const next = this.tail.then(task);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }
}
