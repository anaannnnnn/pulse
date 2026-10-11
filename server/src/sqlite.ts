// Thin better-sqlite3-compatible wrapper over Node's built-in `node:sqlite` (no native build step).
// Requires Node >= 22.13 (node:sqlite unflagged) — Node 24 LTS recommended.
import type { DatabaseSync as DatabaseSyncT, StatementSync } from 'node:sqlite';

// node:sqlite prints a one-time ExperimentalWarning on load; hide just that one warning.
const origEmit = process.emitWarning;
process.emitWarning = function (warning: any, ...rest: any[]) {
  const msg = typeof warning === 'string' ? warning : warning?.message;
  if (typeof msg === 'string' && msg.includes('SQLite is an experimental feature')) return;
  return (origEmit as any).call(process, warning, ...rest);
} as typeof process.emitWarning;
let DatabaseSync: typeof DatabaseSyncT;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  throw new Error(`Pulse needs Node.js 22.13 or newer (built-in node:sqlite). You are running ${process.version}. Install Node 24 LTS from https://nodejs.org`);
} finally {
  process.emitWarning = origEmit;
}

type Params = any[];
export interface RunResult { changes: number; lastInsertRowid: number | bigint }

export class Statement {
  constructor(private stmt: StatementSync, private owner?: Database) {}
  run(...params: Params): RunResult {
    const r = this.stmt.run(...(params as [any]));
    if (this.owner) this.owner.version++;
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }
  get(...params: Params): unknown { return this.stmt.get(...(params as [any])); }
  all(...params: Params): unknown[] { return this.stmt.all(...(params as [any])); }
}

export class Database {
  private db: DatabaseSyncT;
  private depth = 0;
  private stmtCache = new Map<string, Statement>();
  /** Bumped on every write (run/exec/transaction); read-model caches (facets, home rails, lists) compare it to know when to refresh. */
  version = 0;
  readonly inMemory: boolean;
  constructor(file: string) {
    this.inMemory = file === ':memory:' || file === '';
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (!this.inMemory) this.db.exec('PRAGMA synchronous = NORMAL; PRAGMA cache_size = -65536; PRAGMA temp_store = MEMORY; PRAGMA wal_autocheckpoint = 1000');
  }
  get inTransaction() { return this.depth > 0; }
  exec(sql: string) { this.db.exec(sql); this.version++; return this; }
  prepare(sql: string): Statement {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = new Statement(this.db.prepare(sql), this);
      if (this.stmtCache.size > 500) this.stmtCache.clear();
      this.stmtCache.set(sql, s);
    }
    return s;
  }
  pragma(source: string, opts: { simple?: boolean } = {}) {
    const rows = this.db.prepare(`PRAGMA ${source}`).all() as any[];
    if (opts.simple) { const r = rows[0]; return r ? Object.values(r)[0] : undefined; }
    return rows;
  }
  /** Same semantics as better-sqlite3: returns a function that runs `fn` inside a transaction (nested calls use savepoints). */
  transaction<A extends any[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      const sp = `sp_${this.depth}`;
      const outer = this.depth === 0;
      this.db.exec(outer ? 'BEGIN' : `SAVEPOINT ${sp}`);
      this.depth++;
      try {
        const res = fn(...args);
        this.depth--;
        this.db.exec(outer ? 'COMMIT' : `RELEASE ${sp}`);
        return res;
      } catch (e) {
        this.depth--;
        try { this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`); } catch { /* already rolled back */ }
        throw e;
      }
    };
  }
  close() { this.stmtCache.clear(); this.db.close(); }
}
export default Database;
