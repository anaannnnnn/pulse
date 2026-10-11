import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-perf-'));
process.env.DATA_DIR = dataDir;
const { buildApp } = await import('../src/app.js');
const { openDb } = await import('../src/db.js');
const { CacheStore } = await import('../src/cacheStore.js');
const { Database } = await import('../src/sqlite.js');
const { norm, levenshtein, tick } = await import('../src/text.js');

const tick20 = () => new Promise((r) => setTimeout(r, 20));

describe('CacheStore (provider cache)', () => {
  it('returns what was set immediately, compressed on disk, and survives a reopen', async () => {
    const file = path.join(dataDir, 'c1.db');
    const c = new CacheStore(file);
    const big = { data: Array.from({ length: 500 }, (_, i) => ({ id: i, title: 'Some scene title ' + i, tags: ['a', 'b', 'c'] })) };
    c.set('k1', big);
    expect(c.get('k1', 1000)).toEqual(big);          // pending write is visible (read-your-write)
    await tick20();
    expect(c.info().pending).toBe(0);
    expect(c.info().diskBytes).toBeGreaterThan(0);
    expect(c.info().diskBytes).toBeLessThan(JSON.stringify(big).length / 3);   // deflated
    c.close();
    const c2 = new CacheStore(file);
    expect(c2.get('k1', 1000)).toEqual(big);
    expect(c2.get('k1', -1)).toBeUndefined();         // older than maxAge
    expect(c2.get('nope', 1000)).toBeUndefined();
    c2.close();
  });
  it('hands out independent copies (callers may mutate them)', () => {
    const c = new CacheStore(':memory:');
    c.set('a', { data: [1, 2, 3] });
    const x = c.get('a', 1000); x.data.push(99);
    expect(c.get('a', 1000).data).toEqual([1, 2, 3]);
    c.close();
  });
  it('purgeEmpty drops only "no results" answers', async () => {
    const c = new CacheStore(':memory:');
    c.set('empty', { data: [] }); c.set('full', { data: [1] });
    await tick20();
    expect(c.purgeEmpty()).toBe(1);
    expect(c.get('empty', 1000)).toBeUndefined();
    expect(c.get('full', 1000)).toEqual({ data: [1] });
    c.close();
  });
  it('stays under its size cap by pruning the oldest rows in chunks', async () => {
    const c = new CacheStore(':memory:', { maxBytes: 60_000, memBytes: 1000 });
    const noise = () => Array.from({ length: 300 }, () => Math.random().toString(36)).join('');   // incompressible-ish
    for (let i = 0; i < 80; i++) { c.set('k' + i, { data: [noise()] }); await new Promise((r) => setTimeout(r, 2)); }
    await tick20();
    c.prune(); await new Promise((r) => setTimeout(r, 200));
    expect(c.info().diskBytes).toBeLessThanOrEqual(60_000);
    expect(c.get('k79', 60_000)).toBeDefined();       // newest kept
    expect(c.info().pruned).toBeGreaterThan(0);
    c.close();
  });
});

describe('database', () => {
  it('drops the legacy http_cache table and has the aggregate indexes', () => {
    const file = path.join(dataDir, 'legacy.db');
    const raw = new Database(file);
    raw.exec(`CREATE TABLE http_cache (key TEXT PRIMARY KEY, body TEXT NOT NULL, fetched_at INTEGER NOT NULL); INSERT INTO http_cache VALUES('k','{"data":[]}',1)`);
    raw.close();
    const db = openDb(file);
    expect(db.prepare(`SELECT 1 x FROM sqlite_master WHERE name='http_cache'`).get()).toBeUndefined();
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as any[]).map((r) => r.name);
    for (const n of ['scene_tags_tag', 'scene_performers_perf', 'scenes_studio']) expect(names).toContain(n);
    const plan = (q: string) => (db.prepare('EXPLAIN QUERY PLAN ' + q).all() as any[]).map((r) => r.detail).join(' ');
    expect(plan('SELECT COUNT(*) FROM scene_tags st WHERE st.tag_id=1')).toMatch(/USING (COVERING )?INDEX scene_tags_tag/);
    expect(plan('SELECT COUNT(*) FROM scenes s WHERE s.studio_id=1')).toMatch(/INDEX scenes_studio/);
    db.close();
  });
  it('db.version moves on every write', () => {
    const db = openDb(':memory:');
    const v = db.version;
    db.prepare(`INSERT INTO kv(key, value) VALUES('x','1')`).run();
    expect(db.version).toBeGreaterThan(v);
    const v2 = db.version; db.prepare('SELECT * FROM kv').all();
    expect(db.version).toBe(v2);
  });
});

