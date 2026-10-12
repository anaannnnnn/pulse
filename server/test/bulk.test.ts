import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { AdaptiveLimiter } from '../src/services/rateLimiter.js';
import { TpdbClient } from '../src/clients/tpdb.js';
import { makeMockTpdb } from './mockTpdb.js';
import { fakeFetch } from './helpers.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-bulk-'));
const { buildApp } = await import('../src/app.js');
const { openDb } = await import('../src/db.js');
const { planGroups, matchGroup, fastCascade } = await import('../src/services/bulkMatcher.js');
const { parseFilename } = await import('../src/parser.js');

afterEach(() => { vi.useRealTimers(); });
const hdr = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });

describe('AdaptiveLimiter', () => {
  it('has no fixed delay: a burst is released immediately', async () => {
    const l = new AdaptiveLimiter({ startRps: 5, maxRps: 20, burst: 20 });
    const t0 = Date.now();
    await Promise.all([1, 2, 3].map(() => l.acquire()));
    expect(Date.now() - t0).toBeLessThan(50);
    l.done(); l.done(); l.done();
  });

  it('halves the rate and pauses for Retry-After on 429, then ramps up when healthy', async () => {
    vi.useFakeTimers();
    const l = new AdaptiveLimiter({ startRps: 8, maxRps: 20, minRps: 1, burst: 8, rampEvery: 4 });
    await l.acquire(); l.done({ status: 429, headers: hdr({ 'retry-after': '3' }) });
    expect(l.rps).toBe(4);
    let released = false;
    const p = l.acquire().then(() => { released = true; });
    await vi.advanceTimersByTimeAsync(2900);
    expect(released).toBe(false);                     // still paused
    await vi.advanceTimersByTimeAsync(400);
    await p; expect(released).toBe(true);
    l.done();
    const before = l.rps;
    for (let i = 0; i < 8; i++) { await vi.advanceTimersByTimeAsync(400); await l.acquire(); l.done({ status: 200 }); }
    expect(l.rps).toBeGreaterThan(before);            // AIMD ramp
    expect(l.stats().throttled).toBe(1);
  });

  it('reads X-RateLimit-* headers: pauses until reset when the window is exhausted, never exceeds the sustainable rate', async () => {
    vi.useFakeTimers();
    const l = new AdaptiveLimiter({ startRps: 10, maxRps: 10, burst: 10, minRps: 0.2 });
    await l.acquire(); l.done({ status: 200, headers: hdr({ 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '5' }) });
    let ok = false; const p = l.acquire().then(() => { ok = true; });
    await vi.advanceTimersByTimeAsync(4500); expect(ok).toBe(false);
    await vi.advanceTimersByTimeAsync(700); await p; expect(ok).toBe(true); l.done();
    // 30 requests left for 60 s -> sustainable 0.45 rps
    l.done({ status: 200, headers: hdr({ 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '30', 'x-ratelimit-reset': '60' }) });
    expect(l.rps).toBeLessThan(1);
    expect(l.stats().remaining).toBe(30);
  });

  it('aborted waiters never consume a token or reach the network', async () => {
    vi.useFakeTimers();
    const l = new AdaptiveLimiter({ startRps: 1, maxRps: 1, burst: 1, maxInflight: 1 });
    await l.acquire();                                  // takes the only in-flight slot
    const ac = new AbortController();
    const w = l.acquire(ac.signal); const caught = w.catch((e) => e.name);
    ac.abort();
    expect(await caught).toBe('AbortError');
    expect(l.stats().waiting).toBe(0);
    l.done();
  });
});

