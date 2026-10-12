import type { DB } from '../db.js';
import { nameKey } from '../db.js';
import { TpdbClient, TpdbType, pickImage, FATAL_TPDB } from '../clients/tpdb.js';
import { parseFilename, ParsedFilename, isUnsearchable } from '../parser.js';
import { Library } from './library.js';
import { config } from '../config.js';
import { fastCascade, planGroups, matchGroup, type Group, type BatchFile, type LocalMatch } from './bulkMatcher.js';
import { isAbort } from './rateLimiter.js';

import { runCascade, toCandidate, MatchCandidate, Alt, EngineResult } from './matchEngine.js';
import type { ProviderId } from '../clients/provider.js';
import { toEngineShape, type StashDbClient } from '../clients/stashdb.js';
import { applyStashScene, mergeDetails, refreshStashPerformer, stampTpdbSource } from './stashApply.js';
export { toCandidate };
export type { MatchCandidate, Alt };

const words = (s: string | null | undefined) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1));
function jaccard(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size); // overlap coefficient, tolerant to extra words
}

/** Confidence 0..1 combining date, studio, performers, title and duration agreement. */
export function scoreCandidate(parsed: ParsedFilename, c: Omit<MatchCandidate, 'confidence'>, fileDuration?: number | null, viaParse = false): number {
  let score = 0, weight = 0;
  if (parsed.jav) {
    weight += 1;
    const code = parsed.jav.replace(/-/g, '').toLowerCase();
    if ((c.title + ' ' + (c as any).externalId).replace(/-/g, '').toLowerCase().includes(code)) score += 1;
  }
  if (parsed.date) { weight += 0.35; if (c.date === parsed.date) score += 0.35; else if (c.date && c.date.slice(0, 7) === parsed.date.slice(0, 7)) score += 0.1; }
  if (parsed.studio) {
    weight += 0.25;
    const a = nameKey(parsed.studio), b = nameKey(c.studio || '');
    if (a && b && (a === b || a.includes(b) || b.includes(a))) score += 0.25;
  }
  if (parsed.performers.length) {
    weight += 0.2;
    const cp = new Set(c.performers.map(nameKey));
    const hits = parsed.performers.filter((p) => cp.has(nameKey(p)) || [...cp].some((x) => x.includes(nameKey(p)))).length;
    score += 0.2 * (hits / parsed.performers.length);
  }
  if (parsed.title && parsed.title !== parsed.jav) { weight += 0.3; score += 0.3 * jaccard(words(parsed.title), words(c.title)); }
  if (fileDuration && c.duration) { weight += 0.1; const diff = Math.abs(fileDuration - c.duration); if (diff < 30) score += 0.1; else if (diff < 120) score += 0.05; }
  let conf = weight ? score / weight : 0;
  if (viaParse) conf = Math.min(1, conf + 0.05);
  return Math.round(conf * 1000) / 1000;
}

export type MatchJobStatus = {
  state: 'idle' | 'running'; queued: number; processed: number; matched: number; failed: number;
  current: { sceneId: number; title: string } | null; startedAt: string | null; lastError: string | null;
  /** Files that were searched fine but have no confident match (not errors). */
  unmatched: number;
  lastErrorCode: string | null; lastErrorAt: string | null;
  /** Failures by reason for this run, e.g. { rate_limited: 12, tpdb_network: 3 } */
  errorCounts: Record<string, number>;
  /** When the next automatic retry of failed files runs (null = none scheduled). */
  retryAt: string | null;
  /** matched-by counts for this run, e.g. { parse: 12, title: 3, words: 2 } */
  strategies?: Record<string, number>;
  /** Paused by the user (workers finish their current file, then wait; state stays 'running'). */
  paused?: boolean;
  /** processed + queued + in flight for this run */
  total?: number;
  /** files in flight right now */
  active?: number;
  /** completed files per minute (trailing 60 s) and the estimated seconds left at that pace (null = unknown) */
  rate?: number;
  etaSeconds?: number | null;
  /** batch resolution of performer / studio groups */
  groups?: { total: number; done: number; filesMatched: number; skipped: Record<string, number> };
  /** upstream usage this process lifetime: network requests, cache hits, de-duplicated in-flight calls, limiter rate */
  requests?: { http: number; cacheHits: number; deduped: number; retries: number; rps: number | null; maxRps: number | null; throttled: number; inflight: number; waiting: number };
};
export type MatchSearchResult = EngineResult & { parsed: ParsedFilename; raw?: any };

