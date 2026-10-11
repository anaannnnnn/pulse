import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { makeMockTpdb } from './mockTpdb.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-retry-'));
const { buildApp } = await import('../src/app.js');
const { openDb } = await import('../src/db.js');

let app: any, mock: ReturnType<typeof makeMockTpdb>;
let authCookies: Record<string, string> = {}; // unlocked session (default PIN)
const json = async (method: string, url: string, body?: any, cookies?: any) => {
  const r = await app.inject({ method, url, payload: body, cookies: cookies ?? authCookies });
  return { status: r.statusCode, body: r.headers['content-type']?.includes('json') ? r.json() : r.body, headers: r.headers, cookies: r.cookies };
};
const waitIdle = async () => { for (let i = 0; i < 200; i++) { const s = (await json('GET', '/api/match/status')).body; if (s.state === 'idle' && s.queued === 0) return s; await new Promise((r) => setTimeout(r, 25)); } throw new Error('timeout'); };
const names = [
  'Brazzers.21.05.12.Kendra.Lust.Big.Boobs.Fun.XXX.1080p.MP4-KTR.mp4',
  'big_boobs_fun_[720p]_x264.mkv',
  'Pool Party Surprise Extra Bonus Footage Uncut.mp4',
  'IMG_0001.mov',
];
let ids: number[] = [];

beforeAll(async () => {
  mock = makeMockTpdb();
  app = await buildApp({ db: openDb(':memory:'), fetch: mock.f, env: { tpdbKey: 'TK', tpdbIntervalMs: 0 } as any });
  const u = await app.inject({ method: 'POST', url: '/api/session/unlock', payload: { pin: '6442' } });
  authCookies = { pulse_auth: u.cookies.find((c: any) => c.name === 'pulse_auth').value };
  const ins = app.ctx.db.prepare(`INSERT INTO scenes(ext_key, source, path, file_name, parsed, match_status) VALUES(?,?,?,?,?,?)`);
  ids = names.map((n, i) => Number(ins.run(`pcloud:${i + 1}`, 'pcloud', `/Videos/${n}`, n, '{"title":"stale","performers":[],"query":"stale"}', 'unmatched').lastInsertRowid));
});

describe('Retry matching', () => {
  it('re-matches every unmatched scene via the cascade and records the strategy', async () => {
    const r = await json('POST', '/api/match/retry-unmatched', {});
    expect(r.status).toBe(200);
    expect(r.body.requeued).toBe(4);
    const s = await waitIdle();
    expect(s.matched).toBe(3);
    expect(s.unmatched).toBe(1); // searched fine, no confident match = unmatched, not an error
    expect(s.failed).toBe(0);
    expect(s.strategies).toMatchObject({ parse: 1, title: 1, words: 1 });
    const lib = (await json('GET', '/api/library?sort=title&order=asc')).body.items;
    const bySt = Object.fromEntries(lib.map((x: any) => [x.fileName, x]));
    expect(bySt[names[0]]).toMatchObject({ matchStatus: 'matched', matchStrategy: 'parse', title: 'Big Boobs Fun' });
    expect(bySt[names[1]]).toMatchObject({ matchStatus: 'matched', matchStrategy: 'title' });
    expect(bySt[names[2]]).toMatchObject({ matchStatus: 'matched', matchStrategy: 'words' });
    expect(bySt[names[3]]).toMatchObject({ matchStatus: 'unmatched', matchStrategy: null });
  });

  it('keeps top-5 alternatives with scores for unmatched files and exposes a pre-filled query', async () => {
    const info = (await json('GET', `/api/scenes/${ids[3]}/match-info`)).body;
    expect(info.status).toBe('unmatched');
    expect(info.query).toBe('IMG 0001');
    expect(Array.isArray(info.alternatives)).toBe(true);
    expect(info.alternatives.length).toBeLessThanOrEqual(5);
    const m = (await json('POST', `/api/scenes/${ids[3]}/match`, { query: 'midnight run' })).body;
    expect(m.candidates.length).toBeGreaterThanOrEqual(2);
    expect(m.candidates[0]).toHaveProperty('matchedBy');
    expect(m.candidates[0].confidence).toBeGreaterThan(0);
    expect(m.query).toBe('midnight run');
  });

  it('picking a candidate manually marks the strategy as manual', async () => {
    const r = await json('POST', `/api/scenes/${ids[3]}/match`, { tpdbId: 's2' });
    expect(r.body.scene).toMatchObject({ matchStatus: 'manual', matchStrategy: 'manual', title: 'Midnight Run' });
  });

  it('is cheap the second time (cached) and re-parses stale rows', async () => {
    app.ctx.db.prepare(`UPDATE scenes SET match_status='unmatched', parsed='{}' WHERE id=?`).run(ids[0]);
    const before = mock.hits.length;
    const r = await json('POST', '/api/match/retry-unmatched', {});
    expect(r.body.requeued).toBe(1);
    await waitIdle();
    expect((await json('GET', `/api/scenes/${ids[0]}`)).body).toMatchObject({ matchStatus: 'matched', matchStrategy: 'parse' });
    expect(JSON.parse(app.ctx.db.prepare('SELECT parsed FROM scenes WHERE id=?').get(ids[0]).parsed)).toMatchObject({ studio: 'Brazzers', date: '2021-05-12' });
    expect(mock.hits.length - before).toBeLessThanOrEqual(1);
  });
});
