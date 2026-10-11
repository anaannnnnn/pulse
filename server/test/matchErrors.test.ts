// Failures must never be silent: real reason in /api/match/status, per-file in the DB, key sanitising, /api/tpdb/test, fail-soft hash + strategies,
// automatic retry of failed files and "Retry matching" re-queueing them.
import { describe, it, expect, beforeEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { makeMockTpdb } from './mockTpdb.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-merr-'));
const { buildApp } = await import('../src/app.js');
const { openDb } = await import('../src/db.js');
const { cleanSecret } = await import('../src/secret.js');
const { TpdbClient } = await import('../src/clients/tpdb.js');

const NAME = 'Brazzers.21.05.12.Kendra.Lust.Big.Boobs.Fun.XXX.1080p.MP4-KTR.mp4';
const mk = async (f: any, extra: any = {}) => {
  const app: any = await buildApp({ db: openDb(':memory:'), fetch: f, env: { tpdbKey: 'TK', tpdbIntervalMs: 0, ...extra } as any });
  app.ctx.matcher.autoRetryDelaysMs = [];
  app.ctx.tpdb.backoffScale = 0;
  const u = await app.inject({ method: 'POST', url: '/api/session/unlock', payload: { pin: '6442' } });
  const cookies = { pulse_auth: u.cookies.find((c: any) => c.name === 'pulse_auth').value };
  const ins = app.ctx.db.prepare(`INSERT INTO scenes(ext_key, source, path, file_name, parsed, match_status) VALUES(?,?,?,?,?,?)`);
  const ids = [1, 2].map((i) => Number(ins.run(`pcloud:${i}`, 'pcloud', `/V/${i}${NAME}`, `${i}${NAME}`, '{}', 'unmatched').lastInsertRowid));
  const j = async (method: string, url: string, body?: any) => (await app.inject({ method, url, payload: body, cookies }));
  const idle = async () => { for (let i = 0; i < 400; i++) { const s = (await j('GET', '/api/match/status')).json(); if (s.state === 'idle' && s.queued === 0) return s; await new Promise((r) => setTimeout(r, 15)); } throw new Error('timeout'); };
  return { app, j, idle, ids };
};
const resp = (status: number, body: any, headers: any = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

describe('cleanSecret', () => {
  it('strips BOM, CR/LF, quotes, spaces, zero-width chars and a Bearer prefix', () => {
    for (const raw of ['\uFEFFabc123\r\n', ' "abc123" ', "'abc123'", 'Bearer abc123', 'abc 123'.replace(' ', ''), '\u201Cabc123\u201D', 'abc\u200B123', 'abc123\t', 'Authorization: Bearer abc123'])
      expect(cleanSecret(raw), JSON.stringify(raw)).toBe('abc123');
    expect(cleanSecret(undefined)).toBe('');
  });
  it('the client sends the cleaned key', async () => {
    let auth = '';
    const c = new TpdbClient('\uFEFF"KEY123"\r\n', undefined, (async (_u: any, init: any) => { auth = init.headers.Authorization; return resp(200, { data: [] }); }) as any, 0);
    await c.get('/scenes', { q: 'x' });
    expect(auth).toBe('Bearer KEY123');
  });
});

describe('failures are never silent', () => {
  it('401: lastError has HTTP status + body, files fail with a reason, remaining queue is marked, nothing stays queued', async () => {
    const { j, idle, ids, app } = await mk((async () => resp(401, { message: 'Unauthenticated.' })) as any);
    await j('POST', '/api/match/retry-unmatched', {});
    const s = await idle();
    expect(s.lastError).toMatch(/rejected the API key \(HTTP 401\).*Unauthenticated/);
    expect(s.lastErrorCode).toBe('tpdb_auth');
    expect(s.errorCounts.tpdb_auth).toBeGreaterThan(0);
    expect(s.failed).toBeGreaterThan(0);
    const rows = app.ctx.db.prepare('SELECT match_status, match_error, match_error_code FROM scenes').all() as any[];
    expect(rows.every((r) => r.match_status === 'failed' && /HTTP 401/.test(r.match_error) && r.match_error_code === 'tpdb_auth')).toBe(true);
    const un = (await j('GET', '/api/match/unmatched')).json();
    expect(un.items[0].matchError).toMatch(/401/);
    expect(un.items[0].matchErrorCode).toBe('tpdb_auth');
  });

  it('429 on every request: reported as rate_limited (not a silent "no match")', async () => {
    const { j, idle, ids } = await mk((async () => resp(429, { message: 'Too Many Attempts.' }, { 'retry-after': '0' })) as any);
    await j('POST', '/api/match/retry-unmatched', {});
    const s = await idle();
    expect(s.failed).toBe(2);
    expect(s.matched).toBe(0);
    expect(s.lastErrorCode).toBe('rate_limited');
    expect(s.lastError).toMatch(/HTTP 429.*Too Many Attempts/);
    expect(s.errorCounts).toEqual({ rate_limited: 2 });
  }, 60_000);

  it('network error (fetch throws): reports the root cause (cause.code)', async () => {
    const { j, idle } = await mk((async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }) as any);
    await j('POST', '/api/match/retry-unmatched', {});
    const s = await idle();
    expect(s.failed).toBe(2);
    expect(s.lastErrorCode).toBe('tpdb_network');
    expect(s.lastError).toContain('ENOTFOUND');
  }, 60_000);

  it('HTML / non-JSON 200 and 5xx are reported with a body snippet', async () => {
    const a = await mk((async () => resp(200, '<html><body>Captive portal login</body></html>')) as any);
    await a.j('POST', '/api/match/retry-unmatched', {});
    const s = await a.idle();
    expect(s.lastErrorCode).toBe('tpdb_bad_response');
    expect(s.lastError).toMatch(/non-JSON.*Captive portal login/);
  });

  it('403 from Cloudflare is "blocked", not "invalid key"', async () => {
    const { j, idle } = await mk((async () => resp(403, '<html>Attention Required! | Cloudflare</html>')) as any);
    await j('POST', '/api/match/retry-unmatched', {});
    expect((await idle()).lastErrorCode).toBe('tpdb_blocked');
  });

  it('a thrown exception inside the matcher is recorded per file with its message', async () => {
    const mock = makeMockTpdb();
    const { j, idle, app } = await mk(mock.f);
    app.ctx.matcher.apply = async () => { throw new Error('SQLITE_ERROR: boom on Windows'); };
    await j('POST', '/api/match/retry-unmatched', {});
    const s = await idle();
    expect(s.failed).toBe(2);
    expect(s.lastError).toBe('SQLITE_ERROR: boom on Windows');
    expect(s.lastErrorCode).toBe('exception');
    expect((app.ctx.db.prepare(`SELECT match_error FROM scenes WHERE match_status='failed'`).all() as any[]).length).toBe(2);
  });

  it('hash step is fail-soft: a throwing hash provider never fails the match', async () => {
    const mock = makeMockTpdb();
    const { j, idle, app } = await mk(mock.f);
    app.ctx.matcher.hashProvider = async () => { throw new Error('ranged read failed (backslash path?)'); };
    await j('POST', '/api/match/retry-unmatched', {});
    const s = await idle();
    expect(s.failed).toBe(0);
    expect(s.matched + s.unmatched).toBe(2);
    expect(s.matched).toBe(2);
  });

  it('one strategy throwing falls through to the next; partial TPDB failures do not hide a match', async () => {
    const mock = makeMockTpdb();
    let n = 0;
    const flaky = ((u: any, i: any) => { const url = new URL(String(u)); if (url.pathname === '/sites' || (url.pathname === '/scenes' && url.searchParams.has('parse') && n++ === 0)) return Promise.resolve(resp(500, 'oops')); return mock.f(u, i); }) as any;
    const { j, idle } = await mk(flaky);
    await j('POST', '/api/match/retry-unmatched', {});
    const s = await idle();
    expect(s.matched).toBe(2);
    expect(s.failed).toBe(0);
  }, 60_000);
});

