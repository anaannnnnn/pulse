import { describe, it, expect } from 'vitest';
import { fakeFetch } from './helpers.js';
import { PcloudClient, buildAuthorizeUrl, parseCallbackInput, hostFromLocation } from '../src/clients/pcloud.js';
import { TpdbClient, pickImage } from '../src/clients/tpdb.js';
import { TorboxClient, normalizeItem } from '../src/clients/torbox.js';
import { scoreCandidate, toCandidate } from '../src/services/matcher.js';
import { parseFilename } from '../src/parser.js';

describe('pCloud client', () => {
  it('builds authorize url with and without redirect', () => {
    const u = new URL(buildAuthorizeUrl({ clientId: 'cid', redirectUri: 'http://h/api/pcloud/callback', state: 's' }));
    expect(u.origin + u.pathname).toBe('https://my.pcloud.com/oauth2/authorize');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('redirect_uri')).toBe('http://h/api/pcloud/callback');
    expect(new URL(buildAuthorizeUrl({ clientId: 'cid' })).searchParams.has('redirect_uri')).toBe(false);
  });
  it('parses pasted callback urls and bare codes', () => {
    expect(parseCallbackInput('https://x/api/pcloud/callback?code=abc&state=s&locationid=2&hostname=eapi.pcloud.com')).toEqual({ code: 'abc', state: 's', locationid: 2, hostname: 'eapi.pcloud.com' });
    expect(parseCallbackInput('  XYZ123 ').code).toBe('XYZ123');
    expect(hostFromLocation(2)).toBe('eapi.pcloud.com');
    expect(hostFromLocation(1)).toBe('api.pcloud.com');
  });
  it('exchanges code, falling back from US to EU', async () => {
    const { f, calls } = fakeFetch((u) => (u.host === 'api.pcloud.com' ? { result: 2012, error: 'Invalid code' } : { result: 0, access_token: 'tok', uid: 1, locationid: 2 }));
    const t = await PcloudClient.exchangeCode({ clientId: 'c', clientSecret: 's', code: 'k', f });
    expect(t).toMatchObject({ accessToken: 'tok', host: 'eapi.pcloud.com', locationid: 2 });
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['api.pcloud.com', 'eapi.pcloud.com']);
    expect(String(calls[0].init.body)).toContain('client_secret=s');
  });
  it('rejects unknown hostnames', async () => {
    const { f } = fakeFetch(() => ({}));
    await expect(PcloudClient.exchangeCode({ clientId: 'c', clientSecret: 's', code: 'k', host: 'evil.com', f })).rejects.toThrow(/Invalid pCloud hostname/);
  });
  it('calls methods with bearer token and builds links', async () => {
    const { f, calls } = fakeFetch((u) => {
      if (u.pathname === '/getfilelink') return { result: 0, hosts: ['c1.pcloud.com', 'c2.pcloud.com'], path: '/abc/v.mp4', expires: 'Thu, 03 Oct 2030 01:06:49 +0000' };
      if (u.pathname === '/getvideolinks') return { result: 0, variants: [{ isoriginal: true, hosts: ['c1'], path: '/o', width: 1920, height: 1080 }, { isoriginal: false, hosts: ['c3'], path: '/t', width: 1280, height: 720, videobitrate: 2000 }] };
      if (u.pathname === '/listfolder') return { result: 1000, error: 'Log in required.' };
      return { result: 0 };
    });
    const c = new PcloudClient({ accessToken: 'TOK', host: 'eapi.pcloud.com' }, f);
    const l = await c.fileLink(5);
    expect(l.url).toBe('https://c1.pcloud.com/abc/v.mp4');
    expect(l.alternatives).toEqual(['https://c2.pcloud.com/abc/v.mp4']);
    expect(calls[0].init.headers.Authorization).toBe('Bearer TOK');
    expect(new URL(calls[0].url).host).toBe('eapi.pcloud.com');
    const v = await c.videoLinks(5);
    expect(v[1]).toMatchObject({ url: 'https://c3/t', height: 720, bitrate: 2000, isOriginal: false });
    await expect(c.listFolder(0, true)).rejects.toMatchObject({ code: 'pcloud_auth', status: 401 });
  });
  it('throws pcloud_not_connected without token', async () => {
    await expect(new PcloudClient(null).userinfo()).rejects.toMatchObject({ code: 'pcloud_not_connected' });
  });
});

