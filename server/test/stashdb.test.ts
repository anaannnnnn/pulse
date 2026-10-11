import { describe, it, expect } from 'vitest';
import { TpdbClient } from '../src/clients/tpdb.js';
import { StashDbClient, normalizeScene, toEngineShape } from '../src/clients/stashdb.js';
import { parseFilename } from '../src/parser.js';
import { mergeProviders, runCascade } from '../src/services/matchEngine.js';
import { mergeDetails } from '../src/services/stashApply.js';
import { makeMockTpdb } from './mockTpdb.js';
import { GOOD_KEY, SCENES, makeMockStash } from './mockStashdb.js';

function setup(opts: { stashKey?: string; stashDelay?: number; tpdbDelay?: number; extra?: any } = {}) {
  const t = makeMockTpdb(opts.tpdbDelay ? undefined : undefined);
  const slowFetch: typeof fetch = opts.tpdbDelay ? (async (i: any, init?: any) => { await new Promise((r) => setTimeout(r, opts.tpdbDelay)); return t.f(i, init); }) as any : t.f;
  const tpdb = new TpdbClient('KEY', t.cache, slowFetch, 0);
  const s = makeMockStash({ delayMs: opts.stashDelay });
  const stash = new StashDbClient(opts.stashKey ?? GOOD_KEY, s.cache, s.f, 0);
  const run = (fileName: string, folder = '', extraIn: any = {}) =>
    runCascade(tpdb, { fileName, folderPath: folder, parsed: parseFilename(fileName, folder), threshold: 0.75, stash, ...extraIn });
  return { t, s, tpdb, stash, run };
}

describe('StashDbClient', () => {
  it('sends the ApiKey header and normalises scenes + performers', async () => {
    const { s, stash } = setup();
    const r = await stash.searchScenes('midnight dreams');
    expect(r[0].id).toBe('st-midnight');
    expect(s.calls[0].key).toBe(GOOD_KEY);
    const sc = r[0];
    expect(sc.source).toBe('stashdb');
    expect(sc.studio?.name).toBe('Vixen');
    expect(sc.poster).toContain('st-midnight-tall'.slice(0, 5));   // largest image
    const p = sc.performers[0];
    expect(p.aliases).toContain('Ava A');
    expect(p.details.extras).toMatchObject({ birthday: '1979-09-14', measurements: '34DD-25-36', height: '170cm', hair_colour: 'Brunette', gender: 'Female', career_start_year: 2002 });
    expect(p.details.extras.tattoos).toContain('butterfly');
    expect(p.details.posters.length).toBe(2);
    // engine shape has what the scorer reads
    const e = toEngineShape(sc);
    expect(e.site.name).toBe('Vixen'); expect(e.performers[0].name).toBe('Ava Addams'); expect(e.date).toBe('2020-08-14');
  });
  it('drops deleted scenes and caches non-empty answers only', async () => {
    const { s, stash } = setup();
    expect((await stash.searchScenes('deleted thing')).length).toBe(0);   // exists but is flagged deleted
    expect((await stash.searchScenes('nothing matches this')).length).toBe(0);
    expect((await stash.searchScenes('nothing matches this')).length).toBe(0);
    expect(s.calls.length).toBe(3);                       // empty answers are not cached
    await stash.searchScenes('midnight dreams'); await stash.searchScenes('midnight dreams');
    expect(s.calls.length).toBe(4);                       // non-empty one is
  });
  it('test(): ok, unauthorized, not configured, unreachable — never leaks the key', async () => {
    const good = setup().stash;
    expect(await good.test()).toMatchObject({ ok: true, status: 'ok' });
    const bad = setup({ stashKey: 'WRONGKEYWRONGKEY1234' }).stash;
    const r = await bad.test();
    expect(r).toMatchObject({ ok: false, status: 'unauthorized' });
    expect(JSON.stringify(r)).not.toContain('WRONGKEY');
    expect(r.hint).toMatch(/401|rejected/i);
    const none = new StashDbClient('', undefined, fetch);
    expect(await none.test()).toMatchObject({ ok: false, status: 'not_configured' });
    const down = new StashDbClient('K', undefined, (async () => { throw new TypeError('fetch failed'); }) as any);
    expect(await down.test()).toMatchObject({ ok: false, status: 'unreachable' });
  });
  it('after a 401 the key is not hammered again (circuit breaker), test() resets it', async () => {
    const { s, stash } = setup({ stashKey: 'BAD' });
    await expect(stash.searchScenes('x y')).rejects.toMatchObject({ code: 'stashdb_auth' });
    const n = s.calls.length;
    await expect(stash.searchScenes('x z')).rejects.toMatchObject({ code: 'stashdb_auth' });
    expect(s.f).toBeTruthy(); expect(s.calls.length).toBe(n);
  });
  it('fingerprint lookup uses queryScenes with hashes', async () => {
    const { stash } = setup();
    const r = await stash.byFingerprints({ oshash: 'ABCD1234ABCD1234' });
    expect(r.map((x) => x.id)).toEqual(['st-midnight']);
    expect(await stash.byFingerprints({ oshash: 'not hex!' })).toEqual([]);
  });
  it('falls back to the legacy searchScene field when the server rejects searchScenes (422)', async () => {
    const seen: string[] = [];
    const f = (async (_u: any, init: any) => {
      const q = String(JSON.parse(init.body).query);
      seen.push(q.includes('searchScenes') ? 'new' : 'legacy');
      if (q.includes('searchScenes')) return new Response(JSON.stringify({ errors: [{ message: 'Cannot query field "searchScenes" on type "Query".' }] }), { status: 422 });
      return new Response(JSON.stringify({ data: { searchScene: [SCENES[0]] } }), { status: 200 });
    }) as any;
    const c = new StashDbClient('K', undefined, f, 0);
    expect((await c.searchScenes('midnight dreams'))[0].id).toBe('st-midnight');
    expect(seen).toEqual(['new', 'legacy']);
  });
  it('normalizeScene tolerates sparse data', () => {
    const n = normalizeScene({ id: 'x', title: null, release_date: null, studio: null, performers: [], tags: [], images: [], urls: [] });
    expect(n).toMatchObject({ title: '', date: null, studio: null, poster: null });
  });
});

