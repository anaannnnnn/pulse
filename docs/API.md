# Pulse API contract (v1)

Base URL: same origin, all routes under `/api`. Server: `server/` (Fastify + TS + built-in `node:sqlite`, Node 22.13+), port **8787**.
In dev, the web app (Vite) should proxy `/api` -> `http://localhost:8787`.

Conventions
- JSON in/out. Times are ISO-8601 UTC strings. Durations in **seconds** (number). Sizes in **bytes**.
- IDs: `scene.id`, `performer.id`, `studio.id`, `tag.id` are local integers.
- Errors: HTTP 4xx/5xx with body `{ "error": { "code": string, "message": string } }`.
  Codes: `bad_request`, `not_found`, `locked` (PIN required, HTTP 423), `pcloud_not_connected` (409),
  `torbox_not_linked` (409), `upstream_error` (502), `rate_limited` (429).
- Pagination: query `page` (1-based, default 1), `pageSize` (default 40, max 200). Paged response:
  `{ "items": T[], "page": number, "pageSize": number, "total": number, "totalPages": number }`.
- Image URLs (`poster`, `thumb`, `image`) are absolute https URLs (TPDB CDN) or `/api/...` proxied URLs; may be `null`.
- **App-wide PIN lock (always on, enforced server-side).** Until a valid unlock, every `/api/*` route except
  `GET /api/health`, `GET /api/session` and `POST /api/session/unlock|lock` returns **423** `locked` — including
  `/api/scenes/:id/stream|proxy|thumb|subtitles/*`, `/api/torbox/stream` and `/api/pcloud/callback`. The static web shell
  is public but renders only the keypad lock screen. Default PIN is **6442** (seeded on first run only if no PIN exists;
  `APP_PIN` env overrides, see README). Unlock via `POST /api/session/unlock`, which sets the signed session cookie
  `pulse_auth` (HMAC-signed, `HttpOnly; SameSite=Lax; Path=/`, `Secure` when served over https, 30 days, sliding). The PIN
  is stored only as a salted scrypt hash. Changing the PIN signs every other session out.
- Brute-force protection: per client IP (`CF-Connecting-IP`, else `X-Forwarded-For`, trusted only from loopback/private peers or
  when `TRUST_PROXY_HEADERS=1`), 5 wrong PINs → **429** `rate_limited` with `Retry-After` for 1 min, then 5 / 15 / 60 min,
  6 h, 24 h on each further 5 wrong tries (resets on success or after 24 h idle). A global cap of 40 wrong tries / 15 min
  across all IPs also applies. Wrong *current* PIN on change-PIN counts too.

## Common types

```ts
type Performer = {
  id: number; name: string; slug: string|null; image: string|null; thumb: string|null;
  gender: string|null; tpdbId: string|null; stashId: string|null; source: 'tpdb'|'stashdb'|null /*provider of the stored data, TPDB wins when both ids exist*/;
  sceneCount: number; favorite: boolean;
};
type PerformerDetail = Performer & {
  bio: string|null; aliases: string[]; birthday: string|null; birthplace: string|null;
  ethnicity: string|null; nationality: string|null; hairColor: string|null; eyeColor: string|null;
  height: string|null; weight: string|null; measurements: string|null; cupSize: string|null;
  tattoos: string|null; piercings: string|null; careerStart: string|null; careerEnd: string|null;
  images: string[]; links: Record<string,string>;
};
type Studio = { id: number; name: string; slug: string|null; logo: string|null; parent: string|null; tpdbId: string|null; stashId: string|null; source: 'tpdb'|'stashdb'|null; sceneCount: number };
type Tag = { id: number; name: string; slug: string|null; source: 'tpdb'|'stashdb'|null; sceneCount: number };
type MatchStatus = 'unmatched' | 'queued' | 'matched' | 'manual' | 'failed' | 'ignored';
type Scene = {               // list item ("card")
  id: number;
  title: string;             // TPDB title if matched else parsed title else filename
  fileName: string; path: string; size: number;
  duration: number|null;     // seconds
  width: number|null; height: number|null; // if known
  date: string|null;         // release date YYYY-MM-DD
  year: number|null;
  poster: string|null;       // TPDB poster/background or pCloud thumb
  thumb: string|null;
  studio: { id: number; name: string } | null;
  performers: { id: number; name: string; image: string|null }[];
  matchStatus: MatchStatus; matchConfidence: number|null; // 0..1
  favorite: boolean;
  progress: { position: number; duration: number|null; percent: number; completed: boolean; updatedAt: string } | null;
  addedAt: string;
  source: 'pcloud' | 'torbox';
};
type SceneDetail = Scene & {
  description: string|null; tags: Tag[]; performers: Performer[];
  tpdb: { id: string; type: 'scene'|'movie'|'jav'; url: string|null } | null;
  stashdb: { id: string; url: string } | null;   // StashDB scene id (set when matched via / also found on StashDB)
  parsed: ParsedFilename;   // filename-parser output
  pcloud: { fileId: number; folderId: number; contentType: string|null } | null;
  trailer: string|null; backdrop: string|null;
};
type ParsedFilename = { studio: string|null; date: string|null; title: string|null; performers: string[]; resolution: string|null; extension: string };
```

