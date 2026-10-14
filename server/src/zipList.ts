import { Readable, Transform } from 'node:stream';
import zlib from 'node:zlib';
import type { FetchLike } from './http.js';

/**
 * Reads ZIP archives that live behind an HTTP URL (TorBox CDN links) with Range requests only.
 * Nothing is downloaded or extracted to disk: the central directory is read from the tail of the file,
 * and a single entry is streamed straight out of the archive when it is played, downloaded or copied.
 *
 * Supports ZIP64 (archives over 4 GB, more than 65 535 entries), store (0) and deflate (8).
 */

export type ZipEntry = {
  name: string;
  /** 0 = stored, 8 = deflate. Anything else cannot be streamed. */
  method: number;
  compSize: number;
  size: number;
  /** offset of the local file header */
  offset: number;
  encrypted: boolean;
  /** resolved lazily from the local header on first open */
  dataStart?: number;
};
export type ZipIndex = { length: number; entries: ZipEntry[]; byName: Map<string, ZipEntry> };

/** Same extensions the TorBox client treats as video. */
export const VIDEO_RE = /\.(mp4|mkv|mov|avi|m4v|webm|ts|wmv|flv|mpg|mpeg)$/i;

export class ZipError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

/** Archive junk that matches the video extensions but is not a video (macOS resource forks, samples). */
export const isJunkEntry = (name: string) => /(^|\/)__MACOSX\//.test(name) || /(^|\/)\._[^/]*$/.test(name);
export const isVideoEntry = (e: ZipEntry) => VIDEO_RE.test(e.name) && !isJunkEntry(e.name) && !/\bsample\b/i.test(e.name);
export const isStreamable = (e: ZipEntry) => !e.encrypted && (e.method === 0 || e.method === 8) && e.size > 0;

const MAX_CD_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 200_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Range GET with a couple of retries for transient CDN errors. Refuses servers that ignore Range (would pull the whole file). */
async function rangeFetch(url: string, f: FetchLike, start: number, end: number, signal?: AbortSignal): Promise<Response> {
  let last: ZipError | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(250 * attempt);
    let res: Response;
    try { res = await f(url, { headers: { Range: `bytes=${start}-${end}` }, signal }); }
    catch (e: any) { if (signal?.aborted) throw e; last = new ZipError(`archive request failed: ${e?.message || e}`); continue; }
    if (res.status === 206) return res;
    if (res.status === 200 && start === 0) return res; // whole body requested anyway
    void res.body?.cancel().catch(() => {});
    if (res.status === 200) throw new ZipError('The archive host ignored the Range header, so the zip cannot be read in place');
    last = new ZipError(`archive range ${res.status}`, res.status === 403 || res.status === 404 || res.status === 410 ? res.status : 502);
    if (res.status < 500 && res.status !== 429) break;
  }
  throw last || new ZipError('archive request failed');
}

async function rangeBuf(url: string, f: FetchLike, start: number, end: number, signal?: AbortSignal): Promise<Buffer> {
  const res = await rangeFetch(url, f, start, end, signal);
  return Buffer.from(await res.arrayBuffer());
}

async function remoteLength(url: string, f: FetchLike): Promise<number> {
  const head = await f(url, { method: 'HEAD' }).catch(() => null);
  let len = Number(head?.headers.get('content-length') || 0);
  if (len) return len;
  const probe = await f(url, { headers: { Range: 'bytes=0-0' } });
  void probe.body?.cancel().catch(() => {});
  len = Number((probe.headers.get('content-range') || '').split('/')[1]) || 0;
  if (!len && probe.status === 200) len = Number(probe.headers.get('content-length') || 0);
  return len;
}

const u64 = (b: Buffer, o: number) => Number(b.readBigUInt64LE(o));