describe('retry behaviour', () => {
  it('Retry matching re-queues failed files and they match once TPDB works again', async () => {
    const mock = makeMockTpdb();
    let down = true;
    const f = ((u: any, i: any) => down ? Promise.resolve(resp(401, 'no')) : mock.f(u, i)) as any;
    const { j, idle, app } = await mk(f);
    await j('POST', '/api/match/retry-unmatched', {});
    await idle();
    expect((app.ctx.db.prepare(`SELECT COUNT(*) c FROM scenes WHERE match_status='failed'`).get() as any).c).toBe(2);
    down = false;
    expect((await j('POST', '/api/match/retry-unmatched', {})).json().requeued).toBe(2);
    const s = await idle();
    expect(s.matched).toBe(2);
    expect(s.lastError).toBeNull();
    expect((app.ctx.db.prepare(`SELECT COUNT(*) c FROM scenes WHERE match_error IS NOT NULL`).get() as any).c).toBe(0);
  });

  it('failed files are retried automatically with backoff (transient network error)', async () => {
    const mock = makeMockTpdb();
    let down = true;
    const f = ((u: any, i: any) => down ? Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })) : mock.f(u, i)) as any;
    const { j, idle, app } = await mk(f);
    app.ctx.matcher.autoRetryDelaysMs = [50, 50, 50];
    await j('POST', '/api/match/retry-unmatched', {});
    const first = await idle();
    expect(first.failed).toBe(2);
    expect(first.retryAt).toBeTruthy();
    down = false;
    for (let i = 0; i < 200; i++) { const m = (app.ctx.db.prepare(`SELECT COUNT(*) c FROM scenes WHERE match_status='matched'`).get() as any).c; if (m === 2) break; await new Promise((r) => setTimeout(r, 25)); }
    expect((app.ctx.db.prepare(`SELECT COUNT(*) c FROM scenes WHERE match_status='matched'`).get() as any).c).toBe(2);
  }, 60_000);
});

