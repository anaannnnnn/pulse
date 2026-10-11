import { Database } from './sqlite.js';
import path from 'node:path';
import { config } from './config.js';
import { encrypt, decrypt } from './crypto.js';

export type DB = Database;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT, secret INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS studios (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT, tpdb_id TEXT UNIQUE, logo TEXT, parent TEXT,
  name_key TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS performers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT, tpdb_id TEXT UNIQUE, image TEXT, thumb TEXT, gender TEXT,
  favorite INTEGER DEFAULT 0, details TEXT, details_at TEXT, added_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  name_key TEXT);
CREATE INDEX IF NOT EXISTS performers_name_key ON performers(name_key);
CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT, tpdb_id TEXT, name_key TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS scenes (
  id INTEGER PRIMARY KEY,
  ext_key TEXT UNIQUE NOT NULL,
  source TEXT NOT NULL DEFAULT 'pcloud',
  pcloud_file_id INTEGER, pcloud_folder_id INTEGER,
  torbox_type TEXT, torbox_id INTEGER, torbox_file_id INTEGER,
  path TEXT, file_name TEXT NOT NULL, size INTEGER DEFAULT 0, content_type TEXT, hash TEXT,
  duration REAL, width INTEGER, height INTEGER, has_thumb INTEGER DEFAULT 0,
  title TEXT, parsed TEXT, date TEXT, description TEXT,
  studio_id INTEGER REFERENCES studios(id) ON DELETE SET NULL,
  tpdb_id TEXT, tpdb_type TEXT, tpdb_url TEXT, poster TEXT, backdrop TEXT, trailer TEXT,
  match_status TEXT NOT NULL DEFAULT 'unmatched', match_confidence REAL,
  favorite INTEGER DEFAULT 0,
  added_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  seen_scan INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS scenes_status ON scenes(match_status);
CREATE INDEX IF NOT EXISTS scenes_added ON scenes(added_at);
CREATE TABLE IF NOT EXISTS scene_performers (scene_id INTEGER REFERENCES scenes(id) ON DELETE CASCADE, performer_id INTEGER REFERENCES performers(id) ON DELETE CASCADE, PRIMARY KEY(scene_id, performer_id));
CREATE TABLE IF NOT EXISTS scene_tags (scene_id INTEGER REFERENCES scenes(id) ON DELETE CASCADE, tag_id INTEGER REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(scene_id, tag_id));
CREATE TABLE IF NOT EXISTS progress (scene_id INTEGER PRIMARY KEY REFERENCES scenes(id) ON DELETE CASCADE, position REAL NOT NULL, duration REAL, completed INTEGER DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS subtitles (id INTEGER PRIMARY KEY, scene_id INTEGER REFERENCES scenes(id) ON DELETE CASCADE, pcloud_file_id INTEGER, name TEXT, lang TEXT, format TEXT, UNIQUE(scene_id, pcloud_file_id));
`;

export function openDb(file = path.join(config.dataDir, 'pulse.db')): DB {
  const db = new Database(file);
  db.exec(SCHEMA);
  dropLegacyHttpCache(db);
  const addCol = (table: string, col: string, def: string) => {
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  addCol('studios', 'favorite', 'INTEGER DEFAULT 0');
  addCol('scenes', 'watchlist', 'INTEGER DEFAULT 0');
  addCol('scenes', 'watchlist_at', 'TEXT');
  addCol('scenes', 'match_strategy', 'TEXT');   // which cascade strategy produced the match ("manual" for hand picks)
  addCol('scenes', 'match_alts', 'TEXT');       // JSON: top-5 candidates with scores for the Review queue
  addCol('scenes', 'match_query', 'TEXT');      // cleaned query used / suggested for this file
  addCol('scenes', 'match_tried_at', 'TEXT');
  // StashDB source ids (a scene/performer/studio/tag can carry ids from both providers)
  addCol('scenes', 'stash_id', 'TEXT');
  addCol('scenes', 'match_source', 'TEXT');     // provider that supplied the stored metadata: 'tpdb' | 'stashdb'
  addCol('scenes', 'oshash', 'TEXT');           // cached OSHASH of the file (computed once, reused for fingerprint lookups)
  addCol('performers', 'stash_id', 'TEXT');
  addCol('studios', 'stash_id', 'TEXT');
  addCol('tags', 'stash_id', 'TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS scenes_stash_id ON scenes(stash_id);
    CREATE INDEX IF NOT EXISTS performers_stash_id ON performers(stash_id);
    CREATE INDEX IF NOT EXISTS studios_stash_id ON studios(stash_id);
    CREATE INDEX IF NOT EXISTS tags_stash_id ON tags(stash_id);`);
  addCol('scenes', 'match_error', 'TEXT');       // why the last automatic match attempt failed (HTTP status + body snippet / exception message)
  addCol('scenes', 'match_error_code', 'TEXT');  // tpdb_auth | rate_limited | tpdb_network | tpdb_http | exception | ...
  // Indexes for the library aggregates. Without them every "scene count per tag/performer/studio" lookup scanned a whole join table
  // (tags/studios/facets took 1-2 s each and blocked the single Node thread, so every other request waited behind them).
  db.exec(`CREATE INDEX IF NOT EXISTS scene_tags_tag ON scene_tags(tag_id, scene_id);
    CREATE INDEX IF NOT EXISTS scene_performers_perf ON scene_performers(performer_id, scene_id);
    CREATE INDEX IF NOT EXISTS scenes_studio ON scenes(studio_id);
    CREATE INDEX IF NOT EXISTS scenes_date ON scenes(date);
    CREATE INDEX IF NOT EXISTS scenes_favorite ON scenes(favorite) WHERE favorite=1;
    CREATE INDEX IF NOT EXISTS scenes_watchlist ON scenes(watchlist) WHERE watchlist=1;
    CREATE INDEX IF NOT EXISTS progress_updated ON progress(updated_at);
    CREATE INDEX IF NOT EXISTS performers_favorite ON performers(favorite) WHERE favorite=1;
    CREATE INDEX IF NOT EXISTS performers_added ON performers(added_at);`);
  if (!db.inMemory) { try { db.exec('ANALYZE'); } catch { /* optional */ } }
  return db;
}

