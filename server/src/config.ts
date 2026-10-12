import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanSecret } from './secret.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// Minimal .env loader: reads server/.env (or ../.env as a fallback). Never overrides real env vars, never logs values.
// Handles Windows quirks: UTF-8 BOM (Notepad), CRLF line endings, quoted values, trailing spaces and `# comments`.
export const loadedEnvFiles: string[] = [];
for (const envFile of [path.join(root, '.env'), path.join(root, '..', '.env')]) {
  if (!fs.existsSync(envFile)) continue;
  loadedEnvFiles.push(envFile);
  const text = fs.readFileSync(envFile, 'utf8').replace(/^\uFEFF/, '');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (v !== '' && !process.env[m[1]]) process.env[m[1]] = v;
  }
}
const argv = process.argv.slice(2);
const demo = process.env.DEMO_MODE === '1' || argv.includes('--demo');

export const config = {
  port: demo ? Number(process.env.DEMO_PORT || 8788) : Number(process.env.PORT || 8787),
  host: process.env.HOST || '0.0.0.0',
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  dataDir: path.resolve(root, process.env.DATA_DIR || (demo ? 'data-demo-db' : 'data')),
  webDist: path.resolve(root, process.env.WEB_DIST || '../web/dist'),
  pcloud: {
    clientId: cleanSecret(process.env.PCLOUD_CLIENT_ID),
    clientSecret: cleanSecret(process.env.PCLOUD_CLIENT_SECRET),
  },
  tpdbKey: cleanSecret(process.env.TPDB_API_KEY),
  // undefined = adaptive rate limiter (default). TPDB_INTERVAL_MS=0 disables limiting, >0 adds a fixed spacing floor.
  tpdbIntervalMs: process.env.TPDB_INTERVAL_MS != null && process.env.TPDB_INTERVAL_MS !== '' ? Number(process.env.TPDB_INTERVAL_MS) : (undefined as number | undefined),
  tpdbMaxRps: Number(process.env.TPDB_MAX_RPS || 10),
  tpdbStartRps: Number(process.env.TPDB_START_RPS || 8),
  matchConcurrency: Number(process.env.MATCH_CONCURRENCY || 10),
  matchFallbackBudget: Number(process.env.MATCH_FALLBACK_BUDGET || 6),
  scanConcurrency: Number(process.env.SCAN_CONCURRENCY || 6),
  // unit tests (vitest) never pick up a real key from the environment or .env; tests pass `env: { stashdbKey }` explicitly
  /** ThePornDB API root; override when the default host is blocked (own proxy / mirror). */
  tpdbBaseUrl: (process.env.TPDB_BASE_URL || 'https://api.theporndb.net').trim().replace(/\/+$/, ''),
  /** Cloudflare Worker (docs/cloudflare-proxy-worker.js) that forwards provider calls when DNS/ISP blocks them, + its shared secret. */
  providerProxyUrl: (process.env.PROVIDER_PROXY_URL || '').trim().replace(/\/+$/, ''),
  providerProxySecret: cleanSecret(process.env.PROVIDER_PROXY_SECRET),
  /** DNS-over-HTTPS fallback when the system resolver fails (PROVIDER_DOH=0 disables). */
  providerDoh: process.env.PROVIDER_DOH !== '0' && !process.env.VITEST,   // unit tests never touch the real DoH resolvers
  stashdbKey: process.env.VITEST ? '' : cleanSecret(process.env.STASHDB_API_KEY),
  stashdbUrl: (process.env.STASHDB_URL || 'https://stashdb.org/graphql').trim(),
  stashdbIntervalMs: Number(process.env.STASHDB_INTERVAL_MS ?? 150),
  torboxKey: cleanSecret(process.env.TORBOX_API_KEY),
  appPin: cleanSecret(process.env.APP_PIN),
  secret: process.env.PULSE_SECRET || process.env.APP_SECRET || '',
  version: '1.0.0',
  demo,
  demoPort: Number(process.env.DEMO_PCLOUD_PORT || 8795),
};
fs.mkdirSync(config.dataDir, { recursive: true });