## Health & session

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/health` | – | `{ ok: true, version: string, time: string }` |
| GET | `/api/session` | – | locked: `{ locked: true, pinEnabled: true }` only; unlocked: `{ locked: false, pinEnabled: true, pcloud: { connected: boolean, email: string|null, region: 'us'|'eu'|null }, torbox: { linked: boolean }, tpdb: { configured: boolean }, stashdb: { configured: boolean }, scan: ScanStatus }` |
| POST | `/api/session/unlock` | `{ pin: string }` | `{ locked: false }` + `Set-Cookie: pulse_auth`; 401 `bad_pin`; 429 `rate_limited` |
| POST | `/api/session/lock` | – | `{ locked: true }` (clears the cookie; "Lock now" / logout) |

## pCloud

The app's client secret cannot read files; the user must authorize once (OAuth2 code flow).
Redirect URI to register in the pCloud app console: `<PUBLIC_BASE_URL>/api/pcloud/callback`
(e.g. `http://localhost:8787/api/pcloud/callback`, plus the tunnel URL). `GET /api/pcloud/authorize-url` returns the exact one in use.

| Method | Path | Body/Query | Response |
|---|---|---|---|
| GET | `/api/pcloud/authorize-url` | `?redirect=1` optional (302 to pCloud instead of JSON); `?redirectUri=` optional override (must be registered); `?manual=1` builds the URL **without** redirect_uri — pCloud then shows the code on screen for the user to paste into `/api/pcloud/exchange` (no redirect URI registration needed); `?force=1` force re-approve | `{ url: string, redirectUri: string|null, state: string, manual: boolean }` |
| GET | `/api/pcloud/callback` | `?code&state&hostname&locationid` (from pCloud) | 302 → `/settings?pcloud=connected` (or `?pcloud=error&message=`) |
| POST | `/api/pcloud/exchange` | `{ code?: string, callbackUrl?: string, hostname?: string, locationid?: number, redirectUri?: string }` — paste the full redirected URL or only the code | `PcloudStatus` |
| GET | `/api/pcloud/status` | – | `PcloudStatus` |
| POST | `/api/pcloud/disconnect` | – | `{ connected: false }` (token wiped; library kept unless `{ purge: true }`) |
| GET | `/api/pcloud/folders` | `?folderId=0` (0 = root) | `{ folderId: number, name: string, path: string, parentId: number|null, folders: {folderId:number,name:string,path:string,selected:boolean}[], videoCount: number }` |
| GET | `/api/pcloud/scan-folders` | – | `{ folders: { folderId: number, path: string, name: string }[] }` (empty = whole account) |
| PUT | `/api/pcloud/scan-folders` | `{ folders: { folderId: number, path?: string, name?: string }[] }` | same as GET |
| POST | `/api/pcloud/rescan` | `{ full?: boolean, autoMatch?: boolean (default true) }` | `ScanStatus` (202) |
| GET | `/api/pcloud/scan` | – | `ScanStatus` |
| GET | `/api/pcloud/files/:fileId/variants` | – | `{ fileId, variants: { url, label, width, height, bitrate, isOriginal, duration }[], hls: string|null }` |

Exchange without hostname tries US (`api.pcloud.com`) then EU (`eapi.pcloud.com`). Tokens are stored AES-256-GCM encrypted in sqlite.

```ts
type PcloudStatus = { connected: boolean; email: string|null; region: 'us'|'eu'|null; apiHost: string|null;
  quota: number|null; usedQuota: number|null; connectedAt: string|null; redirectUri: string; clientConfigured: boolean };
type ScanStatus = { state: 'idle'|'running'|'error'; startedAt: string|null; finishedAt: string|null;
  foldersScanned: number; filesSeen: number; videosFound: number; added: number; removed: number; updated: number;
  currentPath: string|null; error: string|null };
```