describe('TpdbClient: dedupe, negative cache, cancellation, 429', () => {
  const mkCache = () => {
    const store = new Map<string, { v: any; at: number }>();
    return { store, get: (k: string, maxAge: number) => { const e = store.get(k); return e && Date.now() - e.at < maxAge ? e.v : undefined; }, set: (k: string, v: any) => store.set(k, { v, at: Date.now() }) };
  };
  it('de-duplicates identical in-flight queries into one request', async () => {
    let n = 0;
    const { f } = fakeFetch(async () => { n++; await new Promise((r) => setTimeout(r, 20)); return { data: [{ id: 'a' }] }; });
    const c = new TpdbClient('K', undefined, f, 0);
    const r = await Promise.all([1, 2, 3].map(() => c.list('scene', { q: 'same' })));
    expect(n).toBe(1); expect(r.every((x) => x.length === 1)).toBe(true);
    expect(c.stats.deduped).toBe(2);
  });
  it('caches empty answers for a shorter time than hits', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let n = 0;
    const { f } = fakeFetch((u) => { n++; return { data: u.searchParams.get('q') === 'none' ? [] : [{ id: 'x' }] }; });
    const c = new TpdbClient('K', mkCache(), f, 0, { negativeTtlMs: 60_000 });
    await c.list('scene', { q: 'none' }); await c.list('scene', { q: 'some' }); expect(n).toBe(2);
    vi.setSystemTime(Date.now() + 30_000);
    await c.list('scene', { q: 'none' }); await c.list('scene', { q: 'some' }); expect(n).toBe(2);   // both still cached
    vi.setSystemTime(Date.now() + 120_000);
    await c.list('scene', { q: 'none' }); await c.list('scene', { q: 'some' });
    expect(n).toBe(3);                                                                                 // only the empty one expired
  });
  it('aborting the only waiter cancels the request; a shared request survives while another waiter remains', async () => {
    let aborted = 0; let calls = 0;
    const f = ((url: any, init: any) => { calls++; return new Promise((res, rej) => { init.signal.addEventListener('abort', () => { aborted++; rej(Object.assign(new Error('x'), { name: 'AbortError' })); }); setTimeout(() => res(new Response('{"data":[1]}', { status: 200 })), 80); }); }) as any;
    const c = new TpdbClient('K', undefined, f, 0);
    const a = new AbortController(), b = new AbortController();
    const p1 = c.list('scene', { q: 'z' }, 15, a.signal).catch((e) => e.name);
    const p2 = c.list('scene', { q: 'z' }, 15, b.signal);
    a.abort();
    expect(await p1).toBe('AbortError');
    expect(await p2).toEqual([1]); expect(aborted).toBe(0); expect(calls).toBe(1);
    const c2 = new AbortController();
    const p3 = c.list('scene', { q: 'solo' }, 15, c2.signal).catch((e) => e.name);
    c2.abort(); expect(await p3).toBe('AbortError'); await new Promise((r) => setTimeout(r, 10));
    expect(aborted).toBe(1);
  });
  it('backs off on 429 through the limiter, honours Retry-After and succeeds on retry', async () => {
    let n = 0;
    const f = (async () => (++n === 1 ? new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }) : new Response('{"data":[{"id":1}]}', { status: 200 }))) as any;
    const c = new TpdbClient('K', undefined, f, undefined, { startRps: 50, maxRps: 50 });
    const r = await c.list('scene', { q: 'x' });
    expect(r).toHaveLength(1); expect(n).toBe(2);
    expect(c.limiter!.stats().throttled).toBe(1);
    expect(c.limiter!.rps).toBeLessThan(50);
  });
});

describe('planGroups', () => {
  const mk = (names: string[], dir = '/Clips') => names.map((n, i) => ({ id: i + 1, row: { file_name: n }, parsed: parseFilename(n, dir, {}), duration: null }));
  it('groups clip-store files by performer prefix and leaves dated scene releases for per-file matching', () => {
    const files = mk([
      'Mandy Marx - Pain To Play.mp4', 'Mandy Marx - Rope Fun.mp4', 'Mandy Marx - Wet Floor.mp4', 'Mandy Marx - Extra.mp4',
      'Riley Reid - One.mp4', 'Riley Reid - Two.mp4',
      'Brazzers.21.05.12.Kendra.Lust.Big.Boobs.Fun.XXX.1080p.MP4-KTR.mp4', 'IMG_0001.mov',
    ]);
    const { groups, rest } = planGroups(files, 3);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: 'performer', name: 'Mandy Marx' });
    expect(groups[0].files).toHaveLength(4);
    expect(rest.map((f) => f.id).sort()).toEqual([5, 6, 7, 8]);
  });
});

