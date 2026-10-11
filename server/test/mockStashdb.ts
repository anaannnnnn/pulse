// In-memory fake of the parts of the StashDB GraphQL API the app uses (searchScenes, queryScenes, findScene, searchStudio,
// searchPerformers, findPerformer, me). Checks the `ApiKey` header like the real service (401 otherwise).
import { fakeFetch } from './helpers.js';

export const GOOD_KEY = 'GOODSTASHKEY';
const key = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const words = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

const img = (id: string, w = 1200, h = 800) => ({ id, url: `https://cdn.stash.test/${id}.jpg`, width: w, height: h });
export const STUDIOS = [
  { id: 'studio-vixen', name: 'Vixen', aliases: [], parent: null, images: [img('vixen-logo', 200, 200)], deleted: false },
  { id: 'studio-brazzers', name: 'Brazzers', aliases: [], parent: null, images: [], deleted: false },
  { id: 'studio-bz-exxtra', name: 'Brazzers Exxtra', aliases: [], parent: { id: 'studio-brazzers', name: 'Brazzers' }, images: [], deleted: false },
];
export const PERFS = [
  { id: 'perf-ava', name: 'Ava Addams', disambiguation: null, aliases: ['Ava A', 'Ava Adams'], gender: 'FEMALE', urls: [{ url: 'https://ava.test', site: { name: 'Official' } }], birth_date: '1979-09-14', death_date: null, age: 47,
    ethnicity: 'CAUCASIAN', country: 'US', eye_color: 'BROWN', hair_color: 'BRUNETTE', height: 170, cup_size: 'DD', band_size: 34, waist_size: 25, hip_size: 36, breast_type: 'FAKE',
    career_start_year: 2002, career_end_year: null, tattoos: [{ location: 'Lower back', description: 'butterfly' }], piercings: [{ location: 'Navel', description: null }],
    images: [img('ava-1', 800, 1200), img('ava-2', 600, 900)], scene_count: 120, deleted: false, merged_into_id: null },
  { id: 'perf-kendra', name: 'Kendra Lust', disambiguation: null, aliases: [], gender: 'FEMALE', urls: [], birth_date: '1977-09-18', death_date: null, age: 49, ethnicity: 'CAUCASIAN', country: 'US',
    eye_color: 'HAZEL', hair_color: 'BRUNETTE', height: 173, cup_size: 'E', band_size: 36, waist_size: 26, hip_size: 38, breast_type: 'NATURAL', career_start_year: 2009, career_end_year: null,
    tattoos: [], piercings: [], images: [img('kendra-1', 800, 1200)], scene_count: 300, deleted: false, merged_into_id: null },
  { id: 'perf-riley', name: 'Riley Reid', disambiguation: null, aliases: [], gender: 'FEMALE', urls: [], birth_date: null, death_date: null, age: null, ethnicity: null, country: null, eye_color: null, hair_color: null,
    height: null, cup_size: null, band_size: null, waist_size: null, hip_size: null, breast_type: null, career_start_year: null, career_end_year: null, tattoos: null, piercings: null, images: [], scene_count: 5, deleted: false, merged_into_id: null },
];
const S = (id: string) => STUDIOS.find((s) => s.id === id)!;
const P = (...ids: string[]) => ids.map((id) => ({ as: null, performer: PERFS.find((p) => p.id === id)! }));
const scene = (id: string, title: string, date: string, studio: string, perfs: string[], extra: any = {}) => ({
  id, title, details: `About ${title}`, release_date: date, production_date: null, duration: 1800, code: null, director: null, deleted: false,
  urls: [], studio: S(studio), tags: [{ id: 'tag-1', name: 'Brunette' }, { id: 'tag-2', name: 'Romance' }],
  images: [img(`${id}-poster`, 1280, 720), img(`${id}-tall`, 600, 900)], performers: P(...perfs), fingerprints: [], ...extra });