export class Matcher {
  status: MatchJobStatus = { state: 'idle', queued: 0, processed: 0, matched: 0, failed: 0, unmatched: 0, current: null, startedAt: null, lastError: null, lastErrorCode: null, lastErrorAt: null, errorCounts: {}, retryAt: null, strategies: {}, groups: { total: 0, done: 0, filesMatched: 0, skipped: {} } };
  /** Normal queue (recently added first), `high` = files the user opened / asked for, served before everything else. */
  private queue: number[] = [];
  private high: number[] = [];
  /** ids waiting to start (queue + high + inside a pending group job) */
  private pending = new Set<number>();
  private running = new Set<number>();
  private groupJobs: Group[] = [];
  private active = 0;
  private idleWaiters: (() => void)[] = [];
  private gateWaiters: (() => void)[] = [];
  private runAbort: AbortController | null = null;
  private completed: number[] = [];
  private lists = new Map<string, any[]>();
  private hints = new Map<string, any>();
  /** Files left over from a group whose whole scene list was checked: they only get the concurrent cheap strategies, not the long sequential cascade (Retry matching does the thorough pass). */
  private quickIds = new Set<number>();
  private thorough = false;
  /** false = leftovers of a resolved group also get the full sequential cascade (slower, finds a few more). */
  quickLeftovers = process.env.MATCH_QUICK_LEFTOVERS !== '0';
  private cancelled = false;
  paused = false;
  threshold = 0.75;
  /** Parallel workers (MATCH_CONCURRENCY, default 10). The upstream request rate is governed separately by the adaptive limiter in TpdbClient. */
  concurrency = Math.max(1, config.matchConcurrency || 10);
  /** Concurrent cheap strategies per file + early exit; false = the old sequential cascade only. */
  fastPath = true;
  /** Resolve performer / studio groups once and match their files locally. */
  groupMatching = true;
  /** Two files that share a performer or studio are enough to fetch that list once. */
  minGroupSize = 2;
  /** Max TPDB requests of the sequential fallback cascade per file in bulk runs (manual search keeps its own budget). */
  fallbackBudget = Math.max(4, config.matchFallbackBudget || 6);
  /** Compute OSHASH (ranged pCloud reads) during bulk matching. Off by default: hashing is slow and only a last resort. */
  bulkHash = false;
  /** Optional OSHASH provider (pCloud ranged reads); only consulted as the very last strategy. */
  hashProvider: ((row: any) => Promise<string | null>) | null = null;
  /** Automatic retry of failed files (network / rate limit / server errors): delays in ms for consecutive rounds. Empty = disabled. */
  autoRetryDelaysMs: number[] = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
  private retryRound = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  /** Second metadata provider (StashDB), wired by buildApp. Queried in parallel with ThePornDB. */
  stash: StashDbClient | null = null;
  /** Provider switches (Settings > Metadata sources). */
  providers: () => { tpdb: boolean; stashdb: boolean } = () => ({ tpdb: true, stashdb: true });
  useTpdb() { return this.providers().tpdb && this.tpdb.configured; }
  useStash() { return this.providers().stashdb && !!this.stash?.configured; }
  constructor(private db: DB, private lib: Library, public tpdb: TpdbClient) {
    this.status.paused = false; this.status.rate = 0; this.status.etaSeconds = null; this.status.total = 0; this.status.active = 0;
  }

  /** Set by the app: drops cached empty provider answers (cache.db). */
  purgeEmptyCache?: () => void;
  private studiosMemo: { at: number; names: string[] } | null = null;
  private knownStudios(): string[] {
    const now = Date.now();
    if (this.studiosMemo && now - this.studiosMemo.at < 30_000) return this.studiosMemo.names;
    try { this.studiosMemo = { at: now, names: (this.db.prepare('SELECT name FROM studios').all() as any[]).map((r) => r.name) }; return this.studiosMemo.names; } catch { return []; }
  }
  /** Re-parse the stored file name with the current parser (improvements apply to old rows too). */
  reparse(row: any): ParsedFilename {
    const dir = String(row.path || '').replace(/\/[^/]*$/, '');
    return parseFilename(row.file_name, dir, { knownStudios: this.knownStudios() });
  }

