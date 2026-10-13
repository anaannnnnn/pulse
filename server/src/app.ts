import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { config } from './config.js';
import { openDb, KV, DB } from './db.js';
import { registerAuth } from './auth.js';
import { HttpError, FetchLike } from './http.js';
import { PcloudClient, PcloudToken, buildAuthorizeUrl, parseCallbackInput, regionFromHost, hostFromLocation } from './clients/pcloud.js';
import { TpdbClient } from './clients/tpdb.js';
import { StashDbClient } from './clients/stashdb.js';
import { createProviderFetch, type ProviderFetchOpts } from './netFetch.js';
import { TorboxClient, TorboxType } from './clients/torbox.js';
import { Library } from './services/library.js';
import { Matcher } from './services/matcher.js';
import { Scanner, ScanFolder } from './services/scanner.js';
import { parseFilename, isVideo, srtToVtt } from './parser.js';
import { listZipVideos, openZipEntry } from './zipList.js';
import { oshashFromUrl } from './hash.js';
import { CacheStore } from './cacheStore.js';
import { PcloudCacheCloud } from './services/pcloudCache.js';
import { registerPerf, ReadCache, StaticCache, ByteLru, limit } from './perf.js';

export type AppOptions = { db?: DB; /** provider cache file (default: <dataDir>/cache.db, or in-memory when `db` is given) */ cacheFile?: string; fetch?: FetchLike; logger?: boolean; env?: Partial<typeof config>; /** test hooks for the provider network layer (DoH / connect) */ net?: Partial<ProviderFetchOpts> };

const DEFAULT_SETTINGS = {
  autoLockMinutes: 0, blurThumbnails: false, hideFromRecents: false,
  playback: { autoplayNext: true, defaultQuality: 'original', preferHls: false, resumePlayback: true, skipSeconds: 10, playbackRate: 1, subtitlesEnabled: false, subtitleLang: null, muted: false },
  library: { autoMatch: true, matchThreshold: 0.75, scanIntervalHours: 0, hashMatch: true },
  /** Metadata providers that take part in matching (both are queried in parallel when on). */
  metadata: { tpdb: true, stashdb: true, tpdbBaseUrl: '', stashdbUrl: '' },
};
const TB_TYPES: TorboxType[] = ['torrents', 'usenet', 'webdl'];
const err = (status: number, code: string, message: string) => new HttpError(status, message, code);
function deepMerge(a: any, b: any): any {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : b;
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(a?.[k], v) : v;
  return out;
}
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.map': 'application/json', '.mp4': 'video/mp4' };

