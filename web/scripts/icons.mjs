// Renders PWA icons from public/favicon.svg
import sharp from 'sharp';
import fs from 'node:fs';
const svg = fs.readFileSync(new URL('../public/favicon.svg', import.meta.url));
const out = (f) => new URL(`../public/icons/${f}`, import.meta.url).pathname;
await sharp(svg).resize(192, 192).png().toFile(out('icon-192.png'));
await sharp(svg).resize(512, 512).png().toFile(out('icon-512.png'));
await sharp(svg).resize(180, 180).flatten({ background: '#07080d' }).png().toFile(out('apple-touch-icon.png'));
// maskable: icon at 80% on brand canvas
const inner = await sharp(svg).resize(410, 410).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#07080d' } }).composite([{ input: inner, gravity: 'center' }]).png().toFile(out('maskable-512.png'));
console.log('icons written');
