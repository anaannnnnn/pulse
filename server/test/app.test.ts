import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fakeFetch } from './helpers.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-test-'));
const { buildApp } = await import('../src/app.js');
const { openDb } = await import('../src/db.js');

const files = [
  { name: 'Brazzers.21.03.15.Riley.Reid.And.Lana.Rhoades.Hot.Night.XXX.1080p.mp4', fileid: 11 },
  { name: 'Brazzers.21.03.15.Riley.Reid.And.Lana.Rhoades.Hot.Night.XXX.1080p.en.srt', fileid: 12 },
  { name: 'random home clip.mov', fileid: 13 },
];
const tpdbScene = { id: 'tp1', title: 'Hot Night', date: '2021-03-15', duration: 1800, description: 'Desc', url: 'https://b/1', site: { name: 'Brazzers', uuid: 'site1', short_name: 'brazzers' },
  performers: [{ id: 'p1', name: 'Riley Reid', image: 'https://i/r.jpg', parent: { id: 'P1', name: 'Riley Reid', image: 'https://i/r.jpg', thumbnail: 'https://i/rt.jpg' } }, { id: 'p2', name: 'Lana Rhoades' }],
  tags: [{ id: 1, name: 'Blonde' }, { id: 2, name: 'Threesome' }], posters: { large: 'https://i/poster.jpg' }, background: { large: 'https://i/bg.jpg' } };

const { f } = fakeFetch((u, init) => {
  const h = u.host;
  if (h === 'api.pcloud.com' || h === 'eapi.pcloud.com') {
    if (u.pathname === '/oauth2_token') return String(init?.body).includes('code=good') ? { result: 0, access_token: 'AT', uid: 1, locationid: 1 } : { result: 2012, error: 'Invalid code' };
    if (u.pathname === '/userinfo') return { result: 0, email: 'me@x', quota: 10, usedquota: 5 };
    if (u.pathname === '/listfolder') return { result: 0, metadata: { name: '/', isfolder: true, folderid: 0, contents: [{ name: 'Videos', isfolder: true, folderid: 5, contents: files.map((x) => ({ ...x, isfolder: false, parentfolderid: 5, size: 100, thumb: true, contenttype: 'video/mp4', created: 'Thu, 03 Oct 2024 01:06:49 +0000' })) }] } };
    if (u.pathname === '/getfilelink') return { result: 0, hosts: ['c1.pcloud.com'], path: `/f/${u.searchParams.get('fileid')}`, expires: 'Thu, 03 Oct 2030 01:06:49 +0000' };
    if (u.pathname === '/getvideolinks') return { result: 0, variants: [{ isoriginal: true, hosts: ['c1.pcloud.com'], path: '/o', duration: '1799' }, { isoriginal: false, hosts: ['c2.pcloud.com'], path: '/720', width: 1280, height: 720 }] };
    if (u.pathname === '/gethlslink') return { result: 0, hosts: ['c3.pcloud.com'], path: '/hls.m3u8' };
    return { result: 2000, error: 'nope' };
  }
  if (h === 'c1.pcloud.com') {
    if (u.pathname === '/f/12') return new Response('1\n00:00:01,000 --> 00:00:02,000\nHi\n');
    return new Response('VIDEOBYTES', { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-9/100', 'content-length': '10' } });
  }
  if (h === 'api.theporndb.net') {
    if (u.pathname === '/scenes' && u.searchParams.get('parse')?.includes('Brazzers')) return { data: [tpdbScene] };
    if (u.pathname === '/scenes/tp1') return { data: tpdbScene };
    if (u.pathname.startsWith('/performers')) return { data: u.pathname === '/performers' ? [{ id: 'P1', name: 'Riley Reid' }] : { id: 'P1', name: 'Riley Reid', bio: 'Bio', extras: { birthday: '1991-07-09', hair_colour: 'Brunette' }, posters: [{ url: 'https://i/p1.jpg' }] } };
    return { data: [] };
  }
  if (h === 'api.torbox.app') {
    if (u.pathname.endsWith('/user/me')) return init?.headers?.Authorization === 'Bearer GOOD' ? { success: true, data: { email: 'tb@x', plan: 2 } } : new Response(JSON.stringify({ success: false, error: 'BAD_TOKEN' }), { status: 403 });
    return { success: true, data: [] };
  }
  return new Response('not mocked', { status: 500 });
});

let app: any;
let authCookies: Record<string, string> = {}; // unlocked PIN session (default PIN 6442), sent with every request unless overridden
const json = async (method: string, url: string, body?: any, cookies?: any) => {
  const r = await app.inject({ method, url, payload: body, cookies: cookies ?? authCookies });
  return { status: r.statusCode, body: r.headers['content-type']?.includes('json') ? r.json() : r.body, headers: r.headers, cookies: r.cookies };
};
const waitFor = async (fn: () => Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 30)); } throw new Error('timeout'); };

