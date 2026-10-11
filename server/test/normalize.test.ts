import { describe, it, expect } from 'vitest';
import { parseFilename, extractDate, splitCamel } from '../src/parser.js';
import { levenshtein, levRatio, dice, fuzzySim, tokenEq, sigTokens } from '../src/text.js';
import { oshash } from '../src/hash.js';

type Exp = { studio?: string | null; date?: string | null; words?: string; jav?: string | null; res?: string | null; performers?: string[] };
const cases: [string, Exp][] = [
  // scene-release style with every date flavour
  ['Brazzers.21.05.12.Kendra.Lust.Big.Boobs.Fun.XXX.1080p.MP4-KTR.mp4', { studio: 'Brazzers', date: '2021-05-12', words: 'Kendra Lust Big Boobs Fun', res: '1080p' }],
  ['BraZZers.21.05.12.Name.Name.Title.mp4', { studio: 'BraZZers', date: '2021-05-12', words: 'Name Name Title' }],
  ['Vixen.2022.01.05.Some.Great.Title.2160p.mkv', { studio: 'Vixen', date: '2022-01-05', words: 'Some Great Title', res: '2160p' }],
  ['Vixen 12.05.2021 Jane Doe Lovely Day x265 HEVC 2160p.mkv', { studio: 'Vixen', date: '2021-05-12', words: 'Jane Doe Lovely Day', res: '2160p' }],
  ['bangbros_2021-05-12_Lana-Rhoades-Pool-Party_1080p.mp4', { studio: 'bangbros', date: '2021-05-12', words: 'Lana Rhoades Pool Party' }],
  ['20210512-tushy-emily-willis-anal.mp4', { studio: 'tushy', date: '2021-05-12', words: 'Emily Willis Anal' }],
  ['Brazzers 210512 Jane Doe Big Title.mp4', { studio: 'Brazzers', date: '2021-05-12', words: 'Jane Doe Big Title' }],
  ['12 May 2021 - Blacked - Name Here - Title.mp4', { studio: 'Blacked', date: '2021-05-12', words: 'Name Here Title' }],
  ['Blacked - May 12, 2021 - Some Title.mp4', { date: '2021-05-12' }],
  ['TeamSkeet.20.01.30.Some.Name.And.Another.Girl.Cool.Title.XXX.720p.HEVC.x265.PRT[XvX].mp4', { studio: 'TeamSkeet', date: '2020-01-30', words: 'Some Name Another Girl Cool Title', performers: ['Some Name', 'Another Girl'] }],
  ['NaughtyAmerica.19.12.31.Jane.Doe.My.Friends.Hot.Mom.XXX.SD.MP4-WRB.mp4', { studio: 'NaughtyAmerica', date: '2019-12-31', words: 'Jane Doe My Friends Hot Mom' }],
  ['2023-07-04 - Blacked - Jane Doe, Ann Roe - Summer Story 720p.mp4', { studio: 'Blacked', date: '2023-07-04', words: 'Jane Doe Ann Roe Summer Story', performers: ['Jane Doe', 'Ann Roe'] }],
  ['Realitykings.18.03.04.Lana.Rhoades.Mega.Title.480p.WEB-DL.mp4', { studio: 'Realitykings', date: '2018-03-04', words: 'Lana Rhoades Mega Title', res: '480p' }],
  ['31.12.2020 Vixen Last Night.mp4', { date: '2020-12-31' }],
  // junk / separators / camelCase
  ['riley-reid-hot-night-1080p-web-dl-xxx.mp4', { words: 'riley reid hot night', res: '1080p' }],
  ['Hot_Night_by_Riley_Reid_[720p]_(2).mp4', { words: 'Hot Night by Riley Reid', res: '720p' }],
  ['Hot.Night.XXX.1080p.H.264.AAC.5000kbps.mp4', { words: 'Hot Night', res: '1080p' }],
  ['Hot Night [x264][AAC][1920x1080][A1B2C3D4].mkv', { words: 'Hot Night' }],
  ['BigTitsAtWork - Busty Boss.mkv', { studio: 'BigTitsAtWork', words: 'Busty Boss' }],
  ['BigMeatForValentinaSoSweet.mp4', { words: 'Big Meat For Valentina So Sweet' }],
  ['Big Boobs Fun (1).mp4', { words: 'Big Boobs Fun' }],
  ['Big Boobs Fun - Copy.mp4', { words: 'Big Boobs Fun' }],
  ['Big Boobs Fun copy 2.mp4', { words: 'Big Boobs Fun' }],
  ['Big+Boobs+Fun.mp4', { words: 'Big Boobs Fun' }],
  ['  Big   Boobs    Fun  .mp4', { words: 'Big Boobs Fun' }],
  ['www.NewPorn.com - Riley Reid - Hot Night.mp4', { studio: 'NewPorn', words: 'Riley Reid Hot Night' }],
  ['[www.site.xxx] Hot Night 1080p.mp4', { studio: 'site', words: 'Hot Night' }],
  ['Brazzers.com - Jane Doe - Title.mp4', { studio: 'Brazzers', words: 'Jane Doe Title', performers: ['Jane Doe'] }],
  ['Hot Night 4K UHD HDR 60fps.mp4', { words: 'Hot Night', res: '2160p' }],
  ['Hot.Night.Blu-Ray.x265.10bit-GRP.mkv', { words: 'Hot Night' }],
  ['Hot Night FullHD SD HD.avi', { words: 'Hot Night' }],
  ['Hot Night.flv', { words: 'Hot Night' }],
  ['Hot Night.wmv', { words: 'Hot Night' }],
  ['Hot Night.m4v', { words: 'Hot Night' }],
  ['Hot Night.ts', { words: 'Hot Night' }],
  ['Hot Night.webm', { words: 'Hot Night' }],
  ['Hot Night.MOV', { words: 'Hot Night' }],
  // studio detected from a leading known studio
  ['Naughty America - Jane Doe - My Friends Hot Mom (copy).mp4', { studio: 'Naughty America', words: 'Jane Doe My Friends Hot Mom' }],
  ['Brazzers Big Boobs Fun.mp4', { studio: 'Brazzers', words: 'Big Boobs Fun' }],
  // JAV
  ['SSIS-123.mp4', { jav: 'SSIS-123' }],
  ['ssis123 title [1080p].mp4', { jav: 'SSIS-123', words: 'title' }],
  ['FC2-PPV-1234567.mp4', { jav: 'FC2-PPV-1234567' }],
  ['[Sample] ABP-001 Some Title.mp4', { jav: 'ABP-001' }],
  // non-JAV lookalikes
  ['IMG_2231.mov', { jav: null }],
  ['Hot Night x264 AAC.mp4', { jav: null, words: 'Hot Night' }],
  ['Part 2 Hot Night.mp4', { jav: null }],
];

