import { describe, it, expect } from 'vitest';
import { TpdbClient } from '../src/clients/tpdb.js';
import { parseFilename } from '../src/parser.js';
import { runCascade } from '../src/services/matchEngine.js';
import { makeMockTpdb } from './mockTpdb.js';

function setup(extra?: (u: URL) => any) {
  const m = makeMockTpdb(extra);
  const tpdb = new TpdbClient('KEY', m.cache, m.f, 0);
  const run = (fileName: string, folder = '', extraIn: any = {}) => runCascade(tpdb, { fileName, folderPath: folder, parsed: parseFilename(fileName, folder), threshold: 0.75, ...extraIn });
  return { ...m, tpdb, run };
}

describe('match cascade (mocked TPDB)', () => {
  const cases: [string, string, string, string][] = [
    // [file name, folder, expected scene id, expected strategy (first discovery)]
    ['Brazzers.21.05.12.Kendra.Lust.Big.Boobs.Fun.XXX.1080p.MP4-KTR.mp4', '', 's1', 'parse'],
    ['Brazzers - Kendra Lust - Big Boobs Fun (2021-05-12) 1080p.mp4', '', 's1', 'parse'],
    ['big boobs fun.mp4', '', 's1', 'title'],
    ['BigBoobsFun.mp4', '', 's1', 'title'],
    ['big_boobs_fun_[720p]_x264.mkv', '', 's1', 'title'],
    ['Big Boobs Fun (1).mp4', '', 's1', 'title'],
    ['Big.Boobs.Fun.WEB-DL.H.264.AAC.2160p.mp4', '', 's1', 'title'],
    ['www.Brazzers.com - Big Boobs Fun.mp4', '', 's1', 'parse'],
    ['Brazzers 21.06.01.mp4', '', 's5', 'studio+date'],
    ['brazzers_2021-06-01_1080p.mp4', '', 's5', 'studio+date'],
    ['Emily Willis Weekend Getaway.mp4', '', 's7', 'performer'],
    ['Pool Party Surprise Extra Bonus Footage Uncut.mp4', '', 's4', 'words'],
    ['Pool Party Surprise 2021-05-12 Brazzers Kendra Lust Lana Rhoades.mp4', '', 's4', 'parse'],
    ['Midnight Run.mp4', '/Videos/Vixen', 's2', 'parse'],
    ['Midnight Run.mp4', '/Media/Blacked', 's3', 'parse'],
    ['Brazzers.21.05.13.Big.Boobs.Fun.mp4', '', 's1', 'parse'], // one day off
    ['Daisys Anal Stretching BangBros.mp4', '', 's8', 'parse'],
    ['Daisy Anal Stretching Extended Cut.mp4', '', 's8', 'words'],
  ];
  for (const [name, folder, id, strat] of cases) {
    it(`${name}${folder ? ` in ${folder}` : ''} -> ${id} via ${strat}`, async () => {
      const { run } = setup();
      const r = await run(name, folder);
      expect(r.best?.tpdbId, JSON.stringify(r.alternatives)).toBe(id);
      expect(r.confident, `confidence ${r.best?.confidence}`).toBe(true);
      expect(r.strategy).toBe(strat);
    });
  }

  it('stops at the first confident strategy (does not spend the whole budget)', async () => {
    const { run, hits } = setup();
    const r = await run('Brazzers.21.05.12.Kendra.Lust.Big.Boobs.Fun.XXX.1080p.MP4-KTR.mp4');
    expect(r.queries).toBe(1);
    expect(hits).toHaveLength(1);
  });

  it('JAV codes go to the /jav endpoint', async () => {
    const { run, hits } = setup();
    const r = await run('SSIS-123 Therapist [1080p].mp4');
    expect(r.best).toMatchObject({ tpdbId: 'j1', type: 'jav', matchedBy: 'jav' });
    expect(r.confident).toBe(true);
    expect(hits[0]).toMatch(/^\/jav\?/);
  });

  it('falls through to the movies endpoint', async () => {
    const { run } = setup();
    const r = await run('pirates adventure island 2005.mp4');
    expect(r.best).toMatchObject({ tpdbId: 'm1', type: 'movie' });
    expect(r.confident).toBe(true);
    expect(r.strategy).toBe('movie');
  });

  it('uses the optional hash strategy last, only when everything else failed', async () => {
    const { run, hits } = setup();
    let called = 0;
    const r = await run('IMG_0003.mov', '', { hash: async () => { called++; return 'abcd1234abcd1234'; } });
    expect(called).toBe(1);
    expect(r.best).toMatchObject({ tpdbId: 's9', matchedBy: 'hash' });
    expect(r.confident).toBe(true);
    expect(hits.some((h) => h.includes('hash=abcd1234abcd1234'))).toBe(true);
    // not consulted when a normal strategy already matched
    called = 0;
    await run('big boobs fun.mp4', '', { hash: async () => { called++; return 'abcd1234abcd1234'; } });
    expect(called).toBe(0);
  });

  it('does not auto-match ambiguous or junk names, and keeps <=5 sorted alternatives', async () => {
    const { run } = setup();
    const amb = await run('Riley Reid.mp4');
    expect(amb.confident).toBe(false);
    expect(amb.alternatives.length).toBeGreaterThan(0);
    const junk = await run('IMG_0001.mov');
    expect(junk.confident).toBe(false);
    const same = await run('Brazzers 21.05.12.mp4'); // two Brazzers scenes that day, nothing else to tell them apart
    expect(same.confident).toBe(false);
    expect(same.alternatives.slice(0, 2).map((a) => a.tpdbId).sort()).toEqual(['s1', 's4']);
    for (const r of [amb, junk, same]) {
      expect(r.alternatives.length).toBeLessThanOrEqual(5);
      const scores = r.alternatives.map((a) => a.confidence);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    }
  });

  it('caches every query: a second run issues no new HTTP requests', async () => {
    const { run, hits } = setup();
    await run('Pool Party Surprise Extra Bonus Footage Uncut.mp4');
    const n = hits.length;
    expect(n).toBeGreaterThan(2);
    const r = await run('Pool Party Surprise Extra Bonus Footage Uncut.mp4');
    expect(hits.length).toBe(n);
    expect(r.best?.tpdbId).toBe('s4');
  });

  it('manual query search explores several variants and never needs to be confident', async () => {
    const { run } = setup();
    const r = await run('whatever.mp4', '', { query: 'midnight run vixen' });
    expect(r.best?.tpdbId).toBe('s2');
    expect(r.candidates.map((c) => c.tpdbId)).toContain('s3');
    expect(r.candidates.every((c) => c.matchedBy)).toBe(true);
  });

  it('survives upstream errors / empty answers for individual queries', async () => {
    const { run } = setup((u) => (u.pathname === '/sites' ? new Response('boom', { status: 422 }) : undefined));
    const r = await run('Brazzers 21.06.01.mp4');
    expect(r.queries).toBeGreaterThan(0);
    expect(r.best).toBeTruthy();
  });
});
