/**
 * HTTP adapter for the Pulse backend (contract: docs/API.md).
 * The UI works with the domain types in ./types; this file maps the wire format to them,
 * so the iOS app / backend contract can evolve without touching screens.
 */
import type * as T from './types';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string | number | null, public service?: string | null) {
    super(message);
  }
}
export const authEvents = new EventTarget();

/* Session token: the server sets an httpOnly cookie, and ALSO returns the same signed token on unlock. We keep it in localStorage and send it as
   `Authorization: Bearer` so the lock still works when a browser (iOS standalone PWA, ITP, strict cookie settings) drops or ignores the cookie.
   Server-side enforcement is unchanged: every /api route still needs a valid signed session. */
const TOKEN_KEY = 'pulse:session';
export const getToken = (): string | null => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const setToken = (t: string | null) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ } };
/** Adds the session token to a same-origin /api URL that the browser fetches itself (<img>, <video>, <track>) where headers can't be set. */
export const authUrl = (u: string | null | undefined): string => {
  if (!u) return u ?? '';
  const t = getToken();
  if (!t || !/^\/api\//.test(u)) return u;
  return u + (u.includes('?') ? '&' : '?') + 'pt=' + encodeURIComponent(t);
};

async function req<R>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<R> {
  let res: Response;
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}), ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(navigator.onLine ? 'Cannot reach the Pulse server' : 'You are offline', 0, 'network');
  }
  const fresh = res.headers?.get?.('x-pulse-token');
  if (fresh) setToken(fresh);
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-json */
  }
  if (!res.ok) {
    const err = (data as { error?: { message?: string; code?: string } } | null)?.error;
    if (res.status === 423 || err?.code === 'locked') authEvents.dispatchEvent(new Event('locked'));
    if (res.status === 401 && err?.code === 'unpaired') authEvents.dispatchEvent(new Event('unpaired'));
    throw new ApiError(err?.message || `Request failed (${res.status})`, res.status, err?.code);
  }
  return data as R;
}
/** Same-origin URL that streams (or, with `download`, saves) one file out of a TorBox zip. The server reads it in place with Range requests. */
const zipUrl = (kind: T.TorboxKind, id: number, fileId: number, entry: string, download = false) =>
  `/api/torbox/zip/stream${toQuery({ type: kind, id, fileId, entry, download: download ? 1 : undefined })}`;
const unsupported = (what: string): Promise<any> => Promise.reject(new ApiError(`${what} isn’t supported by this server yet`, 501, 'unsupported'));

export function toQuery(q: Record<string, unknown>) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    if (Array.isArray(v)) {
      if (v.length) u.set(k, v.join(','));
    } else u.set(k, v === true ? 'true' : String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}

/* ------------------------------------------------------------------ wire types (docs/API.md) */
type WPerf = { id: number; name: string; image: string | null; thumb?: string | null; gender?: string | null; sceneCount?: number; favorite?: boolean };
type WScene = {
  id: number;
  title: string;
  fileName: string;
  path: string;
  size: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  date: string | null;
  year: number | null;
  poster: string | null;
  thumb: string | null;
  studio: { id: number; name: string } | null;
  performers: WPerf[];
  matchStatus: 'unmatched' | 'queued' | 'matched' | 'manual' | 'failed' | 'ignored';
  matchError?: string | null;
  matchErrorCode?: string | null;
  matchConfidence: number | null;
  matchStrategy?: string | null;
  matchSource?: 'tpdb' | 'stashdb' | null;
  favorite: boolean;
  progress: { position: number; duration: number | null; percent: number; completed: boolean; updatedAt: string } | null;
  addedAt: string;
  source: 'pcloud' | 'torbox';
};
type WSceneDetail = WScene & {
  description: string | null;
  tags: { id: number; name: string; sceneCount?: number }[];
  tpdb: { id: string; type: 'scene' | 'movie' | 'jav'; url: string | null } | null;
  stashdb?: { id: string; url: string } | null;
  parsed: { studio: string | null; date: string | null; title: string | null; performers: string[]; resolution: string | null; extension: string };
  pcloud: { fileId: number; folderId: number; contentType: string | null } | null;
  trailer: string | null;
  backdrop: string | null;
};
type Paged<X> = { items: X[]; page: number; pageSize: number; total: number; totalPages: number };
type WScan = { state: 'idle' | 'running' | 'error'; startedAt: string | null; finishedAt: string | null; foldersScanned: number; filesSeen: number; videosFound: number; added: number; removed: number; updated: number; currentPath: string | null; error: string | null };
type WSettings = {
  pinEnabled: boolean;
  autoLockMinutes: number;
  blurThumbnails: boolean;
  hideFromRecents: boolean;
  playback: { autoplayNext: boolean; defaultQuality: string; preferHls: boolean; resumePlayback: boolean; skipSeconds: number; playbackRate: number; subtitlesEnabled: boolean; subtitleLang: string | null; muted: boolean };
  library: { autoMatch: boolean; matchThreshold: number; scanIntervalHours: number };
};
type WTbItem = { id: number; type: T.TorboxKind; name: string; hash: string | null; size: number; progress: number; state: string; downloadSpeed: number; uploadSpeed: number; seeds: number | null; peers: number | null; eta: number | null; ready: boolean; createdAt: string | null; files: { id: number; name: string; shortName: string; size: number; mime: string | null; isVideo: boolean }[] };

