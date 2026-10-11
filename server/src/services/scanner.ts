import type { DB } from '../db.js';
import { PcloudClient, PcloudMeta } from '../clients/pcloud.js';
import { isVideo, isSubtitle, parseFilename, subtitleLang } from '../parser.js';
import { config } from '../config.js';

export type ScanStatus = { state: 'idle' | 'running' | 'error'; startedAt: string | null; finishedAt: string | null; foldersScanned: number; filesSeen: number; videosFound: number; added: number; removed: number; updated: number; currentPath: string | null; error: string | null };

export type ScanFolder = { folderId: number; path?: string; name?: string };

/**
 * Lists a folder tree with several non-recursive `listfolder` calls in flight at once (instead of one huge recursive call that can time out on
 * big libraries). Child folders that already carry `contents` (recursive answers, mocks) are not listed again. Folders are retried with backoff.
 */
export async function listTree(client: PcloudClient, rootId: number, concurrency: number, onFolder?: (name: string) => void): Promise<PcloudMeta> {
  const root = await client.listFolder(rootId, false);
  const queue: PcloudMeta[] = [];
  const collect = (n: PcloudMeta) => { for (const c of n.contents || []) if (c.isfolder) { if (c.contents === undefined && c.folderid != null) queue.push(c); else collect(c); } };
  collect(root);
  let active = 0; let failure: unknown = null;
  const listOne = async (c: PcloudMeta) => {
    for (let attempt = 0; ; attempt++) {
      try { const m = await client.listFolder(c.folderid!, false); c.contents = m.contents || []; return; }
      catch (e: any) { if (attempt >= 3 || e?.code === 'pcloud_auth' || e?.code === 'pcloud_not_connected') throw e; await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); }
    }
  };
  await new Promise<void>((resolve, reject) => {
    const pump = () => {
      if (failure) { if (active === 0) reject(failure); return; }
      while (active < Math.max(1, concurrency) && queue.length) {
        const c = queue.shift()!; active++; onFolder?.(c.name);
        listOne(c).then(() => collect(c), (e) => { failure = e; }).finally(() => { active--; pump(); });
      }
      if (active === 0 && !queue.length) resolve();
    };
    pump();
  });
  return root;
}

export class Scanner {
  /** Parallel listfolder calls per scan (SCAN_CONCURRENCY, default 6); 1 = a single recursive call. */
  concurrency = Math.max(1, config.scanConcurrency || 6);
  status: ScanStatus = { state: 'idle', startedAt: null, finishedAt: null, foldersScanned: 0, filesSeen: 0, videosFound: 0, added: 0, removed: 0, updated: 0, currentPath: null, error: null };
  constructor(private db: DB) {}

  /** Walks a recursive listfolder tree, yielding files with their folder path. */
  static *walk(node: PcloudMeta, basePath: string): Generator<{ meta: PcloudMeta; dir: string; siblings: PcloudMeta[] } | { folder: string }> {
    yield { folder: basePath };
    const contents = node.contents || [];
    for (const c of contents) {
      if (c.isfolder) yield* Scanner.walk(c, `${basePath === '/' ? '' : basePath}/${c.name}`);
      else yield { meta: c, dir: basePath, siblings: contents };
    }
  }

