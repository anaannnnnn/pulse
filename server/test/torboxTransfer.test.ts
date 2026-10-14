import { describe, it, expect } from 'vitest';
import { PcloudClient } from '../src/clients/pcloud.js';
import { TransferQueue } from '../src/services/torboxTransfers.js';
import { readZipIndex, openZipEntry } from '../src/zipList.js';
import { buildZip, rangeServer, noise } from './zipBuilder.js';

const tok = { accessToken: 'AT', host: 'api.pcloud.com' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function* chunks(buf: Buffer, size = 7000) { for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size); }

/** pCloud stand-in: reads the whole streamed request body and checks it against the announced Content-Length. */
function fakePcloud() {
  const seen: { url: URL; contentLength: number; bodyLength: number; head: string; tail: string; payload: Buffer }[] = [];
  const f = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    const reader = (init.body as ReadableStream<Uint8Array>).getReader();
    const parts: Buffer[] = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(Buffer.from(value)); }
    const all = Buffer.concat(parts);
    const boundary = /boundary=(.+)$/.exec(init.headers['content-type'])![1];
    const start = all.indexOf('\r\n\r\n') + 4;
    const endMark = Buffer.from(`\r\n--${boundary}--\r\n`);
    seen.push({ url, contentLength: Number(init.headers['content-length']), bodyLength: all.length, head: all.subarray(0, start).toString(), tail: all.subarray(all.length - endMark.length).toString(), payload: all.subarray(start, all.length - endMark.length) });
    return new Response(JSON.stringify({ result: 0, fileids: [4242], metadata: [{ fileid: 4242 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, seen };
}

describe('pCloud streaming upload', () => {
  it('frames the stream, announces the exact length and keeps the bytes intact', async () => {
    const data = noise(123_457, 3);
    const { f, seen } = fakePcloud();
    const progress: number[] = [];
    const id = await new PcloudClient(tok, f).uploadStream(77, 'clip "one".mp4', chunks(data), data.length, { onProgress: (b) => progress.push(b) });
    expect(id).toBe(4242);
    expect(seen).toHaveLength(1);
    expect(seen[0].contentLength).toBe(seen[0].bodyLength);
    expect(seen[0].payload.equals(data)).toBe(true);
    expect(seen[0].url.searchParams.get('folderid')).toBe('77');
    expect(seen[0].url.searchParams.get('nopartial')).toBe('1');
    expect(seen[0].head).toMatch(/filename="clip _one_\.mp4"/);
    expect(progress[progress.length - 1]).toBe(data.length);
  });

  it('fails (and so never commits a file) when the source ends early', async () => {
    const data = noise(50_000, 4);
    const { f } = fakePcloud();
    await expect(new PcloudClient(tok, f).uploadStream(1, 'a.mp4', chunks(data.subarray(0, 30_000)), data.length)).rejects.toThrow(/ended early|expected|Source/i);
  });

  it('copies a video straight out of a zip (stored and deflated) into pCloud', async () => {
    const a = noise(90_000, 11);
    const b = Buffer.concat([noise(5_000, 12), Buffer.alloc(120_000, 7)]);
    const zip = buildZip([{ name: 'Pack/a.mp4', data: a, method: 0 }, { name: 'Pack/b.mkv', data: b, method: 8 }]);
    const origin = rangeServer(zip);
    const idx = await readZipIndex('https://cdn/pack.zip', origin.f);
    const { f, seen } = fakePcloud();
    const pc = new PcloudClient(tok, f);
    for (const e of idx.entries) {
      const opened = await openZipEntry('https://cdn/pack.zip', origin.f, e);
      await pc.uploadStream(5, e.name.split('/').pop()!, opened.body, opened.size);
    }
    expect(seen).toHaveLength(2);
    expect(seen[0].payload.equals(a)).toBe(true);
    expect(seen[1].payload.equals(b)).toBe(true);
  });
});

describe('transfer queue', () => {
  it('runs at most N at a time, reports progress and finishes', async () => {
    const q = new TransferQueue({ concurrency: 2, retryDelayMs: 1 });
    let live = 0; let peak = 0;
    const mk = (name: string) => q.add({ name, folderId: 1, size: 100, run: async ({ progress }) => { live++; peak = Math.max(peak, live); progress(40); await sleep(20); progress(100); live--; return 9; } });
    const ts = ['a', 'b', 'c', 'd'].map(mk);
    expect(ts.every((t) => t.state === 'queued')).toBe(true);
    await sleep(150);
    expect(peak).toBe(2);
    const done = q.list();
    expect(done.every((t) => t.state === 'done' && t.fileId === 9 && t.bytes === 100)).toBe(true);
    expect(q.active).toBe(false);
    expect(q.clearFinished()).toBe(4);
  });

  it('retries once, then reports the error', async () => {
    const q = new TransferQueue({ retryDelayMs: 1 });
    let tries = 0;
    const flaky = q.add({ name: 'flaky', folderId: 1, size: 1, run: async () => { if (++tries < 2) throw new Error('boom'); return 1; } });
    const broken = q.add({ name: 'broken', folderId: 1, size: 1, run: async () => { throw new Error('pCloud uploadfile: 2003'); } });
    await sleep(60);
    expect(q.get(flaky.id)!.state).toBe('done');
    expect(q.get(flaky.id)!.attempts).toBe(2);
    expect(q.get(broken.id)!.state).toBe('error');
    expect(q.get(broken.id)!.error).toMatch(/2003/);
  });

  it('cancels a queued and a running transfer', async () => {
    const q = new TransferQueue({ concurrency: 1, retryDelayMs: 1 });
    const run = (ctx: { signal: AbortSignal }) => new Promise<number>((_res, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    const first = q.add({ name: 'first', folderId: 1, size: 1, run });
    const second = q.add({ name: 'second', folderId: 1, size: 1, run });
    await sleep(10);
    expect(q.get(first.id)!.state).toBe('running');
    expect(q.cancel(second.id)).toBe(true);
    expect(q.cancel(first.id)).toBe(true);
    await sleep(20);
    expect(q.get(first.id)!.state).toBe('canceled');
    expect(q.get(second.id)!.state).toBe('canceled');
    expect(q.cancel(first.id)).toBe(false);
  });
});