  /** Runs the strategy cascade for one scene. `query` = manual search text. */
  async search(sceneId: number, opts: { query?: string; type?: TpdbType; budget?: number; shouldStop?: () => boolean; /** bulk mode: concurrent strategies, no remote hashing */ fast?: boolean; /** one filename search, then stop */ once?: boolean } = {}): Promise<MatchSearchResult> {
    const row = this.lib.sceneRow(sceneId);
    if (!row) throw Object.assign(new Error('Scene not found'), { statusCode: 404, code: 'not_found' });
    const parsed = this.reparse(row);
    const useHash = !opts.query && !opts.type && ((!!this.hashProvider && row.source === 'pcloud' && (!opts.fast || this.bulkHash)) || !!row.oshash);
    const cascade = opts.fast && this.fastPath ? (t: TpdbClient, i: Parameters<typeof runCascade>[1]) => fastCascade(t, i, { fallbackBudget: this.fallbackBudget, signal: this.runAbort?.signal, quick: this.quickIds.has(sceneId), once: opts.once }) : runCascade;
    const res = await cascade(this.tpdb, {
      fileName: row.file_name, folderPath: String(row.path || '').replace(/\/[^/]*$/, ''), parsed, duration: row.duration, query: opts.query, types: opts.type ? [opts.type] : undefined,
      threshold: this.threshold, budget: opts.budget, shouldStop: opts.shouldStop ?? (() => this.cancelled),
      hash: useHash ? () => (row.oshash ? Promise.resolve(String(row.oshash)) : this.safeHash(row)) : undefined,
      stash: opts.once ? null : (this.useStash() ? this.stash : null), useTpdb: this.useTpdb(),
      fingerprints: row.oshash ? { oshash: String(row.oshash) } : {},
      onHash: (h) => { try { this.db.prepare('UPDATE scenes SET oshash=? WHERE id=?').run(h, sceneId); } catch { /* cache only */ } },
    });
    const query = opts.query ?? ([parsed.studio, parsed.cleanTitle || parsed.title].filter(Boolean).join(' ').trim() || res.query);
    return { ...res, parsed, query };
  }

  /** Hash step is best effort: errors and slow providers (15 s cap) just mean "no hash", never a failed match. */
  private async safeHash(row: any): Promise<string | null> {
    try {
      return await Promise.race([this.hashProvider!(row), new Promise<null>((r) => setTimeout(() => r(null), 15_000).unref?.())]);
    } catch { return null; }
  }

  async candidates(sceneId: number, opts: { query?: string; type?: TpdbType } = {}): Promise<MatchCandidate[]> {
    return (await this.search(sceneId, opts)).candidates;
  }

