// Smoke test against the real backend through the Vite preview proxy: node scripts/smoke-real.mjs [baseUrl]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const base = process.argv[2] || 'http://127.0.0.1:4173';
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/screens');
mkdirSync(out, { recursive: true });
const b = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(`pageerror ${e.message}`));
p.on('response', (r) => r.url().includes('/api/') && r.status() >= 400 && errs.push(`${r.status()} ${new URL(r.url()).pathname}`));
await p.goto(`${base}/?mock=0`, { waitUntil: 'networkidle' });
for (const [route, name] of [['/', 'home'], ['/library', 'library'], ['/library?tab=performers', 'stars'], ['/library?tab=review', 'review'], ['/torbox', 'torbox'], ['/settings', 'settings'], ['/settings/pcloud', 'pcloud'], ['/settings/torbox', 'torbox-settings']]) {
  await p.goto(base + route, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${out}/real-${name}.png` });
  console.log('ok', route);
}
console.log(errs.length ? errs.join('\n') : 'no errors');
await b.close();
