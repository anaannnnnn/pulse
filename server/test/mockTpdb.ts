// In-memory fake of the parts of the ThePornDB API the matcher uses: /scenes (q, title, parse, date, site_id, performer_id, hash, page),
// /movies, /jav, /sites, /performers. Counts requests so tests can assert caching and strategy order.
import { fakeFetch } from './helpers.js';

const key = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const words = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

export const SITES = [
  { id: 92, uuid: 'site-92', name: 'Brazzers', short_name: 'brazzers' },
  { id: 93, uuid: 'site-93', name: 'Vixen', short_name: 'vixen' },
  { id: 94, uuid: 'site-94', name: 'Blacked', short_name: 'blacked' },
  { id: 95, uuid: 'site-95', name: 'Subby Hubby', short_name: 'subbyhubby' },
  { id: 96, uuid: 'site-96', name: 'Other Studio', short_name: 'otherstudio' },
  { id: 97, uuid: 'site-97', name: 'Brazzers Exxtra', short_name: 'brazzersexxtra', parent: { name: 'Brazzers' } },
  { id: 98, uuid: 'site-98', name: 'Bang Bros', short_name: 'bangbros' },
  { id: 99, uuid: 'site-99', name: 'S1 NO.1 STYLE', short_name: 's1' },
  { id: 100, uuid: 'site-100', name: 'Digital Playground', short_name: 'digitalplayground' },
];
export const PERFORMERS = [
  { id: 'pf-11', _id: 11, name: 'Kendra Lust', aliases: [] }, { id: 'pf-12', _id: 12, name: 'Johnny Sins', aliases: [] },
  { id: 'pf-13', _id: 13, name: 'Jane Doe', aliases: [] }, { id: 'pf-14', _id: 14, name: 'Ann Roe', aliases: [] },
  { id: 'pf-15', _id: 15, name: 'Lana Rhoades', aliases: [] }, { id: 'pf-16', _id: 16, name: 'Riley Reid', aliases: ['Riley R'] },
  { id: 'pf-17', _id: 17, name: 'Emily Willis', aliases: [] }, { id: 'pf-18', _id: 18, name: 'Daisy Stone', aliases: [] },
];
const S = (id: number) => SITES.find((s) => s.id === id)!;
const P = (...ids: number[]) => ids.map((i) => PERFORMERS.find((p) => p._id === i)!);
const scene = (id: string, title: string, date: string, site: number, perfs: number[], extra: any = {}) => ({ id, _id: id, title, date, site: S(site), site_id: site, performers: P(...perfs), duration: 1800, ...extra });

export const SCENES = [
  scene('s1', 'Big Boobs Fun', '2021-05-12', 92, [11, 12]),
  scene('s2', 'Midnight Run', '2020-01-02', 93, [13]),
  scene('s3', 'Midnight Run', '2019-03-04', 94, [14]),
  scene('s4', 'Pool Party Surprise', '2021-05-12', 92, [15, 11]),
  scene('s5', 'Sunday Brunch', '2021-06-01', 92, [15]),
  scene('s6a', 'Riley Reid', '2024-07-09', 95, [16]),
  scene('s6b', 'Riley Reid', '2023-02-02', 96, [16]),
  scene('s7', 'Weekend Getaway', '2022-02-02', 93, [15, 17]),
  scene('s8', "Daisy's Anal Stretching", '2018-02-05', 98, [18]),
  scene('s9', 'Totally Different Name', '2017-03-03', 96, [], { hashes: [{ hash: 'abcd1234abcd1234', type: 'OSHASH' }] }),
  scene('s10', 'Hall Of Fame Johnny Sins', '2020-01-01', 97, [12]),
];
export const JAV = [{ id: 'j1', _id: 'j1', title: 'My Little Therapist - Ssis-123', date: '2021-07-14', site: S(99), performers: [], external_id: 'SSIS-123' }];
export const MOVIES = [{ id: 'm1', _id: 'm1', title: 'Pirates Adventure Island', date: '2005-01-01', site: S(100), performers: [] }];

export function makeMockTpdb(extra?: (u: URL) => any) {
  const hits: string[] = [];
  const m = fakeFetch((u) => {
    if (u.host !== 'api.theporndb.net') return new Response('no', { status: 500 });
    hits.push(u.pathname + u.search);
    const o = extra?.(u);
    if (o !== undefined) return o;
    const p = u.searchParams;
    const page = (arr: any[]) => ({ data: arr.slice(0, Number(p.get('per_page') || 15)), meta: { total: arr.length } });
    if (u.pathname === '/sites') return page(SITES.filter((s) => key(s.name).includes(key(p.get('q') || '#')) || key(p.get('q') || '#').includes(key(s.name))).sort((a, b) => a.name.length - b.name.length));
    if (u.pathname === '/performers') return page(PERFORMERS.filter((x) => key(x.name).includes(key(p.get('q') || '#'))));
    if (u.pathname === '/jav') return page(JAV.filter((x) => key(x.external_id) === key(p.get('q') || '#') || key(x.title).includes(key(p.get('q') || '#'))));
    if (u.pathname === '/movies') return page(MOVIES.filter((x) => words(p.get('q') || '#').every((w) => words(x.title).includes(w))));
    if (u.pathname.startsWith('/scenes/')) { const id = u.pathname.split('/')[2]; return { data: [...SCENES, ...JAV, ...MOVIES].find((x) => x.id === id) }; }
    if (u.pathname !== '/scenes') return { data: [] };
    let r = SCENES.slice();
    const hash = p.get('hash');
    if (hash) return page(r.filter((s: any) => (s.hashes || []).some((h: any) => h.hash === hash)));
    if (p.get('parse')) {
      const k = key(p.get('parse')!);
      return page(r.filter((s) => k.includes(key(s.site.name)) && k.includes(key(s.title))));
    }
    if (p.get('q')) r = r.filter((s) => words(p.get('q')!).every((w) => words(s.title + ' ' + s.site.name).includes(w)));
    if (p.get('title')) r = r.filter((s) => key(s.title) === key(p.get('title')!));
    if (p.get('date')) r = r.filter((s) => s.date === p.get('date'));
    if (p.get('site_id')) r = r.filter((s) => String(s.site_id) === p.get('site_id'));
    if (p.get('performer_id')) r = r.filter((s) => s.performers.some((x) => String(x._id) === p.get('performer_id')));
    if (p.get('year')) r = r.filter((s) => s.date.startsWith(p.get('year')!));
    return page(r);
  });
  const store = new Map<string, any>();
  const cache = { get: (k: string) => store.get(k), set: (k: string, v: any) => store.set(k, v) };
  return { ...m, hits, cache, store };
}