## Library

### GET `/api/library` → `Paged<Scene>`
Query (all optional):
- `q` – text search (title, filename, performer, studio, tag)
- `sort` – `added` (default) | `date` | `title` | `duration` | `size` | `random` | `lastWatched`; `order` – `desc` (default) | `asc`
- `tags` – comma list of tag ids (AND); `performers` – comma list of performer ids (AND); `studio` – studio id (comma list = OR)
- `year` – `2021` or range `2018-2021`; `minDuration`, `maxDuration` – seconds
- `matched` – `true` | `false`; `status` – one MatchStatus; `favorites` – `true`; `watched` – `true|false|inprogress`
- `source` – `pcloud|torbox`; `page`, `pageSize`

| Method | Path | Response |
|---|---|---|
| GET | `/api/library/facets` | `{ years: {year:number,count:number}[], studios: Studio[], tags: Tag[] (top 100), performers: Performer[] (top 100), durationMax: number, totals: { scenes:number, matched:number, unmatched:number, favorites:number } }` |
| GET | `/api/scenes/:id` | `SceneDetail` |
| PATCH | `/api/scenes/:id` | body `{ title?, date?, description?, studioName?, performerNames?: string[], tagNames?: string[] }` → `SceneDetail` (manual edit sets status `manual`) |
| GET | `/api/performers` | `?q&sort=name|scenes|added&order&favorites=true&gender&page&pageSize` → `Paged<Performer>` |
| GET | `/api/performers/:id` | `PerformerDetail & { scenes: Scene[] }` (first 60 scenes; use `/api/library?performers=id` for more) |
| GET | `/api/studios` | `?q&page&pageSize` → `Paged<Studio>` |
| GET | `/api/studios/:id` | `Studio & { scenes: Scene[] }` |
| GET | `/api/tags` | `?q&page&pageSize` (sorted by sceneCount desc) → `Paged<Tag>` |

### Favorites
| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/favorites/toggle` | `{ type: 'scene'|'performer'|'studio', id: number, favorite?: boolean, list?: 'favorites'|'watchlist' }` (omit favorite = toggle; `list:'watchlist'` only for scenes) | `{ type, id, list, favorite: boolean }` |
| GET | `/api/favorites` | – | `{ scenes: Scene[], performers: Performer[], studios: Studio[] }` |
| GET | `/api/watchlist` | – | `{ items: Scene[] }` |

`Scene` also carries `watchlist: boolean`; `Studio` carries `favorite: boolean`. `/api/library` accepts `watchlist=true`; `/api/studios` accepts `favorites=true`.

### Watch progress
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/scenes/:id/progress` | – | `{ position, duration, percent, completed, updatedAt } | null` |
| PUT | `/api/scenes/:id/progress` | `{ position: number, duration?: number, completed?: boolean }` (completed auto when percent ≥ 92) | same shape |
| DELETE | `/api/scenes/:id/progress` | – | `{ ok: true }` |
| GET | `/api/continue-watching` | `?limit=20` | `{ items: Scene[] }` (in progress, not completed, most recent first) |
| GET | `/api/recently-added` | `?limit=20` | `{ items: Scene[] }` |
| GET | `/api/home` | – | `{ hero: Scene[] (≤5), rails: { id: string, title: string, kind: 'scenes'|'performers', items: (Scene|Performer)[] }[] }` — rail ids: `continue`, `recent`, `favorites`, `top-performers`, `studio-<id>`, `tag-<id>`, `unwatched` |

## Streaming

