import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-auth-test-'));
const { buildApp } = await import('../src/app.js');
const { openDb } = await import('../src/db.js');
const { KV } = await import('../src/db.js');

const mk = (db = openDb(':memory:'), env: any = {}) => buildApp({ db, fetch: (async () => new Response('{}')) as any, env: { tpdbKey: 'TK', ...env } as any });
const unlock = (app: any, pin: string, headers: any = {}) => app.inject({ method: 'POST', url: '/api/session/unlock', payload: { pin }, headers });
const cookieOf = (r: any) => r.cookies.find((c: any) => c.name === 'pulse_auth');

describe('PIN lock', () => {
  let app: any;
  beforeAll(async () => { app = await mk(); });

  it('health, session status and unlock are open; everything else is locked from the first request', async () => {
    expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200);
    const s = await app.inject({ url: '/api/session' });
    expect(s.json()).toEqual({ locked: true, pinEnabled: true }); // no data leaked while locked
    for (const [method, url] of [
      ['GET', '/api/library'], ['GET', '/api/home'], ['GET', '/api/settings'], ['PUT', '/api/settings'], ['GET', '/api/pcloud/status'],
      ['GET', '/api/pcloud/callback?code=x'], ['GET', '/api/scenes/1/stream'], ['GET', '/api/scenes/1/proxy'], ['GET', '/api/scenes/1/thumb'],
      ['GET', '/api/scenes/1/subtitles/1'], ['GET', '/api/torbox/stream'], ['POST', '/api/data/clear'], ['POST', '/api/settings/pin'],
      ['GET', '/api/nope'], ['GET', '/api/health/../library'], ['GET', '/API/library'], ['GET', '/api/library/'], ['GET', '//api/library'],
    ] as const) {
      const r = await app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
      expect([401, 423], `${method} ${url} -> ${r.statusCode}`).toContain(r.statusCode);
      expect(r.body).not.toContain('"items"');
    }
    expect((await app.inject({ method: 'POST', url: '/api/settings/pin', payload: { pin: '1111', currentPin: '6442' } })).statusCode).toBe(423);
  });

  it('static web shell loads without a session (client shows the lock screen)', async () => {
    const r = await app.inject({ url: '/' });
    expect([200, 404]).toContain(r.statusCode); // 404 only when web/dist is not built; never 423/401 and never data
    expect(r.body).not.toContain('"locked"');
  });

  it('default PIN 6442 unlocks; cookie is signed, httpOnly, SameSite=Lax, 30 days, Secure only over https', async () => {
    const r = await unlock(app, '6442');
    expect(r.statusCode).toBe(200);
    const c = cookieOf(r);
    expect(c).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(c.secure).toBeFalsy();
    expect(c.maxAge).toBeGreaterThan(29 * 86400);
    expect(c.maxAge).toBeLessThanOrEqual(30 * 86400);
    const ok = await app.inject({ url: '/api/library', cookies: { pulse_auth: c.value } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/session', cookies: { pulse_auth: c.value } })).json()).toMatchObject({ locked: false, pcloud: { connected: false } });
    // tampered / garbage cookies are rejected
    const parts = c.value.split('.');
    for (const bad of [c.value + 'x', `${parts[0]}.${parts[1]}.AAAA`, 'garbage', `v1.${Buffer.from('{"exp":9999999999999,"act":1,"fp":"x"}').toString('base64url')}.${parts[2]}`])
      expect((await app.inject({ url: '/api/library', cookies: { pulse_auth: bad } })).statusCode).toBe(423);
    const https = await unlock(app, '6442', { 'x-forwarded-proto': 'https' });
    expect(cookieOf(https).secure).toBe(true);
  });

  it('lock now clears the session', async () => {
    const c = cookieOf(await unlock(app, '6442'));
    const r = await app.inject({ method: 'POST', url: '/api/session/lock', cookies: { pulse_auth: c.value } });
    expect(r.json()).toEqual({ locked: true });
    expect(cookieOf(r).value).toBe('');
  });

  it('wrong PIN is rate limited per IP: 5 tries then lockout, even for the right PIN; other IPs unaffected', async () => {
    const a = { 'cf-connecting-ip': '203.0.113.7' };
    for (let i = 0; i < 4; i++) { const r = await unlock(app, '0000', a); expect(r.statusCode).toBe(401); expect(r.json().error.code).toBe('bad_pin'); }
    const fifth = await unlock(app, '0000', a);
    expect(fifth.statusCode).toBe(429);
    expect(Number(fifth.headers['retry-after'])).toBeGreaterThan(50);
    expect(Number(fifth.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(fifth.json().error.code).toBe('rate_limited');
    expect((await unlock(app, '6442', a)).statusCode).toBe(429);
    expect((await unlock(app, '6442', { 'x-forwarded-for': '203.0.113.7' })).statusCode).toBe(429); // XFF honored too
    expect((await unlock(app, '6442', { 'cf-connecting-ip': '198.51.100.9' })).statusCode).toBe(200);
  });

  it('lockouts escalate', async () => {
    const h = { 'cf-connecting-ip': '203.0.113.50' };
    const durations: number[] = [];
    const a = (app as any);
    for (let round = 0; round < 2; round++) {
      let last: any;
      for (let i = 0; i < 5; i++) last = await unlock(app, '1234', h);
      durations.push(Number(last.headers['retry-after']));
      if (round === 0) { // simulate the 1 minute passing
        const orig = Date.now; const t = orig() + 61_000; Date.now = () => t;
        try { for (let i = 0; i < 4; i++) await unlock(app, '1234', h); last = await unlock(app, '1234', h); durations.pop(); durations.push(60); durations.push(Number(last.headers['retry-after'])); } finally { Date.now = orig; }
        break;
      }
    }
    expect(durations[1]).toBeGreaterThan(durations[0]);
    void a;
  });

  it('change PIN requires the current PIN, re-hashes (salted scrypt only) and signs out other sessions', async () => {
    const db = openDb(':memory:');
    const app2 = await mk(db);
    const c1 = cookieOf(await unlock(app2, '6442')); const c2 = cookieOf(await unlock(app2, '6442'));
    const ck = (c: any) => ({ pulse_auth: c.value });
    expect((await app2.inject({ method: 'POST', url: '/api/settings/pin', payload: { pin: '135790' }, cookies: ck(c1) })).statusCode).toBe(401);
    expect((await app2.inject({ method: 'POST', url: '/api/settings/pin', payload: { pin: '12', currentPin: '6442' }, cookies: ck(c1) })).statusCode).toBe(400);
    const ch = await app2.inject({ method: 'POST', url: '/api/settings/pin', payload: { pin: '135790', currentPin: '6442' }, cookies: ck(c1) });
    expect(ch.statusCode).toBe(200);
    expect((await app2.inject({ url: '/api/library', cookies: ck(cookieOf(ch)) })).statusCode).toBe(200);
    expect((await app2.inject({ url: '/api/library', cookies: ck(c2) })).statusCode).toBe(423);
    expect((await unlock(app2, '6442')).statusCode).toBe(401);
    expect((await unlock(app2, '135790', { 'cf-connecting-ip': '192.0.2.1' })).statusCode).toBe(200);
    const stored = new KV(db).get<string>('pin', '');
    expect(stored).toMatch(/^s1:/);
    expect(stored).not.toContain('135790');
    // DELETE /api/settings/pin no longer exists: the lock cannot be switched off
    expect((await app2.inject({ method: 'DELETE', url: '/api/settings/pin', payload: { currentPin: '135790' }, cookies: ck(cookieOf(ch)) })).statusCode).toBe(404);
  });

  it('seeding: keeps an existing PIN, sets 6442 when none, APP_PIN env overrides', async () => {
    const db = openDb(':memory:');
    const kv = new KV(db);
    const { hashPin } = await import('../src/crypto.js');
    kv.set('pin', hashPin('2468'));
    const keep = await mk(db);
    expect((await unlock(keep, '6442', { 'cf-connecting-ip': '192.0.2.10' })).statusCode).toBe(401);
    expect((await unlock(keep, '2468')).statusCode).toBe(200);
    const env = await mk(db, { appPin: '777777' });
    expect((await unlock(env, '777777')).statusCode).toBe(200);
    expect((await unlock(env, '2468', { 'cf-connecting-ip': '192.0.2.11' })).statusCode).toBe(401);
    await expect(mk(openDb(':memory:'), { appPin: 'abc' })).rejects.toThrow(/APP_PIN/);
  });
});

describe('lock regression: session must survive unlock on every browser/transport', () => {
  it('PUBLIC_BASE_URL=https must not force Secure on a plain-http request (localhost / LAN); https stays Secure', async () => {
    const app = await mk(openDb(':memory:'), { publicBaseUrl: 'https://example.test' });
    expect(cookieOf(await unlock(app, '6442')).secure).toBeFalsy();
    expect(cookieOf(await unlock(app, '6442', { 'x-forwarded-proto': 'https' })).secure).toBe(true);
    expect(cookieOf(await unlock(app, '6442', { 'cf-visitor': '{"scheme":"https"}' })).secure).toBe(true);
  });

  it('works without cookies: unlock returns a token accepted as Authorization: Bearer (header) and ?pt= (GET only); server still enforces', async () => {
    const app = await mk();
    const r = await unlock(app, '6442');
    const token = r.json().token;
    expect(token).toBe(cookieOf(r).value);
    expect((await app.inject({ url: '/api/library' })).statusCode).toBe(423);
    expect((await app.inject({ url: '/api/library', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/library', headers: { authorization: 'Bearer nonsense' } })).statusCode).toBe(423);
    expect((await app.inject({ url: `/api/library?pt=${encodeURIComponent(token)}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/settings/pin?pt=${encodeURIComponent(token)}`, payload: {} })).statusCode).toBe(423); // never via query on writes
    expect((await app.inject({ url: '/api/session', headers: { authorization: `Bearer ${token}` } })).json().locked).toBe(false);
    expect((await app.inject({ url: '/api/session' })).json().locked).toBe(true);
  });

  it('API responses (incl. session status and 423) are never cacheable', async () => {
    const app = await mk();
    for (const url of ['/api/session', '/api/library', '/api/health']) expect((await app.inject({ url })).headers['cache-control']).toMatch(/no-store/);
    const c = cookieOf(await unlock(app, '6442'));
    expect((await app.inject({ url: '/api/session', cookies: { pulse_auth: c.value } })).headers['cache-control']).toMatch(/no-store/);
    expect((await app.inject({ method: 'POST', url: '/api/session/unlock', payload: { pin: '6442' } })).headers['cache-control']).toMatch(/no-store/);
  });

  it('idle auto-lock stays OFF for settings saved before v2 (old default 15) until the user sets it again', async () => {
    const db = openDb(':memory:');
    new KV(db).set('settings', { autoLockMinutes: 15 }); // what an existing install has saved
    const app = await mk(db);
    const c = cookieOf(await unlock(app, '6442'));
    expect((await app.inject({ url: '/api/settings', cookies: { pulse_auth: c.value } })).json().autoLockMinutes).toBe(0);
    // explicit opt-in works and is enforced server-side
    const put = await app.inject({ method: 'PUT', url: '/api/settings', cookies: { pulse_auth: c.value }, payload: { autoLockMinutes: 5 } });
    expect(put.json().autoLockMinutes).toBe(5);
    expect((await app.inject({ url: '/api/settings', cookies: { pulse_auth: c.value } })).json().autoLockMinutes).toBe(5);
  });

  it('web shell, service worker and manifest are served with revalidation headers; API 423 never carries a cacheable shell', async () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-dist-'));
    fs.mkdirSync(path.join(dist, 'assets'));
    for (const f of ['index.html', 'sw.js', 'workbox-abc.js', 'manifest.webmanifest', 'assets/app-123.js']) fs.writeFileSync(path.join(dist, f), 'x');
    const app = await buildApp({ db: openDb(':memory:'), fetch: (async () => new Response('{}')) as any, env: { tpdbKey: 'TK', webDist: dist } as any });
    for (const f of ['/', '/sw.js', '/workbox-abc.js', '/manifest.webmanifest', '/library']) expect((await app.inject({ url: f })).headers['cache-control'], f).toMatch(/no-cache/);
    expect((await app.inject({ url: '/assets/app-123.js' })).headers['cache-control']).toMatch(/immutable/);
  });
});