/** Parses the central directory of a remote zip. Cheap: one HEAD, one tail read, and at most one more read for the directory. */
export async function readZipIndex(url: string, f: FetchLike): Promise<ZipIndex> {
  const len = await remoteLength(url, f);
  if (len < 22) throw new ZipError('Could not read the archive size', 502);
  const tailN = Math.min(len, 256 * 1024);
  const tailStart = len - tailN;
  const tail = await rangeBuf(url, f, tailStart, len - 1);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== 0x06054b50) continue;
    if (i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break; }
    if (eocd < 0) eocd = i;
  }
  if (eocd < 0) throw new ZipError('Not a zip archive (no end-of-central-directory record)', 422);

  let total = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOff = tail.readUInt32LE(eocd + 16);
  const diskNo = tail.readUInt16LE(eocd + 4);
  if (diskNo !== 0 && diskNo !== 0xffff) throw new ZipError('Split zip archives are not supported', 422);

  if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    // ZIP64: the locator sits right before the classic EOCD and points at the 64-bit record.
    const loc = eocd - 20;
    let rec: Buffer | null = null;
    if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
      const recOff = u64(tail, loc + 8);
      rec = recOff >= tailStart && recOff + 56 <= tailStart + tail.length
        ? tail.subarray(recOff - tailStart, recOff - tailStart + 56)
        : await rangeBuf(url, f, recOff, recOff + 55);
    }
    if (!rec || rec.length < 56 || rec.readUInt32LE(0) !== 0x06064b50) throw new ZipError('Corrupt ZIP64 end-of-central-directory record', 422);
    total = u64(rec, 32);
    cdSize = u64(rec, 40);
    cdOff = u64(rec, 48);
  }
  if (cdSize <= 0 || cdOff + cdSize > len) throw new ZipError('The zip central directory is out of range', 422);
  if (cdSize > MAX_CD_BYTES || total > MAX_ENTRIES) throw new ZipError('This archive has too many entries to index', 413);

  const cd = cdOff >= tailStart && cdOff + cdSize <= tailStart + tail.length
    ? tail.subarray(cdOff - tailStart, cdOff - tailStart + cdSize)
    : await rangeBuf(url, f, cdOff, cdOff + cdSize - 1);

  const entries: ZipEntry[] = [];
  const byName = new Map<string, ZipEntry>();
  let p = 0;
  while (p + 46 <= cd.length) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    let compSize = cd.readUInt32LE(p + 20);
    let size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let offset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (compSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) {
      // ZIP64 extra field: only the 32-bit fields that overflowed are present, in this fixed order.
      const ex = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      for (let q = 0; q + 4 <= ex.length;) {
        const id = ex.readUInt16LE(q);
        const sz = ex.readUInt16LE(q + 2);
        if (id === 0x0001) {
          let r = q + 4;
          if (size === 0xffffffff && r + 8 <= q + 4 + sz) { size = u64(ex, r); r += 8; }
          if (compSize === 0xffffffff && r + 8 <= q + 4 + sz) { compSize = u64(ex, r); r += 8; }
          if (offset === 0xffffffff && r + 8 <= q + 4 + sz) { offset = u64(ex, r); r += 8; }
          break;
        }
        q += 4 + sz;
      }
    }
    p += 46 + nameLen + extraLen + commentLen;
    if (!name || name.endsWith('/')) continue;
    const entry: ZipEntry = { name, method, compSize, size, offset, encrypted: (flags & 1) !== 0 };
    entries.push(entry);
    byName.set(name, entry);
  }
  return { length: len, entries, byName };
}

/** Index cache: one parsed central directory per archive, de-duplicated while loading. */
export class ZipIndexCache {
  private map = new Map<string, { at: number; value?: ZipIndex; pending?: Promise<ZipIndex> }>();
  constructor(private ttlMs = 6 * 3600_000, private max = 32) {}
  async get(key: string, load: () => Promise<ZipIndex>): Promise<ZipIndex> {
    const hit = this.map.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) {
      if (hit.value) { this.map.delete(key); this.map.set(key, hit); return hit.value; }
      if (hit.pending) return hit.pending;
    }
    const slot: { at: number; value?: ZipIndex; pending?: Promise<ZipIndex> } = { at: Date.now() };
    slot.pending = load().then((v) => { slot.value = v; slot.pending = undefined; return v; }, (e) => { if (this.map.get(key) === slot) this.map.delete(key); throw e; });
    this.map.set(key, slot);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
    return slot.pending;
  }
  invalidate(key: string) { this.map.delete(key); }
}

/** Back-compat helper: the playable videos of a remote zip. */
export async function listZipVideos(url: string, f: FetchLike): Promise<ZipEntry[]> {
  const idx = await readZipIndex(url, f);
  return idx.entries.filter((e) => isVideoEntry(e) && isStreamable(e));
}

const MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', avi: 'video/x-msvideo',
  ts: 'video/mp2t', wmv: 'video/x-ms-wmv', flv: 'video/x-flv', mpg: 'video/mpeg', mpeg: 'video/mpeg',
};
export const mimeOf = (name: string) => MIME[name.split('.').pop()?.toLowerCase() || ''] || 'application/octet-stream';

