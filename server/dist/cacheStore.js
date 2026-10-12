// Provider response cache (ThePornDB / StashDB). Replaces the old `http_cache` table that lived inside pulse.db.
//
// Why it exists: one matching run stored ~17,000 responses (StashDB answers average 176 KB, up to 4 MB) = 2.2 GB of JSON inside the library
// database. That made every full-table maintenance query (`DELETE ... WHERE body LIKE ...`, `DELETE ... WHERE fetched_at < ?`) read gigabytes on the
// single Node thread, and every write JSON.stringify'd + wrote megabytes synchronously.
//
// Now: separate cache.db file (the library database stays a few MB), values are deflate-compressed (compression runs on the libuv thread pool,
// not on the event loop), small in-memory LRU of recently used answers, an index on fetched_at, an `empty` flag for negative answers, and a hard
// size cap with chunked pruning (never one long blocking DELETE). The interface is the same sync get/set the API clients already use.
//
// When a pCloud account is connected, bodies older than the hot set are packed and uploaded to a "Pulse Cache" folder. cache.db keeps the index
// and about 32 MB of recent answers, so the device does not fill up and SQLite stays fast. Reads miss locally, then pull the pack from pCloud.
import zlib from 'node:zlib';
import path from 'node:path';
import fs from 'node:fs';
import { Database } from './sqlite.js';
const isEmptyValue = (j) => !!j && typeof j === 'object' && Array.isArray(j.data) && j.data.length === 0;
const PACK_MAGIC = Buffer.from('PCCH');
const HOT_DEFAULT = 32 * 1048576;
const PACK_TARGET = 4 * 1048576;
const PACK_MEM = 48 * 1048576;
const SPILL_PARALLEL = 3;
const SCHEMA = `PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;
  CREATE TABLE IF NOT EXISTS c (key TEXT PRIMARY KEY, body BLOB NOT NULL, fetched_at INTEGER NOT NULL, empty INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS c_fetched ON c(fetched_at);
  CREATE INDEX IF NOT EXISTS c_empty ON c(empty) WHERE empty=1;
  CREATE TABLE IF NOT EXISTS cloud (key TEXT PRIMARY KEY, pack TEXT NOT NULL, off INTEGER NOT NULL, len INTEGER NOT NULL, fetched_at INTEGER NOT NULL, empty INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS cloud_pack ON cloud(pack);
  CREATE INDEX IF NOT EXISTS cloud_fetched ON cloud(fetched_at);`;