type WAlt = { tpdbId: string; type: 'scene' | 'movie' | 'jav'; title: string; date: string | null; studio: string | null; performers: string[]; poster: string | null; duration?: number | null; confidence: number; matchedBy?: string | null; source?: T.MetadataProviderId; alsoOn?: { source: T.MetadataProviderId; id: string }[] };
const mapAlt = (c: WAlt): T.Candidate => ({ source: c.source ?? 'tpdb', alsoOn: c.alsoOn, id: c.tpdbId, type: c.type, title: c.title, date: c.date, site: c.studio, poster: c.poster, performers: c.performers, duration: c.duration ?? null, confidence: c.confidence, matchedBy: c.matchedBy ?? null });
const ts = (s: string | null | undefined) => (s ? Date.parse(s) || 0 : 0);
const STATUS: Record<WScene['matchStatus'], T.MatchStatus> = { unmatched: 'unmatched', failed: 'unmatched', queued: 'pending', matched: 'matched', manual: 'matched', ignored: 'ignored' };

export function mapScene(s: WScene, d?: Partial<WSceneDetail>): T.Item {
  const matched = s.matchStatus === 'matched' || s.matchStatus === 'manual';
  return {
    id: String(s.id),
    source: 'pcloud',
    fileId: d?.pcloud?.fileId ?? 0,
    name: s.fileName,
    title: s.title,
    path: s.path,
    size: s.size,
    addedAt: ts(s.addedAt),
    duration: s.duration,
    resolution: s.height ? `${s.height}p` : d?.parsed?.resolution || null,
    thumb: authUrl(s.thumb) || '',
    matchStatus: STATUS[s.matchStatus] || 'unmatched',
    matchConfidence: s.matchConfidence,
    matchSource: s.matchStatus === 'manual' ? 'manual' : 'auto',
    matchStrategy: s.matchStrategy ?? null,
    provider: s.matchSource ?? null,
    matchError: s.matchError || (s.matchStatus === 'failed' ? 'Matching failed' : null),
    scene: matched
      ? {
          id: (s.matchSource === 'stashdb' ? d?.stashdb?.id : d?.tpdb?.id) || d?.tpdb?.id || d?.stashdb?.id || String(s.id),
          type: d?.tpdb?.type || 'scene',
          title: s.title,
          date: s.date,
          description: d?.description ?? null,
          url: (s.matchSource === 'stashdb' ? d?.stashdb?.url : d?.tpdb?.url) ?? d?.tpdb?.url ?? null,
          trailer: d?.trailer ?? null,
          poster: s.poster,
          background: d?.backdrop || s.poster,
          duration: s.duration,
          site: s.studio,
          performers: (s.performers || []).map((p) => ({ id: String(p.id), name: p.name, image: p.thumb || p.image })),
          tags: (d?.tags || []).map((t) => ({ id: t.id, name: t.name })),
        }
      : null,
    progress: s.progress ? { position: s.progress.position, duration: s.progress.duration, completed: s.progress.completed, updatedAt: ts(s.progress.updatedAt) } : null,
    favorite: s.favorite,
    watchlist: false,
    subtitles: [],
  };
}
const mapPerf = (p: WPerf): T.PerformerSummary => ({ id: String(p.id), name: p.name, image: p.thumb || p.image, photo: p.image, gender: p.gender, scenes: p.sceneCount ?? 0, favorite: !!p.favorite });
const mapScan = (s: WScan): T.ScanState => ({
  running: s.state === 'running',
  folder: s.currentPath,
  foldersDone: s.foldersScanned,
  foldersTotal: s.foldersScanned,
  found: s.videosFound,
  added: s.added,
  removed: s.removed,
  startedAt: ts(s.startedAt) || null,
  finishedAt: ts(s.finishedAt) || null,
  error: s.error,
});
const mapTb = (t: WTbItem): T.TorboxItem => ({
  key: `${t.type}:${t.id}`,
  kind: t.type,
  id: t.id,
  name: t.name,
  hash: t.hash,
  size: t.size,
  progress: t.progress,
  state: t.state,
  speed: t.downloadSpeed,
  eta: t.eta,
  seeds: t.seeds,
  peers: t.peers,
  cached: t.ready,
  ready: t.ready,
  createdAt: t.createdAt,
  expiresAt: null,
  files: (t.files || []).map((f) => ({ id: f.id, name: f.shortName || f.name, path: f.name, size: f.size, mimetype: f.mime, playable: f.isVideo, subtitle: /\.(srt|vtt)$/i.test(f.name) })),
});
function mapSettings(s: WSettings): T.Prefs {
  return {
    autoMatch: s.library.autoMatch,
    autoplayNext: s.playback.autoplayNext,
    resumePlayback: s.playback.resumePlayback,
    defaultSpeed: s.playback.playbackRate,
    skipSeconds: s.playback.skipSeconds,
    preferOriginal: s.playback.defaultQuality === 'original',
    blurThumbs: s.blurThumbnails,
    theme: (localStorage.getItem('pulse:theme') as 'dark' | 'light') || 'dark',
  };
}
export function itemQuery(q: T.ItemQuery) {
  const limit = q.limit || 40;
  const year = q.yearFrom || q.yearTo ? `${q.yearFrom || 1970}-${q.yearTo || new Date().getFullYear() + 1}` : undefined;
  const matched = q.status === 'matched' ? 'true' : q.status && /unmatched|pending/.test(q.status) ? 'false' : undefined;
  return toQuery({
    q: q.q,
    sort: q.sort,
    order: q.order,
    tags: q.tags,
    performers: q.performers,
    studio: q.sites,
    year,
    minDuration: q.minDuration ? q.minDuration * 60 : undefined,
    maxDuration: q.maxDuration ? q.maxDuration * 60 : undefined,
    matched,
    favorites: q.favorites,
    page: Math.floor((q.offset || 0) / limit) + 1,
    pageSize: limit,
  });
}

