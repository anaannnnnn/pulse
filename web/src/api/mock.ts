/* In-memory mock backend used for UI development and design QA (enable with ?mock=1 or VITE_API_MOCK=1).
   Data is real ThePornDB metadata captured once; no network calls. */
import raw from './mockData.json';
import type * as T from './types';
import type { Api } from './client';
import { ApiError } from './client';

const data = raw as unknown as { items: T.Item[]; performers: (T.PerformerDetail & { photo?: string })[]; sites: T.Studio[] };
const items: T.Item[] = data.items.map((i) => ({ ...i }));
const favPerf = new Set<string>();
const favSite = new Set<number>();
let prefs: T.Prefs = { autoMatch: true, autoplayNext: false, resumePlayback: true, defaultSpeed: 1, skipSeconds: 10, preferOriginal: true, blurThumbs: false, theme: 'dark' };
let pcloudConnected = true;
let folders: T.Folder[] = [
  { folderId: 1000, name: 'Studios', path: '/Media/Studios', lastScanAt: Date.now() - 3600e3, fileCount: 11 },
  { folderId: 1001, name: 'Favourites', path: '/Media/Favourites', lastScanAt: Date.now() - 3600e3, fileCount: 7 },
  { folderId: 1002, name: 'Inbox', path: '/Media/Inbox', lastScanAt: Date.now() - 3600e3, fileCount: 6 },
];
const mockSources = { tpdb: true, stashdb: true };
const wait = <X>(v: X, ms = 220) => new Promise<X>((r) => setTimeout(() => r(structuredClone(v)), ms));

function filter(q: T.ItemQuery) {
  let r = items.slice();
  if (q.q) {
    const s = q.q.toLowerCase();
    r = r.filter((i) => [i.title, i.name, i.scene?.site?.name, ...(i.scene?.performers.map((p) => p.name) || [])].some((x) => x?.toLowerCase().includes(s)));
  }
  for (const t of q.tags || []) r = r.filter((i) => i.scene?.tags.some((x) => x.id === t));
  if (q.performers?.length) r = r.filter((i) => i.scene?.performers.some((p) => q.performers!.includes(p.id)));
  if (q.sites?.length) r = r.filter((i) => i.scene?.site && q.sites!.includes(i.scene.site.id));
  if (q.yearFrom) r = r.filter((i) => Number(i.scene?.date?.slice(0, 4)) >= q.yearFrom!);
  if (q.yearTo) r = r.filter((i) => Number(i.scene?.date?.slice(0, 4)) <= q.yearTo!);
  if (q.minDuration) r = r.filter((i) => (i.duration || 0) >= q.minDuration! * 60);
  if (q.maxDuration) r = r.filter((i) => (i.duration || 0) <= q.maxDuration! * 60);
  if (q.status) r = r.filter((i) => q.status!.split(',').includes(i.matchStatus));
  if (q.favorites) r = r.filter((i) => i.favorite);
  if (q.watchlist) r = r.filter((i) => i.watchlist);
  const dir = q.order === 'asc' ? 1 : -1;
  const key: Record<string, (i: T.Item) => number | string> = {
    added: (i) => i.addedAt,
    date: (i) => i.scene?.date || '',
    title: (i) => i.title.toLowerCase(),
    duration: (i) => i.duration || 0,
    size: (i) => i.size || 0,
  };
  if (q.sort === 'random') r.sort(() => Math.random() - 0.5);
  else {
    const k = key[q.sort || 'added'];
    const d = q.sort === 'title' ? (q.order === 'desc' ? -1 : 1) : dir;
    r.sort((a, b) => (k(a) > k(b) ? d : k(a) < k(b) ? -d : 0));
  }
  return r;
}