export const SCENES = [
  scene('st-midnight', 'Midnight Dreams', '2020-08-14', 'studio-vixen', ['perf-ava'], { fingerprints: [{ hash: 'abcd1234abcd1234', algorithm: 'OSHASH', duration: 1800 }] }),
  scene('st-bbf', 'Big Boobs Fun', '2021-05-12', 'studio-brazzers', ['perf-kendra']),   // also exists on the TPDB mock as s1 (merge test)
  scene('st-only', 'Velvet Evening Escape', '2022-03-03', 'studio-vixen', ['perf-ava', 'perf-riley']),
  scene('st-hash', 'Completely Unrelated Name', '2019-01-01', 'studio-vixen', [], { fingerprints: [{ hash: 'feedfacefeedface', algorithm: 'OSHASH', duration: 1700 }] }),
  scene('st-deleted', 'Deleted Thing', '2019-01-01', 'studio-vixen', [], { deleted: true }),
];

export function makeMockStash(opts: { key?: string; delayMs?: number; failWith?: number } = {}) {
  const goodKey = opts.key ?? GOOD_KEY;
  const calls: { op: string; vars: any; at: number; key: string | undefined }[] = [];
  const store = new Map<string, any>();
  const cache = { get: (k: string) => store.get(k), set: (k: string, v: any) => store.set(k, v) };
  const m = fakeFetch(async (u, init) => {
    if (u.host !== 'stashdb.org' && u.host !== 'stash.test') return new Response('no', { status: 500 });
    const hdr = init?.headers || {};
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.failWith) return new Response('', { status: opts.failWith });
    if (hdr.ApiKey !== goodKey) return new Response('', { status: 401 });
    const { query, variables: v = {} } = JSON.parse(String(init.body));
    const op = (String(query).match(/\b(searchScenes|searchScene|queryScenes|findScene|searchStudio|searchPerformers|searchPerformer|findPerformer|me)\b/) || [])[1] || 'unknown';
    calls.push({ op, vars: v, at: Date.now(), key: hdr.ApiKey });
    const data = (d: any) => ({ data: d });
    if (op === 'me') return data({ me: { name: 'tester' } });
    if (op === 'findScene') { const s = SCENES.find((x) => x.id === v.id); return data({ findScene: s || null }); }
    if (op === 'findPerformer') return data({ findPerformer: PERFS.find((x) => x.id === v.id) || null });
    if (op === 'searchStudio') return data({ searchStudio: STUDIOS.filter((s) => key(s.name).includes(key(v.t)) || key(v.t).includes(key(s.name))).slice(0, v.n || 8) });
    if (op === 'searchPerformers') return data({ searchPerformers: { performers: PERFS.filter((p) => [p.name, ...p.aliases].some((n) => key(n).includes(key(v.t)))).slice(0, v.n || 8) } });
    if (op === 'searchScenes') {
      const w = words(v.t);
      return data({ searchScenes: { scenes: SCENES.filter((s) => w.length && w.every((x) => words(`${s.title} ${s.studio.name} ${s.performers.map((p) => p.performer.name).join(' ')}`).includes(x))).slice(0, v.n || 10) } });
    }
    if (op === 'queryScenes') {
      const i = v.i; let r = SCENES.slice();
      if (i.studios) r = r.filter((s) => i.studios.value.includes(s.studio.id));
      if (i.performers) r = r.filter((s) => i.performers.value.every((id: string) => s.performers.some((p) => p.performer.id === id)));
      if (i.date) r = r.filter((s) => s.release_date === i.date.value);
      if (i.text) r = r.filter((s) => words(i.text).every((x) => words(s.title).includes(x)));
      if (i.fingerprints) r = r.filter((s) => s.fingerprints.some((f: any) => i.fingerprints.value.includes(f.hash)));
      return data({ queryScenes: { count: r.length, scenes: r.slice(0, i.per_page) } });
    }
    return { errors: [{ message: 'unknown operation' }] };
  });
  return { ...m, calls, cache, store, key: goodKey };
}
