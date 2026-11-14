export class BudgetError extends Error {}
export function runtime({ fetcher = fetch, clock = Date.now, budget = 40, duration = 240000 } = {}) {
  const controller = new AbortController();
  const deadline = clock() + duration;
  let requests = 0;
  const timer = setTimeout(() => controller.abort(new Error('执行超时')), duration);
  const check = () => { controller.signal.throwIfAborted(); if (clock() >= deadline) throw new Error('执行超时'); };
  return {
    signal: controller.signal,
    get requests() { return requests; },
    canStart(reserve = 1) { check(); return requests + reserve <= budget && deadline - clock() > 35000; },
    async fetch(url, init = {}) {
      check();
      if (requests >= budget) throw new BudgetError('请求预算耗尽');
      requests++;
      return fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
    },
    async sleep(ms) {
      check();
      if (!ms) return;
      await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(t); reject(controller.signal.reason); };
        const t = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve(); }, ms);
        controller.signal.addEventListener('abort', abort, { once: true });
      });
    },
    close() { clearTimeout(timer); controller.abort(new Error('本轮已结束')); },
  };
}
export async function notify(key, title, content, fetcher = fetch) {
  if (!key) return false;
  const safe = String(title).replace(/[:：/]/g, '-').slice(0, 64);
  const url = `https://timelynotify.oicode.cn/${encodeURIComponent(key)}/${encodeURIComponent(safe)}/${encodeURIComponent(String(content).slice(0, 2000))}?group=qinglong`;
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  await response.body?.cancel();
  if (response.status !== 200) throw new Error(`通知失败 HTTP ${response.status}`);
  return true;
}