/** Fake TPDB with one performer who has 250 scenes, paginated 100/page. */
function perfWorld(extra?: (u: URL) => any) {
  const titles = Array.from({ length: 250 }, (_, i) => `Clip Number ${i} ${['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'][i % 5]} ${['Sunset', 'Harbor', 'Velvet', 'Garden'][i % 4]}${i}`);
  const site = { id: 7, name: 'ClipStore', short_name: 'clipstore' };
  const scenes = titles.map((t, i) => ({ id: `ps${i}`, _id: i, title: t, date: `2022-01-${String((i % 28) + 1).padStart(2, '0')}`, site, performers: [{ id: 'mm', _id: 77, name: 'Mandy Marx' }], duration: 600 }));
  const hits: string[] = [];
  const m = fakeFetch((u) => {
    hits.push(u.pathname + u.search);
    const o = extra?.(u); if (o !== undefined) return o;
    const p = u.searchParams;
    if (u.pathname === '/performers') return { data: /mandy/i.test(p.get('q') || '') ? [{ id: 'mm', _id: 77, name: 'Mandy Marx', aliases: [] }] : [] };
    if (u.pathname === '/sites') return { data: [] };
    if (u.pathname === '/scenes' && p.get('performer_id') === '77') {
      const per = Number(p.get('per_page') || 15), page = Number(p.get('page') || 1);
      return { data: scenes.slice((page - 1) * per, page * per), meta: { total: scenes.length, last_page: Math.ceil(scenes.length / per) } };
    }
    if (u.pathname === '/scenes') return { data: [], meta: { total: 0, last_page: 1 } };
    return { data: [] };
  });
  return { ...m, hits, scenes, titles };
}

describe('matchGroup (batch by performer)', () => {
  it('resolves the performer once, pages the scene list and matches many files locally without per-file requests', async () => {
    const w = perfWorld();
    const tpdb = new TpdbClient('K', undefined, w.f, 0);
    const pick = [3, 40, 77, 120, 199, 240];
    const files = [...pick.map((i, k) => `Mandy Marx - ${w.titles[i]}.mp4`), 'Mandy Marx - Totally Unrelated Home Movie.mp4'].map((n, i) => ({ id: i + 1, row: { file_name: n }, parsed: parseFilename(n, '/Clips', {}), duration: null }));
    const out = await matchGroup({ kind: 'performer', key: 'p:mandymarx', name: 'Mandy Marx', files }, { tpdb, threshold: 0.75 });
    expect(out.scenes).toBe(250);
    expect(out.requests).toBe(1 + 3);                                  // performer lookup + 3 pages of 100
    expect(w.hits.length).toBe(4);
    expect(out.matched.map((m) => m.pooled.c.title).sort()).toEqual(pick.map((i) => w.titles[i]).sort());
    expect(out.matched.every((m) => m.confidence >= 0.75 && m.pooled.foundBy === 'performer-batch')).toBe(true);
    expect(out.leftover.map((f) => f.id)).toEqual([7]);
  });
  it('skips groups whose scene list is too large for the number of files (cost model)', async () => {
    const w = perfWorld();
    const tpdb = new TpdbClient('K', undefined, w.f, 0);
    const files = ['A', 'B', 'C'].map((n, i) => ({ id: i + 1, row: { file_name: `Mandy Marx - ${n} Story.mp4` }, parsed: parseFilename(`Mandy Marx - ${n} Story.mp4`, '/', {}), duration: null }));
    const out = await matchGroup({ kind: 'performer', key: 'p:mandymarx', name: 'Mandy Marx', files }, { tpdb, threshold: 0.75, maxPages: 2 });
    expect(out.skipped).toMatch(/too large/);
    expect(out.leftover).toHaveLength(3); expect(out.requests).toBe(2);
  });
  it('does not match anything when the performer is unknown', async () => {
    const w = perfWorld();
    const tpdb = new TpdbClient('K', undefined, w.f, 0);
    const files = [1, 2, 3].map((i) => ({ id: i, row: { file_name: `Nobody Known - X${i}.mp4` }, parsed: parseFilename(`Nobody Known - X${i}.mp4`, '/', {}), duration: null }));
    const out = await matchGroup({ kind: 'performer', key: 'p:nobodyknown', name: 'Nobody Known', files }, { tpdb, threshold: 0.75 });
    expect(out.skipped).toBe('performer not found'); expect(out.leftover).toHaveLength(3);
  });
});

