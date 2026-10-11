// Moves the provider-response cache (ThePornDB / StashDB JSON) into a "Pulse Cache" folder on the user's pCloud.
// The local cache.db keeps only a small hot set plus an index, so the process disk stays small and SQLite stays fast.
import { PcloudClient } from '../clients/pcloud.js';
import type { CacheCloud } from '../cacheStore.js';

const FOLDER = 'Pulse Cache';
const INDEX = 'pulse-cache-index.bin';

export class PcloudCacheCloud implements CacheCloud {
  private folderId: number | null = null;
  private folderPending: Promise<number> | null = null;
  constructor(private client: () => PcloudClient) {}

  private folder() {
    if (this.folderId != null) return Promise.resolve(this.folderId);
    if (!this.folderPending) {
      this.folderPending = this.client().ensureFolder(FOLDER, 0).then((id) => { this.folderId = id; return id; })
        .catch((e) => { this.folderPending = null; throw e; });
    }
    return this.folderPending;
  }

  async putPack(name: string, body: Buffer) {
    return String(await this.client().uploadFile(await this.folder(), name, body));
  }
  async getPack(id: string) {
    return this.client().downloadFile(Number(id));
  }
  async deletePack(id: string) {
    try { await this.client().deleteFile(Number(id)); } catch { /* already gone */ }
  }
  async putIndex(body: Buffer) {
    await this.client().replaceFile(await this.folder(), INDEX, body);
  }
  async getIndex() {
    const meta = await this.client().listFolder(await this.folder(), false);
    const hit = (meta.contents || []).find((c) => !c.isfolder && c.name === INDEX && c.fileid != null);
    if (!hit?.fileid) return null;
    return this.client().downloadFile(hit.fileid);
  }
}