function performerSummaries(): T.PerformerSummary[] {
  const counts = new Map<string, number>();
  items.forEach((i) => i.scene?.performers.forEach((p) => counts.set(p.id, (counts.get(p.id) || 0) + 1)));
  return data.performers
    .map((p) => ({ id: p.id, name: p.name, image: p.image, photo: p.photo, scenes: counts.get(p.id) || 0, favorite: favPerf.has(p.id) }))
    .filter((p) => p.scenes)
    .sort((a, b) => b.scenes - a.scenes || a.name.localeCompare(b.name));
}
function studioList(): T.Studio[] {
  const counts = new Map<number, number>();
  items.forEach((i) => i.scene?.site && counts.set(i.scene.site.id, (counts.get(i.scene.site.id) || 0) + 1));
  return data.sites.map((s) => ({ ...s, scenes: counts.get(s.id) || 0, favorite: favSite.has(s.id) })).sort((a, b) => b.scenes - a.scenes);
}
function tagCounts() {
  const m = new Map<number, T.Tag & { count: number }>();
  items.forEach((i) => i.scene?.tags.forEach((t) => m.set(t.id, { ...t, count: (m.get(t.id)?.count || 0) + 1 })));
  return [...m.values()].sort((a, b) => b.count - a.count);
}
const find = (id: string) => {
  const i = items.find((x) => x.id === id);
  if (!i) throw new ApiError('Not found', 404, 'not_found');
  return i;
};