// Per-request "incoming request / request completed" lines are off (two synchronous log writes per request; the slow-request log in perf.ts replaces them).
// Fastify >= 5.12 wants a LogController for that; older 5.x still takes the plain option.
const LogControllerCls = (Fastify as any).LogController;
const reqLogOff = LogControllerCls ? { logController: new LogControllerCls({ disableRequestLogging: true }) } : { disableRequestLogging: true };

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance & { ctx: any }> {
  const cfg = { ...config, ...(opts.env || {}) } as typeof config;
  const f: FetchLike = opts.fetch || fetch;
  const db = opts.db || openDb();
  const kv = new KV(db);
  const lib = new Library(db);
  // Provider answers live in their own compressed cache.db (never in pulse.db); tests that pass their own in-memory db get an in-memory cache.
  const cache = new CacheStore(opts.cacheFile ?? (opts.db ? ':memory:' : path.join(cfg.dataDir, 'cache.db')));
  // provider calls (ThePornDB, StashDB) survive blocked DNS: optional Worker proxy -> direct -> DNS-over-HTTPS (see netFetch.ts)
  const netOpts: ProviderFetchOpts = { proxyUrl: cfg.providerProxyUrl, proxySecret: cfg.providerProxySecret, doh: cfg.providerDoh, ...(opts.net || {}) };
  const tpdbNet = createProviderFetch(f, netOpts);
  const stashNet = createProviderFetch(f, netOpts);
  const tpdb = new TpdbClient(cfg.tpdbKey, cache, tpdbNet, cfg.tpdbIntervalMs, { maxRps: cfg.tpdbMaxRps, startRps: cfg.tpdbStartRps });
  const stash = new StashDbClient(cfg.stashdbKey, cache, stashNet, cfg.stashdbIntervalMs, cfg.stashdbUrl);
  // endpoints: env defaults, overridable in Settings (metadata.tpdbBaseUrl / metadata.stashdbUrl; empty = default)
  const cleanUrl = (v: any, def: string) => { const t = String(v || '').trim().replace(/\/+$/, ''); try { return t && /^https?:$/.test(new URL(t).protocol) ? t : def; } catch { return def; } };
  const applyEndpoints = () => { const m = settings().metadata || {}; tpdb.base = cleanUrl(m.tpdbBaseUrl, cfg.tpdbBaseUrl); stash.url = cleanUrl(m.stashdbUrl, cfg.stashdbUrl); };
  const matcher = new Matcher(db, lib, tpdb);
  matcher.stash = stash;
  const scanner = new Scanner(db);
  // Idle auto-lock is OFF unless the user explicitly sets it. Values saved before settings v2 (the old default of 15 minutes) are ignored
  // until the user changes the setting again, which stamps `autoLockV: 2`.
  const AUTOLOCK_V = 2;
  const settings = () => {
    const raw: any = kv.get('settings', {});
    const merged: any = { ...deepMerge(DEFAULT_SETTINGS, raw), pinEnabled: true };
    if (raw.autoLockV !== AUTOLOCK_V) merged.autoLockMinutes = 0;
    delete merged.autoLockV;
    return merged;
  };
  matcher.threshold = settings().library.matchThreshold;
  applyEndpoints();
  matcher.purgeEmptyCache = () => cache.purgeEmpty();
  matcher.providers = () => { const m = settings().metadata || {}; return { tpdb: m.tpdb !== false, stashdb: m.stashdb !== false }; };
  const anyProvider = () => matcher.useTpdb() || matcher.useStash();
  // Optional last-resort strategy: OSHASH of the pCloud file (two 64 KiB ranged reads) looked up on TPDB.
  matcher.hashProvider = async (row: any) => {
    if (!settings().library.hashMatch || !row.pcloud_file_id || !pcloudToken() || !row.size) return null;
    const l = await pcloud().fileLink(row.pcloud_file_id);
    return oshashFromUrl(l.url, row.size, f);
  };

  const pcloudToken = (): PcloudToken | null => kv.get<PcloudToken | null>('pcloud.token', null);
  const pcloud = () => new PcloudClient(pcloudToken(), f);
  // Provider JSON (ThePornDB / StashDB) is spilled to a "Pulse Cache" folder on pCloud so cache.db stays a small hot set.
  const attachCacheCloud = () => {
    const t = pcloudToken();
    if (!t) { cache.detachCloud(); return; }
    cache.attachCloud(new PcloudCacheCloud(() => new PcloudClient(pcloudToken() || t, f)));
  };
  attachCacheCloud();
  const torboxKey = (): { key: string; source: 'user' | 'env' } | null => {
    const user = kv.get<string | null>('torbox.key', null);
    if (user) return { key: user, source: 'user' };
    if (cfg.torboxKey && !kv.get('torbox.unlinked', false)) return { key: cfg.torboxKey, source: 'env' };
    return null;
  };
  const torbox = () => { const k = torboxKey(); if (!k) throw err(409, 'torbox_not_linked', 'TorBox is not linked'); return new TorboxClient(k.key, f); };

  const app = Fastify({ ...(reqLogOff as any), logger: opts.logger ? { level: 'info', serializers: { req: (r: any) => ({ method: r.method, url: String(r.url).split('?')[0], remoteAddress: r.ip }) } } : false, trustProxy: true, bodyLimit: 20 * 1024 * 1024 }) as any;
  app.ctx = { db, kv, lib, matcher, scanner, tpdb, stash, cache };
  const perf = registerPerf(app);
  const reads = new ReadCache(db, () => matcher.status.state === 'running' || scanner.status.state === 'running');
  // any API call that changes data (favorite toggle, progress, match...) invalidates the read cache before the response leaves, so the next list request is fresh
  app.addHook('onSend', async (req: FastifyRequest, _reply: FastifyReply, payload: unknown) => { if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') reads.clear(); return payload; });
  const sendJson = (reply: FastifyReply, buf: Buffer) => reply.type('application/json; charset=utf-8').send(buf);
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });

  app.setErrorHandler((e: any, req: FastifyRequest, reply: FastifyReply) => {
    const status = e.status || e.statusCode || 500;
    const code = e.code && typeof e.code === 'string' && !e.code.startsWith('FST_') ? e.code : status === 404 ? 'not_found' : status < 500 ? 'bad_request' : 'internal_error';
    if (status >= 500) req.log.error({ err: { message: e.message, code } }, 'request failed');
    reply.status(status).send({ error: { code, message: e.message || 'Error' } });
  });

  // ---------- session / PIN lock (see auth.ts) ----------
  const auth = registerAuth(app, { kv, appPin: cfg.appPin, publicBaseUrl: cfg.publicBaseUrl, trustProxyHeaders: process.env.TRUST_PROXY_HEADERS, idleMinutes: () => Number(settings().autoLockMinutes) || 0 });

  const publicBase = (req: FastifyRequest) => {
    if (cfg.publicBaseUrl) return cfg.publicBaseUrl;
    const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0] || req.protocol;
    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
    return `${proto}://${host}`;
  };
  const redirectUriFor = (req: FastifyRequest) => `${publicBase(req)}/api/pcloud/callback`;

  const pcloudStatus = (req: FastifyRequest) => {
    const t = pcloudToken(); const info = kv.get<any>('pcloud.info', {});
    return { connected: !!t, email: t ? info.email ?? null : null, region: t ? regionFromHost(t.host) : null, apiHost: t?.host ?? null,
      quota: t ? info.quota ?? null : null, usedQuota: t ? info.usedquota ?? null : null, connectedAt: t ? info.connectedAt ?? null : null,
      redirectUri: redirectUriFor(req), clientConfigured: !!(cfg.pcloud.clientId && cfg.pcloud.clientSecret),
      cache: (() => { const i = cache.info(); return { localBytes: i.diskBytes, cloudBytes: i.cloudBytes, entries: i.cloudEntries, cloud: i.cloud }; })() };
  };
  const torboxStatus = async (validate = false) => {
    const k = torboxKey();
    if (!k) return { linked: false, source: null, email: null, plan: null, planName: null, premiumExpiresAt: null, error: null };
    let me = kv.get<any>('torbox.me', null);
    let error: string | null = null;
    if (validate || !me) {
      try { me = await new TorboxClient(k.key, f).me(); kv.set('torbox.me', { email: me.email, plan: me.plan, premium_expires_at: me.premium_expires_at }); }
      catch (e: any) { error = e.message; }
    }
    const plans: Record<number, string> = { 0: 'Free', 1: 'Essential', 2: 'Pro', 3: 'Standard' };
    return { linked: !error, source: k.source, email: me?.email ?? null, plan: me?.plan ?? null, planName: me?.plan != null ? plans[me.plan] ?? `Plan ${me.plan}` : null, premiumExpiresAt: me?.premium_expires_at ?? null, error };
  };

  // Liveness probe: never touches the database, the provider cache or the filesystem, so it answers even while a heavy request is running.
  app.get('/api/health', async () => ({ ok: true, version: cfg.version, time: new Date().toISOString(), uptimeS: Math.round(process.uptime()), rssMb: Math.round(process.memoryUsage().rss / 1048576),
    loop: { p99Ms: Math.round(perf.loop.percentile(99) / 1e6), maxMs: Math.round(perf.loop.max / 1e6) }, requests: perf.total, slowRequests: perf.slow, lastSlow: perf.lastSlow, cache: cache.info(), reads: { hits: reads.hits, misses: reads.misses } }));
  app.get('/api/session', async (req: FastifyRequest, reply: FastifyReply) => {
    if (auth.isLocked(req, reply)) return { locked: true, pinEnabled: true, pinLength: auth.pinLength() };
    const t = pcloudToken(); const info = kv.get<any>('pcloud.info', {});
    return { locked: false, pinEnabled: true,
      pcloud: { connected: !!t, email: t ? info.email ?? null : null, region: t ? regionFromHost(t.host) : null },
      torbox: { linked: !!torboxKey() }, tpdb: { configured: tpdb.configured }, stashdb: { configured: stash.configured }, scan: scanner.status };
  });

  // ---------- pCloud ----------
  const oauthStates = new Map<string, { redirectUri: string | null; at: number }>();
  app.get('/api/pcloud/authorize-url', async (req: any, reply: FastifyReply) => {
    if (!cfg.pcloud.clientId) throw err(409, 'pcloud_not_configured', 'PCLOUD_CLIENT_ID is not set');
    const manual = req.query.manual === '1' || req.query.manual === 'true';
    const redirectUri = manual ? null : (req.query.redirectUri || redirectUriFor(req));
    const state = crypto.randomBytes(12).toString('hex');
    oauthStates.set(state, { redirectUri, at: Date.now() });
    const url = buildAuthorizeUrl({ clientId: cfg.pcloud.clientId, redirectUri, state, forceReapprove: req.query.force === '1' });
    if (req.query.redirect === '1') return reply.redirect(url);
    return { url, redirectUri, state, manual };
  });
  const connectWith = async (code: string, hostname?: string | null, locationid?: number | null) => {
    if (!cfg.pcloud.clientId || !cfg.pcloud.clientSecret) throw err(409, 'pcloud_not_configured', 'pCloud client credentials are not set');
    const host = hostname || (locationid ? hostFromLocation(locationid) : null);
    const token = await PcloudClient.exchangeCode({ clientId: cfg.pcloud.clientId, clientSecret: cfg.pcloud.clientSecret, code, host, f });
    kv.set('pcloud.token', token, true);
    try { const u = await new PcloudClient(token, f).userinfo(); kv.set('pcloud.info', { email: u.email, quota: u.quota, usedquota: u.usedquota, connectedAt: new Date().toISOString() }); }
    catch { kv.set('pcloud.info', { connectedAt: new Date().toISOString() }); }
    attachCacheCloud();
  };
  app.get('/api/pcloud/callback', async (req: any, reply: FastifyReply) => {
    const q = req.query || {};
    try {
      if (q.error) throw new Error(String(q.error));
      if (!q.code) throw new Error('Missing code');
      if (q.state && oauthStates.size && !oauthStates.has(q.state)) throw new Error('Unknown or expired state, please retry');
      oauthStates.delete(q.state);
      await connectWith(String(q.code), q.hostname, q.locationid ? Number(q.locationid) : null);
      return reply.redirect('/settings?pcloud=connected');
    } catch (e: any) {
      return reply.redirect(`/settings?pcloud=error&message=${encodeURIComponent(e.message)}`);
    }
  });
  app.post('/api/pcloud/exchange', async (req: any) => {
    const b = req.body || {};
    let code = b.code, hostname = b.hostname, locationid = b.locationid;
    if (b.callbackUrl || (code && /code=|^https?:/.test(code))) {
      const p = parseCallbackInput(b.callbackUrl || code);
      code = p.code; hostname = hostname || p.hostname; locationid = locationid || p.locationid;
    }
    if (!code) throw err(400, 'bad_request', 'Provide code or callbackUrl');
    await connectWith(String(code).trim(), hostname, locationid);
    return pcloudStatus(req);
  });
  app.get('/api/pcloud/status', async (req: FastifyRequest) => {
    const s = pcloudStatus(req);
    if (s.connected) { try { const u = await pcloud().userinfo(); kv.set('pcloud.info', { ...kv.get('pcloud.info', {}), email: u.email, quota: u.quota, usedquota: u.usedquota }); return pcloudStatus(req); } catch (e: any) { if (e.code === 'pcloud_auth') return { ...s, connected: false, error: 'pCloud authorization expired, please reconnect' }; } }
    return s;
  });
  app.post('/api/pcloud/disconnect', async (req: any) => {
    kv.del('pcloud.token'); kv.del('pcloud.info');
    cache.detachCloud();
    if (req.body?.purge) { db.prepare(`DELETE FROM scenes WHERE source='pcloud'`).run(); lib.cleanupOrphans(); }
    return { connected: false };
  });
  app.get('/api/pcloud/folders', async (req: any) => {
    const folderId = Number(req.query.folderId || 0);
    const meta = await pcloud().listFolder(folderId, false);
    const selected = new Set(kv.get<ScanFolder[]>('pcloud.scanFolders', []).map((x) => x.folderId));
    const parentPath = (req.query.path as string) || (folderId === 0 ? '/' : `/${meta.name}`);
    const contents = meta.contents || [];
    return {
      folderId, name: folderId === 0 ? 'pCloud' : meta.name, path: parentPath, parentId: folderId === 0 ? null : meta.parentfolderid ?? 0,
      folders: contents.filter((c) => c.isfolder).sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ folderId: c.folderid!, name: c.name, path: `${parentPath === '/' ? '' : parentPath}/${c.name}`, selected: selected.has(c.folderid!) })),
      videoCount: contents.filter((c) => !c.isfolder && isVideo(c.name)).length,
    };
  });
  app.get('/api/pcloud/scan-folders', async () => ({ folders: kv.get('pcloud.scanFolders', []) }));
  app.put('/api/pcloud/scan-folders', async (req: any) => {
    const folders = (req.body?.folders || []).filter((x: any) => Number.isFinite(Number(x.folderId))).map((x: any) => ({ folderId: Number(x.folderId), path: x.path || null, name: x.name || null }));
    kv.set('pcloud.scanFolders', folders);
    return { folders };
  });
  const startScan = (autoMatch = settings().library.autoMatch) => {
    if (!pcloudToken()) throw err(409, 'pcloud_not_connected', 'Connect pCloud first');
    void scanner.run(pcloud(), kv.get('pcloud.scanFolders', []), (newIds) => {
      if (autoMatch && anyProvider()) matcher.enqueueAllUnmatched();
      void newIds;
    });
    return scanner.status;
  };
  app.post('/api/pcloud/rescan', async (req: any, reply: FastifyReply) => { const s = startScan(req.body?.autoMatch ?? settings().library.autoMatch); reply.status(202); return s; });
  app.get('/api/pcloud/scan', async () => scanner.status);
  app.get('/api/pcloud/files/:fileId/variants', async (req: any) => {
    const fileId = Number(req.params.fileId);
    const c = pcloud();
    const variants = await c.videoLinks(fileId);
    let hls: string | null = null; try { hls = await c.hlsLink(fileId); } catch { /* optional */ }
    return { fileId, variants: variants.map((v) => ({ url: v.url, label: v.isOriginal ? 'Original' : v.height ? `${v.height}p` : 'Transcoded', width: v.width, height: v.height, bitrate: v.bitrate, isOriginal: v.isOriginal, duration: v.duration })), hls };
  });

  // ---------- library ----------
  const sceneId = (req: any) => { const id = Number(req.params.id); if (!Number.isInteger(id)) throw err(400, 'bad_request', 'Invalid id'); return id; };
  const needScene = (id: number) => { const r = lib.sceneRow(id); if (!r) throw err(404, 'not_found', 'Scene not found'); return r; };
  // List/aggregate endpoints are served from a short-lived read cache that is invalidated by any database write (see ReadCache)
  app.get('/api/library', async (req: any, reply: FastifyReply) => {
    const q = req.query || {};
    if (String(q.sort) === 'random') return lib.query(q);   // random order must differ per call
    return sendJson(reply, reads.get(req.url, 60_000, () => lib.query(q)));
  });
  app.get('/api/library/facets', async (_req: any, reply: FastifyReply) => sendJson(reply, reads.get('facets', 60_000, () => lib.facets())));
  app.get('/api/scenes/:id', async (req: any) => { const id = sceneId(req); const d = lib.detail(id); if (!d) throw err(404, 'not_found', 'Scene not found'); matcher.prioritize([id], false); /* opened while waiting in the match queue: match it next */ return d; });
  app.patch('/api/scenes/:id', async (req: any) => {
    const id = sceneId(req); needScene(id); const b = req.body || {};
    db.transaction(() => {
      if (b.title !== undefined) db.prepare('UPDATE scenes SET title=? WHERE id=?').run(b.title, id);
      if (b.date !== undefined) db.prepare('UPDATE scenes SET date=? WHERE id=?').run(b.date, id);
      if (b.description !== undefined) db.prepare('UPDATE scenes SET description=? WHERE id=?').run(b.description, id);
      if (b.studioName !== undefined) db.prepare('UPDATE scenes SET studio_id=? WHERE id=?').run(b.studioName ? lib.upsertStudio(b.studioName) : null, id);
      if (Array.isArray(b.performerNames)) lib.setScenePerformers(id, b.performerNames.filter(Boolean).map((n: string) => lib.upsertPerformer(n)));
      if (Array.isArray(b.tagNames)) lib.setSceneTags(id, b.tagNames.filter(Boolean).map((n: string) => lib.upsertTag(n)));
      db.prepare(`UPDATE scenes SET match_status='manual', updated_at=? WHERE id=?`).run(new Date().toISOString(), id);
    })();
    return lib.detail(id);
  });
  app.get('/api/performers', async (req: any, reply: FastifyReply) => sendJson(reply, reads.get(req.url, 60_000, () => lib.performers(req.query || {}))));
  app.get('/api/performers/:id', async (req: any) => {
    const id = sceneId(req);
    const p = db.prepare('SELECT details FROM performers WHERE id=?').get(id) as any;
    if (!p) throw err(404, 'not_found', 'Performer not found');
    if (!p.details && anyProvider()) { try { await matcher.refreshPerformer(id); } catch { /* best-effort */ } }
    return lib.performerDetail(id);
  });
  app.post('/api/performers/:id/refresh', async (req: any) => {
    const id = sceneId(req);
    if (!db.prepare('SELECT 1 FROM performers WHERE id=?').get(id)) throw err(404, 'not_found', 'Performer not found');
    const src = req.body?.source === 'stashdb' ? 'stashdb' : req.body?.source === 'tpdb' ? 'tpdb' : undefined;
    if (src === 'stashdb' && !stash.configured) throw err(409, 'stashdb_not_configured', 'STASHDB_API_KEY is not set');
    const d = await matcher.refreshPerformer(id, src);
    if (!d) throw err(404, 'not_found', `Performer not found on ${src === 'stashdb' ? 'StashDB' : src === 'tpdb' ? 'ThePornDB' : 'ThePornDB or StashDB'}`);
    return lib.performerDetail(id);
  });
  app.get('/api/studios', async (req: any, reply: FastifyReply) => sendJson(reply, reads.get(req.url, 60_000, () => lib.studios(req.query || {}))));
  app.get('/api/studios/:id', async (req: any) => {
    const id = sceneId(req);
    const s = lib.studios({ pageSize: 1000 }).items.find((x: any) => x.id === id);
    if (!s) throw err(404, 'not_found', 'Studio not found');
    return { ...s, scenes: lib.cards(db.prepare('SELECT * FROM scenes WHERE studio_id=? ORDER BY COALESCE(date, added_at) DESC LIMIT 100').all(id) as any[]) };
  });
  app.get('/api/tags', async (req: any, reply: FastifyReply) => sendJson(reply, reads.get(req.url, 60_000, () => lib.tags(req.query || {}))));

  app.post('/api/favorites/toggle', async (req: any) => {
    const { type, id, favorite, list } = req.body || {};
    const table = type === 'scene' ? 'scenes' : type === 'performer' ? 'performers' : type === 'studio' ? 'studios' : null;
    if (!table || !Number.isInteger(Number(id))) throw err(400, 'bad_request', 'type must be scene|performer|studio and id an integer');
    const col = list === 'watchlist' ? 'watchlist' : 'favorite';
    if (col === 'watchlist' && table !== 'scenes') throw err(400, 'bad_request', 'watchlist only applies to scenes');
    const row = db.prepare(`SELECT ${col} v FROM ${table} WHERE id=?`).get(Number(id)) as any;
    if (!row) throw err(404, 'not_found', `${type} not found`);
    const val = favorite === undefined ? !row.v : !!favorite;
    if (table === 'scenes') db.prepare(`UPDATE scenes SET ${col}=?, ${col === 'watchlist' ? 'watchlist_at' : 'updated_at'}=? WHERE id=?`).run(val ? 1 : 0, new Date().toISOString(), Number(id));
    else db.prepare(`UPDATE ${table} SET favorite=? WHERE id=?`).run(val ? 1 : 0, Number(id));
    return { type, id: Number(id), list: col === 'watchlist' ? 'watchlist' : 'favorites', favorite: val };
  });
  app.get('/api/favorites', async () => ({
    scenes: lib.cards(db.prepare('SELECT * FROM scenes WHERE favorite=1 ORDER BY updated_at DESC').all() as any[]),
    performers: lib.performerList('WHERE p.favorite=1', [], 'ORDER BY p.name', 500),
    studios: lib.studios({ favorites: 'true', pageSize: 200 }).items,
  }));
  app.get('/api/watchlist', async () => ({ items: lib.cards(db.prepare('SELECT * FROM scenes WHERE watchlist=1 ORDER BY watchlist_at DESC').all() as any[]) }));

  app.get('/api/scenes/:id/progress', async (req: any) => { const id = sceneId(req); needScene(id); return lib.cards([lib.sceneRow(id)])[0].progress; });
  app.put('/api/scenes/:id/progress', async (req: any) => {
    const id = sceneId(req); needScene(id); const b = req.body || {};
    if (typeof b.position !== 'number' || b.position < 0) throw err(400, 'bad_request', 'position (seconds) required');
    if (settings().hideFromRecents) return { position: b.position, duration: b.duration ?? null, percent: 0, completed: false, updatedAt: new Date().toISOString() };
    return lib.setProgress(id, b.position, b.duration, b.completed);
  });
  app.delete('/api/scenes/:id/progress', async (req: any) => { db.prepare('DELETE FROM progress WHERE scene_id=?').run(sceneId(req)); return { ok: true }; });
  app.get('/api/continue-watching', async (req: any) => ({ items: lib.continueWatching(Math.min(100, Number(req.query.limit) || 20)) }));
  app.get('/api/recently-added', async (req: any) => ({ items: lib.recentlyAdded(Math.min(100, Number(req.query.limit) || 20)) }));
  app.get('/api/home', async (_req: any, reply: FastifyReply) => sendJson(reply, reads.get('home', 30_000, () => lib.home())));

  // ---------- streaming ----------
  const linkCache = new Map<number, { url: string; at: number }>();
  const sourceUrl = async (row: any, req: FastifyRequest, fresh = false): Promise<string> => {
    const c = linkCache.get(row.id);
    if (!fresh && c && Date.now() - c.at < 30 * 60000) return c.url;
    let url: string;
    if (row.source === 'torbox') url = await torbox().requestDownload(row.torbox_type, row.torbox_id, row.torbox_file_id ?? undefined);
    else url = (await pcloud().fileLink(row.pcloud_file_id)).url;
    linkCache.set(row.id, { url, at: Date.now() });
    void req;
    return url;
  };
  app.get('/api/scenes/:id/stream', async (req: any) => {
    const id = sceneId(req); const row = needScene(id);
    const subs = (db.prepare('SELECT id, name, lang, format FROM subtitles WHERE scene_id=?').all(id) as any[]).map((s) => ({ label: s.lang ? s.lang.toUpperCase() : s.name, lang: s.lang, url: `/api/scenes/${id}/subtitles/${s.id}`, format: 'vtt' }));
    const mime = row.content_type || (row.file_name.endsWith('.mkv') ? 'video/x-matroska' : row.file_name.endsWith('.webm') ? 'video/webm' : 'video/mp4');
    const base = { sceneId: id, proxy: `/api/scenes/${id}/proxy`, subtitles: subs, thumbnails: row.has_thumb ? `/api/scenes/${id}/thumb` : null, duration: row.duration ?? null };
    if (row.source === 'torbox' && String(row.path || '').includes('#')) {
      return { ...base, expiresAt: null, primary: { url: `/api/scenes/${id}/proxy`, type: 'mp4', mime, label: 'From archive' }, alternatives: [], hls: null };
    }
    if (row.source === 'torbox') {
      const url = await sourceUrl(row, req, true);
      return { ...base, expiresAt: null, primary: { url, type: 'mp4', mime, label: 'Original' }, alternatives: [], hls: null };
    }
    const c = pcloud();
    const link = await c.fileLink(row.pcloud_file_id);
    linkCache.set(id, { url: link.url, at: Date.now() });
    const alternatives: any[] = [];
    let hls: string | null = null;
    try {
      const variants = await c.videoLinks(row.pcloud_file_id);
      for (const v of variants) if (!v.isOriginal) alternatives.push({ url: v.url, type: 'mp4', label: v.height ? `${v.height}p` : 'Transcoded', width: v.width, height: v.height, bitrate: v.bitrate });
      alternatives.sort((a, b) => (b.height || 0) - (a.height || 0));
      const orig = variants.find((v) => v.isOriginal);
      if (orig?.duration && !row.duration) db.prepare('UPDATE scenes SET duration=? WHERE id=?').run(orig.duration, id);
    } catch { /* getvideolinks not available for all files */ }
    try { hls = await c.hlsLink(row.pcloud_file_id); alternatives.push({ url: hls, type: 'hls', label: 'HLS', width: null, height: null, bitrate: null }); } catch { /* optional */ }
    for (const alt of link.alternatives) alternatives.push({ url: alt, type: 'mp4', label: 'Original (mirror)', width: row.width ?? null, height: row.height ?? null, bitrate: null });
    return { ...base, expiresAt: link.expires ? new Date(link.expires).toISOString() : null, primary: { url: link.url, type: 'mp4', mime, label: 'Original' }, alternatives, hls };
  });
  app.get('/api/scenes/:id/proxy', async (req: any, reply: FastifyReply) => {
    const row = needScene(sceneId(req));
    if (row.source === 'torbox' && String(row.path || '').includes('#')) {
      const inner = String(row.path).slice(String(row.path).indexOf('#') + 1);
      const url = await sourceUrl(row, req, true);
      const entries = await listZipVideos(url, f);
      const entry = entries.find((e) => e.name === inner);
      if (!entry) throw err(404, 'not_found', 'That video is not in the archive');
      const opened = await openZipEntry(url, f, entry, req.headers.range);
      reply.status(opened.status);
      for (const [h, v] of Object.entries(opened.headers)) reply.header(h, v);
      req.raw.on('close', () => opened.body.destroy());
      return reply.send(opened.body);
    }
    const fetchUpstream = async (fresh: boolean) => f(await sourceUrl(row, req, fresh), { headers: req.headers.range ? { Range: req.headers.range } : {} });
    let up = await fetchUpstream(false);
    if (!up.ok && up.status !== 206) up = await fetchUpstream(true);
    if (!up.ok && up.status !== 206) throw err(502, 'upstream_error', `Upstream returned ${up.status}`);
    reply.status(up.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) { const v = up.headers.get(h); if (v) reply.header(h, v); }
    if (!up.headers.get('accept-ranges')) reply.header('accept-ranges', 'bytes');
    reply.header('cache-control', 'private, no-store');
    const stream = Readable.fromWeb(up.body as any);
    req.raw.on('close', () => stream.destroy());
    return reply.send(stream);
  });
  const thumbDir = path.join(cfg.dataDir, 'thumbs'); fs.mkdirSync(thumbDir, { recursive: true });
  // Thumbnails: bytes cached on disk (data/thumbs) AND in a small in-memory LRU; one upstream fetch per thumbnail (in-flight de-dup) with at most
  // 6 pCloud fetches at a time; long-lived private cache headers + ETag so the phone does not even ask again.
  const thumbMem = new ByteLru<{ buf: Buffer; etag: string }>(48 * 1048576);
  const thumbInflight = new Map<string, Promise<Buffer>>();
  const thumbUpstream = limit(6);
  const thumbRow = db.prepare('SELECT id, pcloud_file_id FROM scenes WHERE id=?');
  const loadThumb = async (row: any, size: string): Promise<{ buf: Buffer; etag: string }> => {
    const name = `${row.id}_${size}`;
    const hit = thumbMem.get(name); if (hit) return hit;
    const file = path.join(thumbDir, `${name}.jpg`);
    let buf: Buffer | undefined;
    try { buf = await fs.promises.readFile(file); } catch { /* not on disk yet */ }
    if (!buf) {
      if (!row.pcloud_file_id) throw err(404, 'not_found', 'No thumbnail');
      let p = thumbInflight.get(name);
      if (!p) {
        p = thumbUpstream(async () => {
          const url = await pcloud().thumbLink(row.pcloud_file_id, size);
          const r = await f(url);
          if (!r.ok) throw err(502, 'upstream_error', 'Thumbnail fetch failed');
          const b = Buffer.from(await r.arrayBuffer());
          const tmp = `${file}.${process.pid}.tmp`;
          await fs.promises.writeFile(tmp, b); await fs.promises.rename(tmp, file);
          return b;
        }).finally(() => thumbInflight.delete(name));
        p.catch(() => {});
        thumbInflight.set(name, p);
      }
      buf = await p;
    }
    const v = { buf, etag: `"${crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 16)}"` };
    thumbMem.set(name, v);
    return v;
  };
  app.get('/api/scenes/:id/thumb', async (req: any, reply: FastifyReply) => {
    const row = thumbRow.get(sceneId(req)) as any;
    if (!row) throw err(404, 'not_found', 'Scene not found');
    const size = /^\d{2,4}x\d{2,4}$/.test(req.query.size || '') ? req.query.size : '640x360';
    const t = await loadThumb(row, size);
    reply.header('cache-control', 'private, max-age=2592000, immutable').header('etag', t.etag);
    if (req.headers['if-none-match'] === t.etag) return reply.code(304).send();
    return reply.type('image/jpeg').send(t.buf);
  });
  app.get('/api/scenes/:id/subtitles/:subId', async (req: any, reply: FastifyReply) => {
    const s = db.prepare('SELECT * FROM subtitles WHERE id=? AND scene_id=?').get(Number(req.params.subId), sceneId(req)) as any;
    if (!s) throw err(404, 'not_found', 'Subtitle not found');
    const link = await pcloud().fileLink(s.pcloud_file_id);
    const r = await f(link.url);
    if (!r.ok) throw err(502, 'upstream_error', 'Subtitle fetch failed');
    const text = await r.text();
    reply.header('content-type', 'text/vtt; charset=utf-8');
    return s.format === 'vtt' ? text : srtToVtt(text);
  });

  // ---------- metadata ----------
  app.post('/api/scenes/:id/match', async (req: any) => {
    const id = sceneId(req); needScene(id); const b = req.body || {};
    if (b.tpdbId) {
      const src = b.source === 'stashdb' ? 'stashdb' : 'tpdb';
      const applied = await matcher.apply(id, String(b.tpdbId), src === 'stashdb' ? 'scene' : b.type || 'scene', null, true, null, src);
      return { candidates: [], applied: { ...applied, confidence: 1 }, scene: lib.detail(id) };
    }
    const r = await matcher.search(id, { query: typeof b.query === 'string' && b.query.trim() ? b.query.trim() : undefined, type: b.type });
    const { candidates } = r;
    let applied: any = null;
    if (b.apply && candidates[0] && candidates[0].confidence >= matcher.threshold) {
      await matcher.apply(id, candidates[0].tpdbId, candidates[0].type, candidates[0].confidence, false, candidates[0].matchedBy || null, candidates[0].source ?? 'tpdb', candidates[0].alsoOn);
      applied = candidates[0];
    }
    if (!b.query) db.prepare(`UPDATE scenes SET match_alts=?, match_query=? WHERE id=? AND match_status IN ('unmatched','failed','queued')`).run(JSON.stringify(r.alternatives), r.query, id);
    return {
      candidates, applied, scene: applied ? lib.detail(id) : undefined,
      query: r.query, strategy: r.strategy, confident: r.confident, alternatives: r.alternatives, queries: r.queries,
      parsed: { studio: r.parsed.studio, date: r.parsed.date, year: r.parsed.year, title: r.parsed.title, performers: r.parsed.performers, resolution: r.parsed.resolution, jav: r.parsed.jav, cleanTitle: r.parsed.cleanTitle, folderHints: r.parsed.folderHints },
    };
  });
  app.post('/api/scenes/:id/unmatch', async (req: any) => {
    const id = sceneId(req); needScene(id);
    const row = lib.sceneRow(id); const parsed = JSON.parse(row.parsed || '{}');
    db.transaction(() => {
      db.prepare(`UPDATE scenes SET title=NULL, date=?, description=NULL, studio_id=NULL, tpdb_id=NULL, tpdb_type=NULL, tpdb_url=NULL, stash_id=NULL, match_source=NULL, poster=NULL, backdrop=NULL, trailer=NULL, match_status='unmatched', match_confidence=NULL, match_strategy=NULL WHERE id=?`).run(parsed.date || null, id);
      lib.setScenePerformers(id, []); lib.setSceneTags(id, []);
    })();
    return lib.detail(id);
  });
  app.post('/api/scenes/:id/ignore', async (req: any) => { const id = sceneId(req); needScene(id); db.prepare(`UPDATE scenes SET match_status='ignored' WHERE id=?`).run(id); return { ok: true }; });
  app.get('/api/match/unmatched', async (req: any) => {
    const q = req.query || {};
    const page = Math.max(1, Number(q.page) || 1), pageSize = Math.min(200, Number(q.pageSize) || 40);
    const total = (db.prepare(`SELECT COUNT(*) c FROM scenes WHERE match_status IN ('unmatched','failed')`).get() as any).c;
    const rows = db.prepare(`SELECT * FROM scenes WHERE match_status IN ('unmatched','failed') ORDER BY added_at DESC LIMIT ? OFFSET ?`).all(pageSize, (page - 1) * pageSize) as any[];
    return { items: lib.cards(rows), page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  });
  app.post('/api/match/queue', async (req: any) => {
    if (!anyProvider()) throw err(409, 'tpdb_not_configured', 'No metadata provider is enabled and configured (set TPDB_API_KEY or STASHDB_API_KEY)');
    const b = req.body || {};
    if (b.all) return matcher.enqueueAllUnmatched({ includeTried: true });   // explicit request: also re-search files that were already tried
    const ids = (b.sceneIds || []).map(Number).filter(Number.isInteger);
    if (!ids.length) throw err(400, 'bad_request', 'sceneIds or all required');
    return matcher.enqueue(ids, { priority: !!b.priority });
  });
  app.get('/api/match/status', async () => matcher.touch());
  app.post('/api/match/cancel', async () => matcher.cancel());
  app.post('/api/match/pause', async () => matcher.pause());
  app.post('/api/match/resume', async () => matcher.resume());
  // Move files that are waiting in the queue to the front (also done automatically when a scene is opened).
  app.post('/api/match/prioritize', async (req: any) => {
    const ids = (req.body?.sceneIds || []).map(Number).filter(Number.isInteger);
    if (!ids.length) throw err(400, 'bad_request', 'sceneIds required');
    return matcher.prioritize(ids);
  });
  // Re-parse every unmatched file name with the current parser, drop cached empty TPDB answers and run the full strategy cascade again.
  app.post('/api/match/retry-unmatched', async (req: any) => {
    if (!anyProvider()) throw err(409, 'tpdb_not_configured', 'No metadata provider is enabled and configured (set TPDB_API_KEY or STASHDB_API_KEY)');
    return matcher.retryUnmatched({ includeIgnored: !!req.body?.includeIgnored });
  });
  app.get('/api/scenes/:id/match-info', async (req: any) => {
    const id = sceneId(req); needScene(id);
    const d: any = lib.detail(id);
    const parsed = matcher.reparse(lib.sceneRow(id));
    return { status: d.matchStatus, confidence: d.matchConfidence, strategy: d.matchStrategy, query: d.matchQuery || [parsed.studio, parsed.cleanTitle || parsed.title].filter(Boolean).join(' '), alternatives: d.matchAlternatives, parsed: { studio: parsed.studio, date: parsed.date, title: parsed.title, performers: parsed.performers, cleanTitle: parsed.cleanTitle } };
  });
  // Diagnoses the ThePornDB key + connectivity (uncached): /auth/user and a sample scene search. Never returns the key.
  // Both test routes also report which network path works: direct, doh (DNS-over-HTTPS) or proxy (Cloudflare Worker).
  const withNet = (r: any, n: ReturnType<typeof tpdbNet.info>) => ({ ...r, path: n.path, network: n, ...(!r?.ok && n.problem ? { hint: `${r?.hint ? r.hint + ' ' : ''}${n.problem}` } : {}) });
  app.get('/api/tpdb/test', async (req: any) => withNet(await tpdb.test(typeof req.query?.q === 'string' && req.query.q.trim() ? req.query.q.trim().slice(0, 200) : undefined), tpdbNet.info()));
  // ---- StashDB (second metadata provider)
  // Diagnoses the StashDB key + connectivity with a trivial authenticated GraphQL query. Never returns the key.
  app.get('/api/stashdb/test', async () => withNet(await stash.test(), stashNet.info()));
  app.get('/api/stashdb/search', async (req: any) => {
    const { q, type = 'scene' } = req.query || {};
    if (!q) throw err(400, 'bad_request', 'q required');
    if (!stash.configured) throw err(409, 'stashdb_not_configured', 'STASHDB_API_KEY is not set');
    const { toEngineShape } = await import('./clients/stashdb.js');
    const { toCandidate } = await import('./services/matcher.js');
    if (type === 'performer') return { items: (await stash.searchPerformers(String(q), 12)).map((p) => ({ stashId: p.id, name: p.name, image: p.image, gender: p.gender, aliases: p.aliases, source: 'stashdb' })) };
    const items = await stash.searchScenes(String(q), 20);
    return { items: items.map((x) => ({ ...toCandidate(toEngineShape(x), 'scene'), source: 'stashdb', confidence: 0 })) };
  });
  // Provider switches + key status for the Settings > Metadata sources block (no secrets).
  app.get('/api/metadata/sources', async () => {
    const en = matcher.providers();
    return { sources: [
      { id: 'tpdb', label: 'ThePornDB', configured: tpdb.configured, enabled: en.tpdb, active: matcher.useTpdb() },
      { id: 'stashdb', label: 'StashDB', configured: stash.configured, enabled: en.stashdb, active: matcher.useStash() },
    ] };
  });
  app.get('/api/tpdb/search', async (req: any) => {
    const { q, type = 'scene', page } = req.query || {};
    if (!q) throw err(400, 'bad_request', 'q required');
    if (type === 'performer') {
      const items = await tpdb.searchPerformers(String(q), Number(page) || 1);
      return { items: items.map((p: any) => ({ tpdbId: String(p.id), name: p.name, image: p.image || p.thumbnail || null, gender: p.extras?.gender || null })) };
    }
    if (!['scene', 'movie', 'jav'].includes(type)) throw err(400, 'bad_request', 'invalid type');
    const { toCandidate } = await import('./services/matcher.js');
    const items = await tpdb.search(type, String(q), { page: Number(page) || 1 });
    return { items: items.map((x: any) => ({ ...toCandidate(x, type), confidence: 0 })) };
  });

  // ---------- TorBox ----------
  app.get('/api/torbox/link', async () => torboxStatus(false));
  app.get('/api/torbox/status', async () => torboxStatus(true));
  app.put('/api/torbox/link', async (req: any) => {
    const apiKey = req.body?.apiKey ? String(req.body.apiKey).trim() : null;
    const key = apiKey || cfg.torboxKey;
    if (!key) throw err(400, 'bad_request', 'apiKey required');
    let me: any;
    try { me = await new TorboxClient(key, f).me(); } catch (e: any) { throw err(400, 'invalid_key', `TorBox key validation failed: ${e.message}`); }
    if (apiKey) kv.set('torbox.key', apiKey, true); else kv.del('torbox.key');
    kv.del('torbox.unlinked');
    kv.set('torbox.me', { email: me.email, plan: me.plan, premium_expires_at: me.premium_expires_at });
    return torboxStatus(false);
  });
  app.delete('/api/torbox/link', async () => { kv.del('torbox.key'); kv.del('torbox.me'); kv.set('torbox.unlinked', true); return { linked: false }; });
  const tbType = (t: string): TorboxType => { if (!TB_TYPES.includes(t as TorboxType)) throw err(400, 'bad_request', 'type must be torrents|usenet|webdl'); return t as TorboxType; };
  app.get('/api/torbox/downloads', async (req: any) => {
    const type = req.query.type || 'all'; const tb = torbox();
    const types = type === 'all' ? TB_TYPES : [tbType(type)];
    const lists = await Promise.all(types.map((t) => tb.list(t)));
    return { items: lists.flat().sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt))) };
  });
  app.get('/api/torbox/downloads/:type/:id', async (req: any) => { const [it] = await torbox().list(tbType(req.params.type), Number(req.params.id)); return it; });
  app.get('/api/torbox/downloads/:type/:id/files', async (req: any) => { const [it] = await torbox().list(tbType(req.params.type), Number(req.params.id)); return { files: it?.files || [] }; });
  app.post('/api/torbox/downloads/:type/:id/control', async (req: any) => {
    const op = req.body?.operation;
    if (!['delete', 'pause', 'resume', 'reannounce'].includes(op)) throw err(400, 'bad_request', 'operation must be delete|pause|resume|reannounce');
    await torbox().control(tbType(req.params.type), Number(req.params.id), op);
    return { ok: true, operation: op };
  });
  app.post('/api/torbox/save-to-pcloud', async (req: any) => {
    const { type, id, fileId, folderId } = req.body || {};
    if (!id || folderId === undefined) throw err(400, 'bad_request', 'type, id, fileId, folderId required');
    const url = await torbox().requestDownload(tbType(type), Number(id), fileId !== undefined ? Number(fileId) : undefined);
    await pcloud().downloadToFolder(url, Number(folderId));
    return { ok: true, message: 'pCloud is downloading the file into the selected folder. Rescan when it finishes.' };
  });
  app.delete('/api/torbox/downloads/:type/:id', async (req: any) => { await torbox().remove(tbType(req.params.type), Number(req.params.id)); return { ok: true }; });
  app.post('/api/torbox/add', async (req: any) => {
    const tb = torbox();
    let r: any; let type: TorboxType;
    if (req.isMultipart()) {
      const fields: Record<string, string> = {}; let file: { buf: Buffer; filename: string } | null = null;
      for await (const part of req.parts()) {
        if (part.type === 'file') file = { buf: await part.toBuffer(), filename: part.filename };
        else fields[part.fieldname] = String(part.value);
      }
      if (!file) throw err(400, 'bad_request', 'file required');
      if (/\.nzb$/i.test(file.filename)) { type = 'usenet'; r = await tb.addNzb(null, file, fields.name); }
      else { type = 'torrents'; r = await tb.addTorrentFile(file.buf, file.filename, fields.name); }
    } else {
      const b = req.body || {};
      if (b.magnet) { type = 'torrents'; r = await tb.addMagnet(b.magnet, b.name); }
      else if (b.nzbUrl) { type = 'usenet'; r = await tb.addNzb(b.nzbUrl, undefined, b.name); }
      else if (b.url) { type = 'webdl'; r = await tb.addWeb(b.url, b.name); }
      else throw err(400, 'bad_request', 'magnet, url or nzbUrl required');
    }
    const d = r.data || {};
    return { type, id: d.torrent_id ?? d.usenetdownload_id ?? d.webdownload_id ?? d.id ?? null, hash: d.hash ?? null, message: r.detail || 'Added' };
  });
  app.post('/api/torbox/cached', async (req: any) => {
    const hashes = (req.body?.hashes || []).map(String).filter(Boolean);
    if (!hashes.length) throw err(400, 'bad_request', 'hashes required');
    return { cached: await torbox().checkCached(hashes.slice(0, 100), req.body?.type ? tbType(req.body.type) : 'torrents') };
  });
  app.get('/api/torbox/stream', async (req: any) => {
    const { type, id, fileId } = req.query || {};
    const t = tbType(type);
    if (!id) throw err(400, 'bad_request', 'id required');
    const [it] = await torbox().list(t, Number(id));
    const file = it?.files.find((x: any) => String(x.id) === String(fileId)) || it?.files.find((x: any) => x.isVideo);
    const url = await torbox().requestDownload(t, Number(id), file ? file.id : fileId !== undefined ? Number(fileId) : undefined, req.ip);
    return { url, mime: file?.mime ?? null, name: file?.shortName ?? it?.name ?? '' };
  });
  app.post('/api/torbox/import', async (req: any) => {
    const b = req.body || {}; const tb = torbox();
    const types = b.type ? [tbType(b.type)] : TB_TYPES;
    let added = 0, seen = 0; const newIds: number[] = [];
    for (const t of types) {
      const items = (await tb.list(t)).filter((i: any) => i.ready && (!b.ids || b.ids.map(Number).includes(i.id)));
      for (const it of items) {
        for (const file of it.files.filter((x: any) => x.isVideo && !/\bsample\b/i.test(x.name))) {
          seen++;
          const key = `torbox:${t}:${it.id}:${file.id}`;
          if (db.prepare('SELECT 1 FROM scenes WHERE ext_key=?').get(key)) continue;
          const dir = '/' + String(file.name).split('/').slice(0, -1).join('/');
          const parsed = parseFilename(file.shortName, dir);
          const r = db.prepare(`INSERT INTO scenes(ext_key, source, torbox_type, torbox_id, torbox_file_id, path, file_name, size, content_type, parsed, added_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
            .run(key, 'torbox', t, it.id, file.id, `/TorBox/${file.name}`, file.shortName, file.size, file.mime, JSON.stringify(parsed), it.createdAt || new Date().toISOString());
          newIds.push(Number(r.lastInsertRowid)); added++;
        }
        let zips = 0;
        for (const file of it.files.filter((x: any) => /\.zip$/i.test(x.name || ''))) {
          if (zips++ >= 8) break;
          const prefix = `torbox:${t}:${it.id}:${file.id}:z:`;
          if (db.prepare('SELECT 1 FROM scenes WHERE ext_key LIKE ?').get(prefix + '%')) continue;
          let entries: { name: string; size: number }[] = [];
          try {
            const url = await tb.requestDownload(t, it.id, file.id);
            entries = await listZipVideos(url, f);
          } catch { continue; }
          for (const entry of entries) {
            seen++;
            const key = prefix + entry.name;
            if (db.prepare('SELECT 1 FROM scenes WHERE ext_key=?').get(key)) continue;
            const base = entry.name.split('/').pop() || entry.name;
            const dir = '/' + entry.name.split('/').slice(0, -1).join('/');
            const parsed = parseFilename(base, dir);
            const r = db.prepare(`INSERT INTO scenes(ext_key, source, torbox_type, torbox_id, torbox_file_id, path, file_name, size, content_type, parsed, added_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
              .run(key, 'torbox', t, it.id, file.id, `/TorBox/${file.name}#${entry.name}`, base, entry.size || file.size, base.endsWith('.webm') ? 'video/webm' : 'video/mp4', JSON.stringify(parsed), it.createdAt || new Date().toISOString());
            newIds.push(Number(r.lastInsertRowid)); added++;
          }
        }
      }
    }
    if ((b.autoMatch ?? settings().library.autoMatch) && anyProvider() && newIds.length) matcher.enqueue(newIds);
    return { added, seen, match: matcher.status };
  });

  // ---------- settings ----------
  app.get('/api/settings', async () => settings());
  app.put('/api/settings', async (req: any) => {
    const b = { ...(req.body || {}) }; delete b.pinEnabled; delete b.pin;
    delete b.autoLockV;
    const merged: any = deepMerge(kv.get('settings', {}), b);
    if (b.autoLockMinutes !== undefined) { merged.autoLockMinutes = Math.max(0, Number(b.autoLockMinutes) || 0); merged.autoLockV = AUTOLOCK_V; }
    kv.set('settings', merged);
    const s = settings();
    matcher.threshold = s.library.matchThreshold;
    applyEndpoints();
    return s;
  });
  app.post('/api/data/clear', async (req: any) => {
    const what = req.body?.what;
    const ops: Record<string, () => void> = {
      progress: () => db.exec('DELETE FROM progress'),
      cache: () => { cache.clear(); for (const fl of fs.readdirSync(thumbDir)) fs.rmSync(path.join(thumbDir, fl), { force: true }); thumbMem.clear(); linkCache.clear(); },
      favorites: () => db.exec('UPDATE scenes SET favorite=0, watchlist=0; UPDATE performers SET favorite=0; UPDATE studios SET favorite=0;'),
      metadata: () => { db.exec(`UPDATE scenes SET title=NULL, description=NULL, studio_id=NULL, tpdb_id=NULL, tpdb_type=NULL, tpdb_url=NULL, stash_id=NULL, match_source=NULL, poster=NULL, backdrop=NULL, trailer=NULL, match_status='unmatched', match_confidence=NULL; DELETE FROM scene_performers; DELETE FROM scene_tags;`); lib.cleanupOrphans(); },
      library: () => { db.exec('DELETE FROM scenes'); lib.cleanupOrphans(); },
    };
    if (what === 'all') { for (const k of Object.keys(ops)) ops[k](); return { ok: true, cleared: what }; }
    if (!ops[what]) throw err(400, 'bad_request', 'what must be progress|cache|favorites|metadata|library|all');
    ops[what]();
    return { ok: true, cleared: what };
  });

  // ---------- static web app + SPA fallback ----------
  const statics = new StaticCache();
  app.setNotFoundHandler(async (req: FastifyRequest, reply: FastifyReply) => {
    let url: string;
    try { url = decodeURIComponent(req.url.split('?')[0]); } catch { url = req.url.split('?')[0]; }
    if (url.startsWith('/api/') || (req.method !== 'GET' && req.method !== 'HEAD')) return reply.status(404).send({ error: { code: 'not_found', message: `Route ${req.method} ${url} not found` } });
    const root = cfg.webDist;
    const index = path.join(root, 'index.html');
    let file = path.normalize(path.join(root, url));
    let ent = file.startsWith(root) ? await statics.load(file) : null;
    if (!ent) { file = index; ent = await statics.load(index); }
    if (!ent) return reply.status(404).type('text/plain').send('Pulse API is running. Web app not built yet (web/dist missing).');
    const ext = path.extname(file).toLowerCase();
    reply.header('content-type', MIME[ext] || 'application/octet-stream');
    // The app shell, service worker and manifest must always revalidate (Cloudflare/Safari otherwise keep a stale shell for hours);
    // only content-hashed /assets/* and icons are cached.
    const base = path.basename(file);
    const volatile = file === index || /^(sw\.js|registerSW\.js|workbox-.*\.js|manifest\.webmanifest)$/i.test(base);
    reply.header('cache-control', volatile ? 'no-cache, max-age=0, must-revalidate' : url.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
    if (/^sw\.js$/i.test(base)) reply.header('service-worker-allowed', '/');
    if (ent === 'big') return reply.send(fs.createReadStream(file));   // large files (demo video) are streamed, never held in memory
    reply.header('etag', ent.etag);
    if (req.headers['if-none-match'] === ent.etag) return reply.code(304).send();
    return reply.send(ent.buf);
  });

  // periodic rescan
  const timer = setInterval(() => {
    const h = settings().library.scanIntervalHours;
    const last = kv.get<number>('pcloud.lastAutoScan', 0);
    if (h > 0 && pcloudToken() && scanner.status.state !== 'running' && Date.now() - last > h * 3600e3) { kv.set('pcloud.lastAutoScan', Date.now()); try { startScan(); } catch { /* ignore */ } }
  }, 60000);
  timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); cache.close(); });
  return app;
}