beforeAll(async () => {
  app = await buildApp({ db: openDb(':memory:'), fetch: f, env: { pcloud: { clientId: 'CID', clientSecret: 'SEC' }, tpdbKey: 'TK', tpdbIntervalMs: 0, torboxKey: '', publicBaseUrl: 'https://pulse.example' } as any });
  const u = await app.inject({ method: 'POST', url: '/api/session/unlock', payload: { pin: '6442' } });
  authCookies = { pulse_auth: u.cookies.find((c: any) => c.name === 'pulse_auth').value };
});

describe('app integration (mocked upstreams)', () => {
  it('health + session', async () => {
    expect((await json('GET', '/api/health')).body.ok).toBe(true);
    const s = await json('GET', '/api/session');
    expect(s.body).toMatchObject({ locked: false, pcloud: { connected: false }, torbox: { linked: false }, tpdb: { configured: true } });
  });
  it('pCloud OAuth: authorize url, bad and good exchange, callback', async () => {
    const a = await json('GET', '/api/pcloud/authorize-url');
    expect(a.body.redirectUri).toBe('https://pulse.example/api/pcloud/callback');
    expect(a.body.url).toContain('client_id=CID');
    const m = await json('GET', '/api/pcloud/authorize-url?manual=1');
    expect(m.body.url).not.toContain('redirect_uri');
    expect((await json('POST', '/api/pcloud/exchange', { code: 'bad' })).status).toBe(400);
    const cb = await app.inject({ method: 'GET', url: `/api/pcloud/callback?code=good&state=${a.body.state}&locationid=1&hostname=api.pcloud.com`, cookies: authCookies });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/settings?pcloud=connected');
    const ex = await json('POST', '/api/pcloud/exchange', { callbackUrl: 'https://pulse.example/api/pcloud/callback?code=good&locationid=1&hostname=api.pcloud.com' });
    expect(ex.body).toMatchObject({ connected: true, email: 'me@x', region: 'us' });
    // token stored encrypted
    const row = app.ctx.db.prepare("SELECT value, secret FROM kv WHERE key='pcloud.token'").get();
    expect(row.secret).toBe(1);
    expect(row.value).not.toContain('accessToken');
  });
  it('folders + scan + auto match', async () => {
    const fo = await json('GET', '/api/pcloud/folders?folderId=0');
    expect(fo.body.folders[0]).toMatchObject({ folderId: 5, name: 'Videos', path: '/Videos' });
    expect((await json('PUT', '/api/pcloud/scan-folders', { folders: [] })).body.folders).toEqual([]);
    expect((await json('POST', '/api/pcloud/rescan', {})).status).toBe(202);
    await waitFor(async () => (await json('GET', '/api/pcloud/scan')).body.state === 'idle');
    expect((await json('GET', '/api/pcloud/scan')).body).toMatchObject({ videosFound: 2, added: 2 });
    await waitFor(async () => (await json('GET', '/api/match/status')).body.state === 'idle' && (await json('GET', '/api/library?matched=true')).body.total === 1);
    const lib = await json('GET', '/api/library?matched=true');
    expect(lib.body.items[0]).toMatchObject({ title: 'Hot Night', studio: { name: 'Brazzers' }, matchStatus: 'matched', poster: 'https://i/poster.jpg' });
    expect(lib.body.items[0].performers.map((p: any) => p.name)).toEqual(['Lana Rhoades', 'Riley Reid']);
  });
  it('library filters, facets, detail, performers, tags, studios', async () => {
    const all = await json('GET', '/api/library?sort=title&order=asc');
    expect(all.body.total).toBe(2);
    const id = all.body.items.find((s: any) => s.title === 'Hot Night').id;
    expect((await json('GET', '/api/library?matched=false')).body.total).toBe(1);
    expect((await json('GET', '/api/library?q=riley')).body.total).toBe(1);
    expect((await json('GET', '/api/library?year=2020-2022')).body.total).toBe(1);
    const tags = await json('GET', '/api/tags');
    expect(tags.body.items.map((t: any) => t.name).sort()).toEqual(['Blonde', 'Threesome']);
    expect((await json('GET', `/api/library?tags=${tags.body.items[0].id}`)).body.total).toBe(1);
    const d = await json('GET', `/api/scenes/${id}`);
    expect(d.body).toMatchObject({ description: 'Desc', tpdb: { id: 'tp1', type: 'scene' }, backdrop: 'https://i/bg.jpg' });
    expect(d.body.subtitles[0]).toMatchObject({ lang: 'en', format: 'srt' });
    const facets = await json('GET', '/api/library/facets');
    expect(facets.body.totals).toMatchObject({ scenes: 2, matched: 1, unmatched: 1 });
    const perfs = await json('GET', '/api/performers?sort=scenes');
    const riley = perfs.body.items.find((p: any) => p.name === 'Riley Reid');
    const pd = await json('GET', `/api/performers/${riley.id}`);
    expect(pd.body).toMatchObject({ bio: 'Bio', birthday: '1991-07-09', hairColor: 'Brunette' });
    expect(pd.body.scenes).toHaveLength(1);
    expect((await json('GET', '/api/studios')).body.items[0]).toMatchObject({ name: 'Brazzers', sceneCount: 1 });
  });
  it('stream, proxy, subtitles', async () => {
    const id = (await json('GET', '/api/library?matched=true')).body.items[0].id;
    const s = await json('GET', `/api/scenes/${id}/stream`);
    expect(s.body.primary.url).toBe('https://c1.pcloud.com/f/11');
    expect(s.body.alternatives.map((a: any) => a.label)).toEqual(['720p', 'HLS']);
    expect(s.body.hls).toBe('https://c3.pcloud.com/hls.m3u8');
    expect(s.body.subtitles[0].url).toMatch(/\/api\/scenes\/\d+\/subtitles\/\d+/);
    const p = await app.inject({ method: 'GET', url: `/api/scenes/${id}/proxy`, headers: { range: 'bytes=0-9' }, cookies: authCookies });
    expect(p.statusCode).toBe(206);
    expect(p.headers['content-range']).toBe('bytes 0-9/100');
    expect(p.body).toBe('VIDEOBYTES');
    const sub = await app.inject({ method: 'GET', url: s.body.subtitles[0].url, cookies: authCookies });
    expect(sub.headers['content-type']).toContain('text/vtt');
    expect(sub.body).toContain('00:00:01.000 --> 00:00:02.000');
  });
  it('progress, continue watching, favorites, home', async () => {
    const id = (await json('GET', '/api/library?matched=true')).body.items[0].id;
    expect((await json('PUT', `/api/scenes/${id}/progress`, { position: 600, duration: 1800 })).body).toMatchObject({ position: 600, percent: 33.3, completed: false });
    expect((await json('GET', '/api/continue-watching')).body.items[0].id).toBe(id);
    expect((await json('PUT', `/api/scenes/${id}/progress`, { position: 1700 })).body.completed).toBe(true);
    expect((await json('GET', '/api/continue-watching')).body.items).toHaveLength(0);
    expect((await json('POST', '/api/favorites/toggle', { type: 'scene', id })).body.favorite).toBe(true);
    expect((await json('GET', '/api/library?favorites=true')).body.total).toBe(1);
    expect((await json('GET', '/api/favorites')).body.scenes).toHaveLength(1);
    const home = await json('GET', '/api/home');
    expect(home.body.rails.map((r: any) => r.id)).toContain('recent');
    expect((await json('GET', '/api/recently-added?limit=1')).body.items).toHaveLength(1);
  });
  it('manual match/unmatch/patch', async () => {
    const un = (await json('GET', '/api/match/unmatched')).body.items[0];
    expect(un.fileName).toBe('random home clip.mov');
    const r = await json('POST', `/api/scenes/${un.id}/match`, { tpdbId: 'tp1' });
    expect(r.body.scene).toMatchObject({ title: 'Hot Night', matchStatus: 'manual' });
    expect((await json('POST', `/api/scenes/${un.id}/unmatch`)).body.matchStatus).toBe('unmatched');
    const p = await json('PATCH', `/api/scenes/${un.id}`, { title: 'My Clip', performerNames: ['Someone'], tagNames: ['Home'] });
    expect(p.body).toMatchObject({ title: 'My Clip', matchStatus: 'manual' });
    expect(p.body.performers[0].name).toBe('Someone');
  });
  it('TorBox link validation', async () => {
    expect((await json('GET', '/api/torbox/link')).body.linked).toBe(false);
    expect((await json('GET', '/api/torbox/downloads')).body.error.code).toBe('torbox_not_linked');
    expect((await json('PUT', '/api/torbox/link', { apiKey: 'BAD' })).body.error.code).toBe('invalid_key');
    const ok = await json('PUT', '/api/torbox/link', { apiKey: 'GOOD' });
    expect(ok.body).toMatchObject({ linked: true, source: 'user', plan: 2, planName: 'Pro' });
    expect((await json('GET', '/api/torbox/downloads')).body.items).toEqual([]);
    expect((await json('DELETE', '/api/torbox/link')).body.linked).toBe(false);
  });
  it('settings + change PIN', async () => {
    expect((await json('PUT', '/api/settings', { playback: { skipSeconds: 30 } })).body.playback).toMatchObject({ skipSeconds: 30, autoplayNext: true });
    expect((await json('POST', '/api/settings/pin', { pin: '2468' })).status).toBe(401); // current PIN required
    expect((await json('POST', '/api/settings/pin', { pin: '12', currentPin: '6442' })).status).toBe(400);
    const set = await json('POST', '/api/settings/pin', { pin: '6442', currentPin: '6442' });
    expect(set.body.pinEnabled).toBe(true);
    authCookies = { pulse_auth: set.cookies.find((c: any) => c.name === 'pulse_auth').value };
    expect((await json('GET', '/api/library')).status).toBe(200);
  });
  it('unknown api route is JSON 404', async () => {
    const r = await json('GET', '/api/nope');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('not_found');
  });
});
