import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { readZipIndex, openZipEntry, isVideoEntry, isStreamable, parseRange, ZipIndexCache, contentDisposition } from '../src/zipList.js';
import { buildZip, rangeServer, noise } from './zipBuilder.js';

const drain = async (r: Readable) => { const chunks: Buffer[] = []; for await (const c of r) chunks.push(Buffer.from(c)); return Buffer.concat(chunks); };

describe('remote zip index', () => {
  it('lists hundreds of entries with a handful of requests (no per-entry reads)', async () => {
    const entries = Array.from({ length: 400 }, (_, i) => ({ name: `Set/clip-${String(i).padStart(3, '0')}.mp4`, data: Buffer.from(`video-${i}`), method: (i % 2 ? 8 : 0) as 0 | 8 }));
    entries.push({ name: '__MACOSX/Set/._clip-000.mp4', data: Buffer.from('x'), method: 0 }, { name: 'Set/readme.txt', data: Buffer.from('hi'), method: 0 }, { name: 'Set/Sample/sample.mp4', data: Buffer.from('s'), method: 0 });
    const { f, calls } = rangeServer(buildZip(entries, { comment: 'made by tests' }));
    const idx = await readZipIndex('https://cdn/z.zip', f);
    expect(idx.entries).toHaveLength(403);
    const vids = idx.entries.filter((e) => isVideoEntry(e) && isStreamable(e));
    expect(vids).toHaveLength(400);
    expect(calls.length).toBeLessThanOrEqual(3);
  });

  it('reads ZIP64 entry extras and the ZIP64 end record', async () => {
    const data = [noise(5000, 1), noise(7000, 2), noise(1200, 3)];
    const zip = buildZip([
      { name: 'a.mp4', data: data[0], method: 0, zip64: true },
      { name: 'dir/b.mkv', data: data[1], method: 8, zip64: true },
      { name: 'c.mp4', data: data[2], method: 0 },
    ], { zip64Eocd: true });
    const { f } = rangeServer(zip);
    const idx = await readZipIndex('https://cdn/z.zip', f);
    expect(idx.entries.map((e) => e.name)).toEqual(['a.mp4', 'dir/b.mkv', 'c.mp4']);
    expect(idx.byName.get('a.mp4')?.size).toBe(5000);
    expect(idx.byName.get('dir/b.mkv')?.size).toBe(7000);
    for (let i = 0; i < 3; i++) {
      const e = idx.entries[i];
      const out = await openZipEntry('https://cdn/z.zip', f, e);
      expect(out.status).toBe(200);
      expect((await drain(out.body)).equals(data[i])).toBe(true);
    }
  });

  it('rejects things that are not zips or hosts that ignore Range', async () => {
    const { f } = rangeServer(Buffer.from('definitely not a zip file, just some text.'));
    await expect(readZipIndex('https://cdn/x', f)).rejects.toThrow(/Not a zip/);
    const zip = buildZip([{ name: 'a.mp4', data: noise(300_000, 9), method: 0 }]);
    const ignoring = rangeServer(zip, { ignoreRange: true });
    await expect(readZipIndex('https://cdn/x', ignoring.f)).rejects.toThrow(/ignored the Range/);
  });
});