describe('TPDB client', () => {
  it('sends bearer auth, uses cache and parse param', async () => {
    const store = new Map<string, any>();
    const cache = { get: (k: string) => store.get(k), set: (k: string, v: any) => store.set(k, v) };
    const { f, calls } = fakeFetch(() => ({ data: [{ id: 'x1', title: 'T', date: '2021-03-15', site: { name: 'Brazzers' }, performers: [{ name: 'Riley Reid' }] }] }));
    const c = new TpdbClient('KEY', cache, f, 0);
    const r1 = await c.parse('scene', 'brazzers.21.03.15.title');
    const r2 = await c.parse('scene', 'brazzers.21.03.15.title');
    expect(r1).toEqual(r2);
    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers.Authorization).toBe('Bearer KEY');
    expect(new URL(calls[0].url).searchParams.get('parse')).toBe('brazzers.21.03.15.title');
  });
  it('retries on 429 and maps 401', async () => {
    let n = 0;
    const { f } = fakeFetch(() => (n++ === 0 ? new Response('{}', { status: 429, headers: { 'retry-after': '0' } }) : { data: { id: 'p' } }));
    expect(await new TpdbClient('K', undefined, f, 0).performer('p')).toEqual({ id: 'p' });
    const bad = fakeFetch(() => new Response('{}', { status: 401 }));
    await expect(new TpdbClient('K', undefined, bad.f, 0).search('scene', 'x')).rejects.toMatchObject({ code: 'tpdb_auth' });
  });
  it('pickImage handles strings, objects and arrays', () => {
    expect(pickImage({ posters: { large: 'L' } }, 'posters')).toBe('L');
    expect(pickImage({ posters: [{ url: 'U' }] }, 'posters')).toBe('U');
    expect(pickImage({ image: 'I' }, 'poster', 'image')).toBe('I');
  });
  it('scores candidates', () => {
    const parsed = parseFilename('Brazzers.21.03.15.Riley.Reid.And.Lana.Rhoades.Hot.Night.XXX.1080p.mp4');
    const good = toCandidate({ id: 1, title: 'Hot Night', date: '2021-03-15', site: { name: 'Brazzers' }, performers: [{ name: 'Riley Reid' }, { name: 'Lana Rhoades' }] }, 'scene');
    const bad = toCandidate({ id: 2, title: 'Other', date: '2019-01-01', site: { name: 'Vixen' }, performers: [] }, 'scene');
    expect(scoreCandidate(parsed, good)).toBeGreaterThan(0.95);
    expect(scoreCandidate(parsed, bad)).toBeLessThan(0.2);
  });
});

describe('TorBox client', () => {
  it('validates key via /user/me', async () => {
    const { f, calls } = fakeFetch((u) => (u.pathname.endsWith('/user/me') ? { success: true, data: { email: 'a@b', plan: 2 } } : {}));
    expect(await new TorboxClient('K', f).me()).toMatchObject({ plan: 2 });
    expect(calls[0].url).toBe('https://api.torbox.app/v1/api/user/me');
    expect(calls[0].init.headers.Authorization).toBe('Bearer K');
  });
  it('maps bad token to invalid_key', async () => {
    const { f } = fakeFetch(() => new Response(JSON.stringify({ success: false, error: 'BAD_TOKEN', detail: 'bad' }), { status: 403 }));
    await expect(new TorboxClient('K', f).me()).rejects.toMatchObject({ code: 'invalid_key' });
  });
  it('lists, checks cache, requests download links', async () => {
    const { f, calls } = fakeFetch((u) => {
      if (u.pathname.endsWith('/torrents/mylist')) return { success: true, data: [{ id: 7, name: 'n', hash: 'h', size: 10, progress: 1, download_state: 'cached', download_finished: true, download_present: true, files: [{ id: 1, name: 'd/a.mkv', short_name: 'a.mkv', size: 5, mimetype: 'video/x-matroska' }, { id: 2, name: 'd/a.nfo', size: 1 }] }] };
      if (u.pathname.endsWith('/torrents/checkcached')) return { success: true, data: { h: { name: 'n', size: 10, files: [{ name: 'a.mkv', size: 5 }] } } };
      if (u.pathname.endsWith('/torrents/requestdl')) return { success: true, data: 'https://cdn/x' };
      return { success: true, data: { torrent_id: 9, hash: 'h2' } };
    });
    const tb = new TorboxClient('K', f);
    const [it] = await tb.list('torrents');
    expect(it).toMatchObject({ id: 7, ready: true, progress: 1 });
    expect(it.files.map((x: any) => x.isVideo)).toEqual([true, false]);
    expect(await tb.checkCached(['h', 'z'])).toEqual({ h: { name: 'n', size: 10, files: [{ name: 'a.mkv', size: 5 }] }, z: false });
    expect(await tb.requestDownload('torrents', 7, 1)).toBe('https://cdn/x');
    const rq = new URL(calls[2].url);
    expect(rq.searchParams.get('torrent_id')).toBe('7');
    expect(rq.searchParams.get('redirect')).toBe('false');
    const add = await tb.addMagnet('magnet:?xt=urn:btih:abc');
    expect(add.data.torrent_id).toBe(9);
    expect(calls[3].init.body).toBeInstanceOf(FormData);
  });
  it('normalizeItem usenet', () => {
    expect(normalizeItem('usenet', { id: 1, name: 'x', download_state: 'downloading', progress: 0.5, files: [] })).toMatchObject({ type: 'usenet', ready: false, progress: 0.5 });
  });
});
