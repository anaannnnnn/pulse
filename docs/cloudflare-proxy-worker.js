/**
 * Pulse provider proxy: a tiny Cloudflare Worker that forwards ThePornDB / StashDB calls for networks where those hosts are
 * blocked (DNS or ISP). Paste this whole file into a new Worker (see docs/hosting.md, "Provider proxy").
 *
 * Settings > Variables and Secrets:   PROXY_SECRET   (type: Secret)   a long random string, also put in the Pulse server as
 *                                     PROVIDER_PROXY_SECRET. Optionally ALLOWED_HOSTS (comma list) to override the allowlist.
 *
 * Request contract (what the Pulse server sends):
 *   any method to https://<your-worker>.workers.dev/   with headers
 *     X-Proxy-Secret: <PROXY_SECRET>
 *     X-Proxy-Target: https://api.theporndb.net/scenes?q=...      (full https URL; its host must be on the allowlist)
 *   plus the original headers (Authorization / ApiKey / Content-Type / Accept ...) and body, which are passed through untouched.
 * The response (status, headers, body) is returned as is. Problems with the proxy itself carry `X-Pulse-Proxy-Error: 1`.
 */
const DEFAULT_ALLOWED = ['api.theporndb.net', 'stashdb.org'];
// request headers that must not be copied to the upstream request
const DROP = new Set(['host', 'x-proxy-secret', 'x-proxy-target', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip']);

const fail = (status, code, message) =>
  new Response(JSON.stringify({ error: { code, message } }), { status, headers: { 'content-type': 'application/json', 'x-pulse-proxy-error': '1', 'cache-control': 'no-store' } });

/** Constant-time string comparison. */
function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const secret = env.PROXY_SECRET;
    if (!secret || String(secret).length < 16) return fail(500, 'proxy_not_configured', 'Set a PROXY_SECRET secret (16+ characters) on this Worker.');
    if (!safeEqual(request.headers.get('x-proxy-secret') || '', secret)) return fail(403, 'forbidden', 'Bad or missing X-Proxy-Secret.');

    let target;
    try { target = new URL(request.headers.get('x-proxy-target') || ''); } catch { return fail(400, 'bad_target', 'X-Proxy-Target must be a full https URL.'); }
    const allowed = (env.ALLOWED_HOSTS ? String(env.ALLOWED_HOSTS).split(',') : DEFAULT_ALLOWED).map((h) => h.trim().toLowerCase()).filter(Boolean);
    if (target.protocol !== 'https:' || target.username || target.password || target.port) return fail(400, 'bad_target', 'Only plain https URLs are allowed.');
    if (!allowed.includes(target.hostname.toLowerCase())) return fail(403, 'host_not_allowed', `Host ${target.hostname} is not on the allowlist.`);

    const headers = new Headers();
    for (const [k, v] of request.headers) if (!DROP.has(k.toLowerCase()) && !k.toLowerCase().startsWith('cf-')) headers.set(k, v);

    const hasBody = !['GET', 'HEAD'].includes(request.method);
    const upstream = await fetch(target.toString(), { method: request.method, headers, body: hasBody ? request.body : undefined, redirect: 'manual' });

    const out = new Headers(upstream.headers);
    out.set('x-pulse-proxy-via', 'worker');
    out.set('cache-control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
  },
};