### GET `/api/scenes/:id/stream`
Returns fresh, short-lived direct links (pCloud links are bound to the requesting IP, so the server requests them with the
client's IP forwarded where possible; if playback fails use `proxy`).
```ts
{ sceneId: number; expiresAt: string|null;
  primary: { url: string; type: 'mp4'|'hls'|'other'; mime: string|null; label: 'Original' };
  alternatives: { url: string; type: 'mp4'|'hls'; label: string /* e.g. '1080p', '720p', 'HLS' */; width: number|null; height: number|null; bitrate: number|null }[];
  hls: string|null;                // getvideolinks HLS / gethlslink if available
  proxy: string;                   // `/api/scenes/:id/proxy` – server-side Range proxy (always works)
  subtitles: { label: string; lang: string|null; url: string; format: 'vtt'|'srt' }[]; // url = `/api/scenes/:id/subtitles/:subId` (served as WebVTT)
  thumbnails: string|null;         // pCloud thumb link
  duration: number|null }
```
- `GET /api/scenes/:id/proxy` – streams bytes with HTTP Range support (fallback).
- `GET /api/scenes/:id/subtitles/:subId` – sibling `.srt`/`.vtt` file converted to `text/vtt`.
- `GET /api/scenes/:id/thumb?size=640x360` – 302 to pCloud thumbnail.

## Metadata (ThePornDB + StashDB)

Two providers feed the matcher: **ThePornDB** (`TPDB_API_KEY`) and **StashDB** (`STASHDB_API_KEY`, GraphQL at `https://stashdb.org/graphql`, header `ApiKey`). Both are queried **in parallel**
and their candidates are scored by the same function (see *StashDB* below). `Scene` / `SceneDetail` carry `matchSource: 'tpdb'|'stashdb'|null` (the provider that supplied the stored metadata; shown as the
"Matched via" badge); `performers`, `studios` and `tags` carry `source`. A candidate's `tpdbId` always holds *that provider's* id (a UUID for StashDB) and `source` says which provider it is.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/scenes/:id/match` | `{ query?: string, type?: 'scene'|'movie'|'jav', apply?: boolean }` — without `tpdbId`: runs the strategy cascade (see *Matching strategies*), returns candidates; with `query` it is a manual search (never auto-applies, explores more variants); `apply:true` auto-applies the best if confidence ≥ threshold | `{ candidates: MatchCandidate[] /*≤20, each with matchedBy*/, applied: MatchCandidate|null, query: string /*cleaned query to pre-fill*/, strategy: string|null, confident: boolean, alternatives: Alt[] /*top 5*/, queries: number, parsed: {...} }` |
| POST | `/api/scenes/:id/match` | `{ tpdbId: string, type?: 'scene'|'movie'|'jav', source?: 'tpdb'|'stashdb' }` — apply a specific candidate (`source` defaults to `tpdb`; for `stashdb`, `tpdbId` is the StashDB scene id) | `{ candidates: [], applied: MatchCandidate, scene: SceneDetail }` |
| POST | `/api/scenes/:id/unmatch` | – | `SceneDetail` (status `unmatched`) |
| POST | `/api/scenes/:id/ignore` | – | `{ ok: true }` (status `ignored`) |
| GET | `/api/match/unmatched` | `?page&pageSize` | `Paged<Scene>` (status unmatched/failed) |
| POST | `/api/match/queue` | `{ sceneIds?: number[], all?: boolean, priority?: boolean }` (`all` = every unmatched/failed file, including ones searched before; `priority` = in front of everything else) | `MatchJobStatus` |
| GET | `/api/match/status` | – | `MatchJobStatus` (progress, rate, ETA, upstream usage — see *Bulk matching*) |
| POST | `/api/match/pause` | – | `MatchJobStatus` (`paused: true`; workers finish their current file, `state` stays `running`) |
| POST | `/api/match/resume` | – | `MatchJobStatus` |
| POST | `/api/match/cancel` | – | `MatchJobStatus` (drops the queue, aborts in-flight upstream requests, resets `queued` rows to `unmatched`) |
| POST | `/api/match/prioritize` | `{ sceneIds: number[] }` — move files that are waiting in the queue to the front (also done automatically by `GET /api/scenes/:id`) | `MatchJobStatus` |
| POST | `/api/match/retry-unmatched` | `{ includeIgnored?: boolean }` — **Re-match all unmatched**: drops cached empty TPDB answers, re-parses every unmatched/failed file name with the current parser, then queues them all through the full cascade (background job; poll `/api/match/status`) | `MatchJobStatus & { requeued: number }` |
| GET | `/api/scenes/:id/match-info` | – | `{ status, confidence, strategy: string|null, query: string, alternatives: Alt[], parsed }` — stored result of the last automatic run: cleaned query (pre-fill for the Search box), matched-by strategy and the top-5 alternatives with scores |
| GET | `/api/tpdb/search` | `?q&type=scene|movie|jav|performer&page` | `{ items: MatchCandidate[] }` or for performer `{ items: {tpdbId,name,image,gender}[] }` |
| POST | `/api/performers/:id/refresh` | `{ source?: 'tpdb'|'stashdb' }` | `PerformerDetail` — refetch from ThePornDB (default; StashDB when TPDB is off / has no such performer); `source:'stashdb'` pulls StashDB data and fills the gaps (existing values win; aliases, images and links are unioned) |
| GET | `/api/stashdb/test` | – | `{ ok: boolean, status: 'ok'|'not_configured'|'unauthorized'|'unreachable'|'error', hint: string }` — validates the key with `query { me { name } }` (falls back to a `queryScenes` count); never returns the key |
| GET | `/api/stashdb/search` | `?q&type=scene|performer` | `{ items: MatchCandidate[] }` (each `source:'stashdb'`) or for performer `{ items: { stashId, name, image, gender, aliases, source }[] }` |
| GET | `/api/metadata/sources` | – | `{ sources: { id: 'tpdb'|'stashdb', label, configured: boolean, enabled: boolean, active: boolean /*configured && enabled*/ }[] }` |

```ts
type MatchCandidate = { source?: 'tpdb'|'stashdb'; alsoOn?: { source: 'tpdb'|'stashdb'; id: string }[] /*same scene on the other provider*/; tpdbId: string; type: 'scene'|'movie'|'jav'; title: string; date: string|null; studio: string|null;
  performers: string[]; poster: string|null; duration: number|null; url: string|null; confidence: number /*0..1*/;
  matchedBy?: 'parse'|'title'|'studio+date'|'studio+title'|'performer'|'words'|'fuzzy'|'movie'|'jav'|'hash'|'query' };
type MatchJobStatus = { state: 'idle'|'running'; queued: number; processed: number; matched: number; failed: number; unmatched: number;
  current: { sceneId: number; title: string } | null; startedAt: string|null; lastError: string|null;
  strategies: Record<string, number> /* matched-by counts for this run, e.g. { parse: 12, title: 3, words: 2, 'performer-batch': 80 } */;
  // progress (bulk matching)
  paused: boolean; total: number /*processed + queued + active*/; active: number /*files in flight*/;
  rate: number /*files per minute, trailing 60 s*/; etaSeconds: number|null /*null = unknown yet*/;
  groups: { total: number; done: number; filesMatched: number; skipped: Record<string, number> } /*performer / studio batches*/;
  requests: { http: number; cacheHits: number; deduped: number; retries: number; rps: number|null; maxRps: number|null; throttled: number; inflight: number; waiting: number } /*ThePornDB usage since start*/ };
type Alt = { source?: 'tpdb'|'stashdb'; alsoOn?: { source: 'tpdb'|'stashdb'; id: string }[]; tpdbId: string; type: 'scene'|'movie'|'jav'; title: string; date: string|null; studio: string|null; performers: string[]; poster: string|null; confidence: number; matchedBy: string };
```

### Bulk matching (speed)

Matching a whole library (thousands of files) is limited by ThePornDB's request rate, so everything is built to spend as few requests as possible and to never idle:

- **Workers:** `MATCH_CONCURRENCY` (default 10) files are processed at once. There is **no fixed delay between requests**: `TpdbClient` uses an adaptive token bucket (`services/rateLimiter.ts`).
  It starts at `TPDB_START_RPS` (8), ramps +10 % after every 8 healthy responses up to `TPDB_MAX_RPS` (10) and halves on HTTP 429 (plus a global pause for `Retry-After`); `X-RateLimit-Limit/Remaining/Reset`
  (or `RateLimit-*`) headers are honoured when the API sends them (pause until reset when the window is exhausted, never faster than `remaining / reset`). `TPDB_INTERVAL_MS` is only a legacy extra spacing floor
  (unset = off, `0` = no limiter at all, used by tests). At most 16 requests are in flight.
- **Concurrent strategies (`fastCascade`, `services/bulkMatcher.ts`):** per file, tier 1 fires `parse` (raw + cleaned name) / JAV code at once; if that is not confident, tier 2 fires the title queries, the studio chain
  (site lookup → `site_id+date` / `site_id+title`) and the performer chain (lookup → `performer_id+date/title/site_id`) concurrently. Results are folded into one scored pool in strategy priority order (so `matchedBy` is
  deterministic); at the first confident pool the rest is cancelled through an `AbortController` — requests still waiting for a token never reach the network. Files that stay unconfident fall back to the full sequential
  cascade (word-by-word, fuzzy, movie/JAV endpoints, StashDB, hash) with budget `MATCH_FALLBACK_BUDGET` (16). If StashDB is configured it runs concurrently too and a twin of the chosen scene is recorded as `alsoOn`.
  Set `MATCH_QUICK_LEFTOVERS=0` (bench: `--no-quick`) to also run the full sequential cascade on batch leftovers; it found ~5 more borderline (0.75–0.82) matches per 100 files at ~25% lower throughput.
- **De-duplication + persistent cache:** identical queries in flight at the same moment share one request; every answer is stored in `http_cache` (SQLite). Hits live 7 days, **empty answers only 6 h** (`negativeTtlMs`),
  entries older than 45 days are pruned at the start of a run. The page-sized scene lists used for batching are *not* persisted (kept in memory for the run).
- **Batch by performer / studio:** before the per-file queue is served, files are grouped (`planGroups`): ≥ 3 files sharing a performer (`Name - Title.mp4` prefix or parsed performer) or a date-less studio. The
  performer/site is resolved **once**, its scene list is paged in (100 per page, 3 pages in parallel) and every file in the group is matched locally with the normal scorer (`matchedBy: 'performer-batch'` /
  `'site-batch'`) — no per-file API call, and the scene object from the list is applied directly (no `GET /scenes/{id}`). Cost model: a group is only batched when paging its list costs ≤ 2 requests per file and ≤ 12 pages;
  otherwise its files go through the normal path. Files a batch could not place only get the concurrent strategies (no long cascade); **Retry matching** (`/api/match/retry-unmatched`) runs the thorough path for everything.
- **Priority:** `high` queue (files the user opened — `GET /api/scenes/:id` moves a waiting file to the front — or `priority:true` / `/api/match/prioritize`) → group batches → normal queue ordered by `added_at` (newest first).
- **Never blocks the UI:** all work is async, CPU-heavy loops yield to the event loop, SQLite writes are per-file. Control with `pause` / `resume` / `cancel`; progress in `GET /api/match/status`.
- **Rescans:** a rescan (`autoMatch`) only queues files that were never searched (and previous failures). Files already `matched`/`manual`/`ignored` are never touched; files searched before without a result are only
  queued again by `POST /api/match/queue {all:true}` or *Retry matching*.
- **Hashing:** the OSHASH (two ranged pCloud reads) is **not** computed during bulk matching (`Matcher.bulkHash=false`); an already cached `scenes.oshash` is still used. Thumbnails are generated on demand only.
- **pCloud scan:** sub-folders are listed with up to `SCAN_CONCURRENCY` (6) parallel non-recursive `listfolder` calls (with retries); falls back to the old single recursive call if that fails.
- Benchmark: `TPDB_API_KEY=… npx tsx scripts/bench-match.ts --n 100 [--db data-demo-db] [--concurrency N] [--warm] [--dump]` (runs on a temp copy of the db).

### StashDB (second provider)

- **Enabled when** `STASHDB_API_KEY` is set and `Settings.metadata.stashdb` is not `false`; ThePornDB likewise with `Settings.metadata.tpdb`. Either one alone works; with both off the match queue returns 409.
  The key is trimmed/sanitised like the other env values (BOM, quotes, `Bearer `, whitespace) and is never logged, cached or returned by any route.
- **Parallel:** the StashDB track starts at the same moment as the ThePornDB cascade and adds to the same candidate pool; the cascade stops at the first confident result from *either* provider (the slower track is then aborted).
  Inside the StashDB track independent queries are also concurrent. Strategies (`matchedBy` is shared with TPDB): `title` (`searchScenes` on the full cleaned name, the title words and `studio + title`), `studio+date` / `studio+title`
  (`searchStudio` → `queryScenes{studios, date|text}`), `performer` / `fuzzy` (`searchPerformers` → `queryScenes{performers, date|text|none}`), `words` (progressive shorter queries), and `hash`
  (`queryScenes{fingerprints}` with the file's OSHASH — a cached `scenes.oshash` is used at once, otherwise the OSHASH is computed once as the last resort and shared with the TPDB hash step).
- **Merge:** the same scene on both providers (same normalised title + date) collapses into one candidate: the higher score wins (ties → ThePornDB) and the other provider's id is kept in `alsoOn`; when applied, the second id is stored
  too (`SceneDetail.tpdb` + `SceneDetail.stashdb`).
- **Stored data:** `scenes.stash_id`, `scenes.match_source`, `scenes.oshash`, and `stash_id` columns on `performers`, `studios` and `tags` (merged with existing rows by normalised name). StashDB performer data is stored in the same
  detail shape as ThePornDB, so `PerformerDetail` fills `aliases`, `birthday`, `nationality`, `ethnicity`, `hairColor`, `eyeColor`, `height` (`170cm`), `measurements` (`34DD-25-36`), `cupSize`, `tattoos`, `piercings`,
  `careerStart/End`, all `images` and `links` (including a `StashDB` link).
- **Network path** (both providers): calls go through the optional Cloudflare Worker (`PROVIDER_PROXY_URL` + `PROVIDER_PROXY_SECRET`, see docs/hosting.md) when set, else direct; if the system DNS fails
  (`ENOTFOUND` / `EAI_AGAIN`) the host is resolved via DNS-over-HTTPS (cloudflare-dns.com, dns.google, pinned 1.1.1.1 / 8.8.8.8) and contacted by IP with the original Host/SNI. Endpoints: env `TPDB_BASE_URL`
  (default `https://api.theporndb.net`) and `STASHDB_URL` (default `https://stashdb.org/graphql`), overridable in `Settings.metadata.tpdbBaseUrl` / `.stashdbUrl` (empty = env value).
  `GET /api/tpdb/test` and `GET /api/stashdb/test` add `path: 'direct'|'doh'|'proxy'|null` (path of the last successful request) and `network: { path, proxy: boolean, doh: boolean, problem: string|null }`;
  `problem` explains a blocked network and is appended to `hint` when the test fails.
- A StashDB problem (bad key, outage) never fails a file that ThePornDB can match; it is reported in the run's errors. After a 401 the key is not retried for 5 minutes; `GET /api/stashdb/test` clears that.

### Matching strategies

`Scene` / `SceneDetail` carry `matchStrategy: string|null` (the strategy that produced the match, `manual` for hand picks) and `SceneDetail`
also `matchQuery` and `matchAlternatives` (top-5 with scores from the last automatic run, shown in the Review queue).

File names are normalised first (extension stripped; `.`/`_`/`-`/`+` as spaces; camelCase split; resolution/codec/bitrate/WEB-DL/XXX/SD-HD/release-group
and `[bracket]` junk removed; `www.site.com` tags kept as studio hints; `(1)`/`- Copy` suffixes dropped; dates in `YYYY-MM-DD`, `YY.MM.DD`, `DD.MM.YYYY`,
`YYYYMMDD`, `12 May 2021`; leading studio such as `BraZZers.21.05.12.Name.Name.Title`; parent folders as studio/performer hints).
The cascade then stops at the first confident result (every TPDB query is cached in the db):

1. `jav` – JAV code → `/jav`
2. `parse` / `title` – TPDB `parse=` of the raw name, then exact normalised-title `q=`
3. `studio+date` / `studio+title` – studio resolved via `/sites?q=`, then `site_id` + `date` / `q` filters
4. `performer` – performer names (parsed, folder, name windows) resolved via `/performers?q=`, then `performer_id` + `date`/`q`/`site_id`
5. `words` – word-by-word: progressively shorter title queries (drop trailing / leading words), bigrams, single rare words (also with the date filter)
6. `fuzzy` – Dice / Levenshtein scoring over narrowed lists (performer scenes, studio+year, date)
7. `movie` / `jav` endpoints for names that are not scenes
8. `hash` – optional (setting `library.hashMatch`, default on): OSHASH of the pCloud file (two 64 KiB ranged reads) → `/scenes?hash=`; last resort only

Candidates are scored 0..1 from rarity-weighted token overlap, fuzzy title similarity, and date / studio / performer / JAV-code / duration agreement; ties between different
scenes are capped below the threshold so they go to review instead of being auto-matched wrongly.

## TorBox

| Method | Path | Body/Query | Response |
|---|---|---|---|
| GET | `/api/torbox/link` | – | `TorboxStatus` |
| PUT | `/api/torbox/link` | `{ apiKey?: string }` (omit → use server env key). Validated via `/user/me` | `TorboxStatus` or 400 `invalid_key` |
| DELETE | `/api/torbox/link` | – | `{ linked: false }` |
| GET | `/api/torbox/status` | – | `TorboxStatus` |
| GET | `/api/torbox/downloads` | `?type=torrents|usenet|webdl|all` (default all) | `{ items: TorboxItem[] }` |
| GET | `/api/torbox/downloads/:type/:id` | type = `torrents|usenet|webdl` | `TorboxItem` |
| POST | `/api/torbox/add` | `{ magnet?: string, url?: string, nzbUrl?: string, name?: string }` (multipart `file` .torrent/.nzb also accepted) | `{ type, id: number|null, hash: string|null, message: string }` |
| POST | `/api/torbox/cached` | `{ hashes: string[], type?: 'torrents'|'usenet'|'webdl' }` | `{ cached: Record<string, { name: string, size: number, files: {name:string,size:number}[] } | false> }` |
| GET | `/api/torbox/downloads/:type/:id/files` | – | `{ files: TorboxFile[] }` |
| GET | `/api/torbox/stream` | `?type=torrents|usenet|webdl&id=&fileId=` | `{ url: string, mime: string|null, name: string }` (TorBox requestdl link) |
| DELETE | `/api/torbox/downloads/:type/:id` | – | `{ ok: true }` |
| POST | `/api/torbox/downloads/:type/:id/control` | `{ operation: 'delete'|'pause'|'resume'|'reannounce' }` | `{ ok: true, operation }` |
| POST | `/api/torbox/import` | `{ type?: 'torrents'|'usenet'|'webdl', ids?: number[], autoMatch?: boolean }` — adds video files of *ready* TorBox items to the library as `source:'torbox'` scenes (streamed via requestdl) | `{ added: number, seen: number, match: MatchJobStatus }` |
| POST | `/api/torbox/save-to-pcloud` | `{ type, id, fileId, folderId }` — pCloud `downloadfileasync` of the TorBox link into a pCloud folder | `{ ok: true, message }` |

```ts
type TorboxStatus = { linked: boolean; source: 'user'|'env'|null; email: string|null; plan: number|null; planName: string|null; premiumExpiresAt: string|null; error: string|null };
type TorboxItem = { id: number; type: 'torrents'|'usenet'|'webdl'; name: string; hash: string|null; size: number; progress: number /*0..1*/;
  state: string; downloadSpeed: number; uploadSpeed: number; seeds: number|null; peers: number|null; eta: number|null;
  ready: boolean; createdAt: string|null; files: TorboxFile[] };
type TorboxFile = { id: number; name: string; shortName: string; size: number; mime: string|null; isVideo: boolean };
```

## Settings

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/settings` | – | `Settings` |
| PUT | `/api/settings` | partial `Settings` (excluding pin) | `Settings` |
| POST | `/api/settings/pin` | `{ pin: string /*4-8 digits*/, currentPin: string /*required*/ }` change PIN (needs an unlocked session; rate limited) | `{ pinEnabled: true }` + fresh `pulse_auth` cookie; other sessions are signed out |

The PIN lock cannot be switched off (there is no `DELETE /api/settings/pin`).

| POST | `/api/data/clear` | `{ what: 'progress'|'cache'|'favorites'|'metadata'|'library'|'all' }` | `{ ok: true, cleared }` |

```ts
type Settings = { pinEnabled: true /*always*/; autoLockMinutes: number /*idle auto-lock; 0=never (default)*/; blurThumbnails: boolean; hideFromRecents: boolean;
  playback: { autoplayNext: boolean; defaultQuality: 'original'|'1080p'|'720p'|'480p'|'auto'; preferHls: boolean; resumePlayback: boolean;
    skipSeconds: number; playbackRate: number; subtitlesEnabled: boolean; subtitleLang: string|null; muted: boolean };
  library: { autoMatch: boolean; matchThreshold: number /*0..1*/; scanIntervalHours: number /*0=manual*/; hashMatch: boolean /*OSHASH last-resort strategy*/ };
  metadata: { tpdb: boolean; stashdb: boolean /*providers that take part in matching (default both true)*/; tpdbBaseUrl: string; stashdbUrl: string /*endpoint overrides, '' = env/default*/ } };
```

## Notes for the frontend
- `Scene.poster`/`thumb` may be `/api/scenes/:id/thumb` (pCloud thumbnail proxied + cached by the server).
- Playback: try `primary.url` (direct pCloud/TorBox CDN link); on error fall back to `proxy` (same-origin, Range-capable). In DEMO mode always use `proxy`.
- pCloud OAuth callback redirects to `/settings?pcloud=connected` or `/settings?pcloud=error&message=...`.
- Demo mode: `npm run demo` in `server/` (port 8788, data in `server/data-demo-db`) mocks pCloud with 29 sample files; connect via `POST /api/pcloud/exchange {"code":"mock-code"}`. TPDB/TorBox calls stay live.
- Not implemented: device management / pairing (`/pair`), multi-user accounts.
