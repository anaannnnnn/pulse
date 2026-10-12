// Multi-strategy ThePornDB matching cascade.
// Strategies run cheapest/most-precise first and stop at the first confident result:
//   parse, title (exact normalised title) -> studio+date / studio+title (TPDB site lookup + filters) -> performer (lookup, then their scenes)
//   -> words (progressive word-by-word variants) -> fuzzy (Levenshtein/Dice over narrowed lists) -> movie / jav endpoints -> hash (optional).
// Every candidate in the pool is (re)scored after each query with: weighted token overlap (rarity weighted), fuzzy title similarity,
// date / studio / performer / duration bonuses. All HTTP goes through TpdbClient, which caches every query in the db.
import { pickImage, FATAL_TPDB } from '../clients/tpdb.js';
import { parseFilename, splitPerformers } from '../parser.js';
import { fuzzySim, keyOf, norm, sigTokens, tick, tokenEq, tokens } from '../text.js';
import { toEngineShape } from '../clients/stashdb.js';
import { runStashStage } from './stashStage.js';
export function toCandidate(x, type) {
    return {
        tpdbId: String(x.id ?? x._id), type, title: x.title || '', date: x.date || null,
        studio: x.site?.name || null, performers: (x.performers || []).map((p) => p.name).filter(Boolean),
        poster: pickImage(x, 'posters', 'poster', 'image', 'background'), duration: x.duration ?? null, url: x.url || null,
    };
}
const dayDiff = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;
const isoOk = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null);
const looksName = (s) => { const t = s.trim().split(/\s+/); return t.length >= 1 && t.length <= 3 && t.every((w) => /^[A-Za-z'’.-]{2,}$/.test(w)); };
export function buildProfile(input) {
    const p = input.parsed;
    const manual = input.query != null;
    const rawWords = manual ? tokens(input.query) : (p.words?.length ? p.words : (p.studio || p.date || p.jav) ? [] : tokens(p.cleanTitle || p.title || p.query));
    const studioKeys = new Set();
    (p.studioHints || []).forEach((h) => { const k = keyOf(h); if (k.length >= 3)
        studioKeys.add(k); });
    if (p.studio)
        studioKeys.add(keyOf(p.studio));
    const folderStudioKeys = new Set();
    (p.folderHints || []).forEach((h) => { const k = keyOf(h); if (k.length >= 3 && !studioKeys.has(k))
        folderStudioKeys.add(k); });
    const words = sigTokens(rawWords.join(' ')).filter((t) => !studioKeys.has(t));
    return {
        words, rawWords: rawWords.map((w) => String(w)), title: (manual ? input.query : p.title && p.title !== p.jav ? p.title : p.cleanTitle || rawWords.join(' ')) || '',
        date: p.date, year: p.year, jav: p.jav, studioKeys, folderStudioKeys, perfNames: [...p.performers], duration: input.duration ?? null,
    };
}
/**
 * Memoised "score the whole pool, resolve ties, sort". The cascade asks "are we confident yet?" after every query / stage; scores only change
 * when the pool or the profile's studio keys change, so unchanged state returns the previous result instead of re-scoring every candidate.
 */
export function makeScorer(pool, prof, threshold) {
    let sig = '', last = [];
    return () => {
        let hh = 0;
        for (const p of pool.values())
            if (p.hashHit)
                hh++;
        const s = `${pool.size}|${hh}|${prof.studioKeys.size}|${prof.folderStudioKeys.size}|${prof.words.length}|${prof.perfNames.length}`;
        if (s !== sig) {
            const arr = [...pool.values()];
            scorePool(arr, prof);
            resolveAmbiguity(arr, prof, threshold);
            last = arr.sort((a, b) => b.conf - a.conf);
            sig = s;
        }
        return last.slice();
    };
}
export function candStudioKeys(x) {
    const s = x.site || {};
    return [s.name, s.short_name, s.parent?.name, s.network?.name].filter(Boolean).map((v) => keyOf(v)).filter(Boolean);
}
/** Scores every pooled candidate (0..1) against the profile. Mutates `conf`. */
export function scorePool(pool, prof) {
    const N = pool.length;
    const allToks = pool.map((p) => (p._t ||= new Set([...tokens(p.c.title), ...p.c.performers.flatMap((n) => tokens(n)), ...tokens(p.c.studio)]))); // candidate tokens never change: computed once per candidate
    const df = new Map();
    for (const s of allToks)
        for (const t of s)
            df.set(t, (df.get(t) || 0) + 1);
    const weight = (t) => {
        const base = Math.min(1.4, 0.6 + t.length / 8) * (/^\d+$/.test(t) ? 0.7 : 1);
        if (N < 4)
            return base;
        const d = (df.get(t) || 0) / N;
        return base * (0.45 + 0.55 * (1 - d));
    };
    const has = (set, t) => set.some((u) => tokenEq(t, u));
    const fileTokWeights = prof.words.map((t) => ({ t, w: weight(t) }));
    const fileAll = [...prof.words, ...prof.studioKeys, ...tokens(prof.perfNames.join(' ')), ...prof.rawWords.map((w) => norm(w))];
    const fileSum = fileTokWeights.reduce((a, b) => a + b.w, 0);
    const profTitle = prof.title ? prof.title.replace(prof.perfNames.join(' '), '') : '';
    const tn = norm(prof.title || '');
    pool.forEach((p, i) => {
        const c = p.c;
        const candTitle = (p._ct ||= sigTokens(c.title));
        const candAll = (p._ca ||= [...allToks[i]]);
        // coverage of file words by candidate (title+performers+studio), and of candidate title by file
        const fc = fileSum ? fileTokWeights.reduce((a, b) => a + (has(candAll, b.t) ? b.w : 0), 0) / fileSum : 0;
        const ctSum = candTitle.reduce((a, t) => a + weight(t), 0);
        const tc = ctSum ? candTitle.reduce((a, t) => a + (has(fileAll, t) ? weight(t) : 0), 0) / ctSum : (candTitle.length ? 0 : 1);
        const sim = fc && tc ? (2 * fc * tc) / (fc + tc) : 0;
        const fz = prof.title ? (p._fzk === profTitle ? p._fz : (p._fzk = profTitle, p._fz = fuzzySim(profTitle, c.title))) : 0; // title similarity is the dearest part: memoised per candidate
        let titleScore = Math.max(sim, 0.92 * fz);
        // the whole (distinctive, >=3 words) candidate title is contained in the file name: extra words in the file are just noise
        if (tc >= 0.95 && candTitle.length >= 3)
            titleScore = Math.max(titleScore, 0.88);
        // the candidate title equals the file's title part exactly (after normalisation): the strongest title evidence there is
        const exactTitle = !!tn && tn.split(' ').length >= 2 && !prof.perfNames.some((n) => norm(n) === tn) && norm(c.title) === tn;
        if (exactTitle && candTitle.length >= 2)
            titleScore = Math.max(titleScore, 1);
        // date
        const cd = isoOk(c.date);
        let dateScore = 0, dateMismatch = false;
        if (prof.date && cd) {
            const dd = dayDiff(prof.date, cd);
            if (dd === 0)
                dateScore = 1;
            else if (dd <= 1)
                dateScore = 0.85;
            else if (dd <= 3)
                dateScore = 0.5;
            else if (prof.date.slice(0, 7) === cd.slice(0, 7)) {
                dateScore = 0.15;
                dateMismatch = true;
            }
            else
                dateMismatch = true;
        }
        else if (prof.year && cd) {
            dateScore = Number(cd.slice(0, 4)) === prof.year ? 0.6 : 0;
        }
        // studio
        let studioScore = 0;
        const hintKeys = [...prof.studioKeys];
        const folderKeys = [...prof.folderStudioKeys];
        const matchKeys = (keys) => {
            let best = 0;
            for (const a of keys)
                for (const b of p.studioKeys) {
                    if (!a || !b)
                        continue;
                    if (a === b)
                        best = Math.max(best, 1);
                    else if (Math.min(a.length, b.length) >= 5 && (a.includes(b) || b.includes(a)))
                        best = Math.max(best, 0.8);
                }
            return best;
        };
        if (hintKeys.length)
            studioScore = matchKeys(hintKeys);
        const folderScore = !studioScore && folderKeys.length ? matchKeys(folderKeys) : 0;
        // performers
        const cpKeys = (p._ck ||= c.performers.map((n) => keyOf(n)));
        const cpToks = (p._cpt ||= c.performers.map((n) => tokens(n)));
        let perfScore = 0, perfSignal = false;
        if (prof.perfNames.length) {
            perfSignal = true;
            const hits = prof.perfNames.filter((n) => { const k = keyOf(n); return cpKeys.includes(k) || cpKeys.some((x) => x && k && (x.includes(k) || k.includes(x)) && Math.min(x.length, k.length) >= 5) || (tokens(n).length > 0 && cpToks.some((ts) => tokens(n).every((t) => ts.includes(t)))); }).length;
            perfScore = hits / prof.perfNames.length;
        }
        // implicit performer evidence: a candidate performer's full name appears in the file words
        const implicit = cpToks.filter((ts) => ts.length >= 2 && ts.every((t) => has(prof.words, t) || prof.words.some((w) => tokenEq(w, t)))).length;
        if (implicit) {
            perfSignal = true;
            perfScore = Math.max(perfScore, Math.min(1, implicit / Math.max(1, Math.min(2, c.performers.length))));
        }
        // JAV code
        let javScore = 0;
        if (prof.jav) {
            const code = prof.jav.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
            const hay = [c.title, p.x.external_id, p.x.sku, p.x.slug, p.x.url].filter(Boolean).join(' ').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
            javScore = hay.includes(code) ? 1 : 0;
        }
        // duration
        let durScore = 0, durSignal = false;
        if (prof.duration && c.duration) {
            durSignal = true;
            const d = Math.abs(prof.duration - c.duration);
            durScore = d < 30 ? 1 : d < 120 ? 0.5 : 0;
        }
        const parts = [];
        if (prof.words.length)
            parts.push([0.5, titleScore]);
        if (prof.date)
            parts.push([0.25, dateScore]);
        else if (prof.year)
            parts.push([0.05, dateScore]);
        if (hintKeys.length)
            parts.push([0.12, studioScore]);
        else if (folderKeys.length)
            parts.push([0.04, folderScore]);
        if (perfSignal)
            parts.push([0.18, perfScore]);
        if (prof.jav)
            parts.push([0.7, javScore]);
        if (durSignal)
            parts.push([0.05, durScore]);
        const wsum = parts.reduce((a, b) => a + b[0], 0);
        let conf = wsum ? parts.reduce((a, b) => a + b[0] * b[1], 0) / wsum : 0;
        // decisive evidence boosts / penalties
        if (prof.date && dateScore >= 0.85 && titleScore >= 0.5)
            conf = Math.max(conf, 0.86);
        if (prof.date && dateScore >= 0.85 && studioScore >= 0.8 && (titleScore >= 0.3 || perfScore >= 0.5))
            conf = Math.max(conf, 0.86);
        if (!prof.date && titleScore >= 0.9 && prof.words.length >= 3)
            conf = Math.max(conf, 0.8);
        if (exactTitle && candTitle.length >= 2 && !dateMismatch)
            conf = Math.max(conf, perfScore >= 0.5 ? 0.88 : 0.8);
        if (prof.jav && javScore)
            conf = Math.max(conf, 0.9);
        // several performers named in the file (full names) + some title overlap is strong evidence even without a date/studio
        const k = prof.perfNames.length >= 2 && perfScore >= 0.99 ? prof.perfNames.length : implicit;
        if (k >= 2 && titleScore >= 0.3 && !dateMismatch)
            conf = Math.max(conf, Math.min(0.95, 0.5 + 0.08 * k + 0.35 * titleScore));
        if (dateMismatch && prof.date)
            conf *= 0.75;
        if (prof.words.length <= 1 && !prof.date && !prof.jav && !studioScore && !perfScore)
            conf = Math.min(conf, 0.6);
        if (p.hashHit)
            conf = Math.max(conf, 0.97);
        p.conf = Math.round(Math.min(1, Math.max(0, conf)) * 1000) / 1000;
        if (studioScore === 1)
            p.conf = Math.min(1, p.conf + (hintKeys.includes(keyOf(c.studio)) ? 0.002 : 0.001)); // prefer the exact studio over its network/sub-sites in ties
    });
}
/** Caps confidence when several different scenes tie and nothing decisive separates them. */
export function resolveAmbiguity(pool, prof, threshold) {
    const sorted = [...pool].sort((a, b) => b.conf - a.conf);
    const top = sorted[0];
    if (!top || top.hashHit)
        return;
    // the same release listed twice (e.g. on the performer's own site and on a clip store: same title and performers, dates within ~2 months) is not ambiguity
    const permKey = (x) => x.c.performers.map((n) => keyOf(n)).sort().join('|');
    const same = (a, b) => norm(a.c.title) === norm(b.c.title) && ((a.c.date || '') === (b.c.date || '') || (!!permKey(a) && permKey(a) === permKey(b) && !!a.c.date && !!b.c.date && dayDiff(a.c.date.slice(0, 10), b.c.date.slice(0, 10)) <= 60));
    const rivals = sorted.slice(1).filter((o) => o.conf >= top.conf - 0.03 && !same(top, o));
    if (!rivals.length)
        return;
    const decisive = !!prof.jav || (!!prof.date && top.c.date === prof.date && rivals.every((r) => r.c.date !== prof.date));
    if (decisive)
        return;
    const cap = Math.max(0, threshold - 0.02);
    for (const o of sorted)
        if (o.conf >= top.conf - 0.03 && o.conf > cap)
            o.conf = cap; // the whole tie group needs human review
}
export async function runCascade(tpdb, input) {
    const prof = buildProfile(input);
    const manual = input.query != null;
    const budget = input.budget ?? (manual ? 14 : 22);
    const pool = new Map();
    const memo = new Set();
    const tried = [];
    let queries = 0;
    const siteCache = new Map();
    const types = input.types?.length ? input.types : ['scene'];
    const exhaustive = manual;
    const errs = [];
    let okQueries = 0;
    const useTpdb = input.useTpdb !== false;
    // the OSHASH (two ranged reads) is computed at most once per match and shared by the TPDB and StashDB hash lookups
    let hashP = null;
    const getHash = input.hash ? () => (hashP ??= input.hash().then((h) => { if (h)
        input.onHash?.(h); return h; }).catch(() => null)) : undefined;
    /** Records a failed TPDB call. Fatal ones (bad key, not configured, blocked) abort the whole match; others fall through to the next query/strategy. */
    const note = (e) => {
        if (FATAL_TPDB.has(e?.code))
            throw e;
        if (e?.code === 'not_found') {
            okQueries++;
            return;
        }
        errs.push({ code: String(e?.code || 'error'), message: String(e?.message || e) });
    };
    const broken = () => errs.length >= 3 && okQueries === 0; // TPDB is unreachable/limiting: stop burning requests on this file
    const scored = makeScorer(pool, prof, input.threshold);
    const confident = () => { if (exhaustive)
        return false; const s = scored(); return !!s[0] && s[0].conf >= input.threshold; };
    const done = () => queries >= budget || !!input.shouldStop?.() || confident();
    async function run(label, type, params, perPage = 15, marker) {
        const k = `${type}|${JSON.stringify(params)}|${perPage}`;
        if (memo.has(k) || queries >= budget)
            return 0;
        memo.add(k);
        queries++;
        tried.push(`${label}: ${type} ${Object.entries(params).map(([a, b]) => `${a}=${b}`).join('&')}`);
        let items = [];
        try {
            items = await tpdb.list(type, params, perPage);
            okQueries++;
        }
        catch (e) {
            note(e);
            items = [];
        }
        await tick(); // let pending HTTP requests of the app run between matcher CPU slices
        let added = 0;
        for (const x of items) {
            const c = toCandidate(x, type);
            const key = `${type}:${c.tpdbId}`;
            if (!pool.has(key)) {
                pool.set(key, { key, type, x, c, studioKeys: candStudioKeys(x), foundBy: label, conf: 0 });
                added++;
            }
            marker?.(pool.get(key));
        }
        return items.length;
    }
    // ---------- helpers: site + performer lookup (cached by TpdbClient) ----------
    async function findSite(hint) {
        const k = keyOf(hint);
        if (siteCache.has(k))
            return siteCache.get(k);
        let found = null;
        const variants = [...new Set([hint, hint.replace(/([a-z])([A-Z])/g, '$1 $2'), hint.replace(/\.(com|net|org|xxx)$/i, '')])];
        for (const v of variants) {
            if (queries >= budget)
                break;
            queries++;
            tried.push(`site-lookup: ${v}`);
            let items = [];
            try {
                items = await tpdb.searchSites(v);
                okQueries++;
            }
            catch (e) {
                note(e);
            }
            const exact = items.find((s) => keyOf(s.name) === k || keyOf(s.short_name) === k || keyOf(s.slug) === k);
            const near = items.filter((s) => keyOf(s.name).startsWith(k) && k.length >= 4).sort((a, b) => String(a.name).length - String(b.name).length)[0];
            found = exact || near || null;
            if (found)
                break;
        }
        siteCache.set(k, found);
        return found;
    }
    async function findPerformer(name) {
        if (queries >= budget)
            return null;
        queries++;
        tried.push(`performer-lookup: ${name}`);
        let items = [];
        try {
            items = await tpdb.searchPerformers(name);
            okQueries++;
        }
        catch (e) {
            note(e);
        }
        const k = keyOf(name);
        return items.find((p) => keyOf(p.name) === k) || items.find((p) => (p.aliases || []).some((a) => keyOf(a) === k)) || null;
    }
    const titleWords = () => prof.words.filter((w) => !prof.perfNames.some((n) => tokens(n).includes(w)));
    const sceneTypes = types.filter((t) => t === 'scene');
    const first = types.includes('scene') ? 'scene' : types[0];
    const stages = [];
    const stage = (name, fn) => stages.push({ name, fn });
    // ---- JAV code first (very precise)
    if (prof.jav && !manual) {
        stage('jav', async () => {
            const code = prof.jav;
            for (const q of [code, code.replace(/-/g, ' ')]) {
                await run('jav', 'jav', { q }, 10);
                if (confident())
                    return;
            }
            await run('jav', 'scene', { q: code }, 10);
        });
    }
    // ---- (a) parse + exact normalised title
    stage('title', async () => {
        if (!manual && !prof.jav) {
            const rawBase = input.fileName.replace(/\.[A-Za-z0-9]{2,5}$/, '');
            if (!/\s/.test(rawBase) || input.parsed.date)
                await run('parse', first, { parse: rawBase }, 10);
            if (done())
                return;
            if (input.parsed.query && input.parsed.query !== rawBase) {
                await run('parse', first, { parse: input.parsed.query }, 10);
                if (done())
                    return;
            }
        }
        const full = prof.rawWords.join(' ').trim();
        if (full)
            for (const t of types) {
                await run(manual ? 'query' : 'title', t, { q: full }, 15);
                if (done())
                    return;
            }
        const tw = titleWords().join(' ');
        if (tw && tw !== norm(full)) {
            await run('title', first, { q: tw }, 15);
            if (done())
                return;
        }
        if (prof.date && prof.words.length) {
            await run('title', first, { q: titleWords().join(' ') || full, date: prof.date }, 15);
        }
    });
    // ---- (b) studio + date / studio + title, using TPDB site lookup and filters
    stage('studio', async () => {
        if (!sceneTypes.length)
            return;
        const hints = [...(input.parsed.studioHints || [])].filter((h, i, a) => a.findIndex((x) => keyOf(x) === keyOf(h)) === i);
        const folder = (input.parsed.folderHints || []).filter((h) => !hints.some((x) => keyOf(x) === keyOf(h)));
        const cand = [...hints.slice(0, 2), ...folder.slice(0, 2)];
        if (!cand.length && !prof.date)
            return;
        const tw = titleWords().join(' ');
        for (const h of cand) {
            const site = await findSite(h);
            if (!site)
                continue;
            const fromFolder = !hints.includes(h);
            if (fromFolder)
                prof.folderStudioKeys.add(keyOf(site.name));
            else
                prof.studioKeys.add(keyOf(site.name));
            const sid = site.id;
            if (prof.date) {
                await run('studio+date', 'scene', { site_id: sid, date: prof.date }, 25);
                if (done())
                    return;
            }
            if (tw) {
                await run('studio+title', 'scene', { site_id: sid, q: tw }, 15);
                if (done())
                    return;
            }
            if (prof.date && tw) {
                await run('studio+title', 'scene', { site_id: sid, date: prof.date, q: tw.split(' ').slice(0, 3).join(' ') }, 15);
                if (done())
                    return;
            }
            if (tw) {
                await run('studio+title', 'scene', { q: `${site.name} ${tw}` }, 15);
                if (done())
                    return;
            }
        }
        // unknown studio but a date: date + key words
        if (!cand.length && prof.date) {
            for (const w of rankWords(titleWords()).slice(0, 2)) {
                await run('studio+date', 'scene', { date: prof.date, q: w }, 15);
                if (done())
                    return;
            }
        }
    });
    // ---- (c) performers: resolve names, then their scenes
    stage('performer', async () => {
        if (!sceneTypes.length)
            return;
        const names = [];
        const add = (n) => { const t = n.trim(); if (t && !names.some((x) => keyOf(x) === keyOf(t)))
            names.push(t); };
        prof.perfNames.forEach(add);
        (input.parsed.folderHints || []).filter(looksName).forEach(add);
        // windows over the first words: "First Last", "First Middle Last", also after "and"
        const rw = prof.rawWords.filter((w) => !prof.studioKeys.has(keyOf(w)));
        const starts = new Set([0, 1, 2]);
        rw.forEach((w, i) => { if (/^(and|x|with)$/i.test(w))
            starts.add(i + 1); });
        for (const st of [...starts].sort((a, b) => a - b))
            for (const n of [2, 3]) {
                const win = rw.slice(st, st + n);
                if (win.length === n && win.every((w) => /^[A-Za-z'’-]{3,}$/.test(w) && !/^(and|the|with|her|his|for)$/i.test(w)))
                    add(win.join(' '));
            }
        const resolved = [];
        let lookups = 0;
        for (const n of names) {
            if (lookups >= 5 || resolved.length >= 3 || queries >= budget)
                break;
            lookups++;
            const p = await findPerformer(n);
            if (p) {
                resolved.push(p);
                if (!prof.perfNames.some((x) => keyOf(x) === keyOf(p.name)))
                    prof.perfNames.push(p.name);
            }
        }
        if (!resolved.length)
            return;
        // remove performer tokens from the title words so the title query is cleaner
        const site = [...prof.studioKeys].length ? await findSite([...(input.parsed.studioHints || [])][0] || '') : null;
        for (const p of resolved) {
            const pid = p._id ?? p.id;
            if (prof.date) {
                await run('performer', 'scene', { performer_id: pid, date: prof.date }, 15);
                if (done())
                    return;
            }
            const tw = titleWords().filter((w) => !tokens(p.name).includes(w));
            if (tw.length) {
                await run('performer', 'scene', { performer_id: pid, q: tw.join(' ') }, 15);
                if (done())
                    return;
            }
            if (tw.length > 1) {
                await run('performer', 'scene', { performer_id: pid, q: rankWords(tw)[0] }, 15);
                if (done())
                    return;
            }
            if (site) {
                await run('performer', 'scene', { performer_id: pid, site_id: site.id }, 25);
                if (done())
                    return;
            }
        }
    });
    // ---- (d) word-by-word progressive variants
    stage('words', async () => {
        const tw = (titleWords().length ? titleWords() : prof.words);
        if (!tw.length)
            return;
        const variants = [];
        const push = (v) => { if (v && !variants.includes(v))
            variants.push(v); };
        push(tw.join(' '));
        for (let n = tw.length - 1; n >= Math.min(2, tw.length); n--)
            push(tw.slice(0, n).join(' ')); // drop trailing
        for (let s = 1; s <= 2 && tw.length - s >= 2; s++)
            push(tw.slice(s).join(' ')); // drop leading (studio/performer first names)
        if (tw.length > 3)
            push(tw.slice(1, -1).join(' '));
        const big = [];
        for (let i = 0; i < tw.length - 1; i++)
            big.push(`${tw[i]} ${tw[i + 1]}`);
        big.sort((a, b) => b.length - a.length).slice(0, 4).forEach(push);
        const singles = rankWords(tw).filter((w) => w.length >= 4).slice(0, 4);
        if (prof.date)
            singles.slice(0, 3).forEach((w) => variants.push(`@date:${w}`));
        singles.forEach(push);
        for (const v of variants) {
            for (const t of (types.includes('scene') ? ['scene'] : types)) {
                if (v.startsWith('@date:'))
                    await run('words', t, { q: v.slice(6), date: prof.date }, 15);
                else
                    await run('words', t, { q: v }, 15);
                if (done())
                    return;
            }
        }
    });
    // ---- (e) fuzzy over narrowed lists (performer scenes / studio+year / date)
    stage('fuzzy', async () => {
        if (!sceneTypes.length)
            return;
        const resolvedPerf = prof.perfNames;
        for (const n of resolvedPerf.slice(0, 2)) {
            const p = await findPerformer(n);
            if (!p)
                continue;
            for (const page of [1, 2, 3]) {
                await run('fuzzy', 'scene', { performer_id: p._id ?? p.id, page }, 25);
                if (done())
                    return;
            }
        }
        const hint = (input.parsed.studioHints || [])[0];
        const site = hint ? await findSite(hint) : null;
        if (site) {
            if (prof.year) {
                for (const page of [1, 2]) {
                    await run('fuzzy', 'scene', { site_id: site.id, year: prof.year, page }, 25);
                    if (done())
                        return;
                }
            }
        }
        if (prof.date) {
            for (const page of [1, 2]) {
                await run('fuzzy', 'scene', { date: prof.date, page }, 25);
                if (done())
                    return;
            }
        }
    });
    // ---- movies / JAV endpoints (auto mode only; a user-chosen type is already covered by title/words)
    stage('other-endpoints', async () => {
        if (input.types?.length || manual)
            return;
        const tw = titleWords().join(' ') || prof.rawWords.join(' ');
        if (!tw)
            return;
        const vs = [...new Set([tw, ...rankWords(tw.split(' ')).slice(0, 2)])];
        for (const t of ['movie', 'jav']) {
            for (const v of vs) {
                await run(t, t, { q: v }, 10);
                if (done())
                    return;
            }
        }
    });
    // ---- (g) optional hash search
    stage('hash', async () => {
        if (!getHash || manual)
            return;
        let h = null;
        try {
            h = await getHash();
        }
        catch {
            h = null;
        } // hash step is best-effort: a failing/slow hash must never fail the match
        if (!h)
            return;
        queries++;
        tried.push(`hash: OSHASH ${h}`);
        let items = [];
        try {
            items = await tpdb.byHash(h, 'OSHASH');
            okQueries++;
        }
        catch (e) {
            note(e);
        }
        for (const x of items) {
            const c = toCandidate(x, 'scene');
            const key = `scene:${c.tpdbId}`;
            const ex = pool.get(key);
            if (ex) {
                ex.hashHit = true;
                ex.foundBy = ex.foundBy;
            }
            else
                pool.set(key, { key, type: 'scene', x, c, studioKeys: candStudioKeys(x), foundBy: 'hash', hashHit: true, conf: 0 });
        }
    });
    // ---- StashDB: second provider. Runs CONCURRENTLY with the ThePornDB stages and feeds the same candidate pool/scorer.
    const stashAbort = new AbortController();
    let stashQueries = 0;
    const addStash = (label, sc) => {
        const x = toEngineShape(sc);
        const c = { ...toCandidate(x, 'scene'), source: 'stashdb' };
        const key = `stashdb:scene:${c.tpdbId}`;
        const ex = pool.get(key);
        if (label === 'hash') {
            if (ex)
                ex.hashHit = true;
            else
                pool.set(key, { source: 'stashdb', key, type: 'scene', x, c, studioKeys: candStudioKeys(x), foundBy: 'hash', hashHit: true, conf: 0 });
            return;
        }
        if (!ex)
            pool.set(key, { source: 'stashdb', key, type: 'scene', x, c, studioKeys: candStudioKeys(x), foundBy: label, conf: 0 });
    };
    const stashTask = input.stash?.configured && types.includes('scene')
        ? (async () => {
            const hints = [...(input.parsed.studioHints || [])].filter((h, i, a) => a.findIndex((x) => keyOf(x) === keyOf(h)) === i);
            const folder = (input.parsed.folderHints || []).filter((h) => !hints.some((x) => keyOf(x) === keyOf(h)));
            try {
                stashQueries = await runStashStage({
                    stash: input.stash, manual, signal: stashAbort.signal, budget: manual ? 14 : 12,
                    studioHints: hints, folderHints: folder, rawWords: prof.rawWords, titleWords, date: prof.date, perfNames: () => [...prof.perfNames],
                    fingerprints: input.fingerprints || {}, getHash: manual ? undefined : getHash,
                    add: (label, scenes) => { okQueries++; for (const sc of scenes)
                        addStash(label, sc); },
                    done: () => !!input.shouldStop?.() || (!exhaustive && confident()),
                    note: (l) => tried.push(l),
                    learnStudio: (n) => (hints.length ? prof.studioKeys : prof.folderStudioKeys).add(keyOf(n)),
                    learnPerformer: (n) => { if (!prof.perfNames.some((x) => keyOf(x) === keyOf(n)))
                        prof.perfNames.push(n); },
                });
            }
            catch (e) {
                // a StashDB problem (bad key...) must never abort the ThePornDB result; it is reported in `errors`
                if (e?.name !== 'AbortError')
                    errs.push({ code: String(e?.code || 'stashdb_error'), message: String(e?.message || e) });
            }
        })()
        : null;
    // manual search with an explicit type restriction: no cross-endpoint stage
    const runStages = manual ? ['title', 'words', 'studio', 'performer'] : null;
    for (const s of stages) {
        if (!useTpdb)
            break;
        if (runStages && !runStages.includes(s.name))
            continue;
        if (input.shouldStop?.() || queries >= budget + 4 || broken())
            break;
        if (!exhaustive && confident())
            break;
        // one failing strategy must never abort the others: fatal TPDB errors propagate, everything else falls through to the next strategy
        try {
            await s.fn();
        }
        catch (e) {
            if (FATAL_TPDB.has(e?.code))
                throw e;
            errs.push({ code: 'strategy_error', message: `${s.name}: ${e?.message || e}` });
        }
        if (!exhaustive && confident())
            break;
    }
    if (stashTask) {
        if (input.shouldStop?.() || (!exhaustive && confident()))
            stashAbort.abort(); // already confident: don't wait for the slower provider
        await stashTask;
    }
    // Nothing could be searched at all -> surface the real reason instead of silently reporting "no match".
    if (okQueries === 0 && errs.length) {
        const first = errs[0];
        throw Object.assign(new Error(first.message), { code: first.code, statusCode: 502 });
    }
    const final = mergeProviders(scored());
    const candidates = final.slice(0, 20).map((p) => ({ ...p.c, source: p.source ?? 'tpdb', ...(p.alsoOn?.length ? { alsoOn: p.alsoOn } : {}), confidence: p.conf, matchedBy: p.hashHit ? 'hash' : p.foundBy }));
    const best = candidates[0] || null;
    const alternatives = candidates.slice(0, 5).map((c) => ({ tpdbId: c.tpdbId, type: c.type, title: c.title, date: c.date, studio: c.studio, performers: c.performers.slice(0, 4), poster: c.poster, confidence: c.confidence, matchedBy: c.matchedBy, source: c.source, ...(c.alsoOn?.length ? { alsoOn: c.alsoOn } : {}) }));
    return { candidates, alternatives, best, confident: !!best && best.confidence >= input.threshold, strategy: best?.matchedBy ?? null, queries: queries + stashQueries, tried, query: prof.rawWords.join(' '), errors: errs, queriesOk: okQueries };
}
/**
 * The same scene often exists on both providers. Collapse such duplicates (same normalised title + date) into the best-scoring one,
 * remembering the other provider's id in `alsoOn` (ties prefer ThePornDB). Input must be sorted best first; output keeps that order.
 */
export function mergeProviders(input) {
    // equal scores: ThePornDB first, whichever provider's answer happened to arrive first (arrival order is timing dependent)
    const sorted = [...input].sort((a, b) => b.conf - a.conf || Number((a.source ?? 'tpdb') !== 'tpdb') - Number((b.source ?? 'tpdb') !== 'tpdb'));
    const groups = new Map();
    const out = [];
    for (const p of sorted) {
        const src = p.source ?? 'tpdb';
        const t = norm(p.c.title);
        const k = `${p.type}|${t}|${isoOk(p.c.date) || ''}`;
        const twin = t ? (groups.get(k) || []).find((g) => (g.source ?? 'tpdb') !== src && !g.alsoOn?.some((a) => a.source === src)) : undefined;
        if (twin) {
            (twin.alsoOn ||= []).push({ source: src, id: p.c.tpdbId });
            if (p.hashHit)
                twin.hashHit = true;
            continue;
        }
        if (t)
            groups.set(k, [...(groups.get(k) || []), p]);
        out.push(p);
    }
    // equal scores: put the ThePornDB entry first (stable otherwise)
    return out.sort((a, b) => b.conf - a.conf || Number((a.source ?? 'tpdb') !== 'tpdb') - Number((b.source ?? 'tpdb') !== 'tpdb'));
}
/** Longest / most distinctive words first. */
function rankWords(ws) {
    return [...new Set(ws)].sort((a, b) => b.length - a.length);
}
export { splitPerformers, parseFilename };
