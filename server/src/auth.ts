// App-wide PIN lock. Enforced server-side: every /api route except health + session status/unlock/lock requires a
// valid signed session cookie. PIN is stored only as a salted scrypt hash. Never logs PINs, hashes or tokens.
import crypto from 'node:crypto';
import net from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { KV } from './db.js';
import { hashPin, verifyPin } from './crypto.js';
import { HttpError } from './http.js';

export const DEFAULT_PIN = '6442';
export const AUTH_COOKIE = 'pulse_auth';
const SESSION_MS = 30 * 24 * 3600e3;
const REFRESH_MS = 30e3; // re-issue the cookie (sliding expiry + idle tracking) at most this often
const PIN_RE = /^\d{4,8}$/;
const LOCKOUTS_S = [60, 300, 900, 3600, 21600, 86400]; // escalating per-IP lockouts after every 5 wrong tries
const MAX_TRIES = 5;
const GLOBAL_WINDOW_MS = 15 * 60e3;
const GLOBAL_MAX_FAILS = 40; // all IPs combined, guards against spoofed forwarding headers

const err = (status: number, code: string, message: string) => new HttpError(status, message, code);
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const fingerprint = (stored: string) => crypto.createHash('sha256').update(stored).digest('hex').slice(0, 16);

type Attempt = { fails: number; strikes: number; lockedUntil: number; last: number };
type Payload = { iat: number; exp: number; act: number; fp: string };
export type AuthOptions = {
  kv: KV;
  appPin?: string;                    // APP_PIN env override
  publicBaseUrl?: string;
  trustProxyHeaders?: string;         // TRUST_PROXY_HEADERS: '1' | '0' | auto (default)
  idleMinutes: () => number;          // optional idle auto-lock (0 = never)
};

const PRIVATE_PEER = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|fc|fd|fe80:|::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.))/i;

