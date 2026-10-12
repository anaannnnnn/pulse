// StashDB (stash-box) GraphQL client. Auth is the `ApiKey` header. The key is never logged or put into errors, cache keys or test output.
import { HttpError, RateLimiter, sleep } from '../http.js';
export const STASHDB_URL = 'https://stashdb.org/graphql';
const IMG = `images { id url width height }`;
const PERFORMER_FIELDS = `id name disambiguation aliases gender birth_date death_date age ethnicity country eye_color hair_color height cup_size band_size waist_size hip_size breast_type career_start_year career_end_year tattoos { location description } piercings { location description } urls { url site { name } } ${IMG} scene_count deleted merged_into_id`;
export const SCENE_FIELDS = `id title details release_date production_date duration code director deleted
  urls { url site { name } } studio { id name parent { id name } ${IMG} } tags { id name } ${IMG}
  performers { as performer { ${PERFORMER_FIELDS} } } fingerprints { hash algorithm duration }`;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/; // ids are passed as GraphQL variables; this only rejects junk early
const titleCase = (s) => (s ? String(s).toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : null);
const bodyMods = (a) => (a || []).map((m) => [m.location, m.description].filter(Boolean).join(': ')).filter(Boolean).join('; ') || null;
const bestImage = (imgs) => {
    const list = (imgs || []).filter((i) => i?.url);
    if (!list.length)
        return null;
    return [...list].sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0].url;
};
/** stash-box images are mostly large originals; prefer a landscape one for backdrops and a portrait one for posters. */
const pickPoster = (imgs) => bestImage(imgs);
const pickBackdrop = (imgs) => {
    const list = (imgs || []).filter((i) => i?.url && (i.width || 0) >= (i.height || 0));
    return bestImage(list.length ? list : imgs);
};
export function normalizePerformer(p) {
    const images = (p.images || []).map((i) => i.url).filter(Boolean);
    const cup = p.cup_size && p.band_size ? `${p.band_size}${p.cup_size}` : p.cup_size || null;
    const meas = [cup, p.waist_size, p.hip_size].every((x) => x) ? `${p.band_size}${p.cup_size}-${p.waist_size}-${p.hip_size}` : null;
    const links = {};
    for (const u of p.urls || [])
        if (u?.url)
            links[u.site?.name || `link${Object.keys(links).length + 1}`] = u.url;
    links.StashDB = `https://stashdb.org/performers/${p.id}`;
    const image = images[0] || null;
    const details = {
        id: p.id, name: p.name, slug: null, image, thumbnail: image, bio: null,
        aliases: p.aliases || [],
        posters: images.map((url) => ({ url })),
        extras: {
            gender: titleCase(p.gender), birthday: p.birth_date || null, birthplace: null, nationality: p.country || null,
            ethnicity: titleCase(p.ethnicity), hair_colour: titleCase(p.hair_color), eye_colour: titleCase(p.eye_color),
            height: p.height ? `${p.height}cm` : null, weight: null, measurements: meas, cupsize: cup,
            tattoos: bodyMods(p.tattoos), piercings: bodyMods(p.piercings),
            career_start_year: p.career_start_year ?? null, career_end_year: p.career_end_year ?? null,
            disambiguation: p.disambiguation || null, breast_type: titleCase(p.breast_type), links,
        },
        _source: 'stashdb',
    };
    return { source: 'stashdb', id: String(p.id), name: p.name, aliases: p.aliases || [], gender: titleCase(p.gender), image, thumb: image, images, details };
}
export function normalizeScene(x) {
    const st = x.studio;
    return {
        source: 'stashdb', id: String(x.id), title: x.title || '', date: x.release_date || x.production_date || null, description: x.details || null,
        studio: st ? { id: String(st.id), name: st.name, parent: st.parent?.name || null, logo: bestImage(st.images) } : null,
        performers: (x.performers || []).filter((a) => a?.performer).map((a) => normalizePerformer(a.performer)),
        tags: (x.tags || []).map((t) => ({ id: t.id ? String(t.id) : null, name: t.name })),
        poster: pickPoster(x.images), backdrop: pickBackdrop(x.images), trailer: null,
        duration: x.duration ?? null, url: `https://stashdb.org/scenes/${x.id}`, code: x.code || null,
    };
}
/** Maps a StashDB scene into the TPDB-shaped object the matching engine already scores (title/date/site/performers/duration). */
export function toEngineShape(s) {
    return {
        id: s.id, title: s.title, date: s.date, duration: s.duration, url: s.url, image: s.poster, external_id: s.code, sku: s.code,
        site: s.studio ? { id: s.studio.id, name: s.studio.name, parent: s.studio.parent ? { name: s.studio.parent } : undefined } : null,
        performers: s.performers.map((p) => ({ id: p.id, name: p.name })),
        _source: 'stashdb',
    };
}
export class StashDbClient {
    apiKey;
    cache;
    f;
    url;
    id = 'stashdb';
    label = 'StashDB';
    limiter;
    constructor(apiKey, cache, f = fetch, intervalMs = 150, url = STASHDB_URL) {
        this.apiKey = apiKey;
        this.cache = cache;
        this.f = f;
        this.url = url;
        this.limiter = new RateLimiter(intervalMs);
    }
    get configured() { return !!this.apiKey; }
    /** After a 401 the key is not retried for a while (every file would fail the same way); cleared by a successful test(). */
    authFailedUntil = 0;
    /** Runs one GraphQL operation. Responses with data are cached (not empty ones, so retries see fresh answers). */
    async gql(query, variables = {}, opts = {}) {
        if (!this.apiKey)
            throw new HttpError(409, 'StashDB API key not configured', 'stashdb_not_configured');
        if (opts.cache !== false && Date.now() < this.authFailedUntil)
            throw new HttpError(502, 'StashDB rejected the API key', 'stashdb_auth');
        const body = JSON.stringify({ query: query.replace(/\s+/g, ' ').trim(), variables });
        const ckey = `stashdb:${body}`;
        const useCache = opts.cache !== false && !!this.cache;
        if (useCache) {
            const hit = this.cache.get(ckey, opts.maxAgeMs ?? 7 * 864e5);
            if (hit !== undefined)
                return hit;
            if (this.cache.pull) {
                try {
                    const pulled = await this.cache.pull(ckey, opts.maxAgeMs ?? 7 * 864e5);
                    if (pulled !== undefined)
                        return pulled;
                }
                catch { /* pCloud unreachable: ask StashDB */ }
            }
        }
        for (let attempt = 0; attempt < 4; attempt++) {
            let res;
            try {
                res = await this.limiter.schedule(() => this.f(this.url, { method: 'POST', signal: opts.signal, headers: { ApiKey: this.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' }, body }));
            }
            catch (e) {
                if (e?.name === 'AbortError')
                    throw e;
                if (attempt < 2) {
                    await sleep(500 * (attempt + 1));
                    continue;
                }
                throw new HttpError(502, 'StashDB is unreachable', 'stashdb_unreachable');
            }
            if (res.status === 429 || res.status >= 500) {
                const ra = Number(res.headers.get('retry-after')) || 2 ** attempt;
                await sleep(Math.min(ra, 20) * 1000);
                continue;
            }
            if (res.status === 401 || res.status === 403) {
                this.authFailedUntil = Date.now() + 5 * 60_000;
                throw new HttpError(502, 'StashDB rejected the API key', 'stashdb_auth');
            }
            if (res.status === 422 || res.status === 400) { // GraphQL validation error: surface the message (lets callers fall back to older field names)
                const j = await res.json().catch(() => null);
                throw new HttpError(502, `StashDB: ${String(j?.errors?.[0]?.message || `HTTP ${res.status}`).slice(0, 160)}`, 'stashdb_error');
            }
            if (!res.ok)
                throw new HttpError(502, `StashDB HTTP ${res.status}`, 'stashdb_error');
            const j = await res.json().catch(() => null);
            if (!j)
                throw new HttpError(502, 'StashDB returned an invalid response', 'stashdb_error');
            if (j.errors?.length) {
                const msg = String(j.errors[0]?.message || 'GraphQL error');
                if (/not authori[sz]ed|unauthori[sz]ed|forbidden|invalid.*(key|token)/i.test(msg)) {
                    this.authFailedUntil = Date.now() + 5 * 60_000;
                    throw new HttpError(502, 'StashDB rejected the API key', 'stashdb_auth');
                }
                throw new HttpError(502, `StashDB: ${msg.slice(0, 160)}`, 'stashdb_error');
            }
            if (useCache && hasRows(j.data))
                this.cache.set(ckey, j.data);
            return j.data;
        }
        throw new HttpError(429, 'StashDB rate limit', 'rate_limited');
    }
    async test() {
        if (!this.apiKey)
            return { ok: false, status: 'not_configured', hint: 'STASHDB_API_KEY is not set on the server. Add it to server/.env and restart.' };
        try {
            const d = await this.gql('query { me { name } }', {}, { cache: false });
            this.authFailedUntil = 0;
            if (d?.me?.name)
                return { ok: true, status: 'ok', hint: `StashDB key works (signed in as ${d.me.name}).` };
            // some deployments reject `me` for keys without a user; fall back to a scene query that also needs auth
            const s = await this.gql('query($i: SceneQueryInput!) { queryScenes(input: $i) { count } }', { i: { page: 1, per_page: 1, direction: 'DESC', sort: 'DATE' } }, { cache: false });
            return typeof s?.queryScenes?.count === 'number' ? { ok: true, status: 'ok', hint: 'StashDB key works.' } : { ok: false, status: 'unauthorized', hint: 'StashDB did not accept the key. Generate a new API key in your StashDB account settings.' };
        }
        catch (e) {
            if (e?.code === 'stashdb_auth')
                return { ok: false, status: 'unauthorized', hint: 'StashDB rejected the API key (401). Copy the full key from StashDB > Account > API Key (it is a long token starting with "eyJ"), put it in STASHDB_API_KEY with no quotes or spaces, and restart.' };
            if (e?.code === 'stashdb_unreachable')
                return { ok: false, status: 'unreachable', hint: 'Could not reach stashdb.org from this server. Check internet access / firewall.' };
            return { ok: false, status: 'error', hint: String(e?.message || 'Unexpected StashDB error').slice(0, 200) };
        }
    }
    async searchScenes(term, limit = 15, opts = {}) {
        const t = term.trim();
        if (!t)
            return [];
        let rows = [];
        try {
            rows = (await this.gql(`query($t: String!, $n: Int) { searchScenes(term: $t, limit: $n) { scenes { ${SCENE_FIELDS} } } }`, { t, n: limit }, opts)).searchScenes?.scenes || [];
        }
        catch (e) {
            if (e?.code !== 'stashdb_error' || !/Cannot query field|Unknown/i.test(e.message || ''))
                throw e;
            rows = (await this.gql(`query($t: String!, $n: Int) { searchScene(term: $t, limit: $n) { ${SCENE_FIELDS} } }`, { t, n: limit }, opts)).searchScene || [];
        }
        return rows.filter((r) => !r.deleted).map(normalizeScene);
    }
    /** Filtered scene query (text, studio ids, performer ids, date, fingerprints). */
    async queryScenes(input, opts = {}) {
        const i = { page: input.page ?? 1, per_page: input.perPage ?? 20, direction: 'DESC', sort: input.sort ?? 'DATE' };
        if (input.text)
            i.text = input.text;
        if (input.studios?.length)
            i.studios = { value: input.studios, modifier: 'INCLUDES' };
        if (input.performers?.length)
            i.performers = { value: input.performers, modifier: input.performers.length > 1 ? 'INCLUDES_ALL' : 'INCLUDES' };
        if (input.date)
            i.date = { value: input.date, modifier: 'EQUALS' };
        if (input.fingerprints?.length)
            i.fingerprints = { value: input.fingerprints, modifier: 'INCLUDES' };
        const d = await this.gql(`query($i: SceneQueryInput!) { queryScenes(input: $i) { count scenes { ${SCENE_FIELDS} } } }`, { i }, opts);
        return (d.queryScenes?.scenes || []).filter((r) => !r.deleted).map(normalizeScene);
    }
    /** Scenes carrying any of these file fingerprints (MD5 / OSHASH / PHASH hex strings). */
    async byFingerprints(fp, opts = {}) {
        const hashes = [fp.oshash, fp.md5, fp.phash].filter((h) => !!h && /^[0-9a-f]{8,64}$/i.test(h)).map((h) => h.toLowerCase());
        if (!hashes.length)
            return [];
        return this.queryScenes({ fingerprints: hashes, perPage: 10, sort: 'CREATED_AT' }, opts);
    }
    async scene(id) {
        if (!ID_RE.test(id))
            return null;
        const d = await this.gql(`query($id: ID!) { findScene(id: $id) { ${SCENE_FIELDS} } }`, { id });
        return d.findScene && !d.findScene.deleted ? normalizeScene(d.findScene) : null;
    }
    async searchStudios(term, limit = 8) {
        const t = term.trim();
        if (!t)
            return [];
        const d = await this.gql(`query($t: String!, $n: Int) { searchStudio(term: $t, limit: $n) { id name aliases parent { name } deleted } }`, { t, n: limit }, { maxAgeMs: 30 * 864e5 });
        return (d.searchStudio || []).filter((s) => !s.deleted).map((s) => ({ id: String(s.id), name: s.name, aliases: s.aliases || [], parent: s.parent?.name || null }));
    }
    async searchPerformers(term, limit = 8) {
        const t = term.trim();
        if (!t)
            return [];
        let rows = [];
        try {
            rows = (await this.gql(`query($t: String!, $n: Int) { searchPerformers(term: $t, limit: $n) { performers { ${PERFORMER_FIELDS} } } }`, { t, n: limit }, { maxAgeMs: 14 * 864e5 })).searchPerformers?.performers || [];
        }
        catch (e) {
            if (e?.code !== 'stashdb_error' || !/Cannot query field|Unknown/i.test(e.message || ''))
                throw e;
            rows = (await this.gql(`query($t: String!, $n: Int) { searchPerformer(term: $t, limit: $n) { ${PERFORMER_FIELDS} } }`, { t, n: limit }, { maxAgeMs: 14 * 864e5 })).searchPerformer || [];
        }
        return rows.filter((p) => !p.deleted && !p.merged_into_id).map(normalizePerformer);
    }
    async performer(id) {
        if (!ID_RE.test(id))
            return null;
        const d = await this.gql(`query($id: ID!) { findPerformer(id: $id) { ${PERFORMER_FIELDS} } }`, { id }, { maxAgeMs: 14 * 864e5 });
        return d.findPerformer && !d.findPerformer.deleted ? normalizePerformer(d.findPerformer) : null;
    }
}
function hasRows(d) {
    if (!d || typeof d !== 'object')
        return false;
    for (const v of Object.values(d)) {
        if (Array.isArray(v)) {
            if (v.length)
                return true;
        }
        else if (v && typeof v === 'object') {
            if (hasRows(v))
                return true;
        }
        else if (v != null && v !== 0)
            return true;
    }
    return false;
}