describe('filename normalisation', () => {
  for (const [name, e] of cases) {
    it(name, () => {
      const p = parseFilename(name);
      if (e.studio !== undefined) expect(p.studio).toBe(e.studio);
      if (e.date !== undefined) expect(p.date).toBe(e.date);
      if (e.words !== undefined) expect(p.words!.join(' ')).toBe(e.words);
      if (e.jav !== undefined) expect(p.jav).toBe(e.jav);
      if (e.res !== undefined) expect(p.resolution).toBe(e.res);
      if (e.performers) expect(p.performers).toEqual(e.performers);
      expect(p.query.length).toBeGreaterThan(0);
      expect(p.cleanTitle).toBe(p.words!.join(' '));
      // junk never survives in the cleaned words
      expect(p.words!.join(' ')).not.toMatch(/\b(1080p|720p|x264|x265|hevc|web-?dl|xxx|mp4|aac|kbps)\b/i);
    });
  }

  it('strips the file extension for every supported video type', () => {
    for (const ext of ['mp4', 'mkv', 'mov', 'avi', 'm4v', 'webm', 'ts', 'wmv', 'flv']) {
      const p = parseFilename(`Some Title.${ext}`);
      expect(p.extension).toBe(ext);
      expect(p.title).toBe('Some Title');
    }
  });

  it('uses folder names as hints but ignores generic ones', () => {
    const p = parseFilename('Midnight Run.mp4', '/Videos/Downloads/Vixen');
    expect(p.studio).toBe('Vixen');
    expect(p.folderHints).toEqual(['Vixen']);
    const q = parseFilename('Midnight Run.mp4', '/Videos/Riley Reid/Completed');
    expect(q.folderHints).toEqual(['Riley Reid']);
    expect(q.studio).toBeNull();
  });

  it('learns studios from the library', () => {
    expect(parseFilename('Obscure Studio Hot Night.mp4').studio).toBeNull();
    expect(parseFilename('Obscure Studio Hot Night.mp4', '', { knownStudios: ['Obscure'] }).studio).toBe('Obscure');
  });

  it('extractDate understands many formats and rejects impossible dates', () => {
    expect(extractDate('x 2021-05-12 y')?.date).toBe('2021-05-12');
    expect(extractDate('x 2021.05.12 y')?.date).toBe('2021-05-12');
    expect(extractDate('x 21.05.12 y')?.date).toBe('2021-05-12');
    expect(extractDate('x 12.05.2021 y')?.date).toBe('2021-05-12');
    expect(extractDate('x 05.12.2021 y')?.date).toBe('2021-12-05'); // ambiguous -> DD.MM.YYYY
    expect(extractDate('x 05.25.2021 y')?.date).toBe('2021-05-25'); // only valid as MM.DD.YYYY
    expect(extractDate('x 20210512 y')?.date).toBe('2021-05-12');
    expect(extractDate('x 12 May 2021 y')?.date).toBe('2021-05-12');
    expect(extractDate('x May 12, 2021 y')?.date).toBe('2021-05-12');
    expect(extractDate('x 2021-13-45 y')).toBeNull();
    expect(extractDate('x 1080p60 y')).toBeNull();
    expect(extractDate('x 2021-02-30 y')).toBeNull();
  });

  it('splitCamel splits real camelCase but leaves names alone', () => {
    expect(splitCamel('BigTitsAtWork')).toBe('Big Tits At Work');
    expect(splitCamel('McKenzie')).toBe('McKenzie');
    expect(splitCamel('BraZZers')).toBe('BraZZers');
    expect(splitCamel('DeVille')).toBe('DeVille');
  });
});