export function registerAuth(app: FastifyInstance, o: AuthOptions) {
  const { kv } = o;

  // ----- PIN seeding (hash only) -----
  const seed = () => {
    const envPin = (o.appPin || '').trim();
    if (envPin) {
      if (!PIN_RE.test(envPin)) throw new Error('APP_PIN must be 4-8 digits');
      const efp = crypto.createHash('sha256').update('env:' + envPin).digest('hex');
      if (kv.get('auth.envFp', '') !== efp) { kv.set('pin', hashPin(envPin)); kv.set('auth.envFp', efp); kv.set('pinLen', envPin.length); }
    }
    if (!kv.get<string | null>('pin', null)) { kv.set('pin', hashPin(DEFAULT_PIN)); kv.set('pinLen', DEFAULT_PIN.length); }
  };
  seed();
  let key = kv.get<string | null>('auth.key', null);
  if (!key) { key = crypto.randomBytes(32).toString('hex'); kv.set('auth.key', key, true); }
  const keyBuf = Buffer.from(key, 'hex');
  const storedPin = () => kv.get<string>('pin', '');
  const curFp = () => fingerprint(storedPin());

  // ----- signed session cookie -----
  const sign = (p: Payload) => { const body = b64u(JSON.stringify(p)); return `v1.${body}.${b64u(crypto.createHmac('sha256', keyBuf).update('v1.' + body).digest())}`; };
  const parse = (tok: unknown): Payload | null => {
    if (typeof tok !== 'string') return null;
    const [v, body, mac] = tok.split('.');
    if (v !== 'v1' || !body || !mac) return null;
    const want = crypto.createHmac('sha256', keyBuf).update('v1.' + body).digest();
    const got = Buffer.from(mac, 'base64url');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    try { const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return typeof p.exp === 'number' && typeof p.act === 'number' && typeof p.fp === 'string' ? p : null; } catch { return null; }
  };
  // Secure flag only when THIS request really arrived over https (direct, via Cloudflare/proxy headers). A configured PUBLIC_BASE_URL must
  // not force Secure, otherwise plain-http access (localhost / LAN IP) would silently drop the cookie and the lock screen would loop.
  const isHttps = (req: FastifyRequest) => {
    const xfp = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
    if (xfp.split(',')[0].trim() === 'https') return true;
    if (String(req.headers['cf-visitor'] || '').includes('"https"')) return true;
    return req.protocol === 'https';
  };
  /** Sets the session cookie and returns the signed token (also usable as `Authorization: Bearer` when a browser drops cookies). */
  const setCookie = (req: FastifyRequest, reply: FastifyReply, p: Payload): string => {
    const tok = sign(p);
    reply.setCookie(AUTH_COOKIE, tok, { path: '/', httpOnly: true, sameSite: 'lax', secure: isHttps(req), maxAge: Math.floor((p.exp - Date.now()) / 1000) });
    return tok;
  };
  const clearCookie = (req: FastifyRequest, reply: FastifyReply) =>
    reply.clearCookie(AUTH_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: isHttps(req) });
  const issue = (req: FastifyRequest, reply: FastifyReply): string => { const n = Date.now(); return setCookie(req, reply, { iat: n, exp: n + SESSION_MS, act: n, fp: curFp() }); };

  /** Session token from (in order) the cookie, an `Authorization: Bearer` header, or `?pt=` on GET/HEAD (for <img>/<video> URLs). */
  const tokenOf = (req: FastifyRequest): string | undefined => {
    const c = (req.cookies as any)?.[AUTH_COOKIE];
    if (c && parse(c)) return c;
    const h = String(req.headers.authorization || '');
    if (/^bearer /i.test(h)) { const t = h.slice(7).trim(); if (parse(t)) return t; }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const q = (req.query as any)?.pt;
      if (typeof q === 'string' && parse(q)) return q;
    }
    return undefined;
  };

  /** true when the request carries a valid unlock session (also refreshes the sliding cookie). */
  const unlocked = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const p = parse(tokenOf(req));
    const n = Date.now();
    if (!p || p.exp <= n || p.fp !== curFp()) return false;
    const idle = o.idleMinutes();
    if (idle > 0 && n - p.act > idle * 60e3) return false;
    if (n - p.act > REFRESH_MS) {
      const tok = setCookie(req, reply, { ...p, exp: n + SESSION_MS, act: n });
      // Header-token clients only need a new token when idle tracking is on or the old one has been used for >7 days (keeps image URLs stable otherwise).
      if (idle > 0 || p.exp - n < SESSION_MS - 7 * 24 * 3600e3) reply.header('x-pulse-token', tok);
    }
    return true;
  };

  // ----- client IP (Cloudflare tunnel aware) + brute-force limiter -----
  const trustHeaders = (req: FastifyRequest) => {
    if (o.trustProxyHeaders === '1') return true;
    if (o.trustProxyHeaders === '0') return false;
    return PRIVATE_PEER.test(req.raw.socket?.remoteAddress || '');
  };
  const clientIp = (req: FastifyRequest): string => {
    if (trustHeaders(req)) {
      const cf = String(req.headers['cf-connecting-ip'] || '').trim();
      if (net.isIP(cf)) return cf;
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (net.isIP(xff)) return xff;
    }
    return req.raw.socket?.remoteAddress || 'unknown';
  };
  const attempts = new Map<string, Attempt>();
  let globalFails: number[] = [];
  const gc = setInterval(() => {
    const n = Date.now();
    for (const [k, a] of attempts) if (a.lockedUntil < n && n - a.last > 24 * 3600e3) attempts.delete(k);
    globalFails = globalFails.filter((t) => n - t < GLOBAL_WINDOW_MS);
  }, 10 * 60e3);
  gc.unref();
  app.addHook('onClose', async () => clearInterval(gc));

  const tooMany = (reply: FastifyReply, secs: number) => {
    reply.header('retry-after', String(secs));
    const e: any = err(429, 'rate_limited', `Too many wrong attempts. Try again in ${secs < 90 ? `${secs} seconds` : `${Math.ceil(secs / 60)} minutes`}.`);
    e.retryAfter = secs;
    return e;
  };
  const checkLimit = (ip: string, reply: FastifyReply) => {
    const n = Date.now();
    const a = attempts.get(ip);
    if (a && a.lockedUntil > n) throw tooMany(reply, Math.ceil((a.lockedUntil - n) / 1000));
    globalFails = globalFails.filter((t) => n - t < GLOBAL_WINDOW_MS);
    if (globalFails.length >= GLOBAL_MAX_FAILS) throw tooMany(reply, Math.max(1, Math.ceil((globalFails[0] + GLOBAL_WINDOW_MS - n) / 1000)));
  };
  const recordFail = (ip: string) => {
    const n = Date.now();
    let a = attempts.get(ip);
    if (!a) attempts.set(ip, (a = { fails: 0, strikes: 0, lockedUntil: 0, last: n }));
    if (n - a.last > 24 * 3600e3) a.strikes = 0;
    a.last = n; a.fails++;
    globalFails.push(n);
    if (a.fails >= MAX_TRIES) { a.fails = 0; a.lockedUntil = n + LOCKOUTS_S[Math.min(a.strikes, LOCKOUTS_S.length - 1)] * 1000; a.strikes++; }
  };
  /** Verifies a PIN with rate limiting; throws 429 / 401. */
  const checkPin = (req: FastifyRequest, reply: FastifyReply, pin: unknown) => {
    const ip = clientIp(req);
    checkLimit(ip, reply);
    if (typeof pin === 'string' && PIN_RE.test(pin) && verifyPin(pin, storedPin())) {
      attempts.delete(ip);
      // Remember only the length (never the digits) so the lock screen can submit as soon as the last digit is typed.
      if (kv.get<number | null>('pinLen', null) !== pin.length) kv.set('pinLen', pin.length);
      return;
    }
    recordFail(ip);
    const a = attempts.get(ip)!;
    if (a.lockedUntil > Date.now()) throw tooMany(reply, Math.ceil((a.lockedUntil - Date.now()) / 1000));
    throw err(401, 'bad_pin', `Incorrect PIN. ${MAX_TRIES - a.fails} ${MAX_TRIES - a.fails === 1 ? 'try' : 'tries'} left.`);
  };

  // API responses (session status, 423s, JSON) must never be cached by Safari/PWA, Cloudflare or a service worker.
  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    if (/^\/+api(\/|$)/i.test(req.url) && !reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });

  // ----- enforcement -----
  const OPEN = new Set(['GET /api/health', 'HEAD /api/health', 'GET /api/session', 'HEAD /api/session', 'POST /api/session/unlock', 'POST /api/session/lock']);
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const route = req.routeOptions?.url;
    if (route && OPEN.has(`${req.method} ${route}`)) return;
    // Unmatched non-API paths fall through to the static web shell, which only renders the lock screen until unlocked.
    const path = req.url.split('?')[0];
    if (!route && !/^\/+api(\/|$)/i.test(path)) return;
    if (!unlocked(req, reply)) throw err(423, 'locked', 'App is locked. Enter your PIN.');
  });

  app.post('/api/session/unlock', async (req: any, reply: FastifyReply) => {
    checkPin(req, reply, req.body?.pin);
    return { locked: false, token: issue(req, reply) };
  });
  app.post('/api/session/lock', async (req: FastifyRequest, reply: FastifyReply) => { clearCookie(req, reply); return { locked: true }; });
  // Change PIN: requires an unlocked session and the current PIN (rate limited like unlock).
  app.post('/api/settings/pin', async (req: any, reply: FastifyReply) => {
    const { pin, currentPin } = req.body || {};
    checkPin(req, reply, currentPin);
    if (!PIN_RE.test(String(pin ?? ''))) throw err(400, 'bad_request', 'PIN must be 4-8 digits');
    kv.set('pin', hashPin(String(pin)));
    kv.set('pinLen', String(pin).length);
    const token = issue(req, reply); // new fingerprint: all other sessions are signed out
    return { pinEnabled: true, token };
  });

  return {
    isLocked: (req: FastifyRequest, reply: FastifyReply) => !unlocked(req, reply),
    /** Number of digits in the current PIN (4-8), or null if unknown (set before this was tracked). */
    pinLength: (): number | null => { const n = kv.get<number | null>('pinLen', null); return typeof n === 'number' && n >= 4 && n <= 8 ? n : null; },
  };
}
