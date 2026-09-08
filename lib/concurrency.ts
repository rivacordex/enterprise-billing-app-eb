// bm18-spec §Phase-2 review folds T9 — a small process-level concurrency
// guard for the draft-invoice renderer (D19 defers real pooling; this only
// bounds how many Chromium instances can run at once so a handful of active
// reviewers can't OOM the app container). Requests beyond `limit` queue
// (FIFO) rather than being rejected: the caller's `run()` promise simply
// resolves later, so a queued HTTP request just takes longer, per the
// verification requirement "excess requests queue rather than launch".
export interface Semaphore {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createSemaphore(limit: number): Semaphore {
  let active = 0;
  const queue: (() => void)[] = [];

  function admitNext(): void {
    if (active >= limit) return;
    const admit = queue.shift();
    if (!admit) return;
    active++;
    admit();
  }

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await new Promise<void>((resolve) => {
        queue.push(resolve);
        admitNext();
      });
      try {
        return await fn();
      } finally {
        active--;
        admitNext();
      }
    },
  };
}
