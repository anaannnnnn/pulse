// StashDB candidate source for the matching cascade. It runs in PARALLEL with the ThePornDB stages (see runCascade) and feeds the same
// candidate pool, so both providers are scored by the same function. Inside the stage, independent queries are issued concurrently:
//   wave 1: stored fingerprint (if the file already has an OSHASH) | title text searches | studio lookup | performer lookup
//   wave 2: studio+date / studio+title | performer scenes (date, title, plain list) | date+word
//   wave 3: word-by-word progressive variants
//   wave 4: OSHASH of the file (pCloud ranged reads), last resort only
import type { NormScene } from '../clients/provider.js';
import type { StashDbClient, StashFingerprints } from '../clients/stashdb.js';
import { keyOf, norm, tokens } from '../text.js';

export type StashStageCtx = {
  stash: StashDbClient;
  manual: boolean;
  signal: AbortSignal;
  budget: number;
  studioHints: string[]; folderHints: string[];
  rawWords: string[]; titleWords: () => string[];
  date: string | null;
  perfNames: () => string[];
  fingerprints: StashFingerprints;
  /** Computes (and memoises) the OSHASH of the file; only called as the last resort. */
  getHash?: () => Promise<string | null>;
  add: (label: string, scenes: NormScene[]) => void;
  done: () => boolean;
  note: (line: string) => void;
  learnStudio: (name: string) => void;
  learnPerformer: (name: string) => void;
};

