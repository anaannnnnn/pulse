import { HttpError, FetchLike } from '../http.js';

export type PcloudRegion = 'us' | 'eu';
export const PCLOUD_HOSTS: Record<PcloudRegion, string> = { us: 'api.pcloud.com', eu: 'eapi.pcloud.com' };
export const regionFromHost = (h: string): PcloudRegion => (h.startsWith('eapi') ? 'eu' : 'us');
export const hostFromLocation = (loc?: number | string | null) => (Number(loc) === 2 ? PCLOUD_HOSTS.eu : PCLOUD_HOSTS.us);

export type PcloudToken = { accessToken: string; host: string; uid?: number; locationid?: number };

export type PcloudMeta = {
  isfolder: boolean; name: string; folderid?: number; fileid?: number; parentfolderid?: number;
  size?: number; contenttype?: string; created?: string; modified?: string; thumb?: boolean; hash?: number | string;
  duration?: string | number; width?: number; height?: number; category?: number; contents?: PcloudMeta[]; path?: string;
};

export function buildAuthorizeUrl(opts: { clientId: string; redirectUri?: string | null; state?: string; forceReapprove?: boolean }) {
  const u = new URL('https://my.pcloud.com/oauth2/authorize');
  u.searchParams.set('client_id', opts.clientId);
  u.searchParams.set('response_type', 'code');
  if (opts.redirectUri) u.searchParams.set('redirect_uri', opts.redirectUri);
  if (opts.state) u.searchParams.set('state', opts.state);
  if (opts.forceReapprove) u.searchParams.set('force_reapprove', '1');
  return u.toString();
}

