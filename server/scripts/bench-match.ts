// Benchmark: runs the real matcher against real ThePornDB on a COPY of a library db (never touches the original).
//   TPDB_API_KEY=... tsx scripts/bench-match.ts [--db data-demo-db] [--n 100] [--label after] [--concurrency N] [--warm]
// Prints files/min, matched/failed, request counts. The API key is never printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const arg = (k: string, d?: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.resolve(arg('db', '/workspace/pulse-app/server/data-demo-db')!);
const N = Number(arg('n', '100'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-bench-'));
for (const f of ['pulse.db', 'pulse.db-wal', 'pulse.db-shm', 'secret.key']) if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(tmp, f));
process.env.DATA_DIR = tmp;
if (!process.env.TPDB_API_KEY) { console.error('TPDB_API_KEY not set'); process.exit(2); }

const { buildApp } = await import('../src/app.js');
let calls = 0, status429 = 0, maxInflight = 0, inflight = 0;
const realFetch = fetch;
const counting: typeof fetch = (async (input: any, init?: any) => {
  const u = String(input);
  if (!u.includes('theporndb')) return realFetch(input, init);
  calls++; inflight++; maxInflight = Math.max(maxInflight, inflight);
  try { const r = await realFetch(input, init); if (r.status === 429) status429++; return r; } finally { inflight--; }
}) as any;
const app: any = await buildApp({ fetch: counting });
const { db, matcher } = app.ctx;
if (!args.includes('--warm')) app.ctx.cache.clear();
const http0 = calls;
db.exec(`UPDATE scenes SET match_status='unmatched', tpdb_id=NULL, tpdb_type=NULL, title=NULL, match_confidence=NULL, match_strategy=NULL, match_alts=NULL, match_tried_at=NULL`);
const ids = (db.prepare('SELECT id FROM scenes ORDER BY id LIMIT ?').all(N) as any[]).map((r) => r.id);
if (args.includes('--no-quick')) matcher.quickLeftovers = false;
const c = arg('concurrency'); if (c) matcher.concurrency = Number(c);
const t0 = Date.now();
matcher.enqueue(ids);
let last = 0;
while (true) {
  await new Promise((r) => setTimeout(r, 500));
  const s = matcher.status;
  if (Date.now() - last > 5000) { last = Date.now(); console.error(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] processed ${s.processed}/${ids.length} matched ${s.matched} http ${calls}`); }
  if (s.state === 'idle' && s.queued === 0 && s.processed >= ids.length) break;
  if (Date.now() - t0 > 25 * 60_000) { console.error('timeout'); break; }
}
const sec = (Date.now() - t0) / 1000;
const s = matcher.status;
const idList = ids.join(',');
const q = (st: string) => (db.prepare(`SELECT COUNT(*) c FROM scenes WHERE match_status=? AND id IN (${idList})`).get(st) as any).c;
console.log(JSON.stringify({
  label: arg('label', 'run'), files: ids.length, seconds: Math.round(sec * 10) / 10, filesPerMin: Math.round((ids.length / sec) * 60 * 10) / 10,
  matched: q('matched'), unmatched: q('unmatched'), failed: q('failed'), httpRequests: calls, httpPerFile: Math.round((calls / ids.length) * 100) / 100,
  http429: status429, peakInflight: maxInflight, strategies: s.strategies, lastError: s.lastError,
}, null, 1));
if (args.includes('--dump')) for (const r of db.prepare(`SELECT file_name, match_status, match_strategy, match_confidence FROM scenes WHERE id IN (${idList}) ORDER BY match_status`).all() as any[]) console.log(`${r.match_status}\t${r.match_strategy ?? '-'}\t${r.match_confidence ?? '-'}\t${r.file_name.slice(0, 110)}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