export class CacheStore {
    db;
    mem = new Map();
    memSize = 0;
    pending = new Map();
    parked = [];
    bytes = 0;
    cloudBytes = 0;
    cloudEntries = 0;
    sets = 0;
    pruning = false;
    pausing = false;
    timer;
    cloudTimer = null;
    closed = false;
    cloud = null;
    hotBytes;
    spillChain = Promise.resolve();
    spillQueued = false;
    claimed = new Set();
    reserved = 0;
    compactTimer = null;
    packs = new Map();
    packBytes = 0;
    packInflight = new Map();
    spillFailures = 0;
    indexDirty = false;
    stats = { hits: 0, memHits: 0, misses: 0, writes: 0, pruned: 0, cloudHits: 0, spilled: 0 };
    o;
    file;
    constructor(file, opts = {}) {
        this.file = file;
        this.hotBytes = opts.hotBytes ?? HOT_DEFAULT;
        this.o = { maxBytes: 512 * 1048576, maxAgeMs: 45 * 864e5, memBytes: 32_000_000, maxValueBytes: 8_000_000, ...opts };
        if (file !== ':memory:')
            fs.mkdirSync(path.dirname(file), { recursive: true });
        this.db = new Database(file);
        this.db.exec(SCHEMA);
        this.bytes = Number(this.db.prepare('SELECT COALESCE(SUM(size),0) b FROM c').get().b) || 0;
        this.refreshCloudStats();
        // first prune a few seconds after start (off the startup path), then hourly
        const first = setTimeout(() => this.prune(), 5000);
        first.unref?.();
        this.timer = setInterval(() => this.prune(), 3600e3);
        this.timer.unref?.();
    }
    /** Start spilling cold answers to pCloud (or any CacheCloud). Safe to call again when the token changes. */
    attachCloud(cloud, opts = {}) {
        this.cloud = cloud;
        if (opts.hotBytes)
            this.hotBytes = opts.hotBytes;
        if (this.cloudTimer)
            clearInterval(this.cloudTimer);
        const boot = () => this.restoreIndex().catch(() => { }).then(() => this.drain());
        this.spillChain = this.spillChain.then(boot).catch(() => { });
        this.cloudTimer = setInterval(() => { this.spillChain = this.spillChain.then(() => this.drain()).catch(() => { }); }, 20_000);
        this.cloudTimer.unref?.();
    }
    detachCloud() {
        this.cloud = null;
        if (this.cloudTimer) {
            clearInterval(this.cloudTimer);
            this.cloudTimer = null;
        }
    }
    get cloudEnabled() { return !!this.cloud; }
    localCap() { return this.cloud ? Math.min(this.o.maxBytes, this.hotBytes) : this.o.maxBytes; }
    refreshCloudStats() {
        try {
            const r = this.db.prepare('SELECT COALESCE(SUM(len),0) b, COUNT(*) n FROM cloud').get();
            this.cloudBytes = Number(r?.b) || 0;
            this.cloudEntries = Number(r?.n) || 0;
        }
        catch {
            this.cloudBytes = 0;
            this.cloudEntries = 0;
        }
    }
    get(key, maxAgeMs) {
        const now = Date.now();
        const p = this.pending.get(key);
        if (p)
            return now - p.at < maxAgeMs ? JSON.parse(p.json) : undefined;
        const m = this.mem.get(key);
        if (m) {
            this.mem.delete(key);
            this.mem.set(key, m); // LRU touch
            if (now - m.at >= maxAgeMs)
                return undefined;
            this.stats.memHits++;
            this.stats.hits++;
            return JSON.parse(m.json);
        }
        let row;
        try {
            row = this.db.prepare('SELECT body, fetched_at FROM c WHERE key=?').get(key);
        }
        catch {
            return undefined;
        }
        if (row && now - row.fetched_at < maxAgeMs) {
            let json;
            try {
                json = zlib.inflateSync(row.body).toString('utf8');
            }
            catch {
                return undefined;
            }
            this.remember(key, json, row.fetched_at);
            this.stats.hits++;
            return JSON.parse(json);
        }
        const cold = this.readCloudMem(key, maxAgeMs);
        if (cold !== undefined)
            return cold;
        this.stats.misses++;
        return undefined;
    }
    /** Fetch a value that was spilled to the cloud tier. Remembers it so the following get() is local. */
    async pull(key, maxAgeMs) {
        const hot = this.lookupHot(key, maxAgeMs);
        if (hot !== undefined)
            return hot;
        if (!this.cloud || this.closed)
            return undefined;
        let row;
        try {
            row = this.db.prepare('SELECT pack, off, len, fetched_at FROM cloud WHERE key=?').get(key);
        }
        catch {
            return undefined;
        }
        if (!row || Date.now() - row.fetched_at >= maxAgeMs)
            return undefined;
        const pack = await this.loadPack(String(row.pack));
        if (!pack || row.off < 0 || row.off + row.len > pack.length)
            return undefined;
        let json;
        try {
            json = zlib.inflateSync(pack.subarray(row.off, row.off + row.len)).toString('utf8');
        }
        catch {
            return undefined;
        }
        this.remember(key, json, row.fetched_at);
        this.stats.cloudHits++;
        this.stats.hits++;
        try {
            return JSON.parse(json);
        }
        catch {
            return undefined;
        }
    }
    lookupHot(key, maxAgeMs) {
        const now = Date.now();
        const p = this.pending.get(key);
        if (p)
            return now - p.at < maxAgeMs ? JSON.parse(p.json) : undefined;
        const m = this.mem.get(key);
        if (m && now - m.at < maxAgeMs)
            return JSON.parse(m.json);
        return undefined;
    }
    readCloudMem(key, maxAgeMs) {
        if (!this.cloud || this.packs.size === 0)
            return undefined;
        let row;
        try {
            row = this.db.prepare('SELECT pack, off, len, fetched_at FROM cloud WHERE key=?').get(key);
        }
        catch {
            return undefined;
        }
        if (!row || Date.now() - row.fetched_at >= maxAgeMs)
            return undefined;
        const pack = this.packs.get(String(row.pack));
        if (!pack)
            return undefined;
        this.packs.delete(String(row.pack));
        this.packs.set(String(row.pack), pack);
        let json;
        try {
            json = zlib.inflateSync(pack.subarray(row.off, row.off + row.len)).toString('utf8');
        }
        catch {
            return undefined;
        }
        this.remember(key, json, row.fetched_at);
        this.stats.cloudHits++;
        this.stats.hits++;
        try {
            return JSON.parse(json);
        }
        catch {
            return undefined;
        }
    }
    async loadPack(id) {
        const hit = this.packs.get(id);
        if (hit) {
            this.packs.delete(id);
            this.packs.set(id, hit);
            return hit;
        }
        let p = this.packInflight.get(id);
        if (!p) {
            p = (async () => {
                try {
                    return await this.cloud.getPack(id);
                }
                catch {
                    return null;
                }
            })().finally(() => this.packInflight.delete(id));
            this.packInflight.set(id, p);
        }
        const buf = await p;
        if (!buf)
            return null;
        this.packs.set(id, buf);
        this.packBytes += buf.length;
        while (this.packBytes > PACK_MEM && this.packs.size > 1) {
            const k = this.packs.keys().next().value;
            const v = this.packs.get(k);
            this.packs.delete(k);
            this.packBytes -= v.length;
        }
        return buf;
    }
    set(key, value) {
        if (this.closed)
            return;
        let json;
        try {
            json = JSON.stringify(value);
        }
        catch {
            return;
        }
        if (json.length > this.o.maxValueBytes)
            return;
        const at = Date.now();
        const empty = isEmptyValue(value) ? 1 : 0;
        this.pending.set(key, { json, at, empty });
        this.remember(key, json, at);
        // compress on the thread pool, then one small INSERT on the event loop
        zlib.deflate(json, { level: 3 }, (err, buf) => {
            const cur = this.pending.get(key);
            if (cur && cur.json === json)
                this.pending.delete(key);
            if (err || this.closed)
                return;
            try {
                this.write(key, buf, at, empty);
            }
            catch { /* cache only */ }
        });
    }
    write(key, buf, at, empty) {
        if (this.pausing) {
            this.parked.push({ key, buf, at, empty });
            return;
        }
        const old = this.db.prepare('SELECT size FROM c WHERE key=?').get(key);
        this.db.prepare('INSERT OR REPLACE INTO c(key, body, fetched_at, empty, size) VALUES(?,?,?,?,?)').run(key, buf, at, empty, buf.length);
        this.bytes += buf.length - (old?.size || 0);
        // a fresh local body wins over a spilled copy of the same key
        try {
            const prev = this.db.prepare('SELECT len FROM cloud WHERE key=?').get(key);
            if (prev) {
                this.db.prepare('DELETE FROM cloud WHERE key=?').run(key);
                this.cloudBytes = Math.max(0, this.cloudBytes - (prev.len || 0));
                this.cloudEntries = Math.max(0, this.cloudEntries - 1);
            }
        }
        catch { /* cloud table missing on a racing compact */ }
        this.stats.writes++;
        this.sets++;
        if (this.bytes > this.localCap()) {
            if (this.cloud)
                this.scheduleSpill();
            else
                this.prune();
        }
    }
    remember(key, json, at) {
        if (json.length > this.o.memBytes / 4)
            return;
        const prev = this.mem.get(key);
        if (prev)
            this.memSize -= prev.json.length;
        this.mem.delete(key);
        this.mem.set(key, { json, at });
        this.memSize += json.length;
        while (this.memSize > this.o.memBytes) {
            const k = this.mem.keys().next().value;
            const v = this.mem.get(k);
            this.mem.delete(k);
            this.memSize -= v.json.length;
        }
    }
    /** Forgets cached "no results" answers (used by "Retry matching"). Indexed; touches only those rows. */
    purgeEmpty() {
        for (const [k, v] of this.pending)
            if (v.empty)
                this.pending.delete(k);
        this.mem.clear();
        this.memSize = 0;
        const r = this.db.prepare('DELETE FROM c WHERE empty=1').run();
        let n = r.changes;
        try {
            const packs = this.db.prepare('SELECT DISTINCT pack FROM cloud WHERE empty=1').all().map((x) => String(x.pack));
            const c = this.db.prepare('DELETE FROM cloud WHERE empty=1').run();
            n += c.changes;
            if (packs.length)
                void this.gcPacks(packs);
        }
        catch { /* no cloud table yet */ }
        this.bytes = Number(this.db.prepare('SELECT COALESCE(SUM(size),0) b FROM c').get().b) || 0;
        this.refreshCloudStats();
        return n;
    }
    clear() {
        this.pending.clear();
        this.mem.clear();
        this.memSize = 0;
        this.parked = [];
        let packs = [];
        try {
            packs = this.db.prepare('SELECT DISTINCT pack FROM cloud').all().map((x) => String(x.pack));
        }
        catch { /* ignore */ }
        this.db.exec('DELETE FROM c; DELETE FROM cloud');
        this.bytes = 0;
        this.cloudBytes = 0;
        this.cloudEntries = 0;
        this.packs.clear();
        this.packBytes = 0;
        try {
            this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM');
        }
        catch { /* optional */ }
        if (packs.length)
            void this.gcPacks(packs);
        if (this.cloud?.putIndex)
            void this.cloud.putIndex(Buffer.alloc(0)).catch(() => { });
    }
    info() {
        return {
            diskBytes: this.bytes, memChars: this.memSize, memEntries: this.mem.size, pending: this.pending.size,
            cloud: !!this.cloud, cloudBytes: this.cloudBytes, cloudEntries: this.cloudEntries,
            ...this.stats,
        };
    }
    /** Chunked pruning: expired rows first, then oldest rows until under the size cap. Yields to the event loop between chunks. */
    prune() {
        if (this.pruning || this.closed)
            return;
        // A connected cloud tier spills instead of deleting. Delete locally only after repeated upload failures, and only above 2× the hot cap,
        // so a full cache still moves to pCloud instead of being thrown away while the first uploads are in flight.
        if (this.cloud && (this.spillFailures < 3 || this.bytes <= this.hotBytes * 2)) {
            this.scheduleSpill();
            return;
        }
        this.pruning = true;
        const cutoff = Date.now() - this.o.maxAgeMs;
        const target = this.cloud ? this.hotBytes * 2 : this.o.maxBytes;
        const step = () => {
            if (this.closed) {
                this.pruning = false;
                return;
            }
            try {
                let rows = this.db.prepare('SELECT rowid r, size FROM c WHERE fetched_at < ? ORDER BY fetched_at LIMIT 200').all(cutoff);
                if (!rows.length && this.bytes > target * 0.9)
                    rows = this.db.prepare('SELECT rowid r, size FROM c ORDER BY fetched_at LIMIT 100').all();
                if (rows.length) {
                    const del = this.db.prepare('DELETE FROM c WHERE rowid=?');
                    this.db.transaction(() => { for (const r of rows)
                        del.run(r.r); })();
                    this.bytes = Math.max(0, this.bytes - rows.reduce((a, r) => a + r.size, 0));
                    this.stats.pruned += rows.length;
                    setImmediate(step);
                    return;
                }
            }
            catch { /* retry next hour */ }
            this.pruning = false;
            try {
                this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
            }
            catch { /* optional */ }
        };
        setImmediate(step);
    }
    scheduleSpill() {
        if (!this.cloud || this.closed || this.spillQueued)
            return;
        this.spillQueued = true;
        const job = this.spillChain.then(() => this.drain());
        this.spillChain = job.catch(() => { });
        job.finally(() => { this.spillQueued = false; });
    }
    /** Spill until the local hot set is back under its cap, then snapshot the index and shrink a bloated cache.db. */
    async flushCloud() {
        const job = this.spillChain.then(() => this.drain());
        this.spillChain = job.catch(() => { });
        await job;
    }
    async drain() {
        if (!this.cloud || this.closed)
            return;
        // Several packs upload at once. Packing stays on this thread, but only between awaits, so requests are not stuck behind one long move.
        await Promise.all(Array.from({ length: SPILL_PARALLEL }, () => this.spillWorker()));
        await this.snapshotIndex();
        this.scheduleCompact();
    }
    async spillWorker() {
        while (!this.closed && this.cloud && this.bytes - this.reserved > this.hotBytes && this.spillFailures < 8) {
            const job = this.pickPack();
            if (!job)
                return;
            const ok = await this.commitPack(job);
            if (!ok)
                return;
            await new Promise((r) => setImmediate(r));
        }
    }
    /** Claim the next cold pack without reading bodies we will not upload. Synchronous so parallel workers cannot grab the same keys. */
    pickPack() {
        if (!this.cloud || this.closed || this.pausing)
            return null;
        if (this.bytes - this.reserved <= this.hotBytes)
            return null;
        const rows = this.db.prepare('SELECT key, fetched_at, empty, size FROM c ORDER BY fetched_at LIMIT 500').all();
        const meta = [];
        let size = 0;
        for (const r of rows) {
            if (this.claimed.has(String(r.key)))
                continue;
            if (meta.length && size >= PACK_TARGET)
                break;
            if (meta.length && this.bytes - this.reserved - (size + (r.size || 0)) < this.hotBytes * 0.75)
                break;
            meta.push(r);
            size += r.size || 0;
        }
        if (!meta.length)
            return null;
        const getBody = this.db.prepare('SELECT body FROM c WHERE key=? AND fetched_at=?');
        const full = [];
        for (const r of meta) {
            const b = getBody.get(r.key, r.fetched_at);
            if (!b?.body)
                continue;
            this.claimed.add(String(r.key));
            full.push({ key: String(r.key), body: b.body, fetched_at: r.fetched_at, empty: r.empty, size: r.size || 0 });
        }
        if (!full.length)
            return null;
        const reserved = full.reduce((a, r) => a + r.size, 0);
        this.reserved += reserved;
        return { rows: full, reserved };
    }
    release(job, removed) {
        for (const r of job.rows)
            this.claimed.delete(r.key);
        this.reserved = Math.max(0, this.reserved - job.reserved);
        if (removed)
            this.bytes = Math.max(0, this.bytes - removed);
    }
    async commitPack(job) {
        const picked = job.rows;
        const parts = [PACK_MAGIC, Buffer.from([1])];
        const index = [];
        let cursor = parts.reduce((a, b) => a + b.length, 0);
        for (const r of picked) {
            const keyBuf = Buffer.from(r.key, 'utf8');
            const body = Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body);
            const head = Buffer.alloc(8);
            head.writeUInt32BE(keyBuf.length, 0);
            head.writeUInt32BE(body.length, 4);
            const off = cursor + head.length + keyBuf.length;
            parts.push(head, keyBuf, body);
            cursor = off + body.length;
            index.push({ key: r.key, off, len: body.length, at: r.fetched_at, empty: r.empty ? 1 : 0 });
        }
        const pack = Buffer.concat(parts);
        const name = `pack-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.bin`;
        let id;
        try {
            id = await this.cloud.putPack(name, pack);
        }
        catch {
            this.spillFailures++;
            this.release(job, 0);
            return false;
        }
        if (this.closed) {
            this.release(job, 0);
            return false;
        }
        const ins = this.db.prepare('INSERT OR REPLACE INTO cloud(key, pack, off, len, fetched_at, empty) VALUES(?,?,?,?,?,?)');
        const del = this.db.prepare('DELETE FROM c WHERE key=? AND fetched_at=?');
        let removed = 0;
        let n = 0;
        this.db.transaction(() => {
            for (let i = 0; i < picked.length; i++) {
                const still = this.db.prepare('SELECT fetched_at FROM c WHERE key=?').get(picked[i].key);
                if (!still || still.fetched_at !== picked[i].fetched_at)
                    continue;
                ins.run(index[i].key, id, index[i].off, index[i].len, index[i].at, index[i].empty);
                del.run(picked[i].key, picked[i].fetched_at);
                removed += picked[i].size || 0;
                n++;
            }
        })();
        this.release(job, removed);
        this.refreshCloudStats();
        this.rememberPack(id, pack);
        this.stats.spilled += n;
        if (n > 0) {
            this.spillFailures = 0;
            this.indexDirty = true;
        }
        return n > 0;
    }
    rememberPack(id, pack) {
        if (this.packs.has(id))
            this.packBytes -= this.packs.get(id).length;
        this.packs.set(id, pack);
        this.packBytes += pack.length;
        while (this.packBytes > PACK_MEM && this.packs.size > 1) {
            const k = this.packs.keys().next().value;
            this.packBytes -= this.packs.get(k).length;
            this.packs.delete(k);
        }
    }
    async gcPacks(maybe) {
        if (!this.cloud?.deletePack)
            return;
        for (const id of maybe) {
            let left = 1;
            try {
                left = Number(this.db.prepare('SELECT COUNT(*) n FROM cloud WHERE pack=?').get(id)?.n) || 0;
            }
            catch {
                continue;
            }
            if (left)
                continue;
            this.packs.delete(id);
            try {
                await this.cloud.deletePack(id);
            }
            catch { /* best effort */ }
        }
    }
    async snapshotIndex() {
        if (!this.cloud?.putIndex || this.closed || !this.indexDirty)
            return;
        let rows = [];
        try {
            rows = this.db.prepare('SELECT key, pack, off, len, fetched_at, empty FROM cloud').all();
        }
        catch {
            return;
        }
        const json = JSON.stringify(rows.map((r) => [r.key, r.pack, r.off, r.len, r.fetched_at, r.empty]));
        const body = await new Promise((resolve, reject) => zlib.deflate(json, { level: 6 }, (err, buf) => err ? reject(err) : resolve(buf)));
        try {
            await this.cloud.putIndex(body);
            this.indexDirty = false;
        }
        catch { /* next interval */ }
    }
    async restoreIndex() {
        if (!this.cloud?.getIndex || this.closed)
            return;
        const n = Number(this.db.prepare('SELECT COUNT(*) n FROM cloud').get()?.n) || 0;
        if (n > 0)
            return;
        const buf = await this.cloud.getIndex();
        if (!buf || !buf.length)
            return;
        let rows;
        try {
            rows = JSON.parse(zlib.inflateSync(buf).toString('utf8'));
        }
        catch {
            return;
        }
        if (!Array.isArray(rows) || !rows.length)
            return;
        const ins = this.db.prepare('INSERT OR REPLACE INTO cloud(key, pack, off, len, fetched_at, empty) VALUES(?,?,?,?,?,?)');
        this.db.transaction(() => {
            for (const r of rows) {
                if (!Array.isArray(r) || r.length < 6 || typeof r[0] !== 'string' || typeof r[1] !== 'string')
                    continue;
                ins.run(r[0], r[1], Number(r[2]) || 0, Number(r[3]) || 0, Number(r[4]) || 0, r[5] ? 1 : 0);
            }
        })();
        this.refreshCloudStats();
    }
    /** Shrink cache.db later, not in the middle of a move, so the rewrite does not stall requests. */
    scheduleCompact() {
        if (this.compactTimer || this.closed || this.file === ':memory:')
            return;
        this.compactTimer = setTimeout(() => { this.compactTimer = null; this.compact(); }, 2500);
        this.compactTimer.unref?.();
    }
    compact() {
        if (this.closed || this.pausing || this.file === ':memory:')
            return;
        let sz = 0;
        try {
            sz = fs.statSync(this.file).size;
        }
        catch {
            return;
        }
        const wal = this.file + '-wal';
        try {
            sz += fs.statSync(wal).size;
        }
        catch { /* no wal */ }
        if (sz < 80 * 1048576 || sz < this.bytes * 4 + 32 * 1048576)
            return;
        const next = this.file + '.next';
        try {
            fs.rmSync(next, { force: true });
        }
        catch { /* ignore */ }
        this.pausing = true;
        try {
            const fresh = new Database(next);
            fresh.exec(SCHEMA);
            const local = this.db.prepare('SELECT key, body, fetched_at, empty, size FROM c').all();
            const cold = this.db.prepare('SELECT key, pack, off, len, fetched_at, empty FROM cloud').all();
            const insL = fresh.prepare('INSERT INTO c(key, body, fetched_at, empty, size) VALUES(?,?,?,?,?)');
            const insC = fresh.prepare('INSERT INTO cloud(key, pack, off, len, fetched_at, empty) VALUES(?,?,?,?,?,?)');
            fresh.transaction(() => {
                for (const r of local)
                    insL.run(r.key, r.body, r.fetched_at, r.empty, r.size);
                for (const r of cold)
                    insC.run(r.key, r.pack, r.off, r.len, r.fetched_at, r.empty);
            })();
            fresh.close();
            this.db.close();
            for (const ext of ['-wal', '-shm']) {
                try {
                    fs.rmSync(this.file + ext, { force: true });
                }
                catch { /* ignore */ }
            }
            const old = this.file + '.old';
            fs.rmSync(old, { force: true });
            fs.renameSync(this.file, old);
            fs.renameSync(next, this.file);
            try {
                fs.rmSync(old, { force: true });
            }
            catch { /* ignore */ }
            this.db = new Database(this.file);
            this.db.exec(SCHEMA);
            this.bytes = Number(this.db.prepare('SELECT COALESCE(SUM(size),0) b FROM c').get().b) || 0;
            this.refreshCloudStats();
        }
        catch {
            try {
                if (!this.db) { /* replaced */ }
            }
            catch { /* ignore */ }
            try {
                this.db = new Database(this.file);
                this.db.exec(SCHEMA);
            }
            catch { /* leave closed */ }
        }
        finally {
            this.pausing = false;
            const parked = this.parked.splice(0);
            for (const p of parked) {
                try {
                    this.write(p.key, p.buf, p.at, p.empty);
                }
                catch { /* cache only */ }
            }
        }
    }
    close() {
        if (this.closed)
            return;
        for (const [k, v] of this.pending) {
            try {
                this.write(k, zlib.deflateSync(v.json, { level: 1 }), v.at, v.empty);
            }
            catch { /* ignore */ }
        }
        this.pending.clear();
        this.closed = true;
        clearInterval(this.timer);
        if (this.cloudTimer)
            clearInterval(this.cloudTimer);
        if (this.compactTimer)
            clearTimeout(this.compactTimer);
        try {
            this.db.close();
        }
        catch { /* already closed */ }
    }
}
