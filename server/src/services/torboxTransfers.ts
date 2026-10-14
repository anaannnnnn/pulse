import crypto from 'node:crypto';

export type TransferState = 'queued' | 'running' | 'done' | 'error' | 'canceled';

export interface Transfer {
  id: string;
  /** transfers created by one request share a batch id (e.g. "save these 40 videos") */
  batch: string;
  name: string;
  folderId: number;
  size: number;
  bytes: number;
  state: TransferState;
  error: string | null;
  /** pCloud file id once the upload finished */
  fileId: number | null;
  attempts: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export type TransferJob = {
  name: string;
  folderId: number;
  size: number;
  batch?: string;
  /** Does the work. Must stop when `signal` aborts and report bytes moved through `progress`. Returns the pCloud file id. */
  run: (ctx: { signal: AbortSignal; progress: (bytes: number) => void }) => Promise<number | null>;
};

type Slot = { t: Transfer; job: TransferJob; abort: AbortController };

/**
 * In-memory queue for TorBox → pCloud copies that run through this server (no files are written to disk).
 * A few run at a time, each can be cancelled, and a failed one is retried once before it is reported.
 */
export class TransferQueue {
  private slots = new Map<string, Slot>();
  private running = 0;
  constructor(private opts: { concurrency?: number; maxAttempts?: number; keepFinished?: number; retryDelayMs?: number; now?: () => number } = {}) {}
  private get concurrency() { return Math.max(1, this.opts.concurrency ?? 2); }
  private now() { return (this.opts.now ?? Date.now)(); }

  add(job: TransferJob): Transfer {
    const t: Transfer = {
      id: crypto.randomUUID(), batch: job.batch || crypto.randomUUID(), name: job.name, folderId: job.folderId, size: job.size, bytes: 0,
      state: 'queued', error: null, fileId: null, attempts: 0, createdAt: this.now(), startedAt: null, finishedAt: null,
    };
    this.slots.set(t.id, { t, job, abort: new AbortController() });
    this.prune();
    queueMicrotask(() => this.pump());
    return { ...t };
  }

  list(): Transfer[] { return [...this.slots.values()].map((s) => ({ ...s.t })).sort((a, b) => b.createdAt - a.createdAt); }
  get(id: string): Transfer | null { const s = this.slots.get(id); return s ? { ...s.t } : null; }
  get active() { return [...this.slots.values()].some((s) => s.t.state === 'queued' || s.t.state === 'running'); }

  cancel(id: string): boolean {
    const s = this.slots.get(id);
    if (!s || (s.t.state !== 'queued' && s.t.state !== 'running')) return false;
    s.abort.abort();
    if (s.t.state === 'queued') { s.t.state = 'canceled'; s.t.finishedAt = this.now(); }
    return true;
  }
  cancelBatch(batch: string): number { let n = 0; for (const s of this.slots.values()) if (s.t.batch === batch && this.cancel(s.t.id)) n++; return n; }

  clearFinished(): number {
    let n = 0;
    for (const [id, s] of this.slots) if (s.t.state === 'done' || s.t.state === 'error' || s.t.state === 'canceled') { this.slots.delete(id); n++; }
    return n;
  }

  private prune() {
    const keep = this.opts.keepFinished ?? 200;
    const finished = [...this.slots.values()].filter((s) => s.t.finishedAt != null).sort((a, b) => (a.t.finishedAt as number) - (b.t.finishedAt as number));
    for (const s of finished.slice(0, Math.max(0, finished.length - keep))) this.slots.delete(s.t.id);
  }

  private pump() {
    for (const s of this.slots.values()) {
      if (this.running >= this.concurrency) return;
      if (s.t.state !== 'queued') continue;
      this.running++;
      s.t.state = 'running';
      s.t.startedAt = s.t.startedAt ?? this.now();
      void this.exec(s).finally(() => { this.running--; this.pump(); });
    }
  }

  private async exec(s: Slot) {
    const max = Math.max(1, this.opts.maxAttempts ?? 2);
    for (;;) {
      s.t.attempts++;
      s.t.bytes = 0;
      try {
        const fileId = await s.job.run({ signal: s.abort.signal, progress: (b) => { s.t.bytes = b; } });
        s.t.fileId = fileId;
        s.t.bytes = s.t.size || s.t.bytes;
        s.t.state = 'done';
        break;
      } catch (e: any) {
        if (s.abort.signal.aborted) { s.t.state = 'canceled'; break; }
        if (s.t.attempts < max) { await new Promise((r) => setTimeout(r, this.opts.retryDelayMs ?? 1500)); if (s.abort.signal.aborted) { s.t.state = 'canceled'; break; } continue; }
        s.t.state = 'error';
        s.t.error = String(e?.message || e).slice(0, 300);
        break;
      }
    }
    s.t.finishedAt = this.now();
  }
}
