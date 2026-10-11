import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import type { FetchLike } from './http.js';

export type ZipVideo = { name: string; method: number; compSize: number; size: number; dataStart: number };

const VIDEO = /\.(mp4|mkv|mov|webm|m4v|avi|mpg|mpeg)$/i;

async function readRange(url: string, f: FetchLike, start: number, end: number): Promise<Buffer> {
  const res = await f(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (!res.ok && res.status !== 206) throw new Error(`archive range ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Video files inside a remote zip, read from the central directory. Store and deflate only. */
export async function listZipVideos(url: string, f: FetchLike): Promise<ZipVideo[]> {
  let len = 0;
  const head = await f(url, { method: 'HEAD' }).catch(() => null);
  len = Number(head?.headers.get('content-length') || 0);
  if (!len) {
    const probe = await f(url, { headers: { Range: 'bytes=0-0' } });
    len = Number((probe.headers.get('content-range') || '').split('/')[1]) || 0;
  }
  if (!len || len < 22) return [];
  const tailN = Math.min(len, 256 * 1024);
  const tailStart = len - tailN;
  const tail = await readRange(url, f, tailStart, len - 1);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return [];
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOff = tail.readUInt32LE(eocd + 16);
  if (cdSize <= 0 || cdSize > 8_000_000) return [];
  const cd = cdOff >= tailStart && cdOff + cdSize <= tailStart + tail.length
    ? tail.subarray(cdOff - tailStart, cdOff - tailStart + cdSize)
    : await readRange(url, f, cdOff, cdOff + cdSize - 1);
  const found: { name: string; method: number; compSize: number; size: number; local: number }[] = [];
  let p = 0;
  while (p + 46 <= cd.length && found.length < 40) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const method = cd.readUInt16LE(p + 10);
    const compSize = cd.readUInt32LE(p + 20);
    const size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const local = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (!VIDEO.test(name) || name.endsWith('/') || /\bsample\b/i.test(name)) continue;
    if ((method !== 0 && method !== 8) || compSize === 0xffffffff || local === 0xffffffff || compSize === 0) continue;
    found.push({ name, method, compSize, size, local });
  }
  const out: ZipVideo[] = [];
  for (const e of found) {
    const lh = await readRange(url, f, e.local, e.local + 29);
    if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) continue;
    out.push({ name: e.name, method: e.method, compSize: e.compSize, size: e.size, dataStart: e.local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28) });
  }
  return out;
}

function mimeOf(name: string) {
  const e = name.split('.').pop()?.toLowerCase();
  if (e === 'webm') return 'video/webm';
  if (e === 'mkv') return 'video/x-matroska';
  return 'video/mp4';
}

/** Stream one video out of a zip. Stored entries honor Range. Deflated entries play from the start. */
export async function openZipEntry(url: string, f: FetchLike, entry: ZipVideo, rangeHeader?: string): Promise<{ status: number; headers: Record<string, string>; body: Readable }> {
  const mime = mimeOf(entry.name);
  if (entry.method === 0) {
    const total = entry.size || entry.compSize;
    let start = 0;
    let end = total - 1;
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || '');
    if (m && (m[1] || m[2])) {
      if (m[1]) start = Math.min(total - 1, Number(m[1]));
      end = m[2] ? Math.min(total - 1, Number(m[2])) : total - 1;
      if (end < start) end = total - 1;
    }
    const res = await f(url, { headers: { Range: `bytes=${entry.dataStart + start}-${entry.dataStart + end}` } });
    if (!res.ok && res.status !== 206) throw new Error(`archive read ${res.status}`);
    const partial = !!rangeHeader && (start > 0 || end < total - 1);
    return {
      status: partial ? 206 : 200,
      headers: {
        'content-type': mime,
        'accept-ranges': 'bytes',
        'content-length': String(end - start + 1),
        ...(partial ? { 'content-range': `bytes ${start}-${end}/${total}` } : {}),
        'cache-control': 'private, no-store',
      },
      body: Readable.fromWeb(res.body as any),
    };
  }
  const res = await f(url, { headers: { Range: `bytes=${entry.dataStart}-${entry.dataStart + entry.compSize - 1}` } });
  if (!res.ok && res.status !== 206) throw new Error(`archive read ${res.status}`);
  const inflate = zlib.createInflateRaw();
  Readable.fromWeb(res.body as any).pipe(inflate);
  return {
    status: 200,
    headers: { 'content-type': mime, 'cache-control': 'private, no-store', ...(entry.size ? { 'content-length': String(entry.size) } : {}) },
    body: inflate,
  };
}