describe('cascade with both providers', () => {
  it('matches a scene that only exists on StashDB', async () => {
    const { run } = setup();
    const r = await run('Vixen - Ava Addams - Velvet Evening Escape (2022-03-03).mp4');
    expect(r.best?.source).toBe('stashdb');
    expect(r.best?.tpdbId).toBe('st-only');
    expect(r.confident).toBe(true);
    expect(r.candidates.every((c) => c.source)).toBe(true);
  });
  it('merges the same scene found on both providers (prefers TPDB, remembers the StashDB id)', async () => {
    const { run } = setup();
    const r = await run('Brazzers - Kendra Lust - Big Boobs Fun (2021-05-12) 1080p.mp4');
    expect(r.best?.source).toBe('tpdb');
    expect(r.best?.tpdbId).toBe('s1');
    expect(r.best?.alsoOn).toEqual([{ source: 'stashdb', id: 'st-bbf' }]);
    expect(r.candidates.filter((c) => c.title === 'Big Boobs Fun').length).toBe(1);
  });
  it('queries both providers in PARALLEL, not sequentially', async () => {
    const { run, s, t } = setup({ stashDelay: 120, tpdbDelay: 120 });
    const t0 = Date.now();
    // unknown to both -> every stage runs; the point is the two tracks overlap in time
    await run('zzz qqq unknownthing xxyy.mp4');
    const stashFirst = s.calls[0]?.at ?? Infinity;
    const tpdbCalls = t.calls.length;
    expect(tpdbCalls).toBeGreaterThan(1);
    expect(stashFirst - t0).toBeLessThan(120 * 2);        // StashDB started while the first TPDB request was still in flight
  });
  it('stops waiting for StashDB when ThePornDB is already confident', async () => {
    const { run } = setup({ stashDelay: 400 });
    const t0 = Date.now();
    const r = await run('Brazzers - Kendra Lust - Big Boobs Fun (2021-05-12) 1080p.mp4');
    expect(r.best?.tpdbId).toBe('s1');
    expect(Date.now() - t0).toBeLessThan(1500);
  });
  it('works StashDB-only when ThePornDB is switched off', async () => {
    const { run, t } = setup();
    const r = await run('Midnight Dreams Vixen 2020-08-14.mp4', '', { useTpdb: false });
    expect(r.best?.source).toBe('stashdb');
    expect(r.best?.tpdbId).toBe('st-midnight');
    expect(t.calls.length).toBe(0);
  });
  it('finds a scene by fingerprint when the name says nothing', async () => {
    const { run } = setup();
    const r = await run('IMG_2231.mov', '', { fingerprints: { oshash: 'feedfaceFEEDFACE' } });
    expect(r.best?.tpdbId).toBe('st-hash');
    expect(r.best?.matchedBy).toBe('hash');
    expect(r.best!.confidence).toBeGreaterThanOrEqual(0.97);
  });
  it('computes the OSHASH at most once and reports it', async () => {
    const { run } = setup();
    let n = 0; const seen: string[] = [];
    const r = await run('IMG_2231.mov', '', { hash: async () => { n++; return 'feedfacefeedface'; }, onHash: (h: string) => seen.push(h) });
    expect(r.best?.tpdbId).toBe('st-hash');
    expect(n).toBe(1); expect(seen).toEqual(['feedfacefeedface']);
  });
  it('a rejected StashDB key never breaks the ThePornDB result and is reported in errors', async () => {
    const { run } = setup({ stashKey: 'WRONGKEY' });
    const r = await run('Brazzers - Kendra Lust - Big Boobs Fun (2021-05-12) 1080p.mp4');
    expect(r.best?.tpdbId).toBe('s1');
    expect(r.errors.some((e) => e.code === 'stashdb_auth')).toBe(true);
    expect(JSON.stringify(r)).not.toContain('WRONGKEY');
  });
  it('manual search returns candidates from both providers', async () => {
    const { run } = setup();
    const r = await run('x.mp4', '', { query: 'Midnight Dreams' });
    expect(r.candidates.some((c) => c.source === 'stashdb' && c.tpdbId === 'st-midnight')).toBe(true);
  });
  it('mergeProviders keeps same-provider look-alikes separate', () => {
    const mk = (source: any, id: string, conf: number) => ({ source, key: `${source}:${id}`, type: 'scene', x: {}, c: { tpdbId: id, type: 'scene', title: 'Same', date: '2020-01-01', studio: null, performers: [], poster: null, duration: null, url: null }, studioKeys: [], foundBy: 'title', conf }) as any;
    const out = mergeProviders([mk('tpdb', 'a', 0.9), mk('tpdb', 'b', 0.85), mk('stashdb', 'c', 0.8)]);
    expect(out.map((p: any) => p.c.tpdbId)).toEqual(['a', 'b']);
    expect(out[0].alsoOn).toEqual([{ source: 'stashdb', id: 'c' }]);
  });
});

describe('mergeDetails', () => {
  it('existing values win, gaps are filled, aliases / posters / links are unioned', () => {
    const base = { name: 'A', aliases: ['x'], bio: 'bio', posters: [{ url: 'u1' }], extras: { birthday: '1990-01-01', height: null, links: { Site: 's' } } };
    const add = { aliases: ['x', 'y'], bio: 'other', posters: [{ url: 'u1' }, { url: 'u2' }], extras: { birthday: '1991-01-01', height: '170cm', links: { StashDB: 'z' } } };
    const m = mergeDetails(base, add);
    expect(m.bio).toBe('bio'); expect(m.aliases).toEqual(['x', 'y']); expect(m.posters.map((p: any) => p.url)).toEqual(['u1', 'u2']);
    expect(m.extras).toMatchObject({ birthday: '1990-01-01', height: '170cm', links: { Site: 's', StashDB: 'z' } });
  });
});
void SCENES;
