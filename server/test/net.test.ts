import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createProviderFetch, dohLookup, isDnsError, type ConnectFn } from '../src/netFetch.js';
import { makeMockTpdb } from './mockTpdb.js';
import { GOOD_KEY, makeMockStash } from './mockStashdb.js';
// @ts-expect-error plain JS Worker file
import worker from '../../docs/cloudflare-proxy-worker.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-net-'));
const { buildApp } = await import('../src/app.js');
const { openDb } = await import('../src/db.js');

afterEach(() => vi.unstubAllGlobals());

const dnsFail = (host = 'x') => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND', hostname: host }) });
const ok = (body: any = { ok: true }) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('isDnsError', () => {
  it('recognises undici-style DNS failures', () => {
    expect(isDnsError(dnsFail())).toBe(true);
    expect(isDnsError(Object.assign(new Error('x'), { code: 'EAI_AGAIN' }))).toBe(true);
    expect(isDnsError(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }))).toBe(false);
    expect(isDnsError(new Error('boom'))).toBe(false);
  });
});

describe('DNS-over-HTTPS fallback', () => {
  it('direct DNS failure -> resolves via DoH, connects to the IP keeping the original host, caches, stops retrying direct', async () => {
    const base = vi.fn(async () => { throw dnsFail('api.theporndb.net'); });
    const dohQuery = vi.fn(async (h: string) => ({ ips: ['104.21.1.2', '172.67.3.4'], ttl: 300 }));
    const seen: { host: string; ip: string; auth: string | null; path: string }[] = [];
    const connect: ConnectFn = async (url, init, ip) => { seen.push({ host: url.host, ip, auth: new Headers(init.headers).get('authorization'), path: url.pathname + url.search }); return ok({ data: [] }); };
    const f = createProviderFetch(base as any, { dohQuery, connect, dohCache: new Map() });
    expect(f.info().path).toBeNull();
    const r = await f('https://api.theporndb.net/scenes?q=a', { headers: { Authorization: 'Bearer SECRET' } });
    expect(await r.json()).toEqual({ data: [] });
    expect(seen).toEqual([{ host: 'api.theporndb.net', ip: '104.21.1.2', auth: 'Bearer SECRET', path: '/scenes?q=a' }]);
    expect(f.info()).toMatchObject({ path: 'doh', doh: true, proxy: false, problem: null });
    await f('https://api.theporndb.net/scenes?q=b');
    expect(dohQuery).toHaveBeenCalledTimes(1);          // cached
    expect(base).toHaveBeenCalledTimes(1);              // host is known to be DNS-blocked: no more direct attempts for a while
  });
  it('tries the next IP when connecting to the first fails', async () => {
    const connect: ConnectFn = vi.fn(async (_u, _i, ip) => { if (ip === '1.1.1.1') throw new Error('ECONNREFUSED'); return ok(); });
    const f = createProviderFetch((async () => { throw dnsFail(); }) as any, { dohQuery: async () => ({ ips: ['1.1.1.1', '2.2.2.2'], ttl: 60 }), connect, dohCache: new Map() });
    await f('https://stashdb.org/graphql', { method: 'POST', body: '{}' });
    expect((connect as any).mock.calls.map((c: any[]) => c[2])).toEqual(['1.1.1.1', '2.2.2.2']);
  });
  it('DoH failing too keeps the ENOTFOUND cause and explains the way out', async () => {
    const f = createProviderFetch((async () => { throw dnsFail('stashdb.org'); }) as any, { dohQuery: async () => { throw new Error('DoH blocked'); }, dohCache: new Map() });
    const e: any = await f('https://stashdb.org/graphql').catch((x) => x);
    expect(isDnsError(e)).toBe(true);
    expect(f.info().problem).toMatch(/PROVIDER_PROXY_URL/);
  });
  it('non-DNS errors and HTTP errors are not rerouted; DoH can be switched off', async () => {
    const dohQuery = vi.fn();
    const f1 = createProviderFetch((async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); }) as any, { dohQuery: dohQuery as any });
    await expect(f1('https://stashdb.org/x')).rejects.toThrow('fetch failed');
    const f2 = createProviderFetch((async () => new Response('', { status: 401 })) as any, { dohQuery: dohQuery as any });
    expect((await f2('https://stashdb.org/x')).status).toBe(401);
    expect(f2.info().path).toBe('direct');
    const f3 = createProviderFetch((async () => { throw dnsFail(); }) as any, { dohQuery: dohQuery as any, doh: false });
    await expect(f3('https://stashdb.org/x')).rejects.toThrow();
    expect(dohQuery).not.toHaveBeenCalled();
  });
  it('dohLookup parses dns-json A answers (cloudflare first, accept: application/dns-json)', async () => {
    const calls: { url: string; accept: string | null }[] = [];
    vi.stubGlobal('fetch', async (u: string, init: any) => { calls.push({ url: String(u), accept: new Headers(init.headers).get('accept') }); return ok({ Status: 0, Answer: [{ name: 'a', type: 5, TTL: 9, data: 'x.' }, { name: 'a', type: 1, TTL: 120, data: '9.9.9.9' }] }); });
    const r = await dohLookup('stashdb.org');
    expect(r).toEqual({ ips: ['9.9.9.9'], ttl: 120 });
    expect(calls[0]).toEqual({ url: 'https://cloudflare-dns.com/dns-query?name=stashdb.org&type=A', accept: 'application/dns-json' });
  });
  it('dohLookup falls back to dns.google, then to the pinned resolver IPs when their names do not resolve', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (u: string) => { urls.push(String(u)); if (u.includes('cloudflare')) throw dnsFail('cloudflare-dns.com'); return ok({ Answer: [{ type: 1, TTL: 30, data: '5.6.7.8' }] }); });
    expect((await dohLookup('x.test')).ips).toEqual(['5.6.7.8']);
    expect(urls.some((u) => u.startsWith('https://dns.google/resolve?name=x.test'))).toBe(true);
    const pinned: string[] = [];
    vi.stubGlobal('fetch', async () => { throw dnsFail('resolver'); });
    const connect: ConnectFn = async (u, _i, ip) => { pinned.push(`${u.host}@${ip}`); return ok({ Answer: [{ type: 1, TTL: 30, data: '8.8.4.4' }] }); };
    expect((await dohLookup('y.test', connect)).ips).toEqual(['8.8.4.4']);
    expect(pinned[0]).toBe('cloudflare-dns.com@1.1.1.1');
  });
});

