export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'upstream_error', public body?: unknown) { super(message); }
}
export type FetchLike = typeof fetch;

/** Simple serial rate limiter: at most one request per `intervalMs`. */
export class RateLimiter {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();
  constructor(private intervalMs: number) {}
  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.last + this.intervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
    });
    this.chain = run.catch(() => {});
    return run.then(fn);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
