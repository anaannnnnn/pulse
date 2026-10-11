export function fmtTime(sec: number | null | undefined) {
  if (sec == null || !Number.isFinite(sec)) return '--:--';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
export function fmtDuration(sec: number | null | undefined) {
  if (!sec) return null;
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`;
}
export function fmtBytes(b: number | null | undefined) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${u[i]}`;
}
export function fmtDate(d: string | null | undefined) {
  if (!d) return null;
  const t = new Date(d.length === 10 ? `${d}T00:00:00` : d);
  return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
export function fmtRelative(ms: number | null | undefined) {
  if (!ms) return 'never';
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86400)} d ago`;
}
export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}
export function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
export function age(birthday: unknown) {
  if (typeof birthday !== 'string') return null;
  const b = new Date(birthday);
  if (Number.isNaN(b.getTime())) return null;
  const n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) a--;
  return a;
}
export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

const STRATEGY_LABELS: Record<string, string> = {
  parse: 'Filename parser',
  title: 'Exact title',
  'studio+date': 'Studio + date',
  'studio+title': 'Studio + title',
  performer: 'Performer',
  'performer-batch': 'Performer batch',
  'site-batch': 'Studio batch',
  words: 'Word-by-word',
  fuzzy: 'Fuzzy title',
  movie: 'Movies',
  jav: 'JAV code',
  hash: 'File hash',
  query: 'Your search',
  manual: 'Picked manually',
};
/** Human label for a matching strategy id returned by the server. */
export const strategyLabel = (s: string | null | undefined) => (s ? STRATEGY_LABELS[s] || s : '');

/** Display names of the metadata providers ('tpdb' | 'stashdb'). */
export const PROVIDER_LABEL: Record<string, string> = { tpdb: 'ThePornDB', stashdb: 'StashDB' };
export const providerLabel = (p: string | null | undefined) => (p ? PROVIDER_LABEL[p] || p : '');