describe('Cloudflare Worker proxy', () => {
  const env = { PROXY_SECRET: 'a-very-long-shared-secret' };
  const upstream = vi.fn(async (_u: string, init: any) => new Response(JSON.stringify({ got: Object.fromEntries(new Headers(init.headers)), body: init.body ? 'has-body' : null, method: init.method }), { status: 200, headers: { 'content-type': 'application/json' } }));
  // The Worker runs on Cloudflare; here its global fetch is the "upstream" and the Pulse side talks to worker.fetch directly.
  const viaWorker = async (input: any, init: any = {}) => {
    vi.stubGlobal('fetch', upstream);
    return worker.fetch(new Request(String(input), init), env);
  };
  it('rejects a missing/wrong secret, bad targets and hosts outside the allowlist', async () => {
    const req = (h: Record<string, string>) => worker.fetch(new Request('https://w.example/', { headers: h }), env);
    expect((await req({})).status).toBe(403);
    expect((await req({ 'x-proxy-secret': 'nope' })).status).toBe(403);
    expect((await req({ 'x-proxy-secret': env.PROXY_SECRET })).status).toBe(400);
    const evil = await req({ 'x-proxy-secret': env.PROXY_SECRET, 'x-proxy-target': 'https://evil.example/steal' });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('x-pulse-proxy-error')).toBe('1');
    expect((await req({ 'x-proxy-secret': env.PROXY_SECRET, 'x-proxy-target': 'http://api.theporndb.net/' })).status).toBe(400);
    expect((await req({ 'x-proxy-secret': env.PROXY_SECRET, 'x-proxy-target': 'https://api.theporndb.net.evil.example/' })).status).toBe(403);
    expect((await worker.fetch(new Request('https://w.example/'), {})).status).toBe(500);   // no secret configured
  });
  it('createProviderFetch routes through the Worker: method, headers and body pass, the secret and target headers are stripped', async () => {
    const f = createProviderFetch(viaWorker as any, { proxyUrl: 'https://w.example/', proxySecret: env.PROXY_SECRET, dohCache: new Map() });
    const r = await f('https://stashdb.org/graphql', { method: 'POST', headers: { ApiKey: 'K1', 'Content-Type': 'application/json' }, body: '{"query":"{me{name}}"}' });
    const j: any = await r.json();
    expect(upstream.mock.calls.at(-1)![0]).toBe('https://stashdb.org/graphql');
    expect(j).toMatchObject({ method: 'POST', body: 'has-body', got: { apikey: 'K1', 'content-type': 'application/json' } });
    expect(j.got['x-proxy-secret']).toBeUndefined();
    expect(j.got['x-proxy-target']).toBeUndefined();
    expect(f.info()).toMatchObject({ path: 'proxy', proxy: true });
    await f('https://api.theporndb.net/scenes?q=a', { headers: { Authorization: 'Bearer T' } });
    expect(upstream.mock.calls.at(-1)![0]).toBe('https://api.theporndb.net/scenes?q=a');
  });
  it('a proxy that refuses us (wrong secret) falls back to the direct path instead of failing', async () => {
    const base = vi.fn(async (u: any) => (String(u).startsWith('https://w.example') ? new Response('{}', { status: 403, headers: { 'x-pulse-proxy-error': '1' } }) : ok({ direct: true })));
    const f = createProviderFetch(base as any, { proxyUrl: 'https://w.example', proxySecret: 'wrong', dohCache: new Map() });
    expect(await (await f('https://stashdb.org/graphql')).json()).toEqual({ direct: true });
    expect(f.info().path).toBe('direct');
  });
});