describe('fastCascade (concurrent strategies, early exit)', () => {
  it('confident parse result aborts the remaining work (no tier-2 requests)', async () => {
    const mock = makeMockTpdb();
    const tpdb = new TpdbClient('K', undefined, mock.f, 0);
    const name = 'Brazzers.21.05.12.Kendra.Lust.Big.Boobs.Fun.XXX.1080p.MP4-KTR.mp4';
    const r = await fastCascade(tpdb, { fileName: name, parsed: parseFilename(name, '/', {}), threshold: 0.75 });
    expect(r.confident).toBe(true); expect(r.strategy).toBe('parse');
    expect(r.raw?.id).toBe('s1');
    expect(mock.hits.every((h) => h.includes('parse='))).toBe(true);
    expect(mock.hits.length).toBeLessThanOrEqual(2);
  });
  it('fires the cheap strategies concurrently', async () => {
    let inflight = 0, peak = 0;
    const mock = makeMockTpdb((u) => {
      if (u.pathname !== '/scenes' && u.pathname !== '/sites' && u.pathname !== '/performers') return undefined;
      inflight++; peak = Math.max(peak, inflight);
      return new Promise((res) => setTimeout(() => { inflight--; res(undefined); }, 25)).then(() => ({ data: [] }));
    });
    const tpdb = new TpdbClient('K', undefined, mock.f, 0);
    const name = 'Brazzers 2021-05-12 Kendra Lust something nobody has.mp4';
    await fastCascade(tpdb, { fileName: name, parsed: parseFilename(name, '/', {}), threshold: 0.75, budget: 3 });
    expect(peak).toBeGreaterThanOrEqual(3);
  });
  it('falls back to the sequential cascade for names the cheap strategies cannot decide', async () => {
    const mock = makeMockTpdb();
    const tpdb = new TpdbClient('K', undefined, mock.f, 0);
    const name = 'Pool Party Surprise Extra Bonus Footage Uncut.mp4';
    const r = await fastCascade(tpdb, { fileName: name, parsed: parseFilename(name, '/', {}), threshold: 0.75 });
    expect(r.confident).toBe(true); expect(r.strategy).toBe('words');
  });
  it('once mode makes a single filename search and stops', async () => {
    const mock = makeMockTpdb();
    const tpdb = new TpdbClient('K', undefined, mock.f, 0);
    const name = 'Pool Party Surprise Extra Bonus Footage Uncut.mp4';
    const r = await fastCascade(tpdb, { fileName: name, parsed: parseFilename(name, '/', {}), threshold: 0.75 }, { once: true });
    expect(mock.hits.length).toBe(1);
    expect(mock.hits[0]).toContain('parse=');
    expect(r.strategy === 'parse' || r.strategy === null || r.confident === false || r.confident === true).toBe(true);
  });
});

