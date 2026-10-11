// Adaptive token-bucket limiter for upstream APIs (ThePornDB etc.).
//  - starts at `startRps`, bursts up to `burst` tokens, never exceeds `maxRps` / `maxInflight`
//  - AIMD: +10% (min +0.5 rps) after every `rampEvery` healthy responses, x0.5 on 429 (plus a global pause for Retry-After), x0.8 on 5xx
//  - honours X-RateLimit-Limit / -Remaining / -Reset (and RateLimit-* / Retry-After): when the window is nearly exhausted it pauses until reset
//  - waiters are FIFO and cancellable with an AbortSignal (cancelled requests never hit the network)
// No fixed per-request delay: a request is released the moment a token and an in-flight slot are free.

export type LimiterOptions = {
  startRps?: number; minRps?: number; maxRps?: number; burst?: number; maxInflight?: number; rampEvery?: number;
  /** test hooks */
  now?: () => number;
};
export type Feedback = { status: number; headers?: { get(name: string): string | null } | null; latencyMs?: number };
export type LimiterStats = { rps: number; maxRps: number; inflight: number; waiting: number; throttled: number; pausedMs: number; served: number; remaining: number | null; limit: number | null };

export class AbortedError extends Error { constructor() { super('aborted'); this.name = 'AbortError'; } }
export const isAbort = (e: any) => e?.name === 'AbortError' || e instanceof AbortedError;

type Waiter = { resolve: () => void; reject: (e: unknown) => void; signal?: AbortSignal; onAbort?: () => void };

export class AdaptiveLimiter {
  rps: number; readonly minRps: number; readonly maxRps: number; readonly burst: number; readonly maxInflight: number; private rampEvery: number;
  private tokens: number; private last: number; private pausedUntil = 0;
  private inflight = 0; private healthy = 0; private waiters: Waiter[] = []; private timer: ReturnType<typeof setTimeout> | null = null;
  private now: () => number;
  throttled = 0; served = 0; private pausedTotal = 0;
  remaining: number | null = null; limit: number | null = null;

  constructor(o: LimiterOptions = {}) {
    this.now = o.now ?? Date.now;
    this.maxRps = Math.max(0.5, o.maxRps ?? 10);
    this.minRps = Math.min(this.maxRps, Math.max(0.2, o.minRps ?? 1));
    this.rps = Math.min(this.maxRps, Math.max(this.minRps, o.startRps ?? 6));
    this.burst = Math.max(1, o.burst ?? Math.ceil(this.maxRps));
    this.maxInflight = Math.max(1, o.maxInflight ?? 16);
    this.rampEvery = Math.max(1, o.rampEvery ?? 8);
    this.tokens = Math.min(this.burst, 3); this.last = this.now();
  }

  private refill() {
    const t = this.now();
    if (t > this.last) { this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rps); this.last = t; }
  }

  /** Resolves when a request may be sent. Always pair with `done()` (use `run()` to do it automatically). */
  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new AbortedError());
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = { resolve, reject, signal };
      if (signal) {
        w.onAbort = () => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); reject(new AbortedError()); } };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      this.waiters.push(w);
      this.pump();
    });
  }

  private pump() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.refill();
    const t = this.now();
    while (this.waiters.length) {
      if (t < this.pausedUntil || this.inflight >= this.maxInflight || this.tokens < 1) break;
      const w = this.waiters.shift()!;
      if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
      this.tokens -= 1; this.inflight++;
      w.resolve();
    }
    if (!this.waiters.length) return;
    let wait = 0;
    if (t < this.pausedUntil) wait = this.pausedUntil - t;
    else if (this.tokens < 1) wait = Math.ceil(((1 - this.tokens) / this.rps) * 1000);
    else return; // blocked on inflight: done() will pump again
    this.timer = setTimeout(() => { this.timer = null; this.pump(); }, Math.max(1, wait));
  }

  /** Report the outcome of a request started after `acquire()`. */
  done(fb?: Feedback) {
    this.inflight = Math.max(0, this.inflight - 1);
    if (fb) this.report(fb);
    this.pump();
  }

  private pause(ms: number) {
    const until = this.now() + Math.max(0, ms);
    if (until > this.pausedUntil) { this.pausedTotal += until - Math.max(this.now(), this.pausedUntil); this.pausedUntil = until; }
  }

  report(fb: Feedback) {
    const h = fb.headers;
    const num = (n: string) => { const v = h?.get(n); if (v == null || v === '') return null; const x = Number(v); return Number.isFinite(x) ? x : null; };
    const limit = num('x-ratelimit-limit') ?? num('ratelimit-limit');
    const remaining = num('x-ratelimit-remaining') ?? num('ratelimit-remaining');
    let reset = num('x-ratelimit-reset') ?? num('ratelimit-reset');   // seconds until reset, or an epoch timestamp
    if (reset != null && reset > 1e9) reset = Math.max(0, reset - this.now() / 1000);
    let retryAfter: number | null = null;
    const ra = h?.get('retry-after');
    if (ra) { const n = Number(ra); retryAfter = Number.isFinite(n) ? n * 1000 : Math.max(0, Date.parse(ra) - this.now()) || null; }
    if (limit != null) this.limit = limit;
    if (remaining != null) this.remaining = remaining;

    if (fb.status === 429) {
      this.throttled++; this.healthy = 0;
      this.rps = Math.max(this.minRps, this.rps * 0.5);
      this.tokens = 0;
      this.pause(retryAfter ?? Math.min(15000, 1000 * 2 ** Math.min(4, this.throttled)));
    } else if (fb.status >= 500) {
      this.healthy = 0; this.rps = Math.max(this.minRps, this.rps * 0.8);
      if (retryAfter) this.pause(retryAfter);
    } else {
      if (retryAfter) this.pause(retryAfter);
      this.served++;
      if (remaining != null && limit != null && limit > 0) {
        if (remaining <= Math.max(1, limit * 0.03)) { this.pause((reset ?? 1) * 1000); this.healthy = 0; }
        else if (reset != null && reset > 0) {
          const sustainable = (remaining / reset) * 0.9;
          if (sustainable < this.rps) this.rps = Math.max(this.minRps, sustainable);
        }
      }
      if (++this.healthy >= this.rampEvery) {
        this.healthy = 0;
        const cap = remaining != null && reset ? Math.max(this.minRps, (remaining / reset) * 0.9) : this.maxRps;
        this.rps = Math.min(this.maxRps, cap, this.rps + Math.max(0.5, this.rps * 0.1));
      }
    }
  }

  /** Convenience: acquire, run, report. `fn` returns the Response-like object whose status/headers drive adaptation. */
  async run<T extends { status: number; headers?: any }>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    const t0 = this.now();
    try { const r = await fn(); this.done({ status: r.status, headers: r.headers, latencyMs: this.now() - t0 }); return r; }
    catch (e) { this.done(); throw e; }
  }

  stats(): LimiterStats {
    return { rps: Math.round(this.rps * 100) / 100, maxRps: this.maxRps, inflight: this.inflight, waiting: this.waiters.length, throttled: this.throttled, pausedMs: Math.round(this.pausedTotal), served: this.served, remaining: this.remaining, limit: this.limit };
  }
}
