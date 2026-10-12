// node:sqlite prints a one-time ExperimentalWarning on load; hide just that one warning.
const origEmit = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
    const msg = typeof warning === 'string' ? warning : warning?.message;
    if (typeof msg === 'string' && msg.includes('SQLite is an experimental feature'))
        return;
    return origEmit.call(process, warning, ...rest);
};
let DatabaseSync;
try {
    ({ DatabaseSync } = await import('node:sqlite'));
}
catch {
    throw new Error(`Pulse needs Node.js 22.13 or newer (built-in node:sqlite). You are running ${process.version}. Install Node 24 LTS from https://nodejs.org`);
}
finally {
    process.emitWarning = origEmit;
}
export class Statement {
    stmt;
    owner;
    constructor(stmt, owner) {
        this.stmt = stmt;
        this.owner = owner;
    }
    run(...params) {
        const r = this.stmt.run(...params);
        if (this.owner)
            this.owner.version++;
        return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    }
    get(...params) { return this.stmt.get(...params); }
    all(...params) { return this.stmt.all(...params); }
}
export class Database {
    db;
    depth = 0;
    stmtCache = new Map();
    /** Bumped on every write (run/exec/transaction); read-model caches (facets, home rails, lists) compare it to know when to refresh. */
    version = 0;
    inMemory;
    constructor(file) {
        this.inMemory = file === ':memory:' || file === '';
        this.db = new DatabaseSync(file);
        this.db.exec('PRAGMA busy_timeout = 5000');
        if (!this.inMemory)
            this.db.exec('PRAGMA synchronous = NORMAL; PRAGMA cache_size = -65536; PRAGMA temp_store = MEMORY; PRAGMA wal_autocheckpoint = 1000');
    }
    get inTransaction() { return this.depth > 0; }
    exec(sql) { this.db.exec(sql); this.version++; return this; }
    prepare(sql) {
        let s = this.stmtCache.get(sql);
        if (!s) {
            s = new Statement(this.db.prepare(sql), this);
            if (this.stmtCache.size > 500)
                this.stmtCache.clear();
            this.stmtCache.set(sql, s);
        }
        return s;
    }
    pragma(source, opts = {}) {
        const rows = this.db.prepare(`PRAGMA ${source}`).all();
        if (opts.simple) {
            const r = rows[0];
            return r ? Object.values(r)[0] : undefined;
        }
        return rows;
    }
    /** Same semantics as better-sqlite3: returns a function that runs `fn` inside a transaction (nested calls use savepoints). */
    transaction(fn) {
        return (...args) => {
            const sp = `sp_${this.depth}`;
            const outer = this.depth === 0;
            this.db.exec(outer ? 'BEGIN' : `SAVEPOINT ${sp}`);
            this.depth++;
            try {
                const res = fn(...args);
                this.depth--;
                this.db.exec(outer ? 'COMMIT' : `RELEASE ${sp}`);
                return res;
            }
            catch (e) {
                this.depth--;
                try {
                    this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
                }
                catch { /* already rolled back */ }
                throw e;
            }
        };
    }
    close() { this.stmtCache.clear(); this.db.close(); }
}
export default Database;
