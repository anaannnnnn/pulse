/* Ambient colour: the whole UI picks up a glow from whatever artwork is on screen (Apple TV / Spotify style).
   Sampling needs a CORS-clean image; if the canvas is tainted we fall back to a stable hue from the item id. */
import { gsap, reduced } from './gsap';
import { hash } from '../lib/format';

type HSL = { h: number; s: number; l: number };
const cache = new Map<string, HSL>();
const root = () => document.documentElement;

function rgbToHsl(r: number, g: number, b: number): HSL {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const l = (mx + mn) / 2;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return { h: (h * 60 + 360) % 360, s: s * 100, l: l * 100 };
}

function sample(src: string): Promise<HSL | null> {
  return new Promise((res) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 24;
        const x = c.getContext('2d', { willReadFrequently: true })!;
        x.drawImage(img, 0, 0, 24, 24);
        const d = x.getImageData(0, 0, 24, 24).data;
        let R = 0, G = 0, B = 0, W = 0;
        for (let i = 0; i < d.length; i += 4) {
          const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
          const w = 0.15 + (mx - mn) / 255 * 2; // favour colourful pixels
          R += d[i] * w; G += d[i + 1] * w; B += d[i + 2] * w; W += w;
        }
        res(rgbToHsl(R / W, G / W, B / W));
      } catch {
        res(null);
      }
    };
    img.onerror = () => res(null);
    img.src = src;
  });
}

const fallback = (seed: string): HSL => ({ h: hash(seed) % 360, s: 70, l: 55 });

/** Tint the app. Safe to call often; later calls win. */
export async function setAmbient(src: string | null | undefined, seed: string) {
  let c = src ? cache.get(src) : undefined;
  if (!c) {
    c = (src ? await sample(src) : null) ?? fallback(seed);
    if (src) cache.set(src, c);
  }
  // keep it vivid but never garish or too dark/light to read on
  const t = { h: c.h, s: Math.min(88, Math.max(48, c.s)), l: Math.min(62, Math.max(46, c.l)) };
  const r = root();
  if (reduced()) {
    r.style.setProperty('--amb-h', String(t.h));
    r.style.setProperty('--amb-s', `${t.s}%`);
    r.style.setProperty('--amb-l', `${t.l}%`);
  } else {
    const cur = parseFloat(getComputedStyle(r).getPropertyValue('--amb-h')) || t.h;
    // shortest way round the colour wheel
    let to = t.h;
    while (to - cur > 180) to -= 360;
    while (cur - to > 180) to += 360;
    const o = { h: cur };
    gsap.to(o, { h: to, duration: 1.1, ease: 'power2.out', overwrite: 'auto', onUpdate: () => r.style.setProperty('--amb-h', String(((o.h % 360) + 360) % 360)) });
    gsap.to(r, { '--amb-s': `${t.s}%`, '--amb-l': `${t.l}%`, duration: 1.1, ease: 'power2.out' });
  }
  window.dispatchEvent(new CustomEvent('pulse-ambient', { detail: t }));
}
