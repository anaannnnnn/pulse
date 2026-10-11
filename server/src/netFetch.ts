// Network path for the metadata providers (ThePornDB, StashDB) when the local DNS / ISP blocks them.
//   1. proxy  – PROVIDER_PROXY_URL set: every call goes through the Cloudflare Worker in docs/cloudflare-proxy-worker.js
//   2. direct – normal fetch with the system resolver
//   3. doh    – the system resolver failed (ENOTFOUND / EAI_AGAIN): resolve the host with DNS-over-HTTPS
//               (cloudflare-dns.com, dns.google, then their pinned IPs 1.1.1.1 / 8.8.8.8) and connect to that IP with the
//               original Host header + TLS SNI, so certificates still validate against the real host name.
// Secrets (API keys, the proxy secret) only travel in request headers and are never logged or returned.
import https from 'node:https';
import { Readable } from 'node:stream';
import type { FetchLike } from './http.js';

export type NetPath = 'direct' | 'doh' | 'proxy';
export type ConnectFn = (url: URL, init: RequestInit, ip: string) => Promise<Response>;
export type DohCache = Map<string, { ips: string[]; exp: number }>;
export type ProviderFetchOpts = {
  /** Cloudflare Worker URL (PROVIDER_PROXY_URL) + shared secret (PROVIDER_PROXY_SECRET). */
  proxyUrl?: string; proxySecret?: string;
  /** DNS-over-HTTPS fallback (default on). */
  doh?: boolean;
  /** Test hooks. */
  dohQuery?: (host: string) => Promise<{ ips: string[]; ttl: number }>;
  connect?: ConnectFn;
  dohCache?: DohCache;
  /** How long a host that failed DNS goes straight to DoH before the system resolver is tried again. */
  directRetryMs?: number;
};
export type NetworkInfo = {
  /** Path the most recent successful request took (null = nothing succeeded yet). */
  path: NetPath | null;
  proxy: boolean; doh: boolean;
  /** Both direct DNS and the fallbacks failed on the last attempt: the human-readable reason. */
  problem: string | null;
};
export type ProviderFetch = FetchLike & { info(): NetworkInfo };

const sharedDohCache: DohCache = new Map();
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENODATA', 'ESERVFAIL', 'EAI_FAIL']);

/** True when `e` is a name-resolution failure (undici hides the code in `cause`). */
export function isDnsError(e: any): boolean {
  for (let x = e, i = 0; x && i < 4; x = x.cause, i++) {
    if (DNS_CODES.has(x.code)) return true;
    if (/getaddrinfo (ENOTFOUND|EAI_AGAIN)/i.test(String(x.message || ''))) return true;
  }
  return false;
}
const errCode = (e: any) => String(e?.cause?.code || e?.code || e?.name || 'error');

/** HTTPS request to `url` that connects to `ip` but keeps Host + SNI = the URL's host name. */
export const httpsViaIp: ConnectFn = (url, init, ip) =>
  new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    headers.host = url.host;
    headers['accept-encoding'] = 'identity';
    let body: Buffer | null = null;
    const b: any = init.body;
    if (b != null) body = typeof b === 'string' ? Buffer.from(b) : b instanceof URLSearchParams ? Buffer.from(b.toString()) : Buffer.from(b);
    if (body) headers['content-length'] = String(body.length);
    const req = https.request({
      host: url.hostname, port: url.port || 443, path: url.pathname + url.search, method: (init.method || 'GET').toUpperCase(), headers,
      servername: url.hostname, signal: init.signal ?? undefined, timeout: 30_000,
      lookup: ((_h: string, o: any, cb: any) => (o?.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4))) as any,
    }, (res) => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) for (const x of Array.isArray(v) ? v : v != null ? [v] : []) h.append(k, String(x));
      const status = res.statusCode || 502;
      const nullBody = status === 204 || status === 205 || status === 304;
      if (nullBody) res.resume();
      resolve(new Response(nullBody ? null : (Readable.toWeb(res) as any), { status, statusText: res.statusMessage, headers: h }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });

type DohEndpoint = { url: (name: string) => string; ip: string; host: string };
const DOH_ENDPOINTS: DohEndpoint[] = [
  { url: (n) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(n)}&type=A`, ip: '1.1.1.1', host: 'cloudflare-dns.com' },
  { url: (n) => `https://dns.google/resolve?name=${encodeURIComponent(n)}&type=A`, ip: '8.8.8.8', host: 'dns.google' },
];