  async apply(sceneId: number, tpdbId: string, type: TpdbType = 'scene', confidence: number | null = null, manual = false, strategy: string | null = null, source: ProviderId = 'tpdb', alsoOn?: MatchCandidate['alsoOn']) {
    if (source === 'stashdb') {
      if (!this.stash?.configured) throw Object.assign(new Error('StashDB API key is not configured'), { statusCode: 409, code: 'stashdb_not_configured' });
      const sx = await applyStashScene(this.db, this.lib, this.stash, sceneId, tpdbId, { confidence, manual, strategy, alsoOn });
      return { ...toCandidate(toEngineShape(sx), 'scene'), source: 'stashdb' as ProviderId };
    }
    // bulk matching already holds the full scene object from the list response: no extra GET /scenes/{id}
    const hk = `${type}:${tpdbId}`; const hint = this.hints.get(hk); this.hints.delete(hk);
    const x = hint ?? await this.tpdb.item(type, tpdbId);
    if (!x) throw Object.assign(new Error('TPDB item not found'), { statusCode: 404, code: 'not_found' });
    const tx = this.db.transaction(() => {
      let studioId: number | null = null;
      if (x.site?.name) studioId = this.lib.upsertStudio(x.site.name, { tpdbId: x.site.uuid || (x.site.id != null ? String(x.site.id) : null), slug: x.site.short_name, logo: x.site.logo, parent: x.site.parent?.name || x.site.network?.name || null });
      const perfIds = (x.performers || []).map((p: any) => this.lib.upsertPerformer(p.parent?.name || p.name, {
        tpdbId: p.parent?.id || p.id, slug: p.parent?.slug || p.slug, image: p.parent?.image || p.image, thumb: p.parent?.thumbnail || p.thumbnail || p.face,
        gender: p.parent?.extras?.gender || p.extra?.gender || null,
      }));
      const tagIds = (x.tags || []).map((t: any) => this.lib.upsertTag(t.name, t.uuid || String(t.id)));
      this.db.prepare(`UPDATE scenes SET title=?, date=?, description=?, studio_id=?, tpdb_id=?, tpdb_type=?, tpdb_url=?, poster=?, backdrop=?, trailer=?,
        match_status=?, match_confidence=?, match_strategy=?, duration=COALESCE(duration, ?), updated_at=? WHERE id=?`).run(
        x.title || null, x.date || null, x.description || null, studioId, String(x.id), type, x.url || null,
        pickImage(x, 'posters', 'poster', 'image'), pickImage(x, 'background', 'image', 'poster'), x.trailer || null,
        manual ? 'manual' : 'matched', confidence, manual ? 'manual' : strategy, x.duration || null, new Date().toISOString(), sceneId);
      this.lib.setScenePerformers(sceneId, perfIds);
      this.lib.setSceneTags(sceneId, tagIds);
    });
    tx();
    stampTpdbSource(this.db, sceneId, alsoOn);
    return { ...toCandidate(x, type), source: 'tpdb' as ProviderId };
  }

  /** Refetches a performer. `source` forces one provider; by default ThePornDB first, StashDB when TPDB is off / has no such performer. */
  async refreshPerformer(performerId: number, source?: ProviderId) {
    const p = this.db.prepare('SELECT * FROM performers WHERE id=?').get(performerId) as any;
    if (!p) return null;
    const fromStash = async () => {
      if (!this.useStash()) return null;
      const r = await refreshStashPerformer(this.db, this.stash!, performerId);
      return r ? (JSON.parse((this.db.prepare('SELECT details FROM performers WHERE id=?').get(performerId) as any).details)) : null;
    };
    if (source === 'stashdb' || (source !== 'tpdb' && (!this.useTpdb() || (p.stash_id && !p.tpdb_id)))) return fromStash();
    let tpdbId = p.tpdb_id;
    if (!tpdbId) {
      const found = await this.tpdb.searchPerformers(p.name);
      const best = found.find((f: any) => nameKey(f.name) === p.name_key) || found[0];
      if (!best) return source ? null : fromStash();
      tpdbId = best.id;
    }
    const d = await this.tpdb.performer(tpdbId);
    const merged = p.details ? mergeDetails(d, JSON.parse(p.details)) : d;   // ThePornDB wins, StashDB-only fields are kept
    this.db.prepare('UPDATE performers SET tpdb_id=?, slug=COALESCE(?,slug), image=COALESCE(?,image), thumb=COALESCE(?,thumb), gender=COALESCE(?,gender), details=?, details_at=? WHERE id=?')
      .run(String(d.id), d.slug || null, d.image || null, d.thumbnail || d.face || null, d.extras?.gender || null, JSON.stringify(merged), new Date().toISOString(), performerId);
    return merged;
  }

