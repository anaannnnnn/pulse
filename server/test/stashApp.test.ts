import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { makeMockTpdb } from './mockTpdb.js';
import { GOOD_KEY, makeMockStash } from './mockStashdb.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-stash-'));
const { buildApp } = await import('../src/app.js');
const { openDb } = await import('../src/db.js');

let app: any;
const tpdb = makeMockTpdb();
const stash = makeMockStash();
const f = ((input: any, init?: any) => (new URL(String(input)).host === 'stashdb.org' ? stash.f(input, init) : tpdb.f(input, init))) as typeof fetch;
let cookies: Record<string, string> = {};
const json = async (method: string, url: string, body?: any) => {
  const r = await app.inject({ method, url, payload: body, cookies });
  return { status: r.statusCode, body: r.headers['content-type']?.includes('json') ? r.json() : r.body };
};
const waitIdle = async () => { for (let i = 0; i < 200; i++) { const s = (await json('GET', '/api/match/status')).body; if (s.state === 'idle' && s.queued === 0) return s; await new Promise((r) => setTimeout(r, 25)); } throw new Error('timeout'); };
const addScene = (name: string) => Number(app.ctx.db.prepare(`INSERT INTO scenes(ext_key, source, path, file_name, parsed, match_status) VALUES(?,?,?,?,?,?)`).run(`pcloud:${name}`, 'pcloud', `/Videos/${name}`, name, '{}', 'unmatched').lastInsertRowid);

beforeAll(async () => {
  app = await buildApp({ db: openDb(':memory:'), fetch: f, env: { tpdbKey: 'TK', tpdbIntervalMs: 0, stashdbKey: GOOD_KEY, stashdbIntervalMs: 0 } as any });
  const u = await app.inject({ method: 'POST', url: '/api/session/unlock', payload: { pin: '6442' } });
  cookies = { pulse_auth: u.cookies.find((c: any) => c.name === 'pulse_auth').value };
});

