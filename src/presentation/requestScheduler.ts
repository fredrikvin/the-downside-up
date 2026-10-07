export type RequestPriority = "explicit" | "prefetch";

/**
 * Runs provider requests with a concurrency limit. Explicit requests start
 * before waiting prefetches, and prefetches never take the last free slot
 * (unless the limit is 1), so a request the user makes can start at once.
 */
export class RequestScheduler {
  private active = 0;
  private activePrefetches = 0;
  private readonly waiting: Record<RequestPriority, Array<() => void>> = { explicit: [], prefetch: [] };

  constructor(private readonly limit: () => number) {}

  get running(): number {
    return this.active;
  }

  /** Free slots that prefetching may use now. */
  get prefetchCapacity(): number {
    return Math.max(0, this.prefetchLimit() - this.activePrefetches - this.waiting.prefetch.length);
  }

  schedule<T>(priority: RequestPriority, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting[priority].push(() => {
        this.active++;
        if (priority === "prefetch") this.activePrefetches++;
        let result: Promise<T>;
        try {
          result = task();
        } catch (error) {
          result = Promise.reject(error);
        }
        void result.then(resolve, reject).finally(() => {
          this.active--;
          if (priority === "prefetch") this.activePrefetches--;
          this.pump();
        });
      });
      this.pump();
    });
  }

  /** Starts waiting work after the limit changes. */
  pump(): void {
    const limit = this.currentLimit();
    while (this.active < limit && this.waiting.explicit.length) this.waiting.explicit.shift()!();
    while (
      this.waiting.explicit.length === 0 &&
      this.waiting.prefetch.length &&
      this.active < limit &&
      this.activePrefetches < this.prefetchLimit()
    ) {
      this.waiting.prefetch.shift()!();
    }
  }

  private currentLimit(): number {
    const value = Math.floor(this.limit());
    return Number.isFinite(value) ? Math.min(8, Math.max(1, value)) : 1;
  }

  private prefetchLimit(): number {
    const limit = this.currentLimit();
    return limit === 1 ? 1 : limit - 1;
  }
}

/** Shares one in-progress run of `task` per key, such as one consent prompt per repository and model. */
export function singleFlight<T>(pending: Map<string, Promise<T>>, key: string, task: () => Promise<T>): Promise<T> {
  const existing = pending.get(key);
  if (existing) return existing;
  const run = task().finally(() => {
    if (pending.get(key) === run) pending.delete(key);
  });
  pending.set(key, run);
  return run;
}
