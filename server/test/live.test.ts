// Live checks against real APIs using env keys. Run: npm run test:live  (keys are never printed)
import { describe, it, expect } from 'vitest';
import { TpdbClient } from '../src/clients/tpdb.js';
import { TorboxClient } from '../src/clients/torbox.js';
import { parseFilename } from '../src/parser.js';
import { runCascade } from '../src/services/matchEngine.js';

const live = process.env.LIVE === '1' || process.env.npm_lifecycle_event === 'test:live';
describe.skipIf(!live)('live APIs', () => {
  it('TPDB parse search returns scenes', async () => {
    const c = new TpdbClient(process.env.TPDB_API_KEY || '');
    const r = await c.parse('scene', 'brazzers.21.03.15', 3);
    expect(Array.isArray(r)).toBe(true);
    const s = await c.search('scene', 'riley reid', { perPage: 2 });
    expect(s.length).toBeGreaterThan(0);
    expect(s[0]).toHaveProperty('title');
    const p = await c.searchPerformers('Riley Reid');
    expect(p[0].name).toMatch(/riley/i);
  }, 30000);
  it('TorBox /user/me validates key', async () => {
    const me = await new TorboxClient(process.env.TORBOX_API_KEY || '').me();
    expect(me).toHaveProperty('plan');
  }, 30000);

  // Real-world style names for scenes known to exist on ThePornDB; a name "hits" when the confident best candidate's title contains the expectation.
  const SAMPLES: [string, string, string][] = [
    ['Brazzers.15.09.24.Kendra.Lust.Aerolineas.Tittyfuck.XXX.1080p.MP4-KTR.mp4', '', 'Aerolineas Tittyfuck'],
    ["BangBros - Luna's Visit to the Presidential Anal Office (2018-01-08) 1080p.mp4", '', "Luna's Visit to the Presidential Anal Office"],
    ['bangbros_18.01.07_valentina_nappi_big_meat_for_valentina_so_sweet.mp4', '', 'Big Meat for Valentina So Sweet'],
    ["Daisy's.Anal.Stretching.BangBros.2018.02.05.720p.mp4", '', "Daisy's Anal Stretching"],
    ['Realtor Gets Double Penetration From Monstrous Cocks.mkv', '', 'Realtor Gets Double Penetration From Monstrous Cocks'],
    ['[Bang Bros] Veronica Avluv - Realtor Gets Double Penetration From Monstrous Cocks [4K].mp4', '', 'Realtor Gets Double Penetration From Monstrous Cocks'],
    ['BigMeatForValentinaSoSweet (1).mp4', '', 'Big Meat for Valentina So Sweet'],
    ['monstrous cocks realtor double penetration.mp4', '', 'Realtor Gets Double Penetration From Monstrous Cocks'],
    ['Daisys Anal Stretching.mp4', '/Videos/Bang Bros', "Daisy's Anal Stretching"],
    ['SSIS-123.mp4', '', 'Ssis-123'],
    ['Venida.A.Chorros.Al.Final.Del.Tunel.Brazzers.15.09.24.720p.mp4', '', 'Venida A Chorros Al Final Del Tunel'],
    ['Hall of Fame Johnny Sins brazzers exxtra.mp4', '', 'Hall Of Fame Johnny Sins'],
    // harder: partial titles, performers named in the file, dropped words, wrong day
    ['Valentina Nappi Big Meat Valentina.mp4', '', 'Big Meat for Valentina So Sweet'],
    ['Bang Bros Luna Star Presidential Office.mp4', '', "Luna's Visit to the Presidential Anal Office"],
    ['Ricky Johnson Daisy Stone Stretching.mp4', '', "Daisy's Anal Stretching"],
    ['bangbros.18.02.06.daisys.anal.stretching.mp4', '', "Daisy's Anal Stretching"],
    ['18.01.08 Presidential Anal Office.mp4', '', "Luna's Visit to the Presidential Anal Office"],
  ];
  it('cascade matches real file names (live match rate)', async () => {
    const store = new Map<string, any>();
    const c = new TpdbClient(process.env.TPDB_API_KEY || '', { get: (k) => store.get(k), set: (k, v) => store.set(k, v) }, fetch, 150);
    let hits = 0;
    const lines: string[] = [];
    for (const [name, folder, expected] of SAMPLES) {
      const r = await runCascade(c, { fileName: name, folderPath: folder, parsed: parseFilename(name, folder), threshold: 0.75 });
      const ok = !!r.best && r.confident && r.best.title.toLowerCase().includes(expected.toLowerCase());
      if (ok) hits++;
      lines.push(`${ok ? 'HIT ' : 'MISS'} ${r.strategy ?? '-'} conf=${r.best?.confidence ?? '-'} q=${r.queries} :: ${name}`);
    }
    console.log(`live match rate ${hits}/${SAMPLES.length}\n${lines.join('\n')}`);
    expect(hits / SAMPLES.length).toBeGreaterThanOrEqual(0.8);
  }, 240000);
  it('a junk name is not confidently matched', async () => {
    const c = new TpdbClient(process.env.TPDB_API_KEY || '', undefined, fetch, 150);
    const r = await runCascade(c, { fileName: 'IMG_2231.mov', parsed: parseFilename('IMG_2231.mov'), threshold: 0.75, budget: 8 });
    expect(r.confident).toBe(false);
  }, 60000);
});