describe('StashDB in the app', () => {
  it('session and /api/stashdb/test report the key status without leaking it', async () => {
    expect((await json('GET', '/api/session')).body.stashdb).toEqual({ configured: true });
    const t = await json('GET', '/api/stashdb/test');
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ ok: true, status: 'ok' });
    expect(JSON.stringify(t.body)).not.toContain(GOOD_KEY);
    expect((await json('GET', '/api/metadata/sources')).body.sources).toMatchObject([{ id: 'tpdb', configured: true, enabled: true }, { id: 'stashdb', configured: true, enabled: true, active: true }]);
  });
  it('/api/stashdb/test is behind the PIN lock', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/stashdb/test' });
    expect(r.statusCode).toBe(423);
  });
  it('auto-match: a scene only StashDB knows is matched, with source, performers, tags and studio', async () => {
    const id = addScene('Vixen - Ava Addams and Riley Reid - Velvet Evening Escape (2022-03-03).mp4');
    await json('POST', '/api/match/queue', { sceneIds: [id] });
    const st = await waitIdle();
    expect(st.matched).toBe(1);
    const d = (await json('GET', `/api/scenes/${id}`)).body;
    expect(d).toMatchObject({ matchStatus: 'matched', matchSource: 'stashdb', title: 'Velvet Evening Escape', date: '2022-03-03', studio: { name: 'Vixen' }, stashdb: { id: 'st-only' } });
    expect(d.poster).toContain('cdn.stash.test');
    expect(d.performers.map((p: any) => p.name).sort()).toEqual(['Ava Addams', 'Riley Reid']);
    expect(d.performers.every((p: any) => p.source === 'stashdb' && p.stashId)).toBe(true);
    expect(d.tags.map((t: any) => t.name)).toEqual(['Brunette', 'Romance']);
    expect(d.tags[0].source).toBe('stashdb');
    const ava = d.performers.find((p: any) => p.name === 'Ava Addams');
    const pd = (await json('GET', `/api/performers/${ava.id}`)).body;
    expect(pd).toMatchObject({ aliases: ['Ava A', 'Ava Adams'], birthday: '1979-09-14', measurements: '34DD-25-36', height: '170cm', hairColor: 'Brunette', nationality: 'US', careerStart: '2002' });
    expect(pd.images.length).toBe(2);
    expect(pd.links.StashDB).toContain('stashdb.org/performers/perf-ava');
    const studios = (await json('GET', '/api/studios')).body.items;
    expect(studios.find((s: any) => s.name === 'Vixen')).toMatchObject({ source: 'stashdb' });
    expect((await json('GET', '/api/tags')).body.items[0].source).toBe('stashdb');
  });
  it('a scene on both providers is stored as TPDB with the StashDB id remembered (and the reverse)', async () => {
    const id = addScene('Brazzers.21.05.12.Kendra.Lust.Big.Boobs.Fun.XXX.1080p.mp4');
    await json('POST', '/api/match/queue', { sceneIds: [id] });
    await waitIdle();
    expect((await json('GET', `/api/scenes/${id}`)).body).toMatchObject({ matchStatus: 'matched', matchSource: 'tpdb', tpdb: { id: 's1' } });
    // when both providers returned the scene, the engine hands the other id to apply()
    await app.ctx.matcher.apply(id, 's1', 'scene', 0.9, false, 'parse', 'tpdb', [{ source: 'stashdb', id: 'st-bbf' }]);
    expect((await json('GET', `/api/scenes/${id}`)).body).toMatchObject({ matchSource: 'tpdb', tpdb: { id: 's1' }, stashdb: { id: 'st-bbf' } });
    await app.ctx.matcher.apply(id, 'st-bbf', 'scene', 0.9, false, 'title', 'stashdb', [{ source: 'tpdb', id: 's1' }]);
    expect((await json('GET', `/api/scenes/${id}`)).body).toMatchObject({ matchSource: 'stashdb', tpdb: { id: 's1' }, stashdb: { id: 'st-bbf' } });
  });
  it('manual apply of a StashDB candidate, then unmatch clears the StashDB ids', async () => {
    const id = addScene('random clip 7.mp4');
    const r = await json('POST', `/api/scenes/${id}/match`, { tpdbId: 'st-midnight', source: 'stashdb' });
    expect(r.status).toBe(200);
    expect(r.body.applied.source).toBe('stashdb');
    expect(r.body.scene).toMatchObject({ matchStatus: 'manual', matchSource: 'stashdb', title: 'Midnight Dreams' });
    const u = (await json('POST', `/api/scenes/${id}/unmatch`)).body;
    expect(u).toMatchObject({ matchStatus: 'unmatched', stashdb: null, matchSource: null });
    expect((await json('POST', `/api/scenes/${id}/match`, { tpdbId: 'does-not-exist-123', source: 'stashdb' })).status).toBe(404);
  });
  it('manual search returns StashDB candidates with a source; /api/stashdb/search works', async () => {
    const id = addScene('x.mp4');
    const r = await json('POST', `/api/scenes/${id}/match`, { query: 'Velvet Evening Escape' });
    expect(r.body.candidates.some((c: any) => c.source === 'stashdb' && c.tpdbId === 'st-only')).toBe(true);
    const s = await json('GET', '/api/stashdb/search?q=Midnight%20Dreams');
    expect(s.body.items[0]).toMatchObject({ source: 'stashdb', tpdbId: 'st-midnight', title: 'Midnight Dreams' });
    const p = await json('GET', '/api/stashdb/search?q=Ava&type=performer');
    expect(p.body.items[0]).toMatchObject({ stashId: 'perf-ava', name: 'Ava Addams' });
  });
  it('performer refresh can pull StashDB data for a TPDB performer (existing values win)', async () => {
    const pid = Number(app.ctx.db.prepare(`INSERT INTO performers(name, tpdb_id, name_key, details) VALUES('Ava Addams','tp-ava','avaaddams',?)`).run(JSON.stringify({ id: 'tp-ava', bio: 'tpdb bio', extras: { birthday: '1979-09-15' } })).lastInsertRowid);
    const r = await json('POST', `/api/performers/${pid}/refresh`, { source: 'stashdb' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ bio: 'tpdb bio', birthday: '1979-09-15', measurements: '34DD-25-36', stashId: 'perf-ava', tpdbId: 'tp-ava' });
    expect(r.body.aliases).toContain('Ava A');
  });
  it('settings flags switch providers off and on', async () => {
    await json('PUT', '/api/settings', { metadata: { stashdb: false } });
    expect((await json('GET', '/api/settings')).body.metadata).toMatchObject({ tpdb: true, stashdb: false });
    expect((await json('GET', '/api/metadata/sources')).body.sources[1]).toMatchObject({ enabled: false, active: false });
    const calls = stash.calls.length;
    const id = addScene('Vixen - Midnight Dreams (2020-08-14).mp4');
    await json('POST', '/api/match/queue', { sceneIds: [id] });
    await waitIdle();
    expect(stash.calls.length).toBe(calls);                 // StashDB untouched while disabled
    expect((await json('GET', `/api/scenes/${id}`)).body.matchStatus).not.toBe('matched');   // only StashDB has this one

    await json('PUT', '/api/settings', { metadata: { stashdb: true, tpdb: false } });
    const tp = tpdb.hits.length;
    await json('POST', '/api/match/queue', { sceneIds: [id] });
    await waitIdle();
    expect(tpdb.hits.length).toBe(tp);                       // ThePornDB untouched while disabled
    expect((await json('GET', `/api/scenes/${id}`)).body).toMatchObject({ matchStatus: 'matched', matchSource: 'stashdb' });

    await json('PUT', '/api/settings', { metadata: { tpdb: false, stashdb: false } });
    const q = await json('POST', '/api/match/queue', { sceneIds: [id] });
    expect(q.status).toBe(409);
    await json('PUT', '/api/settings', { metadata: { tpdb: true, stashdb: true } });
  });
});