describe('text similarity', () => {
  it('levenshtein / dice / fuzzy', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levRatio('abc', 'abc')).toBe(1);
    expect(dice('night', 'nacht')).toBeCloseTo(0.25, 2);
    expect(fuzzySim('Aerolineas Tittyfuk', 'Aerolineas Tittyfuck')).toBeGreaterThan(0.9);
    expect(fuzzySim('Hot Night', 'Cold Morning')).toBeLessThan(0.4);
  });
  it('tokenEq tolerates plurals and one-letter typos on longer words only', () => {
    expect(tokenEq('boobs', 'boob')).toBe(true);
    expect(tokenEq('tittyfuk', 'tittyfuck')).toBe(true);
    expect(tokenEq('cat', 'cut')).toBe(false);
  });
  it('sigTokens drops stop words', () => {
    expect(sigTokens('The Hot Night of the Year')).toEqual(['hot', 'night', 'year']);
  });
});

describe('oshash', () => {
  it('matches a straightforward reference implementation', () => {
    const size = 300000;
    const head = new Uint8Array(65536).map((_, i) => (i * 7 + 3) & 255);
    const tail = new Uint8Array(65536).map((_, i) => (i * 13 + 5) & 255);
    let ref = BigInt(size);
    for (const b of [head, tail]) for (let i = 0; i < b.length; i += 8) { let w = 0n; for (let k = 7; k >= 0; k--) w = (w << 8n) | BigInt(b[i + k]); ref = (ref + w) & 0xffffffffffffffffn; }
    expect(oshash(size, head, tail)).toBe(ref.toString(16).padStart(16, '0'));
    expect(oshash(1000, head, tail)).toBeNull();
  });
});