/**
 * Provider responses (ThePornDB / StashDB, up to 4 MB each, ~2 GB after one big matching run) used to live in an `http_cache` table inside
 * pulse.db. They now live in a separate cache.db (see cacheStore.ts). Drop the old table and shrink the file so the library database is small again.
 */
function dropLegacyHttpCache(db: DB) {
  try {
    if (!db.prepare(`SELECT 1 x FROM sqlite_master WHERE type='table' AND name='http_cache'`).get()) return;
    const pages = Number(db.pragma('page_count', { simple: true })) * Number(db.pragma('page_size', { simple: true }));
    const t0 = Date.now();
    db.exec('DROP TABLE http_cache');
    if (pages > 64 * 1048576) {
      console.log(`[pulse] removed the legacy http_cache table (${Math.round(pages / 1048576)} MB database), compacting; this takes a moment once...`);
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.exec('VACUUM');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      console.log(`[pulse] database compacted to ${Math.round(Number(db.pragma('page_count', { simple: true })) * Number(db.pragma('page_size', { simple: true })) / 1048576)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    }
  } catch (e: any) { console.warn('[pulse] could not drop legacy http_cache:', e?.message); }
}

export const nameKey = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');

export class KV {
  constructor(private db: DB) {}
  get<T = any>(key: string, def?: T): T {
    const row = this.db.prepare('SELECT value, secret FROM kv WHERE key=?').get(key) as any;
    if (!row) return def as T;
    try { return JSON.parse(row.secret ? decrypt(row.value) : row.value); } catch { return def as T; }
  }
  set(key: string, value: unknown, secret = false) {
    const json = JSON.stringify(value);
    this.db.prepare('INSERT INTO kv(key,value,secret) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, secret=excluded.secret')
      .run(key, secret ? encrypt(json) : json, secret ? 1 : 0);
  }
  del(key: string) { this.db.prepare('DELETE FROM kv WHERE key=?').run(key); }
}
