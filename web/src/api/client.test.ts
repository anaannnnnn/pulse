import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, authUrl, getToken, httpApi, itemQuery, mapScene, setToken, toQuery } from './client';

const res = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) }) as unknown as Response;

afterEach(() => vi.unstubAllGlobals());

describe('itemQuery', () => {
  it('maps UI filters to the API.md query contract', () => {
    const qs = itemQuery({ q: 'miami', offset: 80, limit: 40, minDuration: 15, maxDuration: 30, status: 'unmatched', sites: [3], sort: 'date', order: 'desc' } as never);
    const p = new URLSearchParams(qs.slice(1));
    expect(p.get('page')).toBe('3');
    expect(p.get('pageSize')).toBe('40');
    expect(p.get('minDuration')).toBe('900');
    expect(p.get('maxDuration')).toBe('1800');
    expect(p.get('matched')).toBe('false');
    expect(p.get('studio')).toBe('3');
    expect(p.get('q')).toBe('miami');
  });
  it('drops empty values', () => {
    expect(toQuery({ a: undefined, b: '', c: 1 })).toBe('?c=1');
  });
});

describe('mapScene', () => {
  it('normalises wire match statuses', () => {
    const base = { id: 7, title: 'A', fileName: 'a.mp4', path: '/a.mp4', size: 1, duration: 60, addedAt: '2026-10-01T00:00:00Z', matchStatus: 'manual' } as never;
    const it = mapScene(base);
    expect(it.id).toBe('7');
    expect(it.matchStatus).toBe('matched');
    expect(mapScene({ ...(base as object), matchStatus: 'failed' } as never).matchStatus).toBe('unmatched');
    expect(mapScene({ ...(base as object), matchStatus: 'queued' } as never).matchStatus).toBe('pending');
  });
});

describe('req errors', () => {
  it('surfaces {error:{code,message}} as ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(404, { error: { code: 'not_found', message: 'Scene not found' } })));
    await expect(httpApi.facets()).rejects.toMatchObject({ status: 404, message: 'Scene not found' });
    await expect(httpApi.facets()).rejects.toBeInstanceOf(ApiError);
  });
  it('maps /session to SessionInfo', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => (u.endsWith('/session') ? res(200, { locked: false, pinEnabled: true }) : res(200, { autoLockMinutes: 5, pinEnabled: true }))));
    expect(await httpApi.session()).toEqual({ paired: true, lockEnabled: true, locked: false, lockTimeoutMin: 5, pinLength: null });
  });
});

describe('session token fallback (cookie-less browsers, iOS standalone PWA)', () => {
  const store = new Map<string, string>();
  const ls = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  afterEach(() => store.clear());
  type F = ReturnType<typeof vi.fn<(u: string, i?: RequestInit) => Promise<Response>>>;
  const hdr = (f: F) => (f.mock.calls.at(-1)![1] as RequestInit).headers as Record<string, string>;

  it('unlock stores the returned token and every later request sends it as Authorization: Bearer (and bypasses HTTP caches)', async () => {
    vi.stubGlobal('localStorage', ls);
    const f: F = vi.fn(async (_u: string, _i?: RequestInit) => ({ ...res(200, { locked: false, token: 'v1.a.b' }), headers: new Headers() }) as unknown as Response);
    vi.stubGlobal('fetch', f);
    await httpApi.unlock('6442');
    expect(getToken()).toBe('v1.a.b');
    await httpApi.tpdbTest();
    expect(hdr(f).Authorization).toBe('Bearer v1.a.b');
    expect((f.mock.calls.at(-1)![1] as RequestInit).cache).toBe('no-store');
  });
  it('adopts a refreshed token from x-pulse-token and clears it on lock / when the server says locked', async () => {
    vi.stubGlobal('localStorage', ls);
    setToken('old');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ...res(200, {}), headers: new Headers({ 'x-pulse-token': 'fresh' }) }) as unknown as Response));
    await httpApi.tpdbTest();
    expect(getToken()).toBe('fresh');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ...res(200, { locked: true, pinEnabled: true }), headers: new Headers() }) as unknown as Response));
    await httpApi.session();
    expect(getToken()).toBeNull();
  });
  it('authUrl appends ?pt= only to same-origin /api URLs and only when a token exists', () => {
    vi.stubGlobal('localStorage', ls);
    expect(authUrl('/api/scenes/1/thumb')).toBe('/api/scenes/1/thumb');
    setToken('v1.a.b');
    expect(authUrl('/api/scenes/1/thumb')).toBe('/api/scenes/1/thumb?pt=v1.a.b');
    expect(authUrl('/api/x?size=1')).toBe('/api/x?size=1&pt=v1.a.b');
    expect(authUrl('https://cdn.example/x.jpg')).toBe('https://cdn.example/x.jpg');
    expect(authUrl(null)).toBe('');
  });
});
