import zlib from 'node:zlib';

export type BuildEntry = { name: string; data: Buffer; method?: 0 | 8; zip64?: boolean };

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

/** Minimal zip writer for tests: stored/deflate entries, optional per-entry ZIP64 extras and a ZIP64 end record. */
export function buildZip(entries: BuildEntry[], opts: { zip64Eocd?: boolean; comment?: string } = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 0;
    const name = Buffer.from(e.name, 'utf8');
    const body = method === 8 ? zlib.deflateRawSync(e.data) : e.data;
    const crc = zlib.crc32(e.data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(e.zip64 ? 45 : 20), u16(0x0800), u16(method), u16(0), u16(0x21), u32(crc),
      u32(e.zip64 ? 0xffffffff : body.length), u32(e.zip64 ? 0xffffffff : e.data.length), u16(name.length), u16(e.zip64 ? 20 : 3), name,
      e.zip64 ? Buffer.concat([u16(1), u16(16), u64(e.data.length), u64(body.length)]) : Buffer.from([0xde, 0xad, 0x00]), // odd extra on purpose
    ]);
    const extra = e.zip64 ? Buffer.concat([u16(1), u16(24), u64(e.data.length), u64(body.length), u64(offset)]) : Buffer.alloc(0);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(45), u16(e.zip64 ? 45 : 20), u16(0x0800), u16(method), u16(0), u16(0x21), u32(crc),
      u32(e.zip64 ? 0xffffffff : body.length), u32(e.zip64 ? 0xffffffff : e.data.length), u16(name.length), u16(extra.length), u16(0), u16(0), u16(0), u32(0),
      u32(e.zip64 ? 0xffffffff : offset), name, extra,
    ]));
    parts.push(local, body);
    offset += local.length + body.length;
  }
  const cd = Buffer.concat(central);
  const cdOff = offset;
  const out: Buffer[] = [...parts, cd];
  const comment = Buffer.from(opts.comment || '', 'utf8');
  if (opts.zip64Eocd) {
    const recOff = cdOff + cd.length;
    out.push(Buffer.concat([u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0), u64(entries.length), u64(entries.length), u64(cd.length), u64(cdOff)]));
    out.push(Buffer.concat([u32(0x07064b50), u32(0), u64(recOff), u32(1)]));
  }
  out.push(Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(opts.zip64Eocd ? 0xffff : entries.length), u16(opts.zip64Eocd ? 0xffff : entries.length),
    u32(opts.zip64Eocd ? 0xffffffff : cd.length), u32(opts.zip64Eocd ? 0xffffffff : cdOff), u16(comment.length), comment,
  ]));
  return Buffer.concat(out);
}

export type RangeCall = { method: string; range: string | null };
/** fetch() stand-in that serves a buffer with HEAD and Range support and records what was asked. */
export function rangeServer(buf: Buffer, opts: { ignoreRange?: boolean } = {}) {
  const calls: RangeCall[] = [];
  const f = (async (_input: any, init?: any) => {
    const method = String(init?.method || 'GET');
    const range = init?.headers?.Range ?? init?.headers?.range ?? null;
    calls.push({ method, range });
    if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(buf.length), 'accept-ranges': 'bytes' } });
    const m = range && /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!m || opts.ignoreRange) return new Response(new Uint8Array(buf), { status: 200, headers: { 'content-length': String(buf.length) } });
    const a = Number(m[1]);
    const b = Math.min(buf.length - 1, Number(m[2]));
    return new Response(new Uint8Array(buf.subarray(a, b + 1)), { status: 206, headers: { 'content-range': `bytes ${a}-${b}/${buf.length}`, 'content-length': String(b - a + 1) } });
  }) as typeof fetch;
  return { f, calls };
}

/** deterministic, poorly compressible-ish bytes */
export function noise(n: number, seed = 1): Buffer {
  const b = Buffer.alloc(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = x & 0xff; }
  return b;
}