describe('GET /api/tpdb/test', () => {
  const t = async (f: any, extra: any = {}) => { const { j } = await mk(f, extra); const r = await j('GET', '/api/tpdb/test'); expect(r.statusCode).toBe(200); return r.json(); };
  it('ok', async () => {
    const r = await t((async (u: any) => String(u).includes('/auth/user') ? resp(200, { data: { name: 'me' } }) : resp(200, { data: [{ title: 'Pain To Play' }] })) as any);
    expect(r).toMatchObject({ ok: true, status: 'ok', sample: { results: 1, first: 'Pain To Play' } });
    expect(JSON.stringify(r)).not.toContain('TK');
  });
  it('invalid key', async () => expect(await t((async () => resp(401, { message: 'Unauthenticated.' })) as any)).toMatchObject({ ok: false, status: 'invalid_key' }));
  it('rate limited', async () => expect(await t((async () => resp(429, 'slow down')) as any)).toMatchObject({ status: 'rate_limited' }));
  it('blocked', async () => expect(await t((async () => resp(403, '<html>Just a moment... Cloudflare</html>')) as any)).toMatchObject({ status: 'blocked' }));
  it('network', async () => { const r = await t((async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } }); }) as any); expect(r.status).toBe('network'); expect(r.hint).toContain('ETIMEDOUT'); });
  it('not configured', async () => expect(await t((async () => resp(200, {})) as any, { tpdbKey: '' })).toMatchObject({ status: 'not_configured', ok: false }));
  it('is locked without a session', async () => { const { app } = await mk((async () => resp(200, {})) as any); expect((await app.inject({ url: '/api/tpdb/test' })).statusCode).toBe(423); });
});

describe('real-world regression: "Performer - Title.mp4" with the same release listed on two sites', () => {
  it('matches instead of capping both at the review threshold', async () => {
    const { runCascade } = await import('../src/services/matchEngine.js');
    const { parseFilename } = await import('../src/parser.js');
    const P = [{ id: 'p1', _id: 1, name: 'Mandy Marx' }];
    const mkScene = (id: string, title: string, date: string, site: string) => ({ id, title, date, site: { id: 1, name: site }, performers: P, duration: 900 });
    const data = [mkScene('a', 'Pain to Play', '2023-08-26', 'Mandy Marx'), mkScene('b', 'Pain To Play', '2023-09-26', 'I Want Clips: Mandy Marx')];
    const other = [mkScene('c', 'To the Pain', '2019-02-14', 'Mandy Marx')];
    const f = (async (u: any) => { const url = new URL(String(u)); return resp(200, { data: url.searchParams.has('parse') ? data : [...data, ...other] }); }) as any;
    const c = new TpdbClient('TK', undefined, f, 0);
    const name = 'Mandy Marx - Pain To Play.mp4';
    const r = await runCascade(c, { fileName: name, parsed: parseFilename(name), threshold: 0.75 });
    expect(r.confident).toBe(true);
    expect(r.best?.title.toLowerCase()).toBe('pain to play');
    expect(r.best!.confidence).toBeGreaterThanOrEqual(0.85);
  });
});