/* local progress for TorBox streams (not stored by the server contract) */
const LP = 'pulse:tbprogress';
const localProg = (): Record<string, { position: number; duration: number | null; title: string | null; poster: string | null; updatedAt: number }> => {
  try {
    return JSON.parse(localStorage.getItem(LP) || '{}');
  } catch {
    return {};
  }
};

export const capabilities: T.Capabilities = { watchlist: false, studioFavorites: false, devices: false, pause: false, saveToPcloud: true, tokenFlow: false, clearServerData: false };

export const httpApi = {
  /* session & lock */
  session: async (): Promise<T.SessionInfo> => {
    // Both requests in parallel: one round trip on start instead of two (settings simply 423s while locked).
    const [s, settings] = await Promise.all([
      req<{ locked: boolean; pinEnabled: boolean; pinLength?: number | null }>('GET', '/session'),
      req<WSettings>('GET', '/settings').catch(() => null),
    ]);
    if (s.locked) setToken(null);
    const timeout = s.locked ? 0 : settings?.autoLockMinutes ?? 0;
    return { paired: true, lockEnabled: s.pinEnabled, locked: s.locked, lockTimeoutMin: timeout, pinLength: s.pinLength ?? null };
  },
  pair: (_code: string) => Promise.resolve({ ok: true as const }),
  unlock: (pin: string) => req<{ locked: false; token?: string }>('POST', '/session/unlock', { pin }).then((r) => { setToken(r.token ?? null); return { ok: true as const }; }),
  lock: () => req('POST', '/session/lock').finally(() => setToken(null)).then(() => ({ ok: true as const })),
  logout: () => req('POST', '/session/lock').finally(() => setToken(null)).then(() => ({ ok: true as const })),
  setLock: async (b: { pin?: string | null; currentPin?: string; timeoutMin?: number }) => {
    if (b.pin) { const r = await req<{ token?: string }>('POST', '/settings/pin', { pin: b.pin, currentPin: b.currentPin }); if (r?.token) setToken(r.token); }
    const s = b.timeoutMin != null ? await req<WSettings>('PUT', '/settings', { autoLockMinutes: b.timeoutMin }) : await req<WSettings>('GET', '/settings');
    return { lockEnabled: s.pinEnabled, lockTimeoutMin: s.autoLockMinutes };
  },
  devices: () => Promise.resolve([] as T.Device[]),
  removeDevice: (_id: string) => unsupported('Device management'),

  /* library */
  home: async (): Promise<T.HomeData> => {
    const [h, f] = await Promise.all([
      req<{ hero: WScene[]; rails: { id: string; title: string; kind: 'scenes' | 'performers'; items: (WScene | WPerf)[] }[] }>('GET', '/home'),
      req<{ tags: { id: number; name: string; sceneCount: number }[]; totals: { scenes: number; matched: number } }>('GET', '/library/facets'),
    ]);
    const rail = (id: string) => (h.rails.find((r) => r.id === id)?.items || []) as WScene[];
    return {
      featured: h.hero.map((s) => mapScene(s)),
      continueWatching: rail('continue').map((s) => mapScene(s)),
      recentlyAdded: rail('recent').map((s) => mapScene(s)),
      watchlist: [],
      favorites: rail('favorites').map((s) => mapScene(s)),
      performers: ((h.rails.find((r) => r.id === 'top-performers')?.items || []) as WPerf[]).map((p) => ({ id: String(p.id), name: p.name, image: p.thumb || p.image, c: p.sceneCount || 0 })),
      tags: f.tags.slice(0, 12).map((t) => ({ id: t.id, name: t.name, c: t.sceneCount })),
      rails: h.rails
        .filter((r) => /^(studio|tag)-/.test(r.id) || r.id === 'unwatched')
        .map((r) => ({
          id: r.id,
          title: r.title,
          kind: r.id.startsWith('studio') ? ('site' as const) : ('tag' as const),
          refId: Number(r.id.split('-')[1]) || 0,
          items: (r.items as WScene[]).map((s) => mapScene(s)),
        })),
      stats: { items: f.totals.scenes, bytes: null, matched: f.totals.matched },
    };
  },
  items: async (q: T.ItemQuery, signal?: AbortSignal) => {
    const r = await req<Paged<WScene>>('GET', `/library${itemQuery(q)}`, undefined, signal);
    return { items: r.items.map((s) => mapScene(s)), total: r.total };
  },
  item: async (id: string) => {
    const d = await req<WSceneDetail>('GET', `/scenes/${id}`);
    const item = mapScene(d, d);
    const relQ = d.performers[0] ? `performers=${d.performers[0].id}` : d.studio ? `studio=${d.studio.id}` : 'sort=random';
    const rel = await req<Paged<WScene>>('GET', `/library?${relQ}&pageSize=13`).catch(() => null);
    const related = (rel?.items || []).filter((s) => s.id !== d.id).slice(0, 12).map((s) => mapScene(s));
    const p = d.parsed || ({} as WSceneDetail['parsed']);
    const parsed: T.ParsedName = { kind: d.tpdb?.type || 'scene', site: p.studio, date: p.date, year: p.date ? Number(p.date.slice(0, 4)) : null, jav: null, title: p.title || d.title, performers: p.performers || [], resolution: p.resolution, query: [p.studio, p.date, p.title].filter(Boolean).join(' ') };
    return { item, related, parsed };
  },
  facets: async (): Promise<T.Facets> => {
    const f = await req<{ years: { year: number; count: number }[]; studios: { id: number; name: string; logo: string | null; sceneCount: number }[]; tags: { id: number; name: string; sceneCount: number }[]; performers: WPerf[]; totals: { scenes: number; matched: number; unmatched: number } }>('GET', '/library/facets');
    const ys = f.years.map((y) => y.year);
    return {
      tags: f.tags.map((t) => ({ id: t.id, name: t.name, count: t.sceneCount })),
      performers: f.performers.map((p) => ({ id: String(p.id), name: p.name, image: p.thumb || p.image, count: p.sceneCount || 0 })),
      sites: f.studios.map((s) => ({ id: s.id, name: s.name, logo: s.logo, count: s.sceneCount })),
      years: { min: ys.length ? Math.min(...ys) : null, max: ys.length ? Math.max(...ys) : null },
      counts: [
        { status: 'matched', count: f.totals.matched },
        { status: 'unmatched', count: f.totals.unmatched },
      ],
    };
  },
  performers: async (q: { q?: string; sort?: 'scenes' | 'name'; limit?: number; offset?: number }) =>
    (await req<Paged<WPerf>>('GET', `/performers${toQuery({ q: q.q, sort: q.sort, order: q.sort === 'name' ? 'asc' : 'desc', pageSize: Math.min(q.limit || 60, 200) })}`)).items.map(mapPerf),
  performer: async (id: string) => {
    const p = await req<WPerf & { bio: string | null; aliases: string[]; birthday: string | null; birthplace: string | null; ethnicity: string | null; nationality: string | null; hairColor: string | null; eyeColor: string | null; height: string | null; weight: string | null; measurements: string | null; cupSize: string | null; tattoos: string | null; piercings: string | null; careerStart: string | null; careerEnd: string | null; images: string[]; scenes: WScene[] }>(
      'GET',
      `/performers/${id}`,
    );
    const performer: T.PerformerDetail = {
      id: String(p.id),
      name: p.name,
      image: p.image || p.thumb || null,
      face: p.thumb || null,
      thumbnail: p.thumb || null,
      bio: p.bio,
      gender: p.gender || null,
      extras: {
        birthday: p.birthday,
        birthplace: p.birthplace,
        nationality: p.nationality,
        ethnicity: p.ethnicity,
        height: p.height,
        weight: p.weight,
        measurements: p.measurements,
        cupsize: p.cupSize,
        hair_colour: p.hairColor,
        eye_colour: p.eyeColor,
        tattoos: p.tattoos,
        piercings: p.piercings,
        career_start_year: p.careerStart,
        career_end_year: p.careerEnd,
      },
      aliases: p.aliases || [],
      photos: p.images || [],
      favorite: !!p.favorite,
    };
    return { performer, items: (p.scenes || []).map((s) => mapScene(s)) };
  },
  performerRemote: async (_id: string, name?: string) => {
    const r = await req<{ items: { tpdbId: string; type: 'scene'; title: string; date: string | null; studio: string | null; performers: string[]; poster: string | null; duration: number | null; confidence: number }[] }>('GET', `/tpdb/search${toQuery({ q: name, type: 'scene' })}`);
    return { scenes: r.items.map((c) => ({ id: c.tpdbId, type: c.type, title: c.title, date: c.date, site: c.studio, poster: c.poster, performers: c.performers, duration: c.duration, confidence: c.confidence })) as T.Candidate[] };
  },
  studios: async (): Promise<T.Studio[]> =>
    (await req<Paged<{ id: number; name: string; logo: string | null; parent: string | null; sceneCount: number }>>('GET', '/studios?pageSize=200')).items.map((s) => ({ id: s.id, name: s.name, logo: s.logo, network: s.parent, scenes: s.sceneCount, favorite: false })),
  studio: async (id: number): Promise<{ studio: T.Studio; items: T.Item[] }> => {
    const s = await req<{ id: number; name: string; logo: string | null; parent: string | null; sceneCount: number; scenes: WScene[] }>('GET', `/studios/${id}`);
    return { studio: { id: s.id, name: s.name, logo: s.logo, network: s.parent, scenes: s.sceneCount, favorite: false }, items: s.scenes.map((x) => mapScene(x)) };
  },
  favorites: async (list: 'favorites' | 'watchlist') => {
    if (list === 'watchlist') return { items: [], performers: [], studios: [] };
    const f = await req<{ scenes: WScene[]; performers: WPerf[] }>('GET', '/favorites');
    return { items: f.scenes.map((s) => mapScene(s)), performers: f.performers.map((p) => ({ id: String(p.id), name: p.name, image: p.thumb || p.image })), studios: [] as T.SiteRef[] };
  },
  setFavorite: (b: { kind: 'item' | 'performer' | 'site'; refId: string | number; list: 'favorites' | 'watchlist'; on: boolean }) =>
    b.kind === 'site' || b.list === 'watchlist' ? unsupported(b.kind === 'site' ? 'Favorite studios' : 'Watchlist') : req('POST', '/favorites/toggle', { type: b.kind === 'item' ? 'scene' : 'performer', id: Number(b.refId), favorite: b.on }),

  /* progress (pCloud scenes on the server, TorBox locally) */
  saveProgress: async (key: string, b: { position: number; duration?: number | null; title?: string; poster?: string | null }) => {
    if (key.startsWith('tb:')) {
      const all = localProg();
      all[key] = { position: b.position, duration: b.duration ?? null, title: b.title ?? null, poster: b.poster ?? null, updatedAt: Date.now() };
      localStorage.setItem(LP, JSON.stringify(all));
      return { ok: true };
    }
    return req('PUT', `/scenes/${key}/progress`, { position: b.position, duration: b.duration ?? undefined });
  },
  getProgress: async (key: string): Promise<T.Progress | null> => {
    if (key.startsWith('tb:')) {
      const p = localProg()[key];
      return p ? { position: p.position, duration: p.duration, completed: !!p.duration && p.position / p.duration > 0.92, updatedAt: p.updatedAt } : null;
    }
    const p = await req<{ position: number; duration: number | null; completed: boolean; updatedAt: string } | null>('GET', `/scenes/${key}/progress`);
    return p ? { position: p.position, duration: p.duration, completed: p.completed, updatedAt: ts(p.updatedAt) } : null;
  },
  clearProgress: (key: string) => {
    if (key.startsWith('tb:')) {
      const all = localProg();
      delete all[key];
      localStorage.setItem(LP, JSON.stringify(all));
      return Promise.resolve({ ok: true });
    }
    return req('DELETE', `/scenes/${key}/progress`);
  },
  torboxProgress: async () =>
    Object.entries(localProg())
      .filter(([, p]) => !(p.duration && p.position / p.duration > 0.92))
      .map(([key, p]) => ({ key, ...p }))
      .sort((a, b) => b.updatedAt - a.updatedAt),

  /* streaming */
  stream: async (src: { kind: 'pcloud' | 'torbox'; itemId?: string; tb?: { kind: T.TorboxKind; id: number; fileId: number; entry?: string } }): Promise<T.StreamInfo> => {
    if (src.kind === 'torbox' && src.tb?.entry) {
      return { variants: [{ id: 'original', label: 'From archive', url: authUrl(zipUrl(src.tb.kind, src.tb.id, src.tb.fileId, src.tb.entry)), transcoded: false }], subtitles: [], duration: null };
    }
    if (src.kind === 'torbox' && src.tb) {
      const r = await req<{ url: string; mime: string | null; name: string }>('GET', `/torbox/stream${toQuery({ type: src.tb.kind, id: src.tb.id, fileId: src.tb.fileId })}`);
      return { variants: [{ id: 'original', label: 'Original', url: r.url, transcoded: false }], subtitles: [], duration: null };
    }
    const r = await req<{
      expiresAt: string | null;
      primary: { url: string; type: 'mp4' | 'hls' | 'other'; mime: string | null; label: string };
      alternatives: { url: string; type: 'mp4' | 'hls'; label: string; width: number | null; height: number | null; bitrate: number | null }[];
      hls: string | null;
      proxy: string;
      subtitles: { label: string; lang: string | null; url: string; format: string }[];
      duration: number | null;
    }>('GET', `/scenes/${src.itemId}/stream`);
    const variants: T.StreamVariant[] = [
      { id: 'original', label: 'Original', url: r.primary.url.startsWith('/') ? authUrl(r.primary.url) : r.primary.url, type: r.primary.type, transcoded: false, fallback: authUrl(r.proxy) },
      ...r.alternatives.map((a) => ({ id: a.label, label: a.label, url: a.url, type: a.type, transcoded: true, height: a.height })),
    ];
    if (r.hls && !variants.some((v) => v.url === r.hls)) variants.push({ id: 'HLS', label: 'Adaptive (HLS)', url: r.hls, type: 'hls', transcoded: true });
    variants.push({ id: 'proxy', label: 'Original via server', url: authUrl(r.proxy), type: 'other', transcoded: false });
    return { variants, subtitles: r.subtitles.map((s) => ({ label: s.label, lang: s.lang, url: authUrl(s.url) })), duration: r.duration, expiresAt: r.expiresAt };
  },

  /* matching */
  matchQueue: async (): Promise<T.QueueState> => {
    const [s, f] = await Promise.all([
      req<{ state: 'idle' | 'running'; queued: number; processed: number; matched: number; failed: number; current: { sceneId: number; title: string } | null; lastError: string | null; lastErrorCode?: string | null; errorCounts?: Record<string, number>; unmatched?: number; retryAt?: string | null; strategies?: Record<string, number>; paused?: boolean; total?: number; rate?: number; etaSeconds?: number | null; groups?: { total: number; done: number; filesMatched: number } }>('GET', '/match/status'),
      req<{ totals: { matched: number; unmatched: number } }>('GET', '/library/facets'),
    ]);
    return { running: s.state === 'running', processed: s.processed, matched: s.matched, failed: s.failed, current: s.current?.title ?? null, lastError: s.lastError, lastErrorCode: s.lastErrorCode, errorCounts: s.errorCounts, unmatched: s.unmatched, retryAt: s.retryAt, strategies: s.strategies, paused: s.paused, total: s.total, rate: s.rate, etaSeconds: s.etaSeconds, groups: s.groups, counts: { matched: f.totals.matched, unmatched: f.totals.unmatched, pending: s.queued }, threshold: 0.75 };
  },
  runMatch: (_scope: 'pending' | 'unmatched' | 'all') => req('POST', '/match/queue', { all: true }),
  pauseMatch: () => req('POST', '/match/pause', {}),
  resumeMatch: () => req('POST', '/match/resume', {}),
  cancelMatch: () => req('POST', '/match/cancel', {}),
  /** "Retry matching": re-parses every unmatched file name and runs the full strategy cascade again. */
  retryUnmatched: () => req<{ requeued: number }>('POST', '/match/retry-unmatched', {}),
  /** Stored match info for one file: cleaned query to pre-fill, strategy, and the top-5 alternatives with scores from the last run. */
  matchInfo: async (itemId: string) => {
    const r = await req<{ status: string; confidence: number | null; strategy: string | null; query: string; alternatives: WAlt[] }>('GET', `/scenes/${itemId}/match-info`);
    return { status: r.status, confidence: r.confidence, strategy: r.strategy, query: r.query, alternatives: r.alternatives.map(mapAlt) };
  },
  matchSearch: async (p: { itemId?: string; q?: string; type?: string }) => {
    const r = await req<{ query: string; strategy: string | null; confident: boolean; candidates: WAlt[]; parsed?: { studio: string | null; date: string | null; year: number | null; title: string | null; performers: string[]; resolution: string | null; jav: string | null } }>('POST', `/scenes/${p.itemId}/match`, { query: p.q, type: p.type });
    const pp = r.parsed;
    return {
      parsed: { kind: (p.type as T.ParsedName['kind']) || 'scene', site: pp?.studio ?? null, date: pp?.date ?? null, year: pp?.year ?? null, jav: pp?.jav ?? null, title: pp?.title || '', performers: pp?.performers || [], resolution: pp?.resolution ?? null, query: r.query },
      strategy: r.strategy,
      confident: r.confident,
      candidates: r.candidates.map(mapAlt),
    };
  },
  applyMatch: async (itemId: string, sceneId: string, type: string, source: T.MetadataProviderId = 'tpdb') => {
    const r = await req<{ scene: WSceneDetail }>('POST', `/scenes/${itemId}/match`, { tpdbId: sceneId, type, source });
    return { item: mapScene(r.scene, r.scene) };
  },
  unmatch: async (itemId: string) => {
    const d = await req<WSceneDetail>('POST', `/scenes/${itemId}/unmatch`);
    return { item: mapScene(d, d) };
  },
  ignore: async (itemId: string) => {
    await req('POST', `/scenes/${itemId}/ignore`);
    return { item: null as unknown as T.Item };
  },
  rematch: (itemId: string) => req('POST', '/match/queue', { sceneIds: [Number(itemId)] }),
  /** Diagnoses the server's ThePornDB key + connectivity (auth + sample search) with a human-readable hint. */
  tpdbTest: () => req<T.TpdbTest>('GET', '/tpdb/test'),
  /** Diagnoses the server's StashDB key with a trivial authenticated GraphQL query. */
  stashdbTest: () => req<T.StashdbTest>('GET', '/stashdb/test'),
  metadataSources: async () => (await req<{ sources: T.MetadataSource[] }>('GET', '/metadata/sources')).sources,
  setMetadataSource: (id: T.MetadataProviderId, enabled: boolean) => req('PUT', '/settings', { metadata: { [id]: enabled } }),
  tpdbStatus: async (_fresh = false): Promise<T.TpdbStatus> => {
    const s = await req<{ tpdb: { configured: boolean } }>('GET', '/session');
    return { configured: s.tpdb.configured, ok: s.tpdb.configured };
  },

  /* pCloud */
  pcloudStatus: async (): Promise<T.PcloudStatus> => {
    const [s, f, scan] = await Promise.all([
      req<{ connected: boolean; email: string | null; region: 'us' | 'eu' | null; apiHost: string | null; quota: number | null; usedQuota: number | null; redirectUri: string; clientConfigured: boolean; cache?: { localBytes: number; cloudBytes: number; entries: number; cloud: boolean } }>('GET', '/pcloud/status'),
      req<{ folders: { folderId: number; path: string; name: string }[] }>('GET', '/pcloud/scan-folders').catch(() => ({ folders: [] })),
      req<WScan>('GET', '/pcloud/scan').catch(() => null),
    ]);
    return {
      configured: s.clientConfigured,
      connected: s.connected,
      redirectUri: s.redirectUri,
      region: s.region ? (s.region.toUpperCase() as 'US' | 'EU') : null,
      apiHost: s.apiHost,
      folders: f.folders.map((x) => ({ folderId: x.folderId, name: x.name, path: x.path })),
      scan: scan ? mapScan(scan) : { running: false, folder: null, foldersDone: 0, foldersTotal: 0, found: 0, added: 0, removed: 0, startedAt: null, finishedAt: null, error: null },
      account: s.connected ? { email: s.email || '', premium: false, quota: s.quota || 0, usedQuota: s.usedQuota || 0 } : null,
      cache: s.cache,
    };
  },
  pcloudStart: async (mode: 'redirect' | 'token' | 'manual'): Promise<{ url: string; mode: 'redirect' | 'token' | 'manual'; redirectUri: string | null }> => {
    const r = await req<{ url: string; redirectUri: string; state: string }>('GET', '/pcloud/authorize-url');
    if (mode !== 'manual') return { url: r.url, mode, redirectUri: r.redirectUri };
    // Manual flow: without redirect_uri pCloud shows the code on screen for the user to copy.
    const u = new URL(r.url);
    u.searchParams.delete('redirect_uri');
    u.searchParams.delete('state');
    return { url: u.toString(), mode, redirectUri: null };
  },
  pcloudComplete: async (b: { input?: string; code?: string; hostname?: string; access_token?: string; state?: string }) => {
    const input = (b.input || '').trim();
    const body = /^https?:\/\//i.test(input) || input.includes('code=') ? { callbackUrl: input.startsWith('http') ? input : `https://x/?${input.replace(/^[?#]/, '')}` } : { code: b.code || input, hostname: b.hostname };
    const s = await req<{ connected: boolean; email: string | null; region: string | null }>('POST', '/pcloud/exchange', body);
    return { connected: s.connected, region: (s.region || '').toUpperCase(), email: s.email };
  },
  pcloudDisconnect: () => req('POST', '/pcloud/disconnect', {}),
  pcloudFolders: async (parent: number): Promise<T.FolderListing> => {
    const r = await req<{ folderId: number; name: string; path: string; parentId: number | null; folders: { folderId: number; name: string; path: string; selected: boolean }[]; videoCount: number }>('GET', `/pcloud/folders?folderId=${parent}`);
    return { folder: { folderId: r.folderId, name: r.folderId === 0 ? 'pCloud Drive' : r.name, parentId: r.parentId, path: r.path }, folders: r.folders.map((f) => ({ folderId: f.folderId, name: f.name, selected: f.selected })), videoCount: r.videoCount };
  },
  setFolders: async (folders: T.Folder[]) =>
    (await req<{ folders: { folderId: number; path: string; name: string }[] }>('PUT', '/pcloud/scan-folders', { folders: folders.map((f) => ({ folderId: f.folderId, name: f.name, path: f.path ?? undefined })) })).folders.map((f): T.Folder => ({ folderId: f.folderId, name: f.name, path: f.path })),
  /** Saves the original file (for zip-backed items, just that one video) through the server. */
  itemDownloadUrl: (id: string): string => authUrl(`/api/scenes/${encodeURIComponent(id)}/proxy?download=1`),
  scan: async (_folderIds?: number[]) => mapScan(await req<WScan>('POST', '/pcloud/rescan', { autoMatch: true })),
  scanState: async () => mapScan(await req<WScan>('GET', '/pcloud/scan')),
  variants: (_fileId: number) => unsupported('Variants') as Promise<T.Variants>,

  /* TorBox */
  torboxStatus: async (): Promise<T.TorboxStatus> => {
    const s = await req<{ linked: boolean; source: 'user' | 'env' | null; email: string | null; plan: number | null; planName: string | null; premiumExpiresAt: string | null; error: string | null }>('GET', '/torbox/status');
    return { linked: s.linked, source: s.source, envAvailable: true, account: s.linked ? { email: s.email, plan: s.planName || (s.plan != null ? `Plan ${s.plan}` : '—'), premiumExpiresAt: s.premiumExpiresAt } : null, error: s.error || undefined };
  },
  torboxLink: (apiKey: string) => req<T.TorboxStatus>('PUT', '/torbox/link', { apiKey }),
  torboxUnlink: (useDefault: boolean) => (useDefault ? req<T.TorboxStatus>('PUT', '/torbox/link', {}) : req<T.TorboxStatus>('DELETE', '/torbox/link')),
  torboxList: async (kind?: T.TorboxKind) => ({ items: (await req<{ items: WTbItem[] }>('GET', `/torbox/downloads?type=${kind || 'all'}`)).items.map(mapTb) }),
  torboxImport: () => req<{ added: number; seen: number }>('POST', '/torbox/import', {}),
  torboxAdd: (b: { type: 'magnet' | 'torrent-file' | 'nzb-url' | 'nzb-file' | 'web'; value?: string; fileName?: string; fileBase64?: string; file?: File }) => {
    if (b.file) {
      const f = new FormData();
      f.set('file', b.file, b.file.name);
      return req('POST', '/torbox/add', f);
    }
    return req('POST', '/torbox/add', b.type === 'magnet' ? { magnet: b.value } : b.type === 'nzb-url' ? { nzbUrl: b.value } : { url: b.value });
  },
  torboxControl: (kind: T.TorboxKind, id: number, operation: 'delete' | 'pause' | 'resume' | 'reannounce') => (operation === 'delete' ? req('DELETE', `/torbox/downloads/${kind}/${id}`) : unsupported('Pause/resume')),
  torboxCached: async (hashes: string[]) => {
    const r = await req<{ cached: Record<string, unknown> }>('POST', '/torbox/cached', { hashes });
    return { cached: Object.fromEntries(Object.entries(r.cached).map(([k, v]) => [k, !!v])) };
  },
  torboxSaveToPcloud: (b: { kind: T.TorboxKind; id: number; fileId?: number; folderId: number; name?: string; entries?: string[] | 'videos'; subfolder?: string }) =>
    req<T.TorboxSaveResult>('POST', '/torbox/save-to-pcloud', { type: b.kind, id: b.id, fileId: b.fileId, folderId: b.folderId, name: b.name, entries: b.entries, subfolder: b.subfolder }),
  /** Files inside a zip, read from its central directory (a few KB over Range requests, no download). */
  torboxZipEntries: (kind: T.TorboxKind, id: number, fileId: number) => req<T.ZipListing>('GET', `/torbox/zip/entries${toQuery({ type: kind, id, fileId })}`),
  torboxZipUrl: (kind: T.TorboxKind, id: number, fileId: number, entry: string, download = false): string => authUrl(zipUrl(kind, id, fileId, entry, download)),
  torboxImportZip: (b: { kind: T.TorboxKind; id: number; fileId: number; entries?: string[] }) =>
    req<{ added: number; seen: number }>('POST', '/torbox/import', { zip: { type: b.kind, id: b.id, fileId: b.fileId, entries: b.entries } }),
  torboxTransfers: () => req<{ items: T.TorboxTransfer[]; active: boolean }>('GET', '/torbox/transfers'),
  torboxCancelTransfer: (id: string) => req<{ ok: boolean }>('DELETE', `/torbox/transfers/${encodeURIComponent(id)}`),
  torboxCancelAllTransfers: () => req<{ canceled: number }>('POST', '/torbox/transfers/cancel-all', {}),
  torboxClearTransfers: () => req<{ cleared: number }>('POST', '/torbox/transfers/clear', {}),

  /* settings */
  prefs: async () => mapSettings(await req<WSettings>('GET', '/settings')),
  setPrefs: async (p: Partial<T.Prefs>) => {
    if (p.theme) localStorage.setItem('pulse:theme', p.theme);
    const body: Record<string, unknown> = {};
    if (p.blurThumbs !== undefined) body.blurThumbnails = p.blurThumbs;
    const pb: Record<string, unknown> = {};
    if (p.autoplayNext !== undefined) pb.autoplayNext = p.autoplayNext;
    if (p.resumePlayback !== undefined) pb.resumePlayback = p.resumePlayback;
    if (p.defaultSpeed !== undefined) pb.playbackRate = p.defaultSpeed;
    if (p.skipSeconds !== undefined) pb.skipSeconds = p.skipSeconds;
    if (p.preferOriginal !== undefined) pb.defaultQuality = p.preferOriginal ? 'original' : 'auto';
    if (Object.keys(pb).length) body.playback = pb;
    if (p.autoMatch !== undefined) body.library = { autoMatch: p.autoMatch };
    const s = Object.keys(body).length ? await req<WSettings>('PUT', '/settings', body) : await req<WSettings>('GET', '/settings');
    return mapSettings(s);
  },
  clearData: (what: 'progress' | 'cache' | 'favorites' | 'metadata' | 'library' | 'all') => (what === 'library' ? req('POST', '/pcloud/disconnect', { purge: true }) : unsupported('Clearing server data')),
};

export type Api = typeof httpApi;
