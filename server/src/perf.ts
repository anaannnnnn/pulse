// Request-path performance helpers: slow-request log, event-loop monitor, response compression, read-model cache, static file cache.
import zlib from 'node:zlib';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from './db.js';

const gzipAsync = promisify(zlib.gzip) as (b: zlib.InputType, o?: zlib.ZlibOptions) => Promise<Buffer>;
const brotliAsync = promisify(zlib.brotliCompress) as (b: zlib.InputType, o?: zlib.BrotliOptions) => Promise<Buffer>;

export const SLOW_MS = Number(process.env.SLOW_REQUEST_MS || 500);

/** Route label without ids/query so the slow log groups well: /api/scenes/:id/thumb, /assets/*, ... */
export function routeLabel(req: FastifyRequest): string {
  const r = (req as any).routeOptions?.url as string | undefined;
  if (r && r !== '*') return r;
  const p = req.url.split('?')[0];
  if (p.startsWith('/assets/')) return '/assets/*';
  return /^\/api\//.test(p) ? p.replace(/\/\d+/g, '/:id') : 'static';
}

export type PerfState = { loop: ReturnType<typeof monitorEventLoopDelay>; slow: number; total: number; lastSlow: { route: string; ms: number; at: string } | null };

/** Slow-request log (>= SLOW_REQUEST_MS), event-loop lag monitor + warning, compression hook. */
export function registerPerf(app: FastifyInstance): PerfState {
  const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
  const st: PerfState = { loop, slow: 0, total: 0, lastSlow: null };
  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    st.total++;
    const ms = reply.elapsedTime;
    if (ms >= SLOW_MS) {
      const route = routeLabel(req);
      st.slow++; st.lastSlow = { route, ms: Math.round(ms), at: new Date().toISOString() };
      req.log.warn({ perf: 'slow', route, method: req.method, status: reply.statusCode, ms: Math.round(ms) }, `slow request ${req.method} ${route} ${Math.round(ms)}ms`);
    }
  });
  const t = setInterval(() => {
    const p99 = loop.percentile(99) / 1e6, max = loop.max / 1e6;
    if (max >= 250) app.log.warn({ perf: 'loop', p99Ms: Math.round(p99), maxMs: Math.round(max) }, `event loop was blocked up to ${Math.round(max)}ms in the last 10s`);
    loop.reset();
  }, 10_000);
  t.unref();
  app.addHook('onClose', async () => { clearInterval(t); loop.disable(); });

  // gzip / brotli for text responses (JSON, JS, CSS, HTML, SVG, manifest). Compression runs on the libuv thread pool; results for cached Buffers are memoised.
  const memo = new WeakMap<Buffer, { gzip?: Promise<Buffer>; br?: Promise<Buffer> }>();
  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload: any) => {
    if (req.method === 'HEAD' || reply.statusCode === 204 || reply.statusCode === 304 || reply.hasHeader('content-encoding')) return payload;
    if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return payload;
    const type = String(reply.getHeader('content-type') || '');
    if (!/json|text\/|javascript|svg|xml|manifest/i.test(type)) return payload;
    const len = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length;
    if (len < 1024) return payload;
    const ae = String(req.headers['accept-encoding'] || '');
    const useBr = /\bbr\b/.test(ae), useGz = /\bgzip\b/.test(ae);
    if (!useBr && !useGz) return payload;
    const buf = typeof payload === 'string' ? Buffer.from(payload) : payload;
    let out: Buffer;
    if (useBr && len >= 4096 && !/json/i.test(type)) {   // static assets: brotli (memoised); dynamic JSON: gzip (cheaper to produce)
      const m = memo.get(buf) || {}; memo.set(buf, m);
      out = await (m.br ||= brotliAsync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: len } }));
      reply.header('content-encoding', 'br');
    } else if (useGz) {
      const m = memo.get(buf) || {}; memo.set(buf, m);
      out = await (m.gzip ||= gzipAsync(buf, { level: 4 }));
      reply.header('content-encoding', 'gzip');
    } else return payload;
    reply.header('vary', 'Accept-Encoding').header('content-length', out.length);
    return out;
  });
  return st;
}