/** Parses a pasted callback URL or bare code. */
export function parseCallbackInput(input: string): { code: string | null; hostname: string | null; locationid: number | null; state: string | null } {
  const t = input.trim();
  try {
    if (/^https?:\/\//i.test(t) || t.includes('code=')) {
      const u = new URL(/^https?:\/\//i.test(t) ? t : `http://x/?${t.replace(/^\?/, '')}`);
      const p = new URLSearchParams(u.search || u.hash.replace(/^#/, '?'));
      return { code: p.get('code'), hostname: p.get('hostname'), locationid: p.get('locationid') ? Number(p.get('locationid')) : null, state: p.get('state') };
    }
  } catch { /* fallthrough */ }
  return { code: t || null, hostname: null, locationid: null, state: null };
}

export class PcloudClient {
  constructor(private token: PcloudToken | null, private f: FetchLike = fetch) {}

  static async exchangeCode(opts: { clientId: string; clientSecret: string; code: string; host?: string | null; f?: FetchLike }): Promise<PcloudToken> {
    const f = opts.f || fetch;
    const hosts = opts.host ? [opts.host] : [PCLOUD_HOSTS.us, PCLOUD_HOSTS.eu];
    let lastErr: unknown = null;
    for (const host of hosts) {
      if (!/^e?api\.pcloud\.com$/.test(host)) throw new HttpError(400, 'Invalid pCloud hostname', 'bad_request');
      const body = new URLSearchParams({ client_id: opts.clientId, client_secret: opts.clientSecret, code: opts.code });
      const res = await f(`https://${host}/oauth2_token`, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      const j: any = await res.json().catch(() => ({}));
      if (j && j.result === 0 && j.access_token) {
        return { accessToken: j.access_token, host: j.hostname || host, uid: j.uid, locationid: j.locationid ?? (host.startsWith('eapi') ? 2 : 1) };
      }
      lastErr = new HttpError(400, `pCloud token exchange failed: ${j?.error || res.status}`, 'pcloud_exchange_failed');
    }
    throw lastErr;
  }

  get connected() { return !!this.token; }
  get host() { return this.token?.host || PCLOUD_HOSTS.us; }

  async call<T = any>(method: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    if (!this.token) throw new HttpError(409, 'pCloud is not connected', 'pcloud_not_connected');
    const u = new URL(`https://${this.token.host}/${method}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v));
    const res = await this.f(u.toString(), { headers: { Authorization: `Bearer ${this.token.accessToken}` } });
    if (!res.ok) throw new HttpError(502, `pCloud ${method} HTTP ${res.status}`);
    const j: any = await res.json();
    if (j.result !== 0) {
      const code = [1000, 2000, 2094, 2095].includes(j.result) ? 'pcloud_auth' : 'upstream_error';
      throw new HttpError(code === 'pcloud_auth' ? 401 : 502, `pCloud ${method}: ${j.error || j.result}`, code, { result: j.result });
    }
    return j as T;
  }

  userinfo() { return this.call<{ email: string; quota: number; usedquota: number; userid: number }>('userinfo'); }
  async listFolder(folderId: number, recursive = false): Promise<PcloudMeta> {
    const j = await this.call<{ metadata: PcloudMeta }>('listfolder', { folderid: folderId, recursive: recursive ? 1 : undefined });
    return j.metadata;
  }
  async fileLink(fileId: number, opts: { contenttype?: string } = {}) {
    const j = await this.call<{ hosts: string[]; path: string; expires: string }>('getfilelink', { fileid: fileId, contenttype: opts.contenttype });
    return { url: `https://${j.hosts[0]}${j.path}`, alternatives: j.hosts.slice(1).map((h) => `https://${h}${j.path}`), expires: j.expires };
  }
  async videoLinks(fileId: number) {
    const j = await this.call<{ variants: any[] }>('getvideolinks', { fileid: fileId });
    return (j.variants || []).map((v) => ({
      url: `https://${v.hosts[0]}${v.path}`, width: v.width ?? null, height: v.height ?? null, bitrate: v.videobitrate ?? v.bitrate ?? null,
      isOriginal: !!v.isoriginal, duration: v.duration ? Number(v.duration) : null, expires: v.expires ?? null,
    }));
  }
  async hlsLink(fileId: number) {
    const j = await this.call<{ hosts: string[]; path: string }>('gethlslink', { fileid: fileId });
    return `https://${j.hosts[0]}${j.path}`;
  }
  async downloadToFolder(url: string, folderId: number) {
    return this.call('downloadfileasync', { url, folderid: folderId });
  }
  async thumbLink(fileId: number, size = '640x360', crop = 0) {
    const j = await this.call<{ hosts: string[]; path: string }>('getthumblink', { fileid: fileId, size, crop, type: 'jpg' });
    return `https://${j.hosts[0]}${j.path}`;
  }

  /** Folder id of `name` inside `parentId`, creating it when missing. */
  async ensureFolder(name: string, parentId = 0): Promise<number> {
    try {
      const j = await this.call<{ metadata: PcloudMeta }>('createfolder', { name, folderid: parentId });
      if (j.metadata?.folderid != null) return j.metadata.folderid;
    } catch { /* already exists, or a race with another create */ }
    const meta = await this.listFolder(parentId, false);
    const hit = (meta.contents || []).find((c) => c.isfolder && c.name === name);
    if (hit?.folderid != null) return hit.folderid;
    throw new HttpError(502, `pCloud folder "${name}" could not be created`, 'pcloud_folder');
  }

  async deleteFile(fileId: number) {
    await this.call('deletefile', { fileid: fileId });
  }

  /** Multipart upload. Returns the new pCloud file id. */
  async uploadFile(folderId: number, filename: string, body: Buffer): Promise<number> {
    if (!this.token) throw new HttpError(409, 'pCloud is not connected', 'pcloud_not_connected');
    if (!/^e?api\.pcloud\.com$/.test(this.token.host)) throw new HttpError(400, 'Invalid pCloud hostname', 'bad_request');
    const u = new URL(`https://${this.token.host}/uploadfile`);
    u.searchParams.set('folderid', String(folderId));
    u.searchParams.set('filename', filename);
    u.searchParams.set('nopartial', '1');
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(body)]), filename);
    const res = await this.f(u.toString(), { method: 'POST', body: fd, headers: { Authorization: `Bearer ${this.token.accessToken}` } });
    if (!res.ok) throw new HttpError(502, `pCloud uploadfile HTTP ${res.status}`);
    const j: any = await res.json().catch(() => ({}));
    if (j.result !== 0) throw new HttpError(502, `pCloud uploadfile: ${j.error || j.result}`, 'upstream_error');
    const id = j.fileids?.[0] ?? j.metadata?.[0]?.fileid;
    if (id == null) throw new HttpError(502, 'pCloud uploadfile returned no file id', 'upstream_error');
    return Number(id);
  }

  /** Replace a named file in a folder (pCloud allows duplicate names, so the previous one is deleted). */
  async replaceFile(folderId: number, filename: string, body: Buffer): Promise<number> {
    try {
      const meta = await this.listFolder(folderId, false);
      for (const c of meta.contents || []) if (!c.isfolder && c.name === filename && c.fileid != null) {
        try { await this.deleteFile(c.fileid); } catch { /* keep going */ }
      }
    } catch { /* folder listing is best-effort; the upload still lands */ }
    return this.uploadFile(folderId, filename, body);
  }

  async downloadFile(fileId: number): Promise<Buffer> {
    const link = await this.fileLink(fileId);
    const res = await this.f(link.url);
    if (!res.ok) throw new HttpError(502, `pCloud download HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
