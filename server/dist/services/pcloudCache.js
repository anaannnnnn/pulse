const FOLDER = 'Pulse Cache';
const INDEX = 'pulse-cache-index.bin';
export class PcloudCacheCloud {
    client;
    folderId = null;
    folderPending = null;
    constructor(client) {
        this.client = client;
    }
    folder() {
        if (this.folderId != null)
            return Promise.resolve(this.folderId);
        if (!this.folderPending) {
            this.folderPending = this.client().ensureFolder(FOLDER, 0).then((id) => { this.folderId = id; return id; })
                .catch((e) => { this.folderPending = null; throw e; });
        }
        return this.folderPending;
    }
    async putPack(name, body) {
        return String(await this.client().uploadFile(await this.folder(), name, body));
    }
    async getPack(id) {
        return this.client().downloadFile(Number(id));
    }
    async deletePack(id) {
        try {
            await this.client().deleteFile(Number(id));
        }
        catch { /* already gone */ }
    }
    async putIndex(body) {
        await this.client().replaceFile(await this.folder(), INDEX, body);
    }
    async getIndex() {
        const meta = await this.client().listFolder(await this.folder(), false);
        const hit = (meta.contents || []).find((c) => !c.isfolder && c.name === INDEX && c.fileid != null);
        if (!hit?.fileid)
            return null;
        return this.client().downloadFile(hit.fileid);
    }
}
