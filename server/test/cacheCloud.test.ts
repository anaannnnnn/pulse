import { describe, it, expect } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { CacheStore, type CacheCloud } from '../src/cacheStore.js';

class MemCloud implements CacheCloud {
  packs = new Map<string, Buffer>();
  index: Buffer | null = null;
  private n = 0;
  async putPack(_name: string, body: Buffer) { const id = 'p' + (++this.n); this.packs.set(id, body); return id; }
  async getPack(id: string) {
    const b = this.packs.get(id);
    if (!b) throw new Error('missing pack ' + id);
    return b;
  }
  async deletePack(id: string) { this.packs.delete(id); }
  async putIndex(body: Buffer) { this.index = body; }
  async getIndex() { return this.index; }
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('cache spilled to cloud', () => {
  it('keeps only a hot set locally and reads the rest back from the cloud tier', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-cloud-cache-'));
    const file = path.join(dir, 'cache.db');
    const cloud = new MemCloud();
    const c = new CacheStore(file, { maxBytes: 50_000_000, memBytes: 2000, hotBytes: 2500 });
    const value = (i: number) => ({ data: [{ id: i, blob: Array.from({ length: 180 }, (_, j) => ((i * 31 + j * 17) % 36).toString(36)).join('') }] });
    for (let i = 0; i < 40; i++) c.set('k' + i, value(i));
    for (let i = 0; i < 50 && c.info().pending; i++) await tick(20);
    expect(c.info().pending).toBe(0);
    expect(c.info().diskBytes).toBeGreaterThan(2500);
    c.attachCloud(cloud, { hotBytes: 2500 });
    await c.flushCloud();
    expect(c.info().cloud).toBe(true);
    expect(c.info().diskBytes).toBeLessThanOrEqual(2500);
    expect(c.info().cloudBytes).toBeGreaterThan(0);
    expect(c.info().cloudEntries).toBeGreaterThan(0);
    expect(cloud.packs.size).toBeGreaterThan(0);
    // newest stays readable without the cloud; an older key comes back through pull
    expect(c.get('k39', 60_000)).toEqual(value(39));
    const old = await c.pull('k0', 60_000);
    expect(old).toEqual(value(0));
    expect(c.get('k0', 60_000)).toEqual(value(0));
    c.close();

    const c2 = new CacheStore(file, { memBytes: 2000, hotBytes: 2500 });
    c2.attachCloud(cloud, { hotBytes: 2500 });
    await c2.flushCloud();
    expect(await c2.pull('k0', 60_000)).toEqual(value(0));
    c2.close();

    // a fresh database restores the index snapshot and still reads the packs
    const fresh = path.join(dir, 'fresh.db');
    const c3 = new CacheStore(fresh, { memBytes: 2000 });
    expect(cloud.index && cloud.index.length).toBeGreaterThan(0);
    const rows = JSON.parse(zlib.inflateSync(cloud.index!).toString('utf8'));
    expect(rows.length).toBeGreaterThan(0);
    c3.attachCloud(cloud);
    await c3.flushCloud();
    expect(c3.info().cloudEntries).toBe(rows.length);
    expect(await c3.pull('k0', 60_000)).toEqual(value(0));
    c3.close();
  });

  it('uploads more than one pack at the same time', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-cloud-cache-'));
    const file = path.join(dir, 'cache.db');
    const cloud = new MemCloud();
    let inflight = 0;
    let max = 0;
    const orig = cloud.putPack.bind(cloud);
    cloud.putPack = async (name, body) => {
      inflight++;
      max = Math.max(max, inflight);
      await tick(40);
      inflight--;
      return orig(name, body);
    };
    const c = new CacheStore(file, { memBytes: 1000, hotBytes: 1000, maxValueBytes: 2_000_000 });
    const blob = crypto.randomBytes(350_000).toString('base64');
    for (let i = 0; i < 24; i++) c.set('b' + i, { data: [{ id: i, blob }] });
    for (let i = 0; i < 80 && c.info().pending; i++) await tick(25);
    expect(c.info().pending).toBe(0);
    c.attachCloud(cloud, { hotBytes: 1000 });
    await c.flushCloud();
    expect(max).toBeGreaterThan(1);
    expect(c.info().diskBytes).toBeLessThanOrEqual(1000);
    expect(await c.pull('b0', 60_000)).toBeTruthy();
    c.close();
  });
});