describe('/api/*/test report the working path', () => {
  const tp = makeMockTpdb();
  const st = makeMockStash();
  it('direct DNS blocked for both providers -> doh, and the tests still work', async () => {
    const base = (async (u: any) => { throw dnsFail(new URL(String(u)).hostname); }) as any;
    const connect: ConnectFn = async (url, init) => (url.host === 'stashdb.org' ? st.f(url.toString(), init) : tp.f(url.toString(), init));
    const app: any = await buildApp({ db: openDb(':memory:'), fetch: base, env: { tpdbKey: 'TK', tpdbIntervalMs: 0, stashdbKey: GOOD_KEY, stashdbIntervalMs: 0, providerDoh: true } as any, net: { dohQuery: async () => ({ ips: ['10.0.0.1'], ttl: 60 }), connect, dohCache: new Map() } });
    const u = await app.inject({ method: 'POST', url: '/api/session/unlock', payload: { pin: '6442' } });
    const cookies = { pulse_auth: u.cookies.find((c: any) => c.name === 'pulse_auth').value };
    const s = (await app.inject({ method: 'GET', url: '/api/stashdb/test', cookies })).json();
    expect(s).toMatchObject({ ok: true, status: 'ok', path: 'doh', network: { path: 'doh', doh: true, proxy: false } });
    const t = (await app.inject({ method: 'GET', url: '/api/tpdb/test', cookies })).json();
    expect(t.path).toBe('doh');
    expect(JSON.stringify([s, t])).not.toContain(GOOD_KEY);
  });
  it('healthy network -> direct; endpoints are configurable via settings', async () => {
    const hosts: string[] = [];
    const f = (async (u: any, init: any) => { hosts.push(new URL(String(u)).host); return new URL(String(u)).host.includes('stash') ? st.f(u, init) : tp.f(String(u).replace('mirror.example', 'api.theporndb.net'), init); }) as any;
    const app: any = await buildApp({ db: openDb(':memory:'), fetch: f, env: { tpdbKey: 'TK', tpdbIntervalMs: 0, stashdbKey: GOOD_KEY, stashdbIntervalMs: 0 } as any });
    const u = await app.inject({ method: 'POST', url: '/api/session/unlock', payload: { pin: '6442' } });
    const cookies = { pulse_auth: u.cookies.find((c: any) => c.name === 'pulse_auth').value };
    expect((await app.inject({ method: 'GET', url: '/api/stashdb/test', cookies })).json()).toMatchObject({ ok: true, path: 'direct' });
    await app.inject({ method: 'PUT', url: '/api/settings', cookies, payload: { metadata: { stashdbUrl: 'https://stash.test/graphql', tpdbBaseUrl: 'https://mirror.example/' } } });
    hosts.length = 0;
    await app.inject({ method: 'GET', url: '/api/stashdb/test', cookies });
    await app.inject({ method: 'GET', url: '/api/tpdb/test', cookies });
    expect(hosts).toContain('stash.test');
    expect(hosts).toContain('mirror.example');
    await app.inject({ method: 'PUT', url: '/api/settings', cookies, payload: { metadata: { stashdbUrl: '', tpdbBaseUrl: 'not a url' } } });
    hosts.length = 0;
    await app.inject({ method: 'GET', url: '/api/stashdb/test', cookies });
    await app.inject({ method: 'GET', url: '/api/tpdb/test', cookies });
    expect(hosts).toContain('stashdb.org');
    expect(hosts).toContain('api.theporndb.net');
  });
});
