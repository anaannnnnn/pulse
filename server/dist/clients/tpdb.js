import { HttpError, RateLimiter, sleep } from '../http.js';
import { cleanSecret } from '../secret.js';
import { AdaptiveLimiter, isAbort, AbortedError } from '../services/rateLimiter.js';
const PATHS = { scene: 'scenes', movie: 'movies', jav: 'jav' };
export const FATAL_TPDB = new Set(['tpdb_auth', 'tpdb_not_configured', 'tpdb_blocked']);
const snippet = (t) => t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
/** Root cause of a fetch failure ("fetch failed" hides it in `cause`: ENOTFOUND, ECONNRESET, certificate errors, ...). */
export const netReason = (e) => {
    const c = e?.cause;
    return String(c?.code || c?.message || e?.code || e?.message || e).slice(0, 160);
};
const isEmptyResult = (j) => !!j && typeof j === 'object' && Array.isArray(j.data) && j.data.length === 0;
export class TpdbClient {
    cache;
    f;
    base = 'https://api.theporndb.net';
    /** Adaptive token-bucket limiter (honours X-RateLimit-* / Retry-After, backs off on 429, ramps up when healthy). null = no limiting (tests). */
    limiter;
    /** Legacy fixed spacing, only used when TPDB_INTERVAL_MS is explicitly > 0: a floor on top of the adaptive limiter. */
    spacing = null;
    apiKey;
    /** Multiplier for retry waits (tests set 0). */
    backoffScale = 1;
    stats = { requests: 0, cacheHits: 0, deduped: 0, retries: 0, errors: 0 };
    /** Empty answers are cached for a shorter time than hits (new scenes appear on TPDB all the time). */
    negativeTtlMs;
    inflight = new Map();
    /**
     * @param intervalMs undefined = adaptive limiter (default); 0 = no limiting (tests); >0 = legacy fixed spacing floor in ms.
     * @param opts       limiter tuning (maxRps/startRps/burst/maxInflight) and negativeTtlMs.
     */
    constructor(apiKey, cache, f = fetch, intervalMs, opts = {}) {
        this.cache = cache;
        this.f = f;
        this.apiKey = cleanSecret(apiKey);
        this.negativeTtlMs = opts.negativeTtlMs ?? 6 * 3600e3;
        if (intervalMs === 0)
            this.limiter = null;
        else {
            this.limiter = new AdaptiveLimiter(opts);
            if (intervalMs && intervalMs > 0)
                this.spacing = new RateLimiter(intervalMs);
        }
    }
    get configured() { return !!this.apiKey; }
    get keyLength() { return this.apiKey.length; }
    headers() { return { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json', 'User-Agent': 'Pulse/1.0 (+personal media library)' }; }
    /** One HTTP request through the limiter (+ optional legacy spacing). `signal` aborts both the wait for a token and the request. */
    async send(url, signal) {
        if (this.spacing)
            await this.spacing.schedule(async () => { });
        this.stats.requests++;
        const go = () => this.f(url, { headers: this.headers(), signal });
        return this.limiter ? this.limiter.run(go, signal) : go();
    }
    /** Cached answer (hit) or undefined. Empty answers use the shorter negative TTL. */
    cached(key, maxAgeMs) {
        const hit = this.cache?.get(key, maxAgeMs);
        if (hit === undefined)
            return undefined;
        if (isEmptyResult(hit) && this.cache.get(key, Math.min(maxAgeMs, this.negativeTtlMs)) === undefined)
            return undefined;
        return hit;
    }
    /** True when the answer for this query is already stored locally (no network needed). */
    hasCached(path, params = {}, maxAgeMs = 7 * 864e5) {
        const u = new URL(this.base + path);
        for (const [k, v] of Object.entries(params))
            if (v !== undefined && v !== '')
                u.searchParams.set(k, String(v));
        return this.cached(u.pathname + u.search, maxAgeMs) !== undefined;
    }
    async get(path, params = {}, maxAgeMs = 7 * 864e5, signal, opts = {}) {
        if (!this.apiKey)
            throw new HttpError(409, 'ThePornDB API key is not configured (TPDB_API_KEY is empty)', 'tpdb_not_configured');
        if (signal?.aborted)
            throw new AbortedError();
        const u = new URL(this.base + path);
        for (const [k, v] of Object.entries(params))
            if (v !== undefined && v !== '')
                u.searchParams.set(k, String(v));
        const key = u.pathname + u.search;
        const hit = opts.noStore ? undefined : this.cached(key, maxAgeMs);
        if (hit !== undefined) {
            this.stats.cacheHits++;
            return hit;
        }
        if (!opts.noStore && this.cache?.pull) {
            try {
                let pulled = await this.cache.pull(key, maxAgeMs);
                if (pulled !== undefined && isEmptyResult(pulled)) {
                    const young = await this.cache.pull(key, Math.min(maxAgeMs, this.negativeTtlMs));
                    if (young === undefined)
                        pulled = undefined;
                }
                if (pulled !== undefined) {
                    this.stats.cacheHits++;
                    return pulled;
                }
            }
            catch { /* pCloud unreachable: ask the provider */ }
        }
        // in-flight de-duplication: identical concurrent queries share one request; it is aborted only when every waiter has gone
        let entry = this.inflight.get(key);
        if (entry)
            this.stats.deduped++;
        else {
            const ctl = new AbortController();
            const promise = this.fetchJson(u, key, ctl.signal, !opts.noStore).finally(() => { if (this.inflight.get(key) === entry)
                this.inflight.delete(key); });
            promise.catch(() => { });
            entry = { promise, ctl, refs: 0 };
            this.inflight.set(key, entry);
        }
        const e = entry;
        e.refs++;
        if (!signal) {
            try {
                return await e.promise;
            }
            finally {
                e.refs--;
            }
        }
        return await new Promise((resolve, reject) => {
            const onAbort = () => { e.refs--; if (e.refs <= 0) {
                if (this.inflight.get(key) === e)
                    this.inflight.delete(key);
                e.ctl.abort();
            } reject(new AbortedError()); };
            signal.addEventListener('abort', onAbort, { once: true });
            e.promise.then((v) => { signal.removeEventListener('abort', onAbort); e.refs--; resolve(v); }, (err) => { signal.removeEventListener('abort', onAbort); e.refs--; reject(err); });
        });
    }
    async fetchJson(u, key, signal, store = true) {
        let last = null;
        for (let attempt = 0; attempt < 5; attempt++) {
            if (signal.aborted)
                throw new AbortedError();
            let res;
            try {
                res = await this.send(u.toString(), signal);
            }
            catch (e) {
                if (isAbort(e) || signal.aborted)
                    throw new AbortedError();
                this.stats.errors++;
                last = new HttpError(502, `Cannot reach ThePornDB: ${netReason(e)}`, 'tpdb_network');
                if (attempt < 2) {
                    await sleep(1000 * (attempt + 1) * this.backoffScale);
                    continue;
                }
                throw last;
            }
            if (res.status === 429 || res.status >= 500) {
                this.stats.retries++;
                const body = snippet(await res.text().catch(() => ''));
                last = res.status === 429
                    ? new HttpError(429, `ThePornDB rate limit (HTTP 429)${body ? `: ${body}` : ''}`, 'rate_limited')
                    : new HttpError(502, `ThePornDB server error (HTTP ${res.status})${body ? `: ${body}` : ''}`, 'tpdb_http');
                // the adaptive limiter has already paused every request for Retry-After and halved its rate; without one wait here
                if (!this.limiter) {
                    const hdr = res.headers.get('retry-after');
                    const ra = hdr !== null && hdr !== '' && Number.isFinite(Number(hdr)) ? Number(hdr) : 2 ** attempt;
                    await sleep(Math.min(ra, 30) * 1000 * this.backoffScale);
                }
                else if (res.status >= 500)
                    await sleep(250 * 2 ** attempt * this.backoffScale);
                continue;
            }
            if (res.status === 404)
                throw new HttpError(404, 'Not found on ThePornDB', 'not_found');
            if (res.status === 401 || res.status === 403) {
                const body = snippet(await res.text().catch(() => ''));
                if (res.status === 403 && /cloudflare|attention required|just a moment|access denied|blocked/i.test(body))
                    throw new HttpError(502, `ThePornDB (Cloudflare) blocked this computer's request (HTTP 403): ${body}`, 'tpdb_blocked');
                throw new HttpError(502, `ThePornDB rejected the API key (HTTP ${res.status})${body ? `: ${body}` : ''}`, 'tpdb_auth');
            }
            if (!res.ok)
                throw new HttpError(502, `ThePornDB HTTP ${res.status}: ${snippet(await res.text().catch(() => ''))}`, 'tpdb_http');
            const text = await res.text();
            let j;
            try {
                j = JSON.parse(text);
            }
            catch {
                throw new HttpError(502, `ThePornDB returned a non-JSON response (HTTP ${res.status}): ${snippet(text)}`, 'tpdb_bad_response');
            }
            if (store)
                this.cache?.set(key, j);
            return j;
        }
        throw last ?? new HttpError(429, 'ThePornDB rate limit', 'rate_limited');
    }
    /** Diagnoses the key + connectivity with two uncached calls: /auth/user and a sample scene search. Never throws, never includes the key. */
    async test(sample = 'Mandy Marx - Pain To Play.mp4') {
        const out = { ok: false, status: 'error', hint: '', keyLength: this.apiKey.length, steps: [] };
        if (!this.apiKey) {
            out.status = 'not_configured';
            out.hint = 'No ThePornDB key is set. Put TPDB_API_KEY=your_token in server/.env (no quotes, no spaces), save, and restart the server.';
            return out;
        }
        const call = async (name, path, q = {}) => {
            const u = new URL(this.base + path);
            for (const [k, v] of Object.entries(q))
                u.searchParams.set(k, v);
            try {
                const res = await this.send(u.toString());
                const text = await res.text().catch(() => '');
                let json = null;
                try {
                    json = JSON.parse(text);
                }
                catch { /* not json */ }
                out.steps.push({ name, httpStatus: res.status, ok: res.ok, detail: res.ok ? 'OK' : snippet(text) });
                return { res, text, json };
            }
            catch (e) {
                out.steps.push({ name, httpStatus: null, ok: false, detail: netReason(e) });
                return null;
            }
        };
        const classify = (r) => {
            if (!r) {
                out.status = 'network';
                out.hint = `This computer cannot reach api.theporndb.net (${out.steps[out.steps.length - 1].detail}). Check internet, VPN/proxy, firewall or antivirus HTTPS scanning, and DNS.`;
                return true;
            }
            const st = r.res.status;
            if (st === 401) {
                out.status = 'invalid_key';
                out.hint = `ThePornDB says this API key is invalid (HTTP 401). The key being used is ${this.apiKey.length} characters long. Create a fresh token in your ThePornDB account (API tokens), paste only the token into TPDB_API_KEY in server/.env, and restart.`;
                return true;
            }
            if (st === 403) {
                out.status = /cloudflare|attention required|just a moment|blocked/i.test(r.text) ? 'blocked' : 'invalid_key';
                out.hint = out.status === 'blocked' ? 'Cloudflare in front of ThePornDB blocked this computer (HTTP 403). Try another network/VPN off, then retry later.' : 'ThePornDB refused the key (HTTP 403). Generate a new token and restart.';
                return true;
            }
            if (st === 429) {
                out.status = 'rate_limited';
                out.hint = 'ThePornDB is rate limiting this key/IP (HTTP 429). Wait a few minutes and retry; lower TPDB_INTERVAL_MS speed is not recommended.';
                return true;
            }
            if (!r.res.ok) {
                out.status = 'error';
                out.hint = `ThePornDB answered HTTP ${st}. ${snippet(r.text)}`;
                return true;
            }
            return false;
        };
        const who = await call('auth', '/auth/user');
        if (classify(who))
            return out;
        const wj = who.json;
        out.user = wj?.data?.name || wj?.data?.username || wj?.name || null;
        const sc = await call('scene search', '/scenes', { parse: sample, per_page: '3' });
        if (classify(sc))
            return out;
        const items = sc.json?.data || [];
        out.sample = { query: sample, results: items.length, first: items[0]?.title ?? null };
        if (!items.length) {
            out.status = 'empty';
            out.hint = 'The key works but the sample search returned no results. Try again in a minute.';
            return out;
        }
        out.ok = true;
        out.status = 'ok';
        out.hint = 'ThePornDB key works and searching works.';
        return out;
    }
    async parse(type, filename, limit = 10) {
        const j = await this.get(`/${PATHS[type]}`, { parse: filename, per_page: limit });
        return j.data || [];
    }
    async search(type, q, opts = {}) {
        const j = await this.get(`/${PATHS[type]}`, { q, page: opts.page, per_page: opts.perPage ?? 20, date: opts.date, site: opts.site });
        return j.data || [];
    }
    /** Generic list query with TPDB filters (site_id, performer_id, date, q, title, year, hash…). */
    async list(type, params, perPage = 15, signal) {
        const j = await this.get(`/${PATHS[type]}`, { ...params, per_page: perPage }, undefined, signal);
        return j.data || [];
    }
    /** Like list() but also returns paging meta (total / last_page): used to page through a performer's or site's whole scene list. */
    async listPage(type, params, perPage = 100, signal) {
        const j = await this.get(`/${PATHS[type]}`, { ...params, per_page: perPage }, undefined, signal, { noStore: true });
        return { data: j.data || [], total: Number(j.meta?.total ?? 0), lastPage: Number(j.meta?.last_page ?? 1) || 1 };
    }
    /** Studio/site lookup: /sites?q= */
    async searchSites(q, signal) {
        const j = await this.get('/sites', { q, per_page: 10 }, 30 * 864e5, signal);
        return j.data || [];
    }
    /** Scenes by file hash (OSHASH / PHASH / MD5). */
    async byHash(hash, hashType = 'OSHASH') {
        const j = await this.get('/scenes', { hash, hash_type: hashType, per_page: 5 });
        return j.data || [];
    }
    async item(type, id) {
        const j = await this.get(`/${PATHS[type]}/${encodeURIComponent(id)}`);
        return j.data;
    }
    async searchPerformers(q, page = 1, signal) {
        const j = await this.get('/performers', { q, page, per_page: 20 }, undefined, signal);
        return j.data || [];
    }
    async performer(id) {
        const j = await this.get(`/performers/${encodeURIComponent(id)}`, {}, 14 * 864e5);
        return j.data;
    }
}
export function pickImage(x, ...keys) {
    for (const k of keys) {
        const v = x?.[k];
        if (!v)
            continue;
        if (typeof v === 'string')
            return v;
        if (Array.isArray(v) && v[0]?.url)
            return v[0].url;
        if (typeof v === 'object')
            return v.large || v.full || v.medium || v.small || null;
    }
    return null;
}