const looksName = (s: string) => { const t = s.trim().split(/\s+/); return t.length >= 1 && t.length <= 3 && t.every((w) => /^[A-Za-z'’.-]{2,}$/.test(w)); };
const rank = (ws: string[]) => [...new Set(ws)].sort((a, b) => b.length - a.length);

export async function runStashStage(c: StashStageCtx): Promise<number> {
  let queries = 0;
  const memo = new Set<string>();
  const stop = () => c.signal.aborted || c.done();
  /** One guarded query: budgeted, memoised, never throws except for auth/config errors. */
  async function q(label: string, key: string, fn: () => Promise<NormScene[]>): Promise<NormScene[]> {
    // A fingerprint lookup is one exact request and the most reliable signal, so it never competes for the search budget.
    if (stop() || (label !== 'hash' && queries >= c.budget) || memo.has(key)) return [];
    memo.add(key); queries++;
    c.note(`stashdb ${label}`);
    try {
      const r = await fn();
      if (!c.signal.aborted) c.add(label, r);
      return r;
    } catch (e: any) {
      if (e?.code === 'stashdb_auth' || e?.code === 'stashdb_not_configured') throw e;
      return [];
    }
  }
  const { stash } = c;
  const opts = { signal: c.signal };
  const tw = c.titleWords().join(' ');
  const full = c.rawWords.join(' ').trim();

  // ---- resolve studio / performer ids (cached), concurrently with the text searches
  const studioCandidates = [...new Set([...c.studioHints.slice(0, 2), ...(c.manual ? [] : c.folderHints.slice(0, 1))])].filter(Boolean);
  const names: string[] = [];
  const addName = (n: string) => { const t = n.trim(); if (t && !names.some((x) => keyOf(x) === keyOf(t))) names.push(t); };
  c.perfNames().forEach(addName);
  c.folderHints.filter(looksName).forEach(addName);
  const rw = c.rawWords.filter((w) => !c.studioHints.some((h) => keyOf(h) === keyOf(w)));
  const starts = new Set<number>([0, 1, 2]);
  rw.forEach((w, i) => { if (/^(and|x|with)$/i.test(w)) starts.add(i + 1); });
  for (const st of [...starts].sort((a, b) => a - b)) for (const n of [2, 3]) {
    const win = rw.slice(st, st + n);
    if (win.length === n && win.every((w) => /^[A-Za-z'’-]{3,}$/.test(w) && !/^(and|the|with|her|his|for)$/i.test(w))) addName(win.join(' '));
  }

  const resolveStudio = async (hint: string) => {
    const k = keyOf(hint);
    const variants = [...new Set([hint, hint.replace(/([a-z])([A-Z])/g, '$1 $2'), hint.replace(/\.(com|net|org|xxx)$/i, '')])].slice(0, 2);
    for (const v of variants) {
      const items = await (async () => {
        if (stop() || queries >= c.budget) return null;
        queries++; c.note(`stashdb studio-lookup: ${v}`);
        try { return await stash.searchStudios(v, 8); } catch (e: any) { if (e?.code === 'stashdb_auth' || e?.code === 'stashdb_not_configured') throw e; return null; }
      })();
      if (!items) continue;
      const exact = items.find((s: any) => keyOf(s.name) === k || (s.aliases || []).some((a: string) => keyOf(a) === k));
      const near = items.filter((s: any) => k.length >= 4 && keyOf(s.name).startsWith(k)).sort((a: any, b: any) => a.name.length - b.name.length)[0];
      const hit = exact || near;
      if (hit) { c.learnStudio(hit.name); return hit as { id: string; name: string }; }
    }
    return null;
  };
  const resolvePerformers = async () => {
    const out: { id: string; name: string }[] = [];
    let lookups = 0;
    for (const n of names) {
      if (lookups >= 4 || out.length >= 3 || stop() || queries >= c.budget) break;
      lookups++; queries++; c.note(`stashdb performer-lookup: ${n}`);
      let items: any[] = [];
      try { items = await stash.searchPerformers(n, 6); } catch (e: any) { if (e?.code === 'stashdb_auth' || e?.code === 'stashdb_not_configured') throw e; continue; }
      const k = keyOf(n);
      const hit = items.find((p) => keyOf(p.name) === k || p.aliases.some((a: string) => keyOf(a) === k));
      if (hit && !out.some((x) => x.id === hit.id)) { out.push({ id: hit.id, name: hit.name }); c.learnPerformer(hit.name); }
    }
    return out;
  };

  // ---- wave 1
  const textQueries: string[] = [];
  const pushText = (t: string) => { const v = t.trim(); if (v && !textQueries.some((x) => norm(x) === norm(v))) textQueries.push(v); };
  pushText(full); pushText(tw);
  if (!c.manual && c.studioHints[0] && tw) pushText(`${c.studioHints[0]} ${tw}`);
  const w1: Promise<any>[] = [];
  const fpKnown = c.fingerprints;
  if (!c.manual && (fpKnown.oshash || fpKnown.md5 || fpKnown.phash)) w1.push(q('hash', `fp:${JSON.stringify(fpKnown)}`, () => stash.byFingerprints(fpKnown, opts)));
  // Bulk runs keep one free-text guess so the precise studio/performer lookups (and wave 2) get the rest of the small budget.
  for (const t of textQueries.slice(0, c.manual ? 3 : 1)) w1.push(q('title', `t:${norm(t)}`, () => stash.searchScenes(t, 15, opts)));
  const studiosP = Promise.all(studioCandidates.map((h) => resolveStudio(h)));
  const perfsP = resolvePerformers();
  const [, studios0, perfs] = await Promise.all([Promise.all(w1), studiosP, perfsP]);
  const studios = (studios0 as ({ id: string; name: string } | null)[]).filter((s): s is { id: string; name: string } => !!s);
  if (stop()) return queries;

  // ---- wave 2
  const w2: Promise<any>[] = [];
  for (const s of studios) {
    if (c.date) w2.push(q('studio+date', `sd:${s.id}:${c.date}`, () => stash.queryScenes({ studios: [s.id], date: c.date!, perPage: 25 }, opts)));
    if (tw) w2.push(q('studio+title', `st:${s.id}:${norm(tw)}`, () => stash.queryScenes({ studios: [s.id], text: tw, perPage: 15 }, opts)));
    if (c.date && tw) w2.push(q('studio+title', `sdt:${s.id}:${c.date}:${norm(tw)}`, () => stash.queryScenes({ studios: [s.id], date: c.date!, text: tw.split(' ').slice(0, 3).join(' '), perPage: 15 }, opts)));
  }
  for (const p of perfs) {
    const rest = c.titleWords().filter((w) => !tokens(p.name).includes(w));
    if (c.date) w2.push(q('performer', `pd:${p.id}:${c.date}`, () => stash.queryScenes({ performers: [p.id], date: c.date!, perPage: 15 }, opts)));
    if (rest.length) w2.push(q('performer', `pt:${p.id}:${rest.join(' ')}`, () => stash.queryScenes({ performers: [p.id], text: rest.join(' '), perPage: 15 }, opts)));
    w2.push(q('fuzzy', `pl:${p.id}`, () => stash.queryScenes({ performers: [p.id], perPage: 40 }, opts)));
  }
  if (perfs.length >= 2) w2.push(q('performer', `pall:${perfs.map((p) => p.id).join(',')}`, () => stash.queryScenes({ performers: perfs.map((p) => p.id), perPage: 25 }, opts)));
  if (c.date && !studios.length) for (const w of rank(c.titleWords()).slice(0, 2)) w2.push(q('studio+date', `dw:${c.date}:${w}`, () => stash.queryScenes({ date: c.date!, text: w, perPage: 15 }, opts)));
  await Promise.all(w2);
  if (stop()) return queries;

  // ---- wave 3: word-by-word progressive variants
  const tws = c.titleWords().length ? c.titleWords() : tokens(full);
  if (tws.length) {
    const variants: string[] = [];
    const push = (v: string) => { if (v && !variants.some((x) => norm(x) === norm(v))) variants.push(v); };
    for (let n = tws.length - 1; n >= Math.min(2, tws.length); n--) push(tws.slice(0, n).join(' '));
    for (let s = 1; s <= 2 && tws.length - s >= 2; s++) push(tws.slice(s).join(' '));
    const big: string[] = [];
    for (let i = 0; i < tws.length - 1; i++) big.push(`${tws[i]} ${tws[i + 1]}`);
    big.sort((a, b) => b.length - a.length).slice(0, 3).forEach(push);
    rank(tws).filter((w) => w.length >= 4).slice(0, 3).forEach(push);
    await Promise.all(variants.slice(0, 6).map((v) => q('words', `w:${norm(v)}`, () => stash.searchScenes(v, 15, opts))));
  }
  if (stop()) return queries;

  // ---- wave 4: computed fingerprint, last resort
  if (!c.manual && c.getHash && !fpKnown.oshash) {
    let h: string | null = null;
    try { h = await c.getHash(); } catch { h = null; }
    if (h) await q('hash', `fp:${h}`, () => stash.byFingerprints({ oshash: h }, opts));
  }
  return queries;
}