/** `Content-Disposition` that survives non-ASCII names. */
export function contentDisposition(name: string, disposition: 'inline' | 'attachment') {
  const base = name.split('/').pop() || name;
  const ascii = base.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

/** Local header → first byte of the entry's data. Cached on the entry. */
async function dataStartOf(url: string, f: FetchLike, e: ZipEntry, signal?: AbortSignal): Promise<number> {
  if (e.dataStart !== undefined) return e.dataStart;
  const lh = await rangeBuf(url, f, e.offset, e.offset + 29, signal);
  if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) throw new ZipError('Corrupt zip entry header', 422);
  e.dataStart = e.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  return e.dataStart;
}

/** Parses a Range header against a known size. `null` = no range, 'unsatisfiable' = 416. */
export function parseRange(header: string | undefined, total: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start: number; let end: number;
  if (!m[1]) { const n = Number(m[2]); if (!n) return 'unsatisfiable'; start = Math.max(0, total - n); end = total - 1; }
  else { start = Number(m[1]); end = m[2] ? Math.min(total - 1, Number(m[2])) : total - 1; }
  if (start >= total || end < start) return 'unsatisfiable';
  return { start, end };
}

/** Keeps bytes [from, to] of whatever flows through it and ends the stream as soon as `to` is reached. */
class Slice extends Transform {
  private pos = 0;
  private finished = false;
  constructor(private from: number, private to: number, private onFinished: () => void) { super(); }
  _transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void) {
    if (this.finished) return cb();
    const cs = this.pos;
    const ce = cs + chunk.length - 1;
    this.pos += chunk.length;
    if (ce >= this.from) {
      const a = Math.max(this.from, cs) - cs;
      const b = Math.min(this.to, ce) - cs;
      if (b >= a) this.push(chunk.subarray(a, b + 1));
    }
    if (ce >= this.to) {
      this.finished = true;
      this.onFinished();
      queueMicrotask(() => this.end());
    }
    cb();
  }
}

export type OpenedEntry = { status: number; headers: Record<string, string>; body: Readable; size: number };

/**
 * Streams one entry out of the archive. Stored entries are served with true Range support.
 * Deflated entries cannot be seeked, so a Range request inflates from the start and skips ahead on the server
 * (the browser still gets a normal 206, so scrubbing works; it just reads more of the archive).
 */
export async function openZipEntry(
  url: string, f: FetchLike, entry: ZipEntry,
  opts: { range?: string; download?: boolean; signal?: AbortSignal } = {},
): Promise<OpenedEntry> {
  if (!isStreamable(entry)) throw new ZipError(entry.encrypted ? 'This file is password protected inside the archive' : 'This file uses a compression method that cannot be streamed', 422);
  const total = entry.size;
  const range = parseRange(opts.range, total);
  const common = {
    'content-type': mimeOf(entry.name), 'accept-ranges': 'bytes', 'cache-control': 'private, no-store',
    'content-disposition': contentDisposition(entry.name, opts.download ? 'attachment' : 'inline'),
  };
  if (range === 'unsatisfiable') {
    return { status: 416, headers: { ...common, 'content-range': `bytes */${total}`, 'content-length': '0' }, body: Readable.from([]), size: 0 };
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : total - 1;
  const partial = !!range && (start > 0 || end < total - 1);
  const headers: Record<string, string> = { ...common, 'content-length': String(end - start + 1), ...(partial ? { 'content-range': `bytes ${start}-${end}/${total}` } : {}) };
  const dataStart = await dataStartOf(url, f, entry, opts.signal);

  if (entry.method === 0) {
    const res = await rangeFetch(url, f, dataStart + start, dataStart + end, opts.signal);
    return { status: partial ? 206 : 200, headers, body: Readable.fromWeb(res.body as any), size: end - start + 1 };
  }

  const res = await rangeFetch(url, f, dataStart, dataStart + Math.max(0, entry.compSize - 1), opts.signal);
  const src = Readable.fromWeb(res.body as any);
  const inflate = zlib.createInflateRaw();
  const teardown = () => { src.unpipe(inflate); src.destroy(); inflate.destroy(); };
  const out = new Slice(start, end, teardown);
  src.on('error', (e) => out.destroy(e));
  inflate.on('error', (e) => { src.destroy(); out.destroy(e); });
  out.on('close', teardown);
  src.pipe(inflate).pipe(out);
  return { status: partial ? 206 : 200, headers, body: out, size: end - start + 1 };
}
