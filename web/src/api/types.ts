/* Shared API types. Mirrors docs/API.md (backend contract). */
export type MatchStatus = 'pending' | 'matched' | 'unmatched' | 'ignored';

export interface PerformerRef { id: string; name: string; image: string | null }
export interface Tag { id: number; name: string; count?: number }
export interface SiteRef { id: number; name: string; logo?: string | null }
export interface Subtitle { fileId: number; name: string; lang: string; format: 'srt' | 'vtt' }

export interface Scene {
  id: string;
  type: string;
  title: string | null;
  date: string | null;
  description?: string | null;
  poster: string | null;
  background: string | null;
  duration: number | null;
  url?: string | null;
  trailer?: string | null;
  site: SiteRef | null;
  performers: PerformerRef[];
  tags: Tag[];
}

export interface Progress { position: number; duration: number | null; completed: boolean; updatedAt: number }

export interface Item {
  id: string;
  source: 'pcloud';
  fileId: number;
  name: string;
  title: string;
  path: string | null;
  size: number | null;
  addedAt: number;
  duration: number | null;
  resolution: string | null;
  thumb: string;
  matchStatus: MatchStatus;
  matchConfidence: number | null;
  matchSource: string | null;
  /** Cascade strategy that produced the match (parse, title, studio+date, performer, words, fuzzy, hash…; 'manual' for hand picks). */
  matchStrategy?: string | null;
  /** Metadata provider that supplied this match: shown as the "Matched via" badge. */
  provider?: MetadataProviderId | null;
  matchError: string | null;
  scene: Scene | null;
  progress: Progress | null;
  favorite: boolean;
  watchlist: boolean;
  subtitles: Subtitle[];
}

export interface Rail { id: string; title: string; kind: 'site' | 'tag' | 'performer'; refId: string | number; items: Item[] }
export interface HomeData {
  featured: Item[];
  continueWatching: Item[];
  recentlyAdded: Item[];
  watchlist: Item[];
  favorites: Item[];
  performers: (PerformerRef & { c: number })[];
  tags: (Tag & { c: number })[];
  rails: Rail[];
  stats: { items: number; bytes: number | null; matched: number | null };
}

