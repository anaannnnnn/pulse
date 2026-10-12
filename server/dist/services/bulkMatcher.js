// Fast matching paths used for bulk library matching (provider-agnostic scoring, ThePornDB transport):
//
//  1. fastCascade(): runs the cheap strategies CONCURRENTLY instead of one after another.
//       tier 1  parse (raw name / cleaned name) / JAV code           -> usually decides ~60% of files with 1-2 requests
//       tier 2  title queries, studio (site lookup -> site+date / site+title), performer (lookup -> performer+date / +title)
//     Results are consumed in strategy priority order (deterministic labels); the moment the pool holds a confident match the
//     remaining requests are aborted through an AbortController (queued ones never reach the network). Anything not confident
//     falls back to the full sequential cascade (cache + in-flight dedupe make its repeated queries free).
//  2. planGroups()/matchGroup(): files sharing a performer ("Mandy Marx - ...") or a date-less studio are resolved ONCE:
//     look up the performer/site, page through its scene list (100 per page, a few pages in parallel) and match every file of the
//     group locally by title similarity with the normal scorer. No per-file API calls at all for the files that match.
import { FATAL_TPDB } from '../clients/tpdb.js';
import { keyOf, sigTokens, tick, tokens } from '../text.js';
import { isAbort } from './rateLimiter.js';
import { buildProfile, candStudioKeys, makeScorer, resolveAmbiguity, runCascade, scorePool, toCandidate } from './matchEngine.js';
const looksName = (s) => { const t = s.trim().split(/\s+/); return t.length >= 1 && t.length <= 3 && t.every((w) => /^[A-Za-z'’.-]{2,}$/.test(w)); };
const rankWords = (ws) => [...new Set(ws)].sort((a, b) => b.length - a.length);
const uniqKey = (arr) => arr.filter((h, i, a) => a.findIndex((x) => keyOf(x) === keyOf(h)) === i);
function buildResult(final, threshold, extra) {
    const candidates = final.slice(0, 20).map((p) => ({ ...p.c, source: p.source ?? 'tpdb', confidence: p.conf, matchedBy: p.hashHit ? 'hash' : p.foundBy }));
    const best = candidates[0] || null;
    const alternatives = candidates.slice(0, 5).map((c) => ({ tpdbId: c.tpdbId, type: c.type, title: c.title, date: c.date, studio: c.studio, performers: c.performers.slice(0, 4), poster: c.poster, confidence: c.confidence, matchedBy: c.matchedBy, source: c.source }));
    return { candidates, alternatives, best, confident: !!best && best.confidence >= threshold, strategy: best?.matchedBy ?? null, errors: [], queriesOk: 0, ...extra, raw: final[0]?.x };
}
export async function fastCascade(tpdb, input, opts = {}) {
    // manual searches / explicit endpoint choice / another provider only: unchanged exhaustive sequential behaviour
    if (input.query != null || input.types?.length || input.useTpdb === false)
        return runCascade(tpdb, input);
    const prof = buildProfile(input);
    const ctl = new AbortController();
    const onExt = () => ctl.abort();
    opts.signal?.addEventListener('abort', onExt, { once: true });
    const pool = new Map();
    const tried = [];
    const errs = [];
    let queries = 0, okQueries = 0;
    const seen = new Set();
    const stopped = () => ctl.signal.aborted || !!input.shouldStop?.();
    const note = (e) => {
        if (isAbort(e))
            return;
        if (FATAL_TPDB.has(e?.code))
            throw e;
        if (e?.code === 'not_found') {
            okQueries++;
            return;
        }
        errs.push({ code: String(e?.code || 'error'), message: String(e?.message || e) });
    };
    const scored = makeScorer(pool, prof, input.threshold);
    const confident = () => { const s = scored(); return !!s[0] && s[0].conf >= input.threshold; };
    const q = async (label, type, params, perPage = 15) => {
        const k = `${type}|${JSON.stringify(params)}|${perPage}`;
        if (seen.has(k))
            return null;
        seen.add(k);
        queries++;
        tried.push(`${label}: ${type} ${Object.entries(params).map(([a, b]) => `${a}=${b}`).join('&')}`);
        try {
            const items = await tpdb.list(type, params, perPage, ctl.signal);
            okQueries++;
            await tick();
            return { label, type, items };
        }
        catch (e) {
            note(e);
            return null;
        }
    };
    const siteMemo = new Map();
    const findSite = (hint) => { const k = keyOf(hint); let p = siteMemo.get(k); if (!p) {
        p = findSiteRaw(hint);
        siteMemo.set(k, p);
    } return p; };
    const findSiteRaw = async (hint) => {
        const k = keyOf(hint);
        const variants = [...new Set([hint, hint.replace(/([a-z])([A-Z])/g, '$1 $2'), hint.replace(/\.(com|net|org|xxx)$/i, '')])];
        for (const v of variants) {
            if (stopped())
                return null;
            queries++;
            tried.push(`site-lookup: ${v}`);
            let items = [];
            try {
                items = await tpdb.searchSites(v, ctl.signal);
                okQueries++;
            }
            catch (e) {
                note(e);
            }
            const exact = items.find((s) => keyOf(s.name) === k || keyOf(s.short_name) === k || keyOf(s.slug) === k);
            const near = items.filter((s) => keyOf(s.name).startsWith(k) && k.length >= 4).sort((a, b) => String(a.name).length - String(b.name).length)[0];
            if (exact || near)
                return exact || near;
        }
        return null;
    };
    const findPerformer = async (name) => {
        if (stopped())
            return null;
        queries++;
        tried.push(`performer-lookup: ${name}`);
        let items = [];
        try {
            items = await tpdb.searchPerformers(name, 1, ctl.signal);
            okQueries++;
        }
        catch (e) {
            note(e);
        }
        const k = keyOf(name);
        return items.find((p) => keyOf(p.name) === k) || items.find((p) => (p.aliases || []).some((a) => keyOf(a) === k)) || null;
    };
    const titleWords = () => prof.words.filter((w) => !prof.perfNames.some((n) => tokens(n).includes(w)));
    const flat = async (ps) => ({ hits: (await Promise.all(ps)).filter(Boolean) });
    const guard = (fn) => fn().catch((e) => ({ hits: [], err: e }));
    const add = (h) => {
        for (const x of h.items) {
            const c = toCandidate(x, h.type);
            const key = `${h.type}:${c.tpdbId}`;
            if (!pool.has(key))
                pool.set(key, { key, type: h.type, x, c, studioKeys: candStudioKeys(x), foundBy: h.label, conf: 0 });
        }
    };
    /** Starts all tasks at once, then folds their results into the pool in priority order; stops (and aborts the rest) at the first confident pool. */
    const runTier = async (tasks) => {
        const started = tasks.map((t) => guard(t));
        let ok = false;
        for (const p of started) {
            const out = await p;
            if (out.err) {
                if (FATAL_TPDB.has(out.err?.code)) {
                    ctl.abort();
                    throw out.err;
                }
                note(out.err);
            }
            out.hits.forEach(add);
            if (stopped())
                break;
            if (pool.size && confident()) {
                ok = true;
                break;
            }
        }
        if (ok)
            ctl.abort(); // cancels queued + in-flight requests of the remaining tasks
        await Promise.all(started); // settle (aborted tasks return quickly)
        return ok;
    };
    try {
        // ---------------- tier 1: parse / JAV
        const tier1 = [];
        const first = 'scene';
        if (prof.jav) {
            const code = prof.jav;
            tier1.push(() => flat([q('jav', 'jav', { q: code }, 10), q('jav', 'jav', { q: code.replace(/-/g, ' ') }, 10), q('jav', 'scene', { q: code }, 10)]));
        }
        else {
            const rawBase = input.fileName.replace(/\.[A-Za-z0-9]{2,5}$/, '');
            const ps = [];
            if (!/\s/.test(rawBase) || input.parsed.date)
                ps.push(() => q('parse', first, { parse: rawBase }, 10));
            if (input.parsed.query && input.parsed.query !== rawBase)
                ps.push(() => q('parse', first, { parse: input.parsed.query }, 10));
            if (ps.length)
                tier1.push(() => flat(ps.map((f) => f())));
        }
        if (tier1.length && await runTier(tier1))
            return finish(true);
        if (stopped())
            return finish(false);
        // ---------------- tier 2: title / studio / performer concurrently
        const tier2 = [];
        const full = prof.rawWords.join(' ').trim();
        const tw = titleWords().join(' ');
        tier2.push(() => {
            const ps = [];
            if (full)
                ps.push(q('title', first, { q: full }, 15));
            if (tw && tw !== full.toLowerCase())
                ps.push(q('title', first, { q: tw }, 15));
            if (prof.date && prof.words.length)
                ps.push(q('title', first, { q: tw || full, date: prof.date }, 15));
            return flat(ps);
        });
        const hints = uniqKey([...(input.parsed.studioHints || [])]);
        const folder = (input.parsed.folderHints || []).filter((h) => !hints.some((x) => keyOf(x) === keyOf(h)));
        const siteHints = [...hints.slice(0, 2).map((h) => ({ h, fromFolder: false })), ...folder.slice(0, 2).map((h) => ({ h, fromFolder: true }))];
        for (const { h, fromFolder } of siteHints) {
            tier2.push(async () => {
                const site = await findSite(h);
                if (!site || stopped())
                    return { hits: [] };
                if (fromFolder)
                    prof.folderStudioKeys.add(keyOf(site.name));
                else
                    prof.studioKeys.add(keyOf(site.name));
                const sid = site.id;
                const ps = [];
                if (prof.date)
                    ps.push(q('studio+date', 'scene', { site_id: sid, date: prof.date }, 25));
                if (tw) {
                    ps.push(q('studio+title', 'scene', { site_id: sid, q: tw }, 15));
                    if (prof.date)
                        ps.push(q('studio+title', 'scene', { site_id: sid, date: prof.date, q: tw.split(' ').slice(0, 3).join(' ') }, 15));
                    ps.push(q('studio+title', 'scene', { q: `${site.name} ${tw}` }, 15));
                }
                return flat(ps);
            });
        }
        if (!siteHints.length && prof.date) {
            tier2.push(() => flat(rankWords(titleWords()).slice(0, 2).map((w) => q('studio+date', 'scene', { date: prof.date, q: w }, 15))));
        }
        // performers: explicit names, name-like folder hints and "First Last" windows over the leading words
        const names = [];
        const addName = (n) => { const t = n.trim(); if (t && !names.some((x) => keyOf(x) === keyOf(t)))
            names.push(t); };
        prof.perfNames.forEach(addName);
        (input.parsed.folderHints || []).filter(looksName).forEach(addName);
        const rw = prof.rawWords.filter((w) => !prof.studioKeys.has(keyOf(w)));
        const starts = new Set([0, 1, 2]);
        rw.forEach((w, i) => { if (/^(and|x|with)$/i.test(w))
            starts.add(i + 1); });
        for (const st of [...starts].sort((a, b) => a - b))
            for (const n of [2, 3]) {
                const win = rw.slice(st, st + n);
                if (win.length === n && win.every((w) => /^[A-Za-z'’-]{3,}$/.test(w) && !/^(and|the|with|her|his|for)$/i.test(w)))
                    addName(win.join(' '));
            }
        if (names.length) {
            tier2.push(async () => {
                const found = (await Promise.all(names.slice(0, 5).map((n) => findPerformer(n)))).filter(Boolean).slice(0, 3);
                const ps = [];
                const site = hints[0] ? await findSite(hints[0]) : null; // shared with the studio task (one lookup)
                for (const p of found) {
                    if (!prof.perfNames.some((x) => keyOf(x) === keyOf(p.name)))
                        prof.perfNames.push(p.name);
                    const pid = p._id ?? p.id;
                    if (prof.date)
                        ps.push(q('performer', 'scene', { performer_id: pid, date: prof.date }, 15));
                    const t2 = titleWords().filter((w) => !tokens(p.name).includes(w));
                    if (t2.length)
                        ps.push(q('performer', 'scene', { performer_id: pid, q: t2.join(' ') }, 15));
                    if (t2.length > 1)
                        ps.push(q('performer', 'scene', { performer_id: pid, q: rankWords(t2)[0] }, 15));
                    if (site)
                        ps.push(q('performer', 'scene', { performer_id: pid, site_id: site.id }, 25));
                }
                return flat(ps);
            });
        }
        if (await runTier(tier2))
            return finish(true);
    }
    catch (e) {
        ctl.abort();
        opts.signal?.removeEventListener('abort', onExt);
        throw e;
    }
    opts.signal?.removeEventListener('abort', onExt);
    if (stopped() && input.shouldStop?.())
        return finish(false);
    // ---------------- not confident: the full sequential cascade (word-by-word, fuzzy, other endpoints, hash, StashDB...).
    // Everything asked above is cached, so its first stages cost nothing.
    if (opts.quick)
        return finish(false);
    return await runCascade(tpdb, { ...input, budget: opts.fallbackBudget ?? input.budget });
    async function finish(_conf) {
        opts.signal?.removeEventListener('abort', onExt);
        const r = buildResult(scored(), input.threshold, { queries, tried, query: prof.rawWords.join(' '), errors: errs, queriesOk: okQueries });
        if (!r.confident && okQueries === 0 && errs.length)
            throw Object.assign(new Error(errs[0].message), { code: errs[0].code, statusCode: 502 });
        return r;
    }
}
/** Leading "Name - " of clip-store style names ("Mandy Marx - Pain To Play.mp4"). */
const PREFIX = /^([A-Z][A-Za-z'’.-]+(?: [A-Z][A-Za-z'’.-]+){0,2}) +[-–—] +/;
export function groupKeyOf(f) {
    const p = f.parsed;
    const lead = PREFIX.exec(f.row.file_name || '');
    const perf = (p.performers && p.performers.length === 1 && looksName(p.performers[0]) ? p.performers[0] : null) || (lead && looksName(lead[1]) ? lead[1] : null);
    if (perf && keyOf(perf).length >= 5)
        return { kind: 'performer', key: `p:${keyOf(perf)}`, name: perf };
    const studio = p.studio || p.studioHints?.[0];
    if (studio && !p.date && keyOf(studio).length >= 4)
        return { kind: 'site', key: `s:${keyOf(studio)}`, name: studio };
    return null;
}
/** Splits files into groups (>= minSize files sharing a performer or date-less studio) and the rest (matched one by one). */
export function planGroups(files, minSize = 3) {
    const map = new Map();
    const rest = [];
    const lone = [];
    for (const f of files) {
        const g = groupKeyOf(f);
        if (!g) {
            rest.push(f);
            continue;
        }
        let grp = map.get(g.key);
        if (!grp) {
            grp = { ...g, files: [] };
            map.set(g.key, grp);
        }
        grp.files.push(f);
    }
    const groups = [];
    for (const g of map.values()) {
        if (g.files.length >= minSize)
            groups.push(g);
        else
            lone.push(...g.files);
    }
    groups.sort((a, b) => b.files.length - a.files.length);
    return { groups, rest: [...rest, ...lone] };
}
/** Local title-similarity match of one file against a scene list (the scorer is the same one the cascade uses). */
export function matchLocally(file, scenes, idx, threshold, group) {
    const input = { fileName: file.row.file_name, parsed: file.parsed, duration: file.duration, threshold };
    const prof = buildProfile(input);
    const skip = new Set(group?.performer ? tokens(group.performer) : []);
    const ft = [...new Set(prof.words.filter((w) => !skip.has(w)))];
    const score = new Map();
    for (const t of ft) {
        const list = idx.byToken.get(t);
        if (!list)
            continue;
        const w = Math.log(1 + idx.n / (1 + list.length));
        for (const i of list)
            score.set(i, (score.get(i) || 0) + w);
    }
    if (prof.date)
        for (const i of idx.byDate.get(prof.date) || [])
            score.set(i, (score.get(i) || 0) + 3);
    if (prof.jav) {
        const code = prof.jav.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
        for (const [i, s] of idx.codes)
            if (s.includes(code))
                score.set(i, (score.get(i) || 0) + 5);
    }
    if (!score.size)
        return null;
    const top = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([i]) => i);
    const pool = top.map((i) => ({ key: `scene:${scenes[i].c.tpdbId}`, type: 'scene', x: scenes[i].x, c: scenes[i].c, studioKeys: scenes[i].studioKeys, foundBy: group?.performer ? 'performer-batch' : 'site-batch', conf: 0 }));
    scorePool(pool, prof);
    resolveAmbiguity(pool, prof, threshold);
    pool.sort((a, b) => b.conf - a.conf);
    const best = pool[0];
    const alternatives = pool.slice(0, 5).map((p) => ({ tpdbId: p.c.tpdbId, type: 'scene', title: p.c.title, date: p.c.date, studio: p.c.studio, performers: p.c.performers.slice(0, 4), poster: p.c.poster, confidence: p.conf, matchedBy: p.foundBy, source: 'tpdb' }));
    if (!best || best.conf < threshold)
        return null;
    return { file, pooled: best, alternatives, confidence: best.conf, query: prof.rawWords.join(' ') };
}
export function indexScenes(scenes, skipTokens = new Set()) {
    const byToken = new Map(), byDate = new Map();
    const codes = [];
    scenes.forEach((s, i) => {
        for (const t of new Set(sigTokens(s.c.title))) {
            if (skipTokens.has(t))
                continue;
            (byToken.get(t) || byToken.set(t, []).get(t)).push(i);
        }
        if (s.c.date)
            (byDate.get(s.c.date.slice(0, 10)) || byDate.set(s.c.date.slice(0, 10), []).get(s.c.date.slice(0, 10))).push(i);
        const code = [s.c.title, s.x.external_id, s.x.sku, s.x.slug].filter(Boolean).join(' ').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
        if (code)
            codes.push([i, code]);
    });
    return { n: scenes.length, byToken, byDate, codes };
}
/** Resolves a group's performer / site once, pages through its scenes and matches the group's files locally. */
export async function matchGroup(group, deps) {
    const { tpdb, signal } = deps;
    const maxPages = deps.maxPages ?? 12, conc = deps.pageConcurrency ?? 3;
    const empty = (skipped, requests = 0) => ({ matched: [], leftover: group.files, scenes: 0, requests, skipped });
    let requests = 0;
    let items = deps.lists?.get(group.key);
    if (!items) {
        let filter = null;
        if (group.kind === 'performer') {
            requests++;
            const found = await tpdb.searchPerformers(group.name, 1, signal);
            const k = keyOf(group.name);
            const p = found.find((x) => keyOf(x.name) === k) || found.find((x) => (x.aliases || []).some((a) => keyOf(a) === k));
            if (!p)
                return empty('performer not found', requests);
            filter = { performer_id: p._id ?? p.id };
        }
        else {
            const k = keyOf(group.name);
            const variants = [...new Set([group.name, group.name.replace(/([a-z])([A-Z])/g, '$1 $2'), group.name.replace(/\.(com|net|org|xxx)$/i, '')])];
            let site = null;
            for (const v of variants) {
                requests++;
                const r = await tpdb.searchSites(v, signal);
                site = r.find((s) => keyOf(s.name) === k || keyOf(s.short_name) === k || keyOf(s.slug) === k) || r.filter((s) => keyOf(s.name).startsWith(k) && k.length >= 4)[0] || null;
                if (site)
                    break;
            }
            if (!site)
                return empty('site not found', requests);
            filter = { site_id: site.id };
        }
        await deps.gate?.();
        requests++;
        const first = await tpdb.listPage('scene', { ...filter, page: 1 }, 100, signal);
        // cost model: paging through `lastPage` pages must beat ~2 requests per file for the files that can match
        if (first.lastPage > maxPages || first.lastPage > Math.max(2, group.files.length * 2))
            return empty(`scene list too large (${first.total} scenes)`, requests);
        items = [...first.data];
        const pages = Array.from({ length: first.lastPage - 1 }, (_, i) => i + 2);
        for (let i = 0; i < pages.length; i += conc) {
            await deps.gate?.();
            if (signal?.aborted)
                throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            const chunk = pages.slice(i, i + conc);
            requests += chunk.length;
            const res = await Promise.all(chunk.map((pg) => tpdb.listPage('scene', { ...filter, page: pg }, 100, signal)));
            for (const r of res)
                items.push(...r.data);
        }
        const seenIds = new Set();
        items = items.filter((x) => { const id = String(x.id ?? x._id); if (seenIds.has(id))
            return false; seenIds.add(id); return true; });
        deps.lists?.set(group.key, items);
    }
    const scenes = items.map((x) => ({ x, c: toCandidate(x, 'scene'), studioKeys: candStudioKeys(x) }));
    const idx = indexScenes(scenes, group.kind === 'performer' ? new Set(tokens(group.name)) : new Set());
    const matched = [];
    const leftover = [];
    let n = 0;
    for (const f of group.files) {
        const m = matchLocally(f, scenes, idx, deps.threshold, group.kind === 'performer' ? { performer: group.name } : undefined);
        if (m)
            matched.push(m);
        else
            leftover.push(f);
        if (++n % 25 === 0)
            await new Promise((r) => setImmediate(r)); // keep the event loop (web UI) responsive
    }
    return { matched, leftover, scenes: scenes.length, requests };
}
