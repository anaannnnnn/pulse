import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpApi, mapScene } from './client';
import { providerLabel } from '../lib/format';

const res = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) }) as unknown as Response;
afterEach(() => vi.unstubAllGlobals());

describe('StashDB support', () => {
  it('maps the provider of a matched scene (badge source)', () => {
    const base = { id: 3, title: 'T', fileName: 'a.mp4', path: '/a.mp4', size: 1, duration: 60, addedAt: '2026-10-01T00:00:00Z', matchStatus: 'matched' } as never;
    expect(mapScene({ ...(base as object), matchSource: 'stashdb' } as never).provider).toBe('stashdb');
    expect(mapScene(base).provider).toBeNull();
    const detail = { ...(base as object), matchSource: 'stashdb', stashdb: { id: 'abc', url: 'https://stashdb.org/scenes/abc' }, tpdb: null, tags: [], performers: [] } as never;
    expect(mapScene(detail, detail).scene?.id).toBe('abc');
    expect(providerLabel('stashdb')).toBe('StashDB');
    expect(providerLabel('tpdb')).toBe('ThePornDB');
  });
  it('applyMatch sends the provider, candidates carry their source', async () => {
    const f = vi.fn(async (u: string, init?: { body?: string }) => {
      if (u.endsWith('/match') && init?.body && JSON.parse(init.body).query) return res(200, { query: 'q', strategy: 'title', confident: false, candidates: [{ tpdbId: 'st1', type: 'scene', title: 'X', date: null, studio: null, performers: [], poster: null, confidence: 0.8, source: 'stashdb', alsoOn: [{ source: 'tpdb', id: 't1' }] }] });
      return res(200, { scene: { id: 1, title: 'X', fileName: 'a.mp4', path: '/a.mp4', size: 1, matchStatus: 'manual', tags: [], performers: [], addedAt: '2026-10-01T00:00:00Z' } });
    });
    vi.stubGlobal('fetch', f);
    const s = await httpApi.matchSearch({ itemId: '1', q: 'x' });
    expect(s.candidates[0]).toMatchObject({ id: 'st1', source: 'stashdb', alsoOn: [{ source: 'tpdb', id: 't1' }] });
    await httpApi.applyMatch('1', 'st1', 'scene', 'stashdb');
    expect(JSON.parse((f.mock.calls.at(-1) as unknown as [string, { body: string }])[1].body)).toMatchObject({ tpdbId: 'st1', source: 'stashdb' });
  });
  it('stashdbTest and metadataSources call the new endpoints', async () => {
    const f = vi.fn(async (u: string) => (u.endsWith('/stashdb/test') ? res(200, { ok: false, status: 'unauthorized', hint: 'bad key' }) : res(200, { sources: [{ id: 'stashdb', label: 'StashDB', configured: true, enabled: true, active: true }] })));
    vi.stubGlobal('fetch', f);
    expect(await httpApi.stashdbTest()).toMatchObject({ ok: false, status: 'unauthorized' });
    expect((await httpApi.metadataSources())[0].id).toBe('stashdb');
    await httpApi.setMetadataSource('stashdb', false);
    expect(String(f.mock.calls.at(-1)![0])).toContain('/settings');
  });
});