  /**
   * Adds files to the matching queue. Files sharing a performer / studio are planned as groups (resolved once, matched locally);
   * `priority` puts them in front of everything else.
   */
  enqueue(ids: number[], opts: { priority?: boolean } = {}) {
    const fresh: number[] = [];
    for (const id of ids) if (!this.pending.has(id) && !this.running.has(id)) { fresh.push(id); this.pending.add(id); }
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      this.db.prepare(`UPDATE scenes SET match_status='queued' WHERE id IN (${chunk.map(() => '?').join(',') || 'NULL'}) AND match_status IN ('unmatched','failed')`).run(...chunk);
      this.db.prepare(`UPDATE scenes SET match_error=NULL, match_error_code=NULL WHERE id IN (${chunk.map(() => '?').join(',') || 'NULL'}) AND match_status='queued'`).run(...chunk);
    }
    if (opts.priority) { this.prioritize(ids, false); this.high.unshift(...fresh.filter((id) => !this.high.includes(id))); }
    else this.plan(fresh);
    this.status.queued = this.pending.size;
    if (this.status.state === 'idle') void this.run(); else this.wakeWorkers();
    return this.touch();
  }
  /** Splits fresh ids into performer / studio groups and single files. */
  private plan(ids: number[]) {
    if (!ids.length) return;
    if (!this.groupMatching || ids.length < this.minGroupSize) { this.queue.push(...ids); return; }
    const studios = this.knownStudios();
    const files: BatchFile[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = this.db.prepare(`SELECT id, file_name, path, duration, source FROM scenes WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as any[];
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const id of chunk) {
        const row = byId.get(id);
        if (!row) { this.pending.delete(id); continue; }
        files.push({ id, row, parsed: parseFilename(row.file_name, String(row.path || '').replace(/\/[^/]*$/, ''), { knownStudios: studios }), duration: row.duration ?? null });
      }
    }
    const { groups, rest } = planGroups(files, this.minGroupSize);
    this.groupJobs.push(...groups);
    this.status.groups!.total += groups.length;
    this.queue.push(...rest.map((f) => f.id));
  }
  /** Files the user opened (or any ids) jump to the front of the queue. Ids that are not waiting are ignored. */
  prioritize(ids: number[], touch = true) {
    const want = ids.filter((id) => this.pending.has(id));
    if (want.length) {
      const set = new Set(want);
      this.queue = this.queue.filter((id) => !set.has(id));
      this.high = this.high.filter((id) => !set.has(id));
      for (const g of this.groupJobs) g.files = g.files.filter((f) => !set.has(f.id));
      this.groupJobs = this.groupJobs.filter((g) => g.files.length);
      this.high.unshift(...want);
      this.wakeWorkers();
    }
    return touch ? this.touch() : this.status;
  }
  /** Queues every file that has not been searched yet (new files, previous failures). Files already searched without a result are only re-queued with includeTried. */
  enqueueAllUnmatched(opts: { includeTried?: boolean } = {}) {
    const where = opts.includeTried ? `match_status IN ('unmatched','failed','queued')` : `(match_status IN ('failed','queued') OR (match_status='unmatched' AND match_tried_at IS NULL))`;
    const ids = (this.db.prepare(`SELECT id FROM scenes WHERE ${where} ORDER BY added_at DESC`).all() as any[]).map((r) => r.id);
    return this.enqueue(ids);
  }
  /**
   * "Re-match all unmatched": drops cached empty TPDB answers (so earlier misses are re-asked), re-parses every unmatched file name with the
   * current parser and queues them through the full strategy cascade.
   */
  retryUnmatched(opts: { includeIgnored?: boolean } = {}) {
    this.purgeEmptyCache?.();   // cached "no results" answers are forgotten so earlier misses are asked again (indexed delete in cache.db)
    const statuses = opts.includeIgnored ? `'unmatched','failed','queued','ignored'` : `'unmatched','failed','queued'`;
    const rows = this.db.prepare(`SELECT id, file_name, path, parsed FROM scenes WHERE match_status IN (${statuses}) ORDER BY added_at DESC`).all() as any[];
    const upd = this.db.prepare(`UPDATE scenes SET parsed=?, match_status='unmatched', match_strategy=NULL, match_alts=NULL WHERE id=?`);
    const studios = this.knownStudios();
    this.db.transaction(() => {
      for (const r of rows) upd.run(JSON.stringify(parseFilename(r.file_name, String(r.path || '').replace(/\/[^/]*$/, ''), { knownStudios: studios })), r.id);
    })();
    this.status.strategies = {}; this.retryRound = 0; this.thorough = true;
    return { ...this.enqueue(rows.map((r) => r.id)), requeued: rows.length };
  }
  cancel() {
    this.cancelled = true;
    this.runAbort?.abort();
    this.db.prepare(`UPDATE scenes SET match_status='unmatched' WHERE match_status='queued'`).run();
    this.queue = []; this.high = []; this.groupJobs = []; this.pending.clear(); this.status.queued = 0;
    this.releaseGate(); this.wakeWorkers();
    return this.touch();
  }
  /** Workers finish the file they are on, then wait. State stays 'running' with paused=true. */
  pause() { this.paused = true; this.status.paused = true; return this.touch(); }
  resume() { this.paused = false; this.status.paused = false; this.releaseGate(); this.wakeWorkers(); return this.touch(); }
  private releaseGate() { const w = this.gateWaiters; this.gateWaiters = []; w.forEach((r) => r()); }
  private async gate() { while (this.paused && !this.cancelled) await new Promise<void>((r) => this.gateWaiters.push(r)); }
  private wakeWorkers() { const w = this.idleWaiters; this.idleWaiters = []; w.forEach((r) => r()); }

  /** Derived progress fields (rate, ETA, upstream usage); also returned by /api/match/status. */
  touch(): MatchJobStatus {
    const st = this.status; const now = Date.now();
    while (this.completed.length && this.completed[0] < now - 60_000) this.completed.shift();
    const elapsed = st.startedAt ? (now - Date.parse(st.startedAt)) / 1000 : 0;
    const win = Math.max(1, Math.min(60, elapsed));
    st.rate = st.state === 'running' ? Math.round((this.completed.length / win) * 60 * 10) / 10 : 0;
    st.queued = this.pending.size; st.active = this.active; st.paused = this.paused;
    st.total = st.processed + st.queued + st.active;
    const left = st.queued + st.active;
    st.etaSeconds = st.state === 'running' && st.rate > 0 ? Math.ceil((left / st.rate) * 60) : (left === 0 ? 0 : null);
    const t = this.tpdb.stats, l = this.tpdb.limiter?.stats();
    st.requests = { http: t.requests, cacheHits: t.cacheHits, deduped: t.deduped, retries: t.retries, rps: l?.rps ?? null, maxRps: l?.maxRps ?? null, throttled: l?.throttled ?? 0, inflight: l?.inflight ?? 0, waiting: l?.waiting ?? 0 };
    return st;
  }

  private recordError(code: string, message: string) {
    this.status.lastError = message; this.status.lastErrorCode = code; this.status.lastErrorAt = new Date().toISOString();
    this.status.errorCounts[code] = (this.status.errorCounts[code] || 0) + 1;
  }

  private async processOne(id: number) {
    const row = this.lib.sceneRow(id);
    if (!row || ['matched', 'manual', 'ignored'].includes(row.match_status)) return;
    const parsed = this.reparse(row);
    this.status.current = { sceneId: id, title: row.title || row.file_name };
    if (!this.thorough && isUnsearchable(row.file_name, parsed)) {
      this.db.prepare(`UPDATE scenes SET parsed=?, match_status='unmatched', match_strategy='skipped', match_confidence=NULL, match_alts=NULL, match_query=NULL, match_tried_at=?, match_error=NULL, match_error_code=NULL WHERE id=?`)
        .run(JSON.stringify(parsed), new Date().toISOString(), id);
      this.status.unmatched++;
      this.status.processed++;
      this.completed.push(Date.now());
      const k = 'skipped';
      this.status.strategies![k] = (this.status.strategies![k] || 0) + 1;
      return;
    }
    try {
      const r = await this.search(id, { fast: true, once: !this.thorough });
      const best = r.best;
      if (best && r.raw && (best.source ?? 'tpdb') === 'tpdb') this.hints.set(`${best.type}:${best.tpdbId}`, r.raw);
      const parsedJson = JSON.stringify(r.parsed);
      const partial = r.errors.length ? `${r.errors.length} of ${r.queries} ThePornDB requests failed: ${r.errors[0].message}` : null;
      if (best && best.confidence >= this.threshold) {
        await this.apply(id, best.tpdbId, best.type, best.confidence, false, best.matchedBy || null, best.source ?? 'tpdb', best.alsoOn);
        this.db.prepare(`UPDATE scenes SET parsed=?, match_alts=?, match_query=?, match_tried_at=?, match_error=NULL, match_error_code=NULL WHERE id=?`).run(parsedJson, JSON.stringify(r.alternatives), r.query, new Date().toISOString(), id);
        this.status.matched++;
        const k = best.matchedBy || 'other';
        this.status.strategies![k] = (this.status.strategies![k] || 0) + 1;
      } else {
        // searched fine, nothing confident: "unmatched" (not an error). Partial TPDB failures are kept as a note for the Review tab.
        this.db.prepare(`UPDATE scenes SET match_status='unmatched', match_confidence=?, match_strategy=NULL, parsed=?, match_alts=?, match_query=?, match_tried_at=?, match_error=?, match_error_code=? WHERE id=?`)
          .run(best?.confidence ?? null, parsedJson, JSON.stringify(r.alternatives), r.query, new Date().toISOString(), partial, partial ? r.errors[0].code : null, id);
        this.status.unmatched++;
        if (partial) this.recordError(r.errors[0].code, partial);
      }
    } catch (e: any) {
      const code = String(e?.code && typeof e.code === 'string' ? e.code : 'exception');
      const message = String(e?.message || e || 'Unknown error').slice(0, 500);
      this.recordError(code, message);
      this.db.prepare(`UPDATE scenes SET match_status='failed', match_error=?, match_error_code=?, match_tried_at=? WHERE id=?`).run(message, code, new Date().toISOString(), id);
      this.status.failed++;
      if (FATAL_TPDB.has(code) || code === 'stashdb_auth' || code === 'stashdb_not_configured') { this.fatal = { code, message }; this.cancelled = true; this.runAbort?.abort(); }
    }
    this.status.processed++;
    this.completed.push(Date.now());
  }

  /** One performer / studio group: resolve it once, page through its scenes, match its files locally. Unresolved files go back to the normal queue. */
  private async processGroup(group: Group) {
    const files = group.files.filter((f) => this.pending.has(f.id));
    const toQueue = (fs: BatchFile[]) => { for (const f of fs) if (this.pending.has(f.id)) this.queue.push(f.id); };
    if (files.length < this.minGroupSize) { toQueue(files); return; }
    const g = this.status.groups!;
    let outcome;
    try {
      this.status.current = { sceneId: files[0].id, title: `${group.kind === 'performer' ? 'Performer' : 'Studio'}: ${group.name} (${files.length} files)` };
      outcome = await matchGroup({ ...group, files }, { tpdb: this.tpdb, threshold: this.threshold, signal: this.runAbort?.signal, gate: () => this.gate(), lists: this.lists });
    } catch (e: any) {
      // network trouble, abort, bad key...: the files simply go through the per-file path, which records the real error per file
      g.done++; g.skipped['error'] = (g.skipped['error'] || 0) + 1;
      toQueue(files);
      return;
    }
    g.done++;
    if (outcome.skipped) { const k = outcome.skipped.replace(/ \(.*$/, ''); g.skipped[k] = (g.skipped[k] || 0) + 1; }
    let n = 0;
    for (const m of outcome.matched) {
      if (this.cancelled) break;
      if (!this.pending.delete(m.file.id)) continue;            // already handled by a worker (e.g. the user opened it meanwhile)
      try { await this.applyLocal(m, group.kind); g.filesMatched++; this.status.processed++; this.completed.push(Date.now()); }
      catch { this.pending.add(m.file.id); this.queue.push(m.file.id); }
      if (++n % 20 === 0) await new Promise((r) => setImmediate(r));
    }
    if (this.quickLeftovers && !outcome.skipped && outcome.scenes > 0 && !this.thorough) for (const f of outcome.leftover) this.quickIds.add(f.id);
    toQueue(outcome.leftover);
    this.status.queued = this.pending.size;
    this.wakeWorkers();
  }
  private async applyLocal(m: LocalMatch, kind: Group['kind']) {
    const id = m.file.id;
    const best = m.pooled;
    this.hints.set(`scene:${best.c.tpdbId}`, best.x);
    await this.apply(id, best.c.tpdbId, 'scene', m.confidence, false, best.foundBy);
    this.db.prepare(`UPDATE scenes SET parsed=?, match_alts=?, match_query=?, match_tried_at=?, match_error=NULL, match_error_code=NULL WHERE id=?`)
      .run(JSON.stringify(m.file.parsed), JSON.stringify(m.alternatives), m.query, new Date().toISOString(), id);
    this.status.matched++;
    const k = best.foundBy || `${kind}-batch`;
    this.status.strategies![k] = (this.status.strategies![k] || 0) + 1;
  }
  private fatal: { code: string; message: string } | null = null;

  /** Next unit of work: user-prioritised file, then a group job (resolves many files with a handful of requests), then the normal queue. */
  private nextTask(): { id?: number; group?: Group } | null {
    while (this.high.length) { const id = this.high.shift()!; if (this.pending.delete(id)) { this.running.add(id); return { id }; } }
    if (this.groupJobs.length) return { group: this.groupJobs.shift()! };
    while (this.queue.length) { const id = this.queue.shift()!; if (this.pending.delete(id)) { this.running.add(id); return { id }; } }
    return null;
  }

  /** Re-queues files that failed for transient reasons (network, rate limit, 5xx) with growing delays: 1, 5, 15, 60 minutes. */
  private scheduleRetry() {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; this.status.retryAt = null; }
    if (!this.autoRetryDelaysMs.length || this.fatal) return;
    const failed = (this.db.prepare(`SELECT COUNT(*) c FROM scenes WHERE match_status='failed'`).get() as any).c;
    if (!failed || this.retryRound >= this.autoRetryDelaysMs.length) return;
    const delay = this.autoRetryDelaysMs[this.retryRound++];
    this.status.retryAt = new Date(Date.now() + delay).toISOString();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null; this.status.retryAt = null;
      const ids = (this.db.prepare(`SELECT id FROM scenes WHERE match_status='failed' ORDER BY added_at DESC`).all() as any[]).map((r) => r.id);
      if (ids.length && this.status.state === 'idle') this.enqueue(ids);
    }, delay);
    this.retryTimer.unref?.();
  }

  private async run() {
    if (!this.useTpdb() && !this.useStash()) {
      const noKey = this.providers().tpdb && !this.tpdb.configured;
      const code = noKey ? 'tpdb_not_configured' : 'no_provider';
      this.recordError(code, noKey ? 'ThePornDB API key is not configured (TPDB_API_KEY is empty)' : 'No metadata provider is enabled and configured (Settings > Metadata sources)');
      this.db.prepare(`UPDATE scenes SET match_status='failed', match_error=?, match_error_code=? WHERE match_status='queued'`).run(this.status.lastError, code);
      this.queue = []; this.high = []; this.groupJobs = []; this.pending.clear(); this.status.queued = 0;
      return;
    }
    this.cancelled = false; this.fatal = null;
    this.runAbort = new AbortController(); this.completed = []; this.lists.clear();
    const groups = { total: this.groupJobs.length, done: 0, filesMatched: 0, skipped: {} as Record<string, number> };
    Object.assign(this.status, { state: 'running', processed: 0, matched: 0, failed: 0, unmatched: 0, startedAt: new Date().toISOString(), lastError: null, lastErrorCode: null, lastErrorAt: null, errorCounts: {}, strategies: {}, groups });
    const worker = async () => {
      for (;;) {
        if (this.cancelled) return;
        if (this.paused) { await this.gate(); continue; }
        const t = this.nextTask();
        if (!t) {
          if (this.active === 0) { this.wakeWorkers(); return; }
          await new Promise<void>((r) => this.idleWaiters.push(r));
          continue;
        }
        this.active++;
        try { if (t.group) await this.processGroup(t.group); else { await this.processOne(t.id!); } }
        catch { /* processOne records its own errors */ }
        finally { this.active--; if (t.id != null) this.running.delete(t.id); this.touch(); this.wakeWorkers(); }
      }
    };
    await Promise.all(Array.from({ length: this.concurrency }, worker));
    this.lists.clear(); this.hints.clear(); this.running.clear(); this.quickIds.clear(); this.thorough = false;
    if (this.cancelled) { this.queue = []; this.high = []; this.groupJobs = []; this.pending.clear(); }
    const fatal = this.fatal as { code: string; message: string } | null;
    if (fatal) {
      // the key is rejected / blocked: every remaining file would fail the same way, so mark them with the real reason instead of leaving them "queued"
      this.db.prepare(`UPDATE scenes SET match_status='failed', match_error=?, match_error_code=? WHERE match_status='queued'`).run(fatal.message, fatal.code);
      this.queue = []; this.high = []; this.groupJobs = []; this.pending.clear();
    }
    this.status.current = null; this.status.state = 'idle'; this.status.queued = this.pending.size;
    this.touch();
    if (!this.fatal && !(this.status.failed > 0)) this.retryRound = 0;
    this.scheduleRetry();
  }
}
