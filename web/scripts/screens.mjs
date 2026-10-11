// QA screenshots: node scripts/screens.mjs [baseUrl]  (default http://127.0.0.1:4173, demo data via ?mock=1)
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const base = process.argv[2] || 'http://127.0.0.1:4173';
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/screens');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const settle = (ms = 1500) => page.waitForTimeout(ms);
const shot = async (name) => {
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log('saved', `${out}/${name}.png`);
};

await page.goto(`${base}/?mock=1`, { waitUntil: 'networkidle' });
await settle(2500);
await shot('01-home');

await page.goto(`${base}/library`, { waitUntil: 'networkidle' });
await settle(2000);
await shot('02-library');

await page.getByRole('button', { name: /Filters/ }).first().click();
await settle(900);
await shot('03-filter-sheet');
await page.keyboard.press('Escape');

await page.goto(`${base}/scene/pc_50000`, { waitUntil: 'networkidle' });
await settle(2000);
await shot('04-scene-detail');

await page.goto(`${base}/library?tab=performers`, { waitUntil: 'networkidle' });
await settle(1500);
await page.locator('a[href^="/performer/"]').first().click();
await page.waitForLoadState('networkidle');
await settle(2000);
await shot('05-performer-detail');

await page.goto(`${base}/scene/pc_50000`, { waitUntil: 'networkidle' });
await settle(1200);
await page.getByRole('button', { name: /^(Play|Resume)/ }).first().click();
await settle(3500);
await page.mouse.click(195, 300); // reveal controls
await settle(500);
await shot('06-player');
await page.keyboard.press('Escape');
await settle(500);

await page.goto(`${base}/settings`, { waitUntil: 'networkidle' });
await settle(1500);
await shot('07-settings');

await page.goto(`${base}/torbox`, { waitUntil: 'networkidle' });
await settle(1500);
await shot('08-torbox');

await page.goto(`${base}/settings/pcloud`, { waitUntil: 'networkidle' });
await settle(1500);
await shot('09-pcloud');

await ctx.setOffline(true);
await page.evaluate(() => window.dispatchEvent(new Event('offline')));
await settle(500);
await page.goto(`${base}/`).catch(() => {});
await settle(1500);
await shot('10-home-offline');

await page.setViewportSize({ width: 1440, height: 900 });
await ctx.setOffline(false);
await page.goto(`${base}/`, { waitUntil: 'networkidle' });
await settle(2500);
await shot('11-home-desktop');

console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors');
await browser.close();
