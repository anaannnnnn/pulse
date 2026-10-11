// Text utilities for matching: tokenising, stopwords, string similarity.

export const STOPWORDS = new Set(`a an the and or of in on at to for with from by my me her his their our your its it is are was were be this that these those i we you he she they them as into onto over under up down out off one two xxx video scene part pt vol hd full new first more all`.split(/\s+/));

const normRaw = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
// norm() was the top CPU consumer while matching (the same performer/studio/title strings are normalised thousands of times per file):
// memoise it (bounded; cleared wholesale when full).
const NORM_MAX = 40_000;
let normMemo = new Map<string, string>();
export const norm = (s: string | null | undefined): string => {
  const x = String(s ?? '');
  if (x.length > 400) return normRaw(x);
  let r = normMemo.get(x);
  if (r === undefined) { r = normRaw(x); if (normMemo.size >= NORM_MAX) normMemo = new Map(); normMemo.set(x, r); }
  return r;
};
/**
 * Cooperative scheduling for the matcher: its workers call `await tick()` between CPU-heavy slices (scoring a pool of candidates). Waiting workers are
 * released ONE PER EVENT-LOOP TURN, so with ten workers a loop turn costs ~one slice (tens of ms) instead of ten, and queued HTTP requests of the app
 * get their I/O turn in between. (Without this a request needed several loop turns of ~0.3-3 s each while matching ran.)
 */
const tickWaiters: Array<() => void> = [];
let tickPumping = false;
const tickPump = () => { tickWaiters.shift()?.(); if (tickWaiters.length) setImmediate(tickPump); else tickPumping = false; };
export const tick = () => new Promise<void>((r) => { tickWaiters.push(r); if (!tickPumping) { tickPumping = true; setImmediate(tickPump); } });

export const tokens = (s: string | null | undefined): string[] => norm(s).split(' ').filter(Boolean);
export const sigTokens = (s: string | null | undefined): string[] => tokens(s).filter((t) => !STOPWORDS.has(t) && (t.length > 1 || /\d/.test(t)));
export const keyOf = (s: string | null | undefined) => norm(s).replace(/ /g, '');

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const n = b.length;
  let prev = new Uint16Array(n + 1), cur = new Uint16Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i; const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const d = prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1), u = prev[j] + 1, l = cur[j - 1] + 1;
      cur[j] = d < u ? (d < l ? d : l) : (u < l ? u : l);
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[n];
}
/** 1 = identical, 0 = nothing in common. */
export function levRatio(a: string, b: string): number {
  const m = Math.max(a.length, b.length);
  return m ? 1 - levenshtein(a, b) / m : 1;
}
/** Sørensen–Dice coefficient on character bigrams. */
export function dice(a: string, b: string): number {
  const x = a.replace(/ /g, ''), y = b.replace(/ /g, '');
  if (x === y) return x ? 1 : 0;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) { const g = x.slice(i, i + 2); grams.set(g, (grams.get(g) || 0) + 1); }
  let inter = 0;
  for (let i = 0; i < y.length - 1; i++) { const g = y.slice(i, i + 2); const c = grams.get(g) || 0; if (c > 0) { grams.set(g, c - 1); inter++; } }
  return (2 * inter) / (x.length + y.length - 2);
}
export const fuzzySim = (a: string, b: string) => { const x = norm(a), y = norm(b); return x && y ? Math.max(dice(x, y), levRatio(x.replace(/ /g, ''), y.replace(/ /g, ''))) : 0; };

/** Do two tokens count as the same word (exact, plural/stem, or 1-edit typo for longer words)? */
export function tokenEq(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.min(la, lb) >= 4) {
    if (a + 's' === b || b + 's' === a) return true;
    if (Math.min(la, lb) >= 6 && Math.abs(la - lb) <= 1 && levenshtein(a, b) <= 1) return true;
  }
  return false;
}