export interface ItemQuery {
  q?: string;
  tags?: number[];
  performers?: string[];
  sites?: number[];
  yearFrom?: number;
  yearTo?: number;
  minDuration?: number;
  maxDuration?: number;
  status?: string;
  favorites?: boolean;
  watchlist?: boolean;
  sort?: 'added' | 'date' | 'title' | 'duration' | 'random' | 'size';
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface Facets {
  tags: Tag[];
  performers: (PerformerRef & { count: number })[];
  sites: (SiteRef & { count: number })[];
  years: { min: number | null; max: number | null };
  counts: { status: MatchStatus; count: number }[];
}

export interface PerformerSummary { id: string; name: string; image: string | null; photo?: string | null; gender?: string | null; scenes: number; favorite: boolean }
export interface PerformerDetail {
  id: string;
  name: string;
  image: string | null;
  face: string | null;
  thumbnail: string | null;
  bio: string | null;
  gender: string | null;
  extras: Record<string, string | number | boolean | null>;
  aliases: string[];
  photos: string[];
  favorite: boolean;
}
export interface Studio { id: number; name: string; logo: string | null; poster?: string | null; network?: string | null; scenes: number; favorite: boolean }

export interface Candidate {
  id: string;
  type: 'scene' | 'movie' | 'jav';
  title: string;
  date: string | null;
  site: string | null;
  poster: string | null;
  performers: string[];
  duration: number | null;
  confidence: number;
  matchedBy?: string | null;
  /** Provider this candidate came from (id is that provider's id). */
  source?: MetadataProviderId;
  /** The same scene also exists on the other provider. */
  alsoOn?: { source: MetadataProviderId; id: string }[];
  inLibrary?: boolean;
}
export type MetadataProviderId = 'tpdb' | 'stashdb';
export interface MetadataSource { id: MetadataProviderId; label: string; configured: boolean; enabled: boolean; active: boolean }
/** Network path that worked for the last request: direct, doh (DNS-over-HTTPS fallback) or proxy (Cloudflare Worker). */
export type NetPath = 'direct' | 'doh' | 'proxy';
export interface StashdbTest { ok: boolean; status: 'ok' | 'not_configured' | 'unauthorized' | 'unreachable' | 'error'; hint: string; path?: NetPath | null }

export interface ParsedName {
  kind: 'scene' | 'movie' | 'jav';
  site: string | null;
  date: string | null;
  year: number | null;
  jav: string | null;
  title: string;
  performers: string[];
  resolution: string | null;
  query: string;
}

export interface ScanState {
  running: boolean;
  folder: string | null;
  foldersDone: number;
  foldersTotal: number;
  found: number;
  added: number;
  removed: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}
export interface Folder { folderId: number; name: string; path: string | null; lastScanAt?: number | null; fileCount?: number }
export interface PcloudStatus {
  configured: boolean;
  connected: boolean;
  redirectUri: string;
  region: 'US' | 'EU' | null;
  apiHost: string | null;
  folders: Folder[];
  scan: ScanState;
  account?: { email: string; premium: boolean; quota: number; usedQuota: number } | null;
  error?: string;
  tokenInvalid?: boolean;
  cache?: { localBytes: number; cloudBytes: number; entries: number; cloud: boolean };
}
export interface FolderListing {
  folder: { folderId: number; name: string; parentId: number | null; path: string | null };
  folders: { folderId: number; name: string; selected: boolean }[];
  videoCount: number;
}
export interface Variants {
  duration: number | null;
  original: Variant;
  variants: Variant[];
}
export interface Variant { id: string; label: string; width?: number; height?: number; videoCodec?: string; audioCodec?: string; bitrate?: number; transcoded: boolean }

export interface QueueState {
  running: boolean;
  processed: number;
  matched: number;
  failed: number;
  current: string | null;
  lastError: string | null;
  /** Failure class of lastError (tpdb_auth, rate_limited, tpdb_network, tpdb_http, tpdb_blocked, exception, ...). */
  lastErrorCode?: string | null;
  /** Failures by reason for the current/last run. */
  errorCounts?: Record<string, number>;
  /** Files searched fine without a confident match (not errors). */
  unmatched?: number;
  /** When failed files are retried automatically next (ISO). */
  retryAt?: string | null;
  counts: Partial<Record<MatchStatus, number>>;
  threshold: number;
  strategies?: Record<string, number>;
  /** Bulk-matching progress. */
  paused?: boolean;
  /** processed + queued + in flight for this run */
  total?: number;
  /** completed files per minute */
  rate?: number;
  /** estimated seconds left (null = not known yet) */
  etaSeconds?: number | null;
  /** performer / studio batches resolved with a handful of requests */
  groups?: { total: number; done: number; filesMatched: number };
}
export interface TpdbTest {
  ok: boolean;
  status: 'ok' | 'not_configured' | 'invalid_key' | 'blocked' | 'rate_limited' | 'network' | 'error' | 'empty';
  hint: string;
  keyLength: number;
  steps: { name: string; httpStatus: number | null; ok: boolean; detail: string }[];
  sample?: { query: string; results: number; first: string | null };
  user?: string | null;
  path?: NetPath | null;
}
export interface TpdbStatus { configured: boolean; ok: boolean; error?: string | null; checkedAt?: number; cachedResponses?: number }

export type TorboxKind = 'torrents' | 'usenet' | 'webdl';
export interface TorboxFile { id: number; name: string; path: string; size: number; mimetype: string | null; playable: boolean; subtitle: boolean }
export interface TorboxItem {
  key: string;
  kind: TorboxKind;
  id: number;
  name: string;
  hash: string | null;
  size: number;
  progress: number;
  state: string;
  speed: number;
  eta: number | null;
  seeds: number | null;
  peers: number | null;
  cached: boolean;
  ready: boolean;
  createdAt: string | null;
  expiresAt: string | null;
  files: TorboxFile[];
}
/** One file inside a zip that lives in TorBox (read in place, never extracted). */
export interface ZipEntryInfo { name: string; shortName: string; dir: string; size: number; isVideo: boolean; playable: boolean; seekable: boolean; encrypted: boolean }
export interface ZipListing { total: number; videos: number; truncated: boolean; archiveSize: number; entries: ZipEntryInfo[] }
export interface TorboxTransfer { id: string; batch: string; name: string; folderId: number; size: number; bytes: number; state: 'queued' | 'running' | 'done' | 'error' | 'canceled'; error: string | null; attempts: number; createdAt: number; finishedAt: number | null }
export interface TorboxSaveResult { ok: boolean; mode: 'direct' | 'stream'; message: string; queued?: number; missing?: string[] }
export interface TorboxStatus {
  linked: boolean;
  source: 'user' | 'env' | null;
  envAvailable: boolean;
  account?: { email: string | null; plan: string; subscribed?: boolean; premiumExpiresAt?: string | null; totalDownloaded?: number | null } | null;
  error?: string;
}

export interface StreamVariant { id: string; label: string; url: string; type?: 'mp4' | 'hls' | 'other'; transcoded: boolean; height?: number | null; fallback?: string | null }
export interface StreamInfo { variants: StreamVariant[]; subtitles: { label: string; lang: string | null; url: string }[]; duration: number | null; expiresAt?: string | null }

/** Features the connected backend supports (the UI hides what isn't available). */
export interface Capabilities { watchlist: boolean; studioFavorites: boolean; devices: boolean; pause: boolean; saveToPcloud: boolean; tokenFlow: boolean; clearServerData: boolean }

export interface Prefs {
  autoMatch: boolean;
  autoplayNext: boolean;
  resumePlayback: boolean;
  defaultSpeed: number;
  skipSeconds: number;
  preferOriginal: boolean;
  blurThumbs: boolean;
  theme: 'dark' | 'light';
}
export interface SessionInfo { paired: boolean; lockEnabled: boolean; locked: boolean; lockTimeoutMin: number; /** digits in the PIN while locked (4-8), null when unknown */ pinLength?: number | null }
export interface Device { id: string; label: string; createdAt: number; lastSeen: number; current: boolean }