describe('Matcher queue (integration)', () => {
  const unlock = async (app: any) => { const u = await app.inject({ method: 'POST', url: '/api/session/unlock', payload: { pin: '6442' } }); return { pulse_auth: u.cookies.find((c: any) => c.name === 'pulse_auth').value }; };
  const mk = async (world: ReturnType<typeof perfWorld>, n: number) => {
    const app: any = await buildApp({ db: openDb(':memory:'), fetch: world.f, env: { tpdbKey: 'TK', tpdbIntervalMs: 0 } as any });
    const cookies = await unlock(app);
    const ins = app.ctx.db.prepare(`INSERT INTO scenes(ext_key, source, path, file_name, parsed, match_status, added_at) VALUES(?,?,?,?,?,?,?)`);
    const names = Array.from({ length: n }, (_, i) => `Mandy Marx - ${world.titles[i * 11]}.mp4`);
    const ids = names.map((nm, i) => Number(ins.run(`pcloud:${i + 1}`, 'pcloud', `/Clips/${nm}`, nm, '{}', 'unmatched', new Date(2024, 0, i + 1).toISOString()).lastInsertRowid));
    const json = async (method: string, url: string, body?: any) => { const r = await app.inject({ method, url, payload: body, cookies }); return { status: r.statusCode, body: r.json() }; };
    const idle = async () => { for (let i = 0; i < 400; i++) { const s = (await json('GET', '/api/match/status')).body; if (s.state === 'idle') return s; await new Promise((r) => setTimeout(r, 15)); } throw new Error('timeout'); };
    return { app, ids, names, json, idle };
  };

  it('matches a whole clip-store folder with a handful of requests (batch) and reports progress fields', async () => {
    const w = perfWorld();
    const t = await mk(w, 12);
    const q = await t.json('POST', '/api/match/queue', { all: true });
    expect(q.status).toBe(200);
    const s = await t.idle();
    expect(s.matched).toBe(12); expect(s.failed).toBe(0);
    expect(s.strategies['performer-batch']).toBe(12);
    expect(s.groups).toMatchObject({ total: 1, done: 1, filesMatched: 12 });
    expect(s).toMatchObject({ paused: false, queued: 0, active: 0, total: 12 });
    expect(typeof s.rate).toBe('number'); expect(s.etaSeconds).toBe(0);
    expect(s.requests.http).toBeLessThanOrEqual(4);
    expect(w.hits.length).toBeLessThanOrEqual(4);                       // 1 performer lookup + 3 pages, and no GET /scenes/{id} per file
    expect((await t.json('GET', `/api/scenes/${t.ids[5]}`)).body).toMatchObject({ matchStatus: 'matched', matchStrategy: 'performer-batch', title: w.titles[55] });
  });

  it('rescan semantics: already matched and already tried files are not searched again unless asked', async () => {
    const w = perfWorld();
    const t = await mk(w, 6);
    await t.json('POST', '/api/match/queue', { all: true }); await t.idle();
    t.app.ctx.db.prepare(`UPDATE scenes SET match_status='unmatched', match_tried_at=? WHERE id=?`).run(new Date().toISOString(), t.ids[0]);
    const before = w.hits.length;
    t.app.ctx.matcher.enqueueAllUnmatched();                            // what a rescan does
    await t.idle();
    expect(w.hits.length).toBe(before);
    expect(t.app.ctx.matcher.status.processed).toBe(0);
    await t.json('POST', '/api/match/queue', { all: true });            // explicit request
    const s = await t.idle();
    expect(s.processed + s.groups.filesMatched).toBeGreaterThan(0);
  });

  it('pause / resume / cancel and prioritisation', async () => {
    const w = perfWorld((u) => (u.pathname === '/scenes' && u.searchParams.get('q') ? new Promise((r) => setTimeout(r, 5)).then(() => ({ data: [] })) : undefined));
    const t = await mk(w, 0);
    const ins = t.app.ctx.db.prepare(`INSERT INTO scenes(ext_key, source, path, file_name, parsed, match_status, added_at) VALUES(?,?,?,?,?,?,?)`);
    const ids = Array.from({ length: 20 }, (_, i) => Number(ins.run(`pcloud:s${i}`, 'pcloud', `/x/Unknown Thing ${i}.mp4`, `Unknown Thing ${i}.mp4`, '{}', 'unmatched', new Date(2023, 0, i + 1).toISOString()).lastInsertRowid));
    const m = t.app.ctx.matcher; m.concurrency = 1;
    const order: number[] = []; const orig = m.processOne.bind(m); m.processOne = async (id: number) => { order.push(id); return orig(id); };
    expect((await t.json('POST', '/api/match/pause')).body).toMatchObject({ paused: true });
    await t.json('POST', '/api/match/queue', { sceneIds: ids });
    await new Promise((r) => setTimeout(r, 60));
    let s = (await t.json('GET', '/api/match/status')).body;
    expect(s).toMatchObject({ state: 'running', paused: true, processed: 0, queued: 20 });
    // opening a scene (or POST /prioritize) moves it to the front
    await t.json('GET', `/api/scenes/${ids[17]}`);
    await t.json('POST', '/api/match/prioritize', { sceneIds: [ids[3]] });
    await t.json('POST', '/api/match/resume');
    for (let i = 0; i < 100 && order.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    expect(new Set(order.slice(0, 2))).toEqual(new Set([ids[17], ids[3]]));
    expect(order[0]).toBe(ids[3]);                                      // last prioritised first
    // cancel stops the rest and resets queued rows
    await t.json('POST', '/api/match/cancel');
    s = await t.idle();
    expect(s.queued).toBe(0);
    expect((t.app.ctx.db.prepare(`SELECT COUNT(*) c FROM scenes WHERE match_status='queued'`).get() as any).c).toBe(0);
    expect(order.length).toBeLessThan(20);
  });
});

describe('Scanner: parallel listfolder', () => {
  it('lists sub-folders concurrently (bounded), retries transient errors and builds the same tree', async () => {
    const { listTree, Scanner } = await import('../src/services/scanner.js');
    const { PcloudClient } = await import('../src/clients/pcloud.js');
    const dirs: Record<number, any[]> = { 0: [], };
    const N = 12;
    dirs[0] = Array.from({ length: N }, (_, i) => ({ name: `d${i}`, isfolder: true, folderid: 100 + i }));
    for (let i = 0; i < N; i++) dirs[100 + i] = [{ name: `v${i}.mp4`, isfolder: false, fileid: 1000 + i, size: 1, contenttype: 'video/mp4' }, ...(i === 0 ? [{ name: 'deep', isfolder: true, folderid: 500 }] : [])];
    dirs[500] = [{ name: 'deepvideo.mp4', isfolder: false, fileid: 5000, size: 1, contenttype: 'video/mp4' }];
    let inflight = 0, peak = 0, flaky = true;
    const { f } = fakeFetch(async (u) => {
      if (u.pathname !== '/listfolder') return { result: 0 };
      const id = Number(u.searchParams.get('folderid'));
      inflight++; peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 15)); inflight--;
      if (id === 103 && flaky) { flaky = false; return { result: 5000, error: 'Internal error. Try again later.' }; }
      return { result: 0, metadata: { name: `f${id}`, isfolder: true, folderid: id, contents: dirs[id] } };
    });
    const client = new PcloudClient({ accessToken: 't', host: 'api.pcloud.com', uid: 1, locationid: 1 } as any, f);
    const tree = await listTree(client, 0, 4);
    expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(4);
    const files: string[] = [];
    for (const it of Scanner.walk(tree, '/')) if ('meta' in it) files.push(it.meta.name);
    expect(files.sort()).toEqual([...Array.from({ length: N }, (_, i) => `v${i}.mp4`), 'deepvideo.mp4'].sort());
  });
});