/** DNS-over-HTTPS A lookup. Tries each resolver by name first (system DNS), then pinned to its well-known IP. */
export async function dohLookup(host: string, connect: ConnectFn = httpsViaIp): Promise<{ ips: string[]; ttl: number }> {
  const errors: string[] = [];
  for (const ep of DOH_ENDPOINTS) {
    const url = ep.url(host);
    const init: RequestInit = { headers: { accept: 'application/dns-json' } };
    for (const via of ['name', 'ip'] as const) {
      try {
        const res = via === 'name' ? await fetch(url, { ...init, signal: AbortSignal.timeout(6000) }) : await connect(new URL(url), { ...init, signal: AbortSignal.timeout(6000) }, ep.ip);
        if (!res.ok) { errors.push(`${ep.host} HTTP ${res.status}`); continue; }
        const j: any = await res.json();
        const ans = (j.Answer || []).filter((a: any) => a.type === 1 && /^\d+\.\d+\.\d+\.\d+$/.test(a.data));
        if (ans.length) return { ips: ans.map((a: any) => a.data), ttl: Math.min(...ans.map((a: any) => Number(a.TTL) || 60)) };
        errors.push(`${ep.host}: no A record`);
        break;                                  // the resolver answered (no such host): the pinned IP would say the same
      } catch (e: any) { errors.push(`${ep.host}${via === 'ip' ? ' (ip)' : ''}: ${errCode(e)}`); }
    }
  }
  throw Object.assign(new Error(`DNS-over-HTTPS lookup of ${host} failed (${errors.join('; ')})`), { code: 'DOH_FAILED' });
}

/** Wraps a fetch so provider calls survive blocked DNS: optional Worker proxy, then direct, then DNS-over-HTTPS. */
export function createProviderFetch(base: FetchLike, o: ProviderFetchOpts = {}): ProviderFetch {
  const proxyUrl = (o.proxyUrl || '').trim().replace(/\/+$/, '');
  const proxy = !!(proxyUrl && o.proxySecret);
  const useDoh = o.doh !== false;
  const connect = o.connect ?? httpsViaIp;
  const cache = o.dohCache ?? sharedDohCache;
  const dohQuery = o.dohQuery ?? ((h: string) => dohLookup(h, connect));
  const retryMs = o.directRetryMs ?? 10 * 60_000;
  const dnsBlockedUntil = new Map<string, number>();
  const st: { path: NetPath | null; problem: string | null } = { path: null, problem: null };

  const resolve = async (host: string): Promise<string[]> => {
    const hit = cache.get(host);
    if (hit && hit.exp > Date.now()) return hit.ips;
    const r = await dohQuery(host);
    cache.set(host, { ips: r.ips, exp: Date.now() + Math.min(Math.max(r.ttl, 60), 3600) * 1000 });
    return r.ips;
  };

  const fn = (async (input: any, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    let proxyErr: any = null;
    if (proxy) {
      try {
        const headers = new Headers(init.headers);
        headers.set('x-proxy-secret', o.proxySecret!);
        headers.set('x-proxy-target', url.toString());
        const res = await base(proxyUrl, { ...init, headers });
        if (res.headers.get('x-pulse-proxy-error')) { await res.body?.cancel().catch(() => {}); throw Object.assign(new Error('provider proxy rejected the request (check PROVIDER_PROXY_SECRET / the Worker allowlist)'), { code: 'EPROXY' }); }
        st.path = 'proxy'; st.problem = null;
        return res;
      } catch (e: any) { if (e?.name === 'AbortError') throw e; proxyErr = e; }   // fall back to the direct paths
    }
    const host = url.hostname;
    let dnsErr: any = null;
    if (!((dnsBlockedUntil.get(host) || 0) > Date.now())) {
      try {
        const res = await base(input, init);
        st.path = 'direct'; st.problem = null;
        return res;
      } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
        if (!(useDoh && isDnsError(e))) { st.problem = proxyErr ? `proxy: ${proxyErr.message}; direct: ${errCode(e)}` : null; throw e; }
        dnsErr = e;
        dnsBlockedUntil.set(host, Date.now() + retryMs);
      }
    }
    if (!useDoh) throw dnsErr;
    let ips: string[];
    try { ips = await resolve(host); }
    catch (e: any) {
      st.problem = `DNS for ${host} is blocked on this network and DNS-over-HTTPS failed too${proxy ? ' (and the proxy failed)' : ''}. Set PROVIDER_PROXY_URL (docs/hosting.md).`;
      throw dnsErr || Object.assign(new TypeError('fetch failed', { cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }) }), { dohError: e.message });
    }
    let last: any = dnsErr;
    for (const ip of ips) {
      try {
        const res = await connect(url, init, ip);
        st.path = 'doh'; st.problem = null;
        return res;
      } catch (e: any) { if (e?.name === 'AbortError') throw e; last = e; }
    }
    cache.delete(host);
    st.problem = `DNS-over-HTTPS resolved ${host} (${ips.join(', ')}) but connecting failed (${errCode(last)}). Set PROVIDER_PROXY_URL (docs/hosting.md).`;
    throw last;
  }) as ProviderFetch;
  fn.info = () => ({ path: st.path, proxy, doh: useDoh, problem: st.problem });
  return fn;
}