export const mockApi: Api = {
  session: () => wait({ paired: true, lockEnabled: false, locked: false, lockTimeoutMin: 0 }),
  pair: () => wait({ ok: true as const }),
  unlock: () => wait({ ok: true as const }),
  lock: () => wait({ ok: true as const }),
  logout: () => wait({ ok: true as const }),
  setLock: (b) => wait({ lockEnabled: !!b.pin, lockTimeoutMin: b.timeoutMin || 0 }),
  devices: () => wait([{ id: 'a1b2c3d4', label: navigator.userAgent, createdAt: Date.now() - 86400e3, lastSeen: Date.now(), current: true }]),
  removeDevice: () => wait({}),

  home: () => {
    const perf = performerSummaries();
    const tags = tagCounts();
    const sites = studioList().filter((s) => s.scenes >= 2).slice(0, 2);
    return wait({
      featured: items.filter((i) => i.scene?.background).slice(0, 5),
      continueWatching: items.filter((i) => i.progress && !i.progress.completed).sort((a, b) => b.progress!.updatedAt - a.progress!.updatedAt),
      recentlyAdded: filter({ sort: 'added' }).slice(0, 16),
      watchlist: items.filter((i) => i.watchlist),
      favorites: items.filter((i) => i.favorite),
      performers: perf.slice(0, 16).map((p) => ({ id: p.id, name: p.name, image: p.image, c: p.scenes })),
      tags: tags.slice(0, 12).map((t) => ({ ...t, c: t.count })),
      rails: [
        ...sites.map((s) => ({ id: `site-${s.id}`, title: s.name, kind: 'site' as const, refId: s.id, items: filter({ sites: [s.id] }) })),
        ...perf.slice(0, 1).map((p) => ({ id: `perf-${p.id}`, title: `More with ${p.name}`, kind: 'performer' as const, refId: p.id, items: filter({ performers: [p.id] }) })),
        ...tags.slice(0, 1).map((t) => ({ id: `tag-${t.id}`, title: t.name, kind: 'tag' as const, refId: t.id, items: filter({ tags: [t.id] }) })),
      ],
      stats: { items: items.length, bytes: items.reduce((a, b) => a + (b.size || 0), 0), matched: items.filter((i) => i.matchStatus === 'matched').length },
    });
  },
  items: (q) => {
    const r = filter(q);
    return wait({ items: r.slice(q.offset || 0, (q.offset || 0) + (q.limit || 40)), total: r.length });
  },
  item: (id) => {
    const it = find(id);
    const related = items.filter((x) => x.id !== id && x.scene && it.scene && (x.scene.site?.id === it.scene.site?.id || x.scene.performers.some((p) => it.scene!.performers.some((q) => q.id === p.id))));
    return wait({
      item: it,
      related: related.slice(0, 12),
      parsed: { kind: 'scene', site: it.scene?.site?.name || null, date: it.scene?.date || null, year: null, jav: null, title: it.title, performers: [], resolution: it.resolution, query: it.name },
    });
  },
  facets: () =>
    wait({
      tags: tagCounts(),
      performers: performerSummaries().map((p) => ({ id: p.id, name: p.name, image: p.image, count: p.scenes })),
      sites: studioList().map((s) => ({ id: s.id, name: s.name, logo: s.logo, count: s.scenes })),
      years: { min: 2025, max: 2026 },
      counts: [
        { status: 'matched', count: items.filter((i) => i.matchStatus === 'matched').length },
        { status: 'unmatched', count: items.filter((i) => i.matchStatus === 'unmatched').length },
      ],
    }),
  performers: (q) => {
    let r = performerSummaries();
    if (q.q) r = r.filter((p) => p.name.toLowerCase().includes(q.q!.toLowerCase()));
    if (q.sort === 'name') r.sort((a, b) => a.name.localeCompare(b.name));
    return wait(r);
  },
  performer: (id) => {
    const p = data.performers.find((x) => x.id === id);
    if (!p) return Promise.reject(new ApiError('Performer not found', 404));
    return wait({
      performer: { id: p.id, name: p.name, image: p.photo || p.image, face: p.image, thumbnail: p.image, bio: p.bio, gender: null, extras: p.extras || {}, aliases: [], photos: [p.photo || p.image].filter(Boolean) as string[], favorite: favPerf.has(id) },
      items: filter({ performers: [id], sort: 'date' }),
    });
  },
  performerRemote: (id) =>
    wait({
      scenes: items
        .filter((i) => i.scene?.performers.some((p) => p.id === id))
        .slice(0, 6)
        .map((i) => ({ id: i.scene!.id, type: 'scene' as const, title: i.scene!.title || '', date: i.scene!.date, site: i.scene!.site?.name || null, poster: i.scene!.poster, performers: [], duration: i.scene!.duration, confidence: 1, inLibrary: true })),
    }),
  studios: () => wait(studioList().filter((s) => s.scenes)),
  studio: (id) => {
    const s = studioList().find((x) => x.id === id);
    if (!s) return Promise.reject(new ApiError('Studio not found', 404));
    return wait({ studio: s, items: filter({ sites: [id], sort: 'date' }) });
  },
  favorites: (list) =>
    wait({
      items: items.filter((i) => (list === 'watchlist' ? i.watchlist : i.favorite)),
      performers: list === 'favorites' ? performerSummaries().filter((p) => favPerf.has(p.id)) : [],
      studios: list === 'favorites' ? studioList().filter((s) => favSite.has(s.id)) : [],
    }),
  setFavorite: (b) => {
    if (b.kind === 'item') {
      const it = find(String(b.refId));
      if (b.list === 'watchlist') it.watchlist = b.on;
      else it.favorite = b.on;
    } else if (b.kind === 'performer') b.on ? favPerf.add(String(b.refId)) : favPerf.delete(String(b.refId));
    else b.on ? favSite.add(Number(b.refId)) : favSite.delete(Number(b.refId));
    return wait({ ok: true }, 80);
  },
  saveProgress: (key, b) => {
    const it = items.find((i) => i.id === key);
    if (it) it.progress = { position: b.position, duration: b.duration ?? null, completed: !!b.duration && b.position / b.duration > 0.94, updatedAt: Date.now() };
    return wait({ ok: true }, 20);
  },
  getProgress: (key) => wait(items.find((i) => i.id === key)?.progress || null, 20),
  clearProgress: (key) => {
    const it = items.find((i) => i.id === key);
    if (it) it.progress = null;
    return wait({ ok: true });
  },
  torboxProgress: () => wait([]),
  stream: (src) =>
    wait({
      variants:
        src.kind === 'torbox'
          ? [{ id: 'original', label: 'Original', url: '/demo/sample.mp4', transcoded: false }]
          : [
              { id: 'original', label: 'Original · 720p', url: '/demo/sample.mp4', type: 'mp4' as const, transcoded: false, fallback: '/demo/sample.mp4' },
              { id: '480p', label: '480p', url: '/demo/sample.mp4', type: 'mp4' as const, transcoded: true, height: 480 },
            ],
      subtitles: src.itemId && items.find((i) => i.id === src.itemId)?.subtitles.length ? [{ label: 'English', lang: 'en', url: '/demo/sample.vtt' }] : [],
      duration: 60,
    }),
  matchQueue: () =>
    wait({ running: false, processed: 24, matched: 22, failed: 0, current: null, lastError: null, counts: { matched: items.filter((i) => i.matchStatus === 'matched').length, unmatched: items.filter((i) => i.matchStatus === 'unmatched').length }, threshold: 0.6 }),
  runMatch: () => wait({}),
  pauseMatch: () => wait({}),
  resumeMatch: () => wait({}),
  cancelMatch: () => wait({}),
  retryUnmatched: () => wait({ requeued: items.filter((i) => i.matchStatus === 'unmatched').length }),
  matchInfo: (itemId) => {
    const it = find(itemId);
    return wait({ status: it.matchStatus, confidence: it.matchConfidence, strategy: it.matchStrategy ?? null, query: it.name.replace(/\.[^.]+$/, '').replace(/[._]+/g, ' '), alternatives: [] });
  },
  matchSearch: (p) =>
    wait(
      {
        parsed: { kind: 'scene' as const, site: null, date: null, year: null, jav: null, title: p.q || 'holiday edit final v2', performers: [], resolution: null, query: p.q || '' },
        strategy: 'words',
        confident: false,
        candidates: items
          .filter((i) => i.scene)
          .slice(0, 6)
          .map((i, n) => ({ id: i.scene!.id, type: 'scene' as const, title: i.scene!.title || '', date: i.scene!.date, site: i.scene!.site?.name || null, poster: i.scene!.poster, performers: i.scene!.performers.map((x) => x.name), duration: i.scene!.duration, confidence: Math.max(0.1, 0.82 - n * 0.14), matchedBy: ['title', 'words', 'performer', 'studio+date', 'fuzzy', 'words'][n] })),
      },
      600,
    ),
  applyMatch: (itemId, sceneId) => {
    const it = find(itemId);
    const src = items.find((i) => i.scene?.id === sceneId);
    Object.assign(it, { scene: src?.scene || null, matchStatus: 'matched', matchConfidence: 1, matchSource: 'manual', matchStrategy: 'manual', title: src?.scene?.title || it.title });
    return wait({ item: it });
  },
  unmatch: (itemId) => {
    const it = find(itemId);
    Object.assign(it, { scene: null, matchStatus: 'unmatched', matchConfidence: null, matchSource: 'manual' });
    return wait({ item: it });
  },
  ignore: (itemId) => {
    const it = find(itemId);
    Object.assign(it, { scene: null, matchStatus: 'ignored' });
    return wait({ item: it });
  },
  rematch: () => wait({}),
  tpdbTest: () => wait({ ok: true, status: 'ok' as const, hint: 'ThePornDB key works and searching works.', keyLength: 48, steps: [], sample: { query: 'Mandy Marx - Pain To Play.mp4', results: 2, first: 'Pain to Play' } }),
  stashdbTest: () => wait({ ok: true, status: 'ok' as const, hint: 'StashDB key works (signed in as demo).', path: 'direct' as const }),
  metadataSources: () => wait([{ id: 'tpdb' as const, label: 'ThePornDB', configured: true, enabled: mockSources.tpdb, active: mockSources.tpdb }, { id: 'stashdb' as const, label: 'StashDB', configured: true, enabled: mockSources.stashdb, active: mockSources.stashdb }]),
  setMetadataSource: (id, enabled) => { mockSources[id] = enabled; return wait({ ok: true }); },
  tpdbStatus: () => wait({ configured: true, ok: true, checkedAt: Date.now(), cachedResponses: 128 }),

  pcloudStatus: () =>
    wait({
      configured: true,
      connected: pcloudConnected,
      redirectUri: `${location.origin}/oauth/pcloud`,
      region: pcloudConnected ? ('EU' as const) : null,
      apiHost: pcloudConnected ? 'eapi.pcloud.com' : null,
      folders,
      scan: { running: false, folder: null, foldersDone: 3, foldersTotal: 3, found: 24, added: 0, removed: 0, startedAt: Date.now() - 3700e3, finishedAt: Date.now() - 3600e3, error: null },
      account: pcloudConnected ? { email: 'owner@example.com', premium: true, quota: 2199023255552, usedQuota: 845623353344 } : null,
      cache: pcloudConnected ? { localBytes: 8_000_000, cloudBytes: 420_000_000, entries: 14000, cloud: true } : undefined,
    }),
  pcloudStart: (mode) => wait({ url: 'https://my.pcloud.com/oauth2/authorize?client_id=demo&response_type=code', mode, redirectUri: mode === 'manual' ? null : `${location.origin}/oauth/pcloud` }),
  pcloudComplete: () => {
    pcloudConnected = true;
    return wait({ connected: true, region: 'EU', email: 'owner@example.com' });
  },
  pcloudDisconnect: () => {
    pcloudConnected = false;
    return wait({});
  },
  pcloudFolders: (parent) =>
    wait({
      folder: parent === 0 ? { folderId: 0, name: 'pCloud Drive', parentId: null, path: '/' } : { folderId: 999, name: 'Media', parentId: 0, path: '/Media' },
      folders:
        parent === 0
          ? [
              { folderId: 998, name: 'Documents', selected: false },
              { folderId: 999, name: 'Media', selected: false },
            ]
          : folders.map((f) => ({ folderId: f.folderId, name: f.name, selected: true })),
      videoCount: 0,
    }),
  setFolders: (f) => {
    folders = f;
    return wait(f);
  },
  scan: () => wait({ running: true, folder: 'Studios', foldersDone: 0, foldersTotal: folders.length, found: 0, added: 0, removed: 0, startedAt: Date.now(), finishedAt: null, error: null }),
  scanState: () => wait({ running: false, folder: null, foldersDone: 3, foldersTotal: 3, found: 24, added: 0, removed: 0, startedAt: Date.now() - 5000, finishedAt: Date.now(), error: null }),
  variants: () =>
    wait({
      duration: 60,
      original: { id: 'original', label: 'Original · 720p', height: 720, width: 1280, videoCodec: 'h264', transcoded: false },
      variants: [{ id: '480', label: '480p', height: 480, width: 854, videoCodec: 'h264', transcoded: true }],
    }),

  torboxStatus: () => wait({ linked: true, source: 'env' as const, envAvailable: true, account: { email: 'owner@example.com', plan: 'Pro', subscribed: true, premiumExpiresAt: '2027-01-14T00:00:00Z' } }),
  torboxLink: () => wait({ linked: true, source: 'user' as const, envAvailable: true }),
  torboxUnlink: () => wait({ linked: true, source: 'env' as const, envAvailable: true }),
  torboxImport: () => wait({ added: 0, seen: 0 }),
  torboxList: () =>
    wait({
      items: [
        { key: 'torrents:1', kind: 'torrents' as const, id: 1, name: 'Vixen.26.08.23.Anniversary.Collection.2160p', hash: 'a'.repeat(40), size: 18_400_000_000, progress: 1, state: 'cached', speed: 0, eta: 0, seeds: 120, peers: 4, cached: true, ready: true, createdAt: '2026-10-08T10:00:00Z', expiresAt: null, files: [{ id: 0, name: 'Part 1.mp4', path: 'Vixen/Part 1.mp4', size: 6_100_000_000, mimetype: 'video/mp4', playable: true, subtitle: false }, { id: 1, name: 'Part 2.mp4', path: 'Vixen/Part 2.mp4', size: 6_200_000_000, mimetype: 'video/mp4', playable: true, subtitle: false }] },
        { key: 'torrents:2', kind: 'torrents' as const, id: 2, name: 'BrazzersExxtra.26.10.05.Best.Of.1080p', hash: 'b'.repeat(40), size: 4_200_000_000, progress: 0.62, state: 'downloading', speed: 18_400_000, eta: 92, seeds: 38, peers: 12, cached: false, ready: false, createdAt: '2026-10-09T09:00:00Z', expiresAt: null, files: [] },
        { key: 'webdl:3', kind: 'webdl' as const, id: 3, name: 'sample-trailer.mp4', hash: null, size: 210_000_000, progress: 1, state: 'completed', speed: 0, eta: 0, seeds: null, peers: null, cached: true, ready: true, createdAt: '2026-10-07T09:00:00Z', expiresAt: null, files: [{ id: 0, name: 'sample-trailer.mp4', path: 'sample-trailer.mp4', size: 210_000_000, mimetype: 'video/mp4', playable: true, subtitle: false }] },
      ],
    }),
  torboxAdd: () => wait({ ok: true }, 500),
  torboxControl: () => wait({ ok: true }),
  torboxCached: (h) => wait({ cached: Object.fromEntries(h.map((x) => [x, true])) }),
  torboxSaveToPcloud: () => wait({ ok: true }),

  prefs: () => wait(prefs),
  setPrefs: (p) => {
    prefs = { ...prefs, ...p };
    return wait(prefs, 60);
  },
  clearData: () => wait({ ok: true }),
};
