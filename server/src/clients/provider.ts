// Common shape for metadata providers (ThePornDB, StashDB). Providers normalise their payloads into these
// records so the matcher, the scorer and the DB writers can treat both sources the same way.
import { TpdbClient, pickImage, type Cache } from './tpdb.js';

export type ProviderId = 'tpdb' | 'stashdb';
export const PROVIDER_LABEL: Record<ProviderId, string> = { tpdb: 'ThePornDB', stashdb: 'StashDB' };

export type ProviderTest = { ok: boolean; status: 'ok' | 'not_configured' | 'unauthorized' | 'unreachable' | 'error'; hint: string };

export type NormPerformer = {
  source: ProviderId; id: string; name: string; aliases: string[]; gender: string | null;
  image: string | null; thumb: string | null; images: string[];
  /** TPDB-shaped details blob (`extras`, `posters`, `bio`...) as stored in performers.details. */
  details: any;
};
export type NormScene = {
  source: ProviderId; id: string; title: string; date: string | null; description: string | null;
  studio: { id: string | null; name: string; parent: string | null; logo: string | null } | null;
  performers: NormPerformer[];
  tags: { id: string | null; name: string }[];
  poster: string | null; backdrop: string | null; trailer: string | null;
  duration: number | null; url: string | null; code: string | null;
};

export interface MetadataProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** An API key is present (does not say whether it is valid). */
  readonly configured: boolean;
  /** Cheap authenticated call; never throws and never contains the key. */
  test(): Promise<ProviderTest>;
  searchScenes(term: string, limit?: number): Promise<NormScene[]>;
  scene(id: string): Promise<NormScene | null>;
  searchPerformers(term: string, limit?: number): Promise<NormPerformer[]>;
  performer(id: string): Promise<NormPerformer | null>;
}

export type ProviderCache = Cache;

// ---------------------------------------------------------------- ThePornDB adapter
export function normalizeTpdbPerformer(p: any): NormPerformer {
  const src = p.parent && typeof p.parent === 'object' ? { ...p, ...p.parent, extras: p.parent.extras || p.extras || p.extra } : p;
  const image = src.image || src.thumbnail || null;
  const images: string[] = (src.posters || []).map((x: any) => x?.url).filter(Boolean);
  if (image && !images.includes(image)) images.unshift(image);
  return { source: 'tpdb', id: String(src.id ?? src._id), name: src.name, aliases: src.aliases || [], gender: src.extras?.gender || src.extra?.gender || null, image, thumb: src.thumbnail || src.face || image, images, details: src };
}
export function normalizeTpdbScene(x: any): NormScene {
  const s = x.site;
  return {
    source: 'tpdb', id: String(x.id ?? x._id), title: x.title || '', date: x.date || null, description: x.description || null,
    studio: s?.name ? { id: s.uuid || (s.id != null ? String(s.id) : null), name: s.name, parent: s.parent?.name || s.network?.name || null, logo: s.logo || null } : null,
    performers: (x.performers || []).map(normalizeTpdbPerformer),
    tags: (x.tags || []).map((t: any) => ({ id: t.uuid || (t.id != null ? String(t.id) : null), name: t.name })),
    poster: pickImage(x, 'posters', 'poster', 'image'), backdrop: pickImage(x, 'background', 'image', 'poster'), trailer: x.trailer || null,
    duration: x.duration ?? null, url: x.url || null, code: x.external_id || null,
  };
}

export class TpdbProvider implements MetadataProvider {
  readonly id = 'tpdb' as const;
  readonly label = 'ThePornDB';
  constructor(public client: TpdbClient) {}
  get configured() { return this.client.configured; }
  async test(): Promise<ProviderTest> {
    if (!this.client.configured) return { ok: false, status: 'not_configured', hint: 'TPDB_API_KEY is not set on the server.' };
    try { await this.client.get('/scenes', { per_page: 1 }, 0); return { ok: true, status: 'ok', hint: 'ThePornDB key works.' }; }
    catch (e: any) {
      if (e?.code === 'tpdb_auth') return { ok: false, status: 'unauthorized', hint: 'ThePornDB rejected the API key.' };
      return { ok: false, status: 'error', hint: String(e?.message || 'ThePornDB error').slice(0, 200) };
    }
  }
  async searchScenes(term: string, limit = 15) { return (await this.client.search('scene', term, { perPage: limit })).map(normalizeTpdbScene); }
  async scene(id: string) { const x = await this.client.item('scene', id); return x ? normalizeTpdbScene(x) : null; }
  async searchPerformers(term: string, limit = 10) { return (await this.client.searchPerformers(term)).slice(0, limit).map(normalizeTpdbPerformer); }
  async performer(id: string) { const x = await this.client.performer(id); return x ? normalizeTpdbPerformer(x) : null; }
}
