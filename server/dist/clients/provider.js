// Common shape for metadata providers (ThePornDB, StashDB). Providers normalise their payloads into these
// records so the matcher, the scorer and the DB writers can treat both sources the same way.
import { pickImage } from './tpdb.js';
export const PROVIDER_LABEL = { tpdb: 'ThePornDB', stashdb: 'StashDB' };
// ---------------------------------------------------------------- ThePornDB adapter
export function normalizeTpdbPerformer(p) {
    const src = p.parent && typeof p.parent === 'object' ? { ...p, ...p.parent, extras: p.parent.extras || p.extras || p.extra } : p;
    const image = src.image || src.thumbnail || null;
    const images = (src.posters || []).map((x) => x?.url).filter(Boolean);
    if (image && !images.includes(image))
        images.unshift(image);
    return { source: 'tpdb', id: String(src.id ?? src._id), name: src.name, aliases: src.aliases || [], gender: src.extras?.gender || src.extra?.gender || null, image, thumb: src.thumbnail || src.face || image, images, details: src };
}
export function normalizeTpdbScene(x) {
    const s = x.site;
    return {
        source: 'tpdb', id: String(x.id ?? x._id), title: x.title || '', date: x.date || null, description: x.description || null,
        studio: s?.name ? { id: s.uuid || (s.id != null ? String(s.id) : null), name: s.name, parent: s.parent?.name || s.network?.name || null, logo: s.logo || null } : null,
        performers: (x.performers || []).map(normalizeTpdbPerformer),
        tags: (x.tags || []).map((t) => ({ id: t.uuid || (t.id != null ? String(t.id) : null), name: t.name })),
        poster: pickImage(x, 'posters', 'poster', 'image'), backdrop: pickImage(x, 'background', 'image', 'poster'), trailer: x.trailer || null,
        duration: x.duration ?? null, url: x.url || null, code: x.external_id || null,
    };
}
export class TpdbProvider {
    client;
    id = 'tpdb';
    label = 'ThePornDB';
    constructor(client) {
        this.client = client;
    }
    get configured() { return this.client.configured; }
    async test() {
        if (!this.client.configured)
            return { ok: false, status: 'not_configured', hint: 'TPDB_API_KEY is not set on the server.' };
        try {
            await this.client.get('/scenes', { per_page: 1 }, 0);
            return { ok: true, status: 'ok', hint: 'ThePornDB key works.' };
        }
        catch (e) {
            if (e?.code === 'tpdb_auth')
                return { ok: false, status: 'unauthorized', hint: 'ThePornDB rejected the API key.' };
            return { ok: false, status: 'error', hint: String(e?.message || 'ThePornDB error').slice(0, 200) };
        }
    }
    async searchScenes(term, limit = 15) { return (await this.client.search('scene', term, { perPage: limit })).map(normalizeTpdbScene); }
    async scene(id) { const x = await this.client.item('scene', id); return x ? normalizeTpdbScene(x) : null; }
    async searchPerformers(term, limit = 10) { return (await this.client.searchPerformers(term)).slice(0, limit).map(normalizeTpdbPerformer); }
    async performer(id) { const x = await this.client.performer(id); return x ? normalizeTpdbPerformer(x) : null; }
}
