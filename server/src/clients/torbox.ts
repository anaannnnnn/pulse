import { HttpError, FetchLike } from '../http.js';

export type TorboxType = 'torrents' | 'usenet' | 'webdl';
const VIDEO_RE = /\.(mp4|mkv|mov|avi|m4v|webm|ts|wmv|flv|mpg|mpeg)$/i;

const ID_PARAM: Record<TorboxType, string> = { torrents: 'torrent_id', usenet: 'usenet_id', webdl: 'web_id' };
const CONTROL: Record<TorboxType, [string, string]> = {
  torrents: ['/torrents/controltorrent', 'torrent_id'],
  usenet: ['/usenet/controlusenetdownload', 'usenet_id'],
  webdl: ['/webdl/controlwebdownload', 'webdl_id'],
};

export function normalizeItem(type: TorboxType, t: any) {
  const files = (t.files || []).map((f: any) => ({
    id: f.id, name: f.name, shortName: f.short_name || String(f.name).split('/').pop(), size: f.size || 0,
    mime: f.mimetype || null, isVideo: (f.mimetype || '').startsWith('video/') || VIDEO_RE.test(f.name || ''),
  }));
  return {
    id: t.id, type, name: t.name, hash: t.hash || null, size: t.size || 0,
    progress: typeof t.progress === 'number' ? t.progress : 0,
    state: t.download_state || (t.download_finished ? 'completed' : 'unknown'),
    downloadSpeed: t.download_speed || 0, uploadSpeed: t.upload_speed || 0,
    seeds: t.seeds ?? null, peers: t.peers ?? null, eta: t.eta ?? null,
    ready: !!(t.download_finished && t.download_present) || t.download_state === 'cached' || t.download_state === 'completed',
    createdAt: t.created_at || null, files,
  };
}

export class TorboxClient {
  base = 'https://api.torbox.app/v1/api';
  constructor(private apiKey: string, private f: FetchLike = fetch) {}
  get linked() { return !!this.apiKey; }

  private async req<T = any>(method: string, path: string, opts: { query?: Record<string, any>; json?: any; form?: FormData } = {}): Promise<T> {
    if (!this.apiKey) throw new HttpError(409, 'TorBox is not linked', 'torbox_not_linked');
    const u = new URL(this.base + path);
    for (const [k, v] of Object.entries(opts.query || {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    let body: any;
    if (opts.json) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.json); }
    if (opts.form) body = opts.form;
    const res = await this.f(u.toString(), { method, headers, body });
    const j: any = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403 || j?.error === 'BAD_TOKEN' || j?.error === 'AUTH_ERROR' || j?.error === 'NO_AUTH') {
      throw new HttpError(400, j?.detail || 'TorBox rejected the API key', 'invalid_key');
    }
    if (res.status === 429) throw new HttpError(429, 'TorBox rate limit', 'rate_limited');
    if (!res.ok || j?.success === false) throw new HttpError(502, j?.detail || `TorBox HTTP ${res.status}`, 'upstream_error', { error: j?.error });
    return j as T;
  }

  async me() { return (await this.req<{ data: any }>('GET', '/user/me')).data; }
  async list(type: TorboxType, id?: number) {
    const path = type === 'torrents' ? '/torrents/mylist' : type === 'usenet' ? '/usenet/mylist' : '/webdl/mylist';
    const j = await this.req<{ data: any }>('GET', path, { query: { bypass_cache: 'true', id } });
    if (id !== undefined) return [normalizeItem(type, j.data)];
    return (j.data || []).map((t: any) => normalizeItem(type, t));
  }
  async addMagnet(magnet: string, name?: string) {
    const form = new FormData(); form.set('magnet', magnet); if (name) form.set('name', name);
    return (await this.req<{ data: any; detail: string }>('POST', '/torrents/createtorrent', { form }));
  }
  async addTorrentFile(buf: Buffer, filename: string, name?: string) {
    const form = new FormData(); form.set('file', new Blob([new Uint8Array(buf)]), filename); if (name) form.set('name', name);
    return (await this.req<{ data: any; detail: string }>('POST', '/torrents/createtorrent', { form }));
  }
  async addNzb(link: string | null, file?: { buf: Buffer; filename: string }, name?: string) {
    const form = new FormData();
    if (link) form.set('link', link);
    if (file) form.set('file', new Blob([new Uint8Array(file.buf)]), file.filename);
    if (name) form.set('name', name);
    return (await this.req<{ data: any; detail: string }>('POST', '/usenet/createusenetdownload', { form }));
  }
  async addWeb(link: string, name?: string) {
    const form = new FormData(); form.set('link', link); if (name) form.set('name', name);
    return (await this.req<{ data: any; detail: string }>('POST', '/webdl/createwebdownload', { form }));
  }
  async checkCached(hashes: string[], type: TorboxType = 'torrents') {
    const path = type === 'torrents' ? '/torrents/checkcached' : type === 'usenet' ? '/usenet/checkcached' : '/webdl/checkcached';
    const j = await this.req<{ data: any }>('GET', path, { query: { hash: hashes.join(','), format: 'object', list_files: 'true' } });
    const out: Record<string, any> = {};
    for (const h of hashes) {
      const v = j.data?.[h] || j.data?.[h.toLowerCase()];
      out[h] = v ? { name: v.name, size: v.size, files: (v.files || []).map((f: any) => ({ name: f.name, size: f.size })) } : false;
    }
    return out;
  }
  async requestDownload(type: TorboxType, id: number, fileId?: number, userIp?: string) {
    const path = type === 'torrents' ? '/torrents/requestdl' : type === 'usenet' ? '/usenet/requestdl' : '/webdl/requestdl';
    const j = await this.req<{ data: string }>('GET', path, {
      query: { token: this.apiKey, [ID_PARAM[type]]: id, file_id: fileId, redirect: 'false', user_ip: userIp },
    });
    return j.data;
  }
  async remove(type: TorboxType, id: number) { return this.control(type, id, 'delete'); }
  async control(type: TorboxType, id: number, operation: 'delete' | 'pause' | 'resume' | 'reannounce') {
    const [path, key] = CONTROL[type];
    return this.req('POST', path, { json: { [key]: id, operation } });
  }
}