  async run(client: PcloudClient, folders: ScanFolder[], onDone?: (newIds: number[]) => void): Promise<ScanStatus> {
    if (this.status.state === 'running') return this.status;
    this.status = { state: 'running', startedAt: new Date().toISOString(), finishedAt: null, foldersScanned: 0, filesSeen: 0, videosFound: 0, added: 0, removed: 0, updated: 0, currentPath: null, error: null };
    const scanId = Date.now();
    const newIds: number[] = [];
    try {
      const roots = folders.length ? folders : [{ folderId: 0, path: '/' }];
      const upsert = this.db.prepare(`INSERT INTO scenes(ext_key, source, pcloud_file_id, pcloud_folder_id, path, file_name, size, content_type, hash, duration, width, height, has_thumb, title, parsed, seen_scan, added_at)
        VALUES(@ext_key, 'pcloud', @fileid, @folderid, @path, @name, @size, @contenttype, @hash, @duration, @width, @height, @thumb, NULL, @parsed, @scan, @added)
        ON CONFLICT(ext_key) DO UPDATE SET pcloud_folder_id=excluded.pcloud_folder_id, path=excluded.path, file_name=excluded.file_name, size=excluded.size,
          content_type=excluded.content_type, hash=excluded.hash, duration=COALESCE(excluded.duration, scenes.duration), width=COALESCE(excluded.width, scenes.width),
          height=COALESCE(excluded.height, scenes.height), has_thumb=excluded.has_thumb, parsed=excluded.parsed, seen_scan=excluded.seen_scan`);
      const exists = this.db.prepare('SELECT id, hash FROM scenes WHERE ext_key=?');
      const subIns = this.db.prepare('INSERT OR IGNORE INTO subtitles(scene_id, pcloud_file_id, name, lang, format) VALUES(?,?,?,?,?)');
      for (const root of roots) {
        this.status.currentPath = root.path || `folder ${root.folderId}`;
        let tree: PcloudMeta;
        if (this.concurrency > 1) {
          try { tree = await listTree(client, root.folderId, this.concurrency, (n) => { this.status.currentPath = n; }); }
          catch (e: any) { if (e?.code === 'pcloud_auth' || e?.code === 'pcloud_not_connected') throw e; tree = await client.listFolder(root.folderId, true); }   // safety net: the old single recursive call
        } else tree = await client.listFolder(root.folderId, true);
        const basePath = root.path || (root.folderId === 0 ? '/' : `/${tree.name}`);
        const batch = this.db.transaction((items: any[]) => {
          for (const it of items) {
            if ('folder' in it) { this.status.foldersScanned++; continue; }
            this.status.filesSeen++;
            const m = it.meta as PcloudMeta;
            if (!isVideo(m.name) || !m.fileid) continue;
            this.status.videosFound++;
            const key = `pcloud:${m.fileid}`;
            const prev = exists.get(key) as any;
            const parsed = parseFilename(m.name, it.dir);
            const r = upsert.run({
              ext_key: key, fileid: m.fileid, folderid: m.parentfolderid ?? null, path: `${it.dir === '/' ? '' : it.dir}/${m.name}`, name: m.name,
              size: m.size ?? 0, contenttype: m.contenttype ?? null, hash: m.hash != null ? String(m.hash) : null,
              duration: m.duration != null ? Number(m.duration) || null : null, width: m.width ?? null, height: m.height ?? null,
              thumb: m.thumb ? 1 : 0, parsed: JSON.stringify(parsed), scan: scanId, added: m.created ? new Date(m.created).toISOString() : new Date().toISOString(),
            });
            const sceneId = prev?.id ?? Number(r.lastInsertRowid);
            if (!prev) { this.status.added++; newIds.push(sceneId); } else if (prev.hash !== (m.hash != null ? String(m.hash) : null)) this.status.updated++;
            const vbase = m.name.replace(/\.[^.]+$/, '');
            for (const s of it.siblings) {
              if (!s.isfolder && s.fileid && isSubtitle(s.name) && s.name.startsWith(vbase)) {
                subIns.run(sceneId, s.fileid, s.name, subtitleLang(s.name, vbase), s.name.toLowerCase().endsWith('.vtt') ? 'vtt' : 'srt');
              }
            }
          }
        });
        let buf: any[] = [];
        for (const it of Scanner.walk(tree, basePath)) {
          buf.push(it);
          if (buf.length >= 500) { batch(buf); buf = []; }
        }
        batch(buf);
      }
      const del = this.db.prepare(`DELETE FROM scenes WHERE source='pcloud' AND seen_scan != ?`).run(scanId);
      this.status.removed = del.changes;
      this.status.state = 'idle';
    } catch (e: any) {
      this.status.state = 'error';
      this.status.error = e.message;
    }
    this.status.finishedAt = new Date().toISOString();
    this.status.currentPath = null;
    if (this.status.state !== 'error') onDone?.(newIds);
    return this.status;
  }
}