describe('streaming one entry', () => {
  const stored = noise(300_000, 7);
  const deflated = Buffer.concat([noise(40_000, 5), Buffer.alloc(400_000, 65), noise(40_000, 6)]);
  const zip = buildZip([
    { name: 'stored.mp4', data: stored, method: 0 },
    { name: 'deflated.mkv', data: deflated, method: 8 },
  ]);

  it('stored entry: full, bounded, open-ended and suffix ranges', async () => {
    const { f, calls } = rangeServer(zip);
    const idx = await readZipIndex('https://cdn/z.zip', f);
    const e = idx.byName.get('stored.mp4')!;
    const full = await openZipEntry('https://cdn/z.zip', f, e);
    expect(full.status).toBe(200);
    expect(full.headers['content-length']).toBe(String(stored.length));
    expect((await drain(full.body)).equals(stored)).toBe(true);

    const mid = await openZipEntry('https://cdn/z.zip', f, e, { range: 'bytes=1000-1999' });
    expect(mid.status).toBe(206);
    expect(mid.headers['content-range']).toBe(`bytes 1000-1999/${stored.length}`);
    expect((await drain(mid.body)).equals(stored.subarray(1000, 2000))).toBe(true);

    const tail = await openZipEntry('https://cdn/z.zip', f, e, { range: `bytes=${stored.length - 100}-` });
    expect((await drain(tail.body)).equals(stored.subarray(stored.length - 100))).toBe(true);
    const suffix = await openZipEntry('https://cdn/z.zip', f, e, { range: 'bytes=-50' });
    expect((await drain(suffix.body)).equals(stored.subarray(stored.length - 50))).toBe(true);

    const bad = await openZipEntry('https://cdn/z.zip', f, e, { range: `bytes=${stored.length + 5}-` });
    expect(bad.status).toBe(416);
    // a seek only asks the archive host for the bytes it needs, never the whole entry
    const ranged = calls.filter((c) => c.range).map((c) => c.range as string);
    const base = e.dataStart as number;
    expect(ranged.includes(`bytes=${base + stored.length - 50}-${base + stored.length - 1}`)).toBe(true);
  });

  it('deflated entry: full file and seeking (server skips ahead)', async () => {
    const { f } = rangeServer(zip);
    const idx = await readZipIndex('https://cdn/z.zip', f);
    const e = idx.byName.get('deflated.mkv')!;
    expect(e.method).toBe(8);
    const full = await openZipEntry('https://cdn/z.zip', f, e);
    expect((await drain(full.body)).equals(deflated)).toBe(true);

    const seek = await openZipEntry('https://cdn/z.zip', f, e, { range: 'bytes=300000-300999' });
    expect(seek.status).toBe(206);
    expect(seek.headers['content-length']).toBe('1000');
    expect((await drain(seek.body)).equals(deflated.subarray(300000, 301000))).toBe(true);

    const head = await openZipEntry('https://cdn/z.zip', f, e, { range: 'bytes=0-99' });
    expect((await drain(head.body)).equals(deflated.subarray(0, 100))).toBe(true);

    const open = await openZipEntry('https://cdn/z.zip', f, e, { range: `bytes=${deflated.length - 5000}-` });
    expect((await drain(open.body)).equals(deflated.subarray(deflated.length - 5000))).toBe(true);
  });

  it('download mode sets an attachment filename', async () => {
    const { f } = rangeServer(zip);
    const idx = await readZipIndex('https://cdn/z.zip', f);
    const out = await openZipEntry('https://cdn/z.zip', f, idx.byName.get('stored.mp4')!, { download: true });
    expect(out.headers['content-disposition']).toMatch(/^attachment; filename="stored\.mp4"/);
    out.body.destroy();
  });
});

describe('helpers', () => {
  it('parses ranges', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=10-', 100)).toEqual({ start: 10, end: 99 });
    expect(parseRange('bytes=10-20', 100)).toEqual({ start: 10, end: 20 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
  });
  it('caches an index once even when asked in parallel', async () => {
    const cache = new ZipIndexCache();
    let loads = 0;
    const load = async () => { loads++; await new Promise((r) => setTimeout(r, 10)); return { length: 1, entries: [], byName: new Map() }; };
    await Promise.all([cache.get('k', load), cache.get('k', load), cache.get('k', load)]);
    await cache.get('k', load);
    expect(loads).toBe(1);
  });
  it('builds safe content-disposition headers', () => {
    expect(contentDisposition('dir/Café "x".mp4', 'inline')).toBe(`inline; filename="Caf_ _x_.mp4"; filename*=UTF-8''Caf%C3%A9%20%22x%22.mp4`);
  });
});