/**
 * Read-model cache for expensive list/aggregate endpoints. An entry is served while the database has not been written since it was built
 * (db.version unchanged) and it is younger than `ttl`; within `burst` ms it is served even after writes (matching writes constantly, and a page
 * load fires a dozen identical requests). Values are pre-serialised Buffers, so a hit costs no DB, no JSON.stringify and no re-compression.
 */
export class ReadCache {
  private m = new Map<string, { buf: Buffer; at: number; ver: number }>();
  hits = 0; misses = 0;
  /** `busy()` = background writers (matching, scanning) are running; only then are slightly stale answers served inside the burst window. */
  constructor(private db: DB, private busy: () => boolean = () => false, private max = 300, private burstMs = 2000) {}
  get(key: string, ttlMs: number, build: () => unknown): Buffer {
    const now = Date.now(); const e = this.m.get(key);
    if (e && ((e.ver === this.db.version && now - e.at < ttlMs) || (this.busy() && now - e.at < this.burstMs))) { this.hits++; return e.buf; }
    this.misses++;
    const buf = Buffer.from(JSON.stringify(build()));
    this.m.delete(key); this.m.set(key, { buf, at: now, ver: this.db.version });
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string);
    return buf;
  }
  clear() { this.m.clear(); }
}

type StaticEntry = { buf: Buffer; etag: string; mtimeMs: number; checked: number };
/** In-memory cache for the built web app (a few MB): no per-request existsSync/statSync/stream, ETag + 304, compressed once. */
export class StaticCache {
  private m = new Map<string, StaticEntry | null>();
  constructor(private revalidateMs = 15_000, private maxFile = 3 * 1048576) {}
  async load(file: string): Promise<StaticEntry | null | 'big'> {
    const now = Date.now(); const e = this.m.get(file);
    if (e !== undefined && (e === null ? now - 3000 : e.checked + this.revalidateMs) > now) return e;
    try {
      const st = await fs.promises.stat(file);
      if (!st.isFile()) { this.m.set(file, null); return null; }
      if (st.size > this.maxFile) return 'big';
      if (e && e.mtimeMs === st.mtimeMs && e.buf.length === st.size) { e.checked = now; return e; }
      const buf = await fs.promises.readFile(file);
      const n: StaticEntry = { buf, etag: `"${crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 20)}"`, mtimeMs: st.mtimeMs, checked: now };
      this.m.set(file, n);
      return n;
    } catch { this.m.set(file, null); if (this.m.size > 500) this.m.clear(); return null; }
  }
}

/** Small byte-budgeted LRU for thumbnails. */
export class ByteLru<V extends { buf: Buffer }> {
  private m = new Map<string, V>(); private bytes = 0;
  constructor(private budget = 48 * 1048576) {}
  get(k: string) { const v = this.m.get(k); if (v) { this.m.delete(k); this.m.set(k, v); } return v; }
  set(k: string, v: V) {
    const p = this.m.get(k); if (p) this.bytes -= p.buf.length;
    this.m.delete(k); this.m.set(k, v); this.bytes += v.buf.length;
    while (this.bytes > this.budget && this.m.size > 1) { const key = this.m.keys().next().value as string; this.bytes -= this.m.get(key)!.buf.length; this.m.delete(key); }
  }
  clear() { this.m.clear(); this.bytes = 0; }
}

/** Runs async tasks with at most `n` in flight (upstream thumbnail fetches must not stampede pCloud / the event loop). */
export function limit(n: number) {
  let active = 0; const q: Array<() => void> = [];
  const next = () => { if (active < n && q.length) { active++; q.shift()!(); } };
  return <T>(fn: () => Promise<T>) => new Promise<T>((res, rej) => { q.push(() => fn().then(res, rej).finally(() => { active--; next(); })); next(); });
}