describe('text helpers', () => {
  it('norm is memoised but unchanged; levenshtein still correct', () => {
    expect(norm('Café  &  Crème-Brûlée!')).toBe('cafe and creme brulee');
    expect(norm('Café  &  Crème-Brûlée!')).toBe('cafe and creme brulee');
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
  });
  it('tick releases waiting workers one per loop turn', async () => {
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => tick().then(() => order.push(n))));
    expect(order).toEqual([1, 2, 3]);
  });
});

describe('app: read cache, compression, thumbnails, health', () => {
  let app: any; let cookies: Record<string, string> = {};
  let sceneIds: number[] = [];
  const get = (url: string, headers: any = {}) => app.inject({ method: 'GET', url, cookies, headers });
  beforeAll(async () => {
    app = await buildApp({ db: openDb(':memory:'), fetch: (async () => new Response('{}')) as any, env: { tpdbKey: '', tpdbIntervalMs: 0 } as any });
    const u = await app.inject({ method: 'POST', url: '/api/session/unlock', payload: { pin: '6442' } });
    cookies = { pulse_auth: u.cookies.find((c: any) => c.name === 'pulse_auth').value };
    const ins = app.ctx.db.prepare(`INSERT INTO scenes(ext_key, source, path, file_name, parsed, match_status, has_thumb) VALUES(?,?,?,?,?,?,1)`);
    sceneIds = Array.from({ length: 60 }, (_, i) => Number(ins.run(`pcloud:${i}`, 'pcloud', `/V/${'long name '.repeat(8)}${i}.mp4`, `${'long name '.repeat(8)}${i}.mp4`, '{}', 'matched').lastInsertRowid));
  });
  afterAll(async () => { await app.close(); });

  it('list endpoints are cached but never stale after a write', async () => {
    const a = (await get('/api/library/facets')).json();
    expect(a.totals.favorites).toBe(0);
    const t = await app.inject({ method: 'POST', url: '/api/favorites/toggle', cookies, payload: { type: 'scene', id: sceneIds[0] } });
    expect(t.statusCode).toBe(200);
    expect((await get('/api/library/facets')).json().totals.favorites).toBe(1);   // immediately, not after a TTL
    const lib1 = (await get('/api/library?pageSize=5')).json();
    expect(lib1.items).toHaveLength(5); expect(lib1.total).toBe(60);
    const hits = app.ctx.db.version; await get('/api/library?pageSize=5');
    expect(app.ctx.db.version).toBe(hits);
  });
  it('gzips JSON and serves 304 for unchanged static/thumbnail bytes', async () => {
    const r = await get('/api/library?pageSize=60', { 'accept-encoding': 'gzip' });
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(zlib.gunzipSync(r.rawPayload).toString()).items).toHaveLength(60);
    const plain = await get('/api/library?pageSize=60', {});
    expect(plain.headers['content-encoding']).toBeUndefined();
    fs.writeFileSync(path.join(dataDir, 'thumbs', `${sceneIds[1]}_640x360.jpg`), Buffer.from('FFD8FFE0-fake-jpeg-bytes'));
    const t1 = await get(`/api/scenes/${sceneIds[1]}/thumb`);
    expect(t1.statusCode).toBe(200);
    expect(t1.headers['cache-control']).toMatch(/max-age=\d{7}.*immutable/);
    expect(t1.headers.etag).toBeTruthy();
    const t2 = await get(`/api/scenes/${sceneIds[1]}/thumb`, { 'if-none-match': t1.headers.etag });
    expect(t2.statusCode).toBe(304);
    expect((await get('/api/scenes/999999/thumb')).statusCode).toBe(404);
  });
  it('/api/health answers without touching the database and reports loop stats', async () => {
    const real = app.ctx.db.prepare.bind(app.ctx.db);
    app.ctx.db.prepare = () => { throw new Error('health must not use the database'); };
    try {
      const r = await app.inject({ method: 'GET', url: '/api/health' });
      expect(r.statusCode).toBe(200);
      const j = r.json();
      expect(j.ok).toBe(true); expect(j.loop).toHaveProperty('p99Ms'); expect(j.cache).toHaveProperty('diskBytes');
    } finally { app.ctx.db.prepare = real; }
  });
  it('still requires the PIN session for lists and thumbnails', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/library/facets' })).statusCode).toBe(423);
    expect((await app.inject({ method: 'GET', url: `/api/scenes/${sceneIds[1]}/thumb` })).statusCode).toBe(423);
  });
});
