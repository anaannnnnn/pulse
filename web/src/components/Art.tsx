import { useState } from 'react';
import { hash } from '../lib/format';

const PALETTES = [
  ['#3a3428', '#c6a15b', '#1a1814'],
  ['#2a2824', '#8a7350', '#14120e'],
  ['#24302c', '#8aa399', '#161614'],
  ['#2c261c', '#e4c98a', '#0c0c0b'],
  ['#1e2428', '#b7b1a6', '#14120e'],
];

/** Generated cover art in the kit's style (gradient blobs + rings) used when no poster exists. */
export function GenArt({ seed, label }: { seed: string; label?: string }) {
  const h = hash(seed);
  const p = PALETTES[h % PALETTES.length];
  const r = (n: number) => ((h >> n) & 0xff) / 255;
  return (
    <div className="gen-art" aria-hidden>
      <span className="blob" style={{ background: p[0], width: '75%', height: '60%', left: `${-20 + r(1) * 30}%`, top: `${-10 + r(3) * 20}%`, opacity: 0.85 }} />
      <span className="blob" style={{ background: p[1], width: '70%', height: '55%', right: `${-25 + r(5) * 20}%`, top: `${25 + r(7) * 20}%`, opacity: 0.8 }} />
      <span className="blob" style={{ background: p[2], width: '55%', height: '45%', left: `${10 + r(9) * 30}%`, bottom: '-18%', opacity: 0.55 }} />
      <svg viewBox="0 0 100 150" preserveAspectRatio="xMidYMid slice">
        {[14, 24, 34, 44, 54].map((rad) => (
          <circle key={rad} cx="50" cy="80" r={rad} fill="none" stroke="#fff" strokeWidth="0.4" />
        ))}
      </svg>
      {label && <span className="label clamp-3">{label}</span>}
    </div>
  );
}

/** <img> with graceful fallback to generated art; images use no-referrer for privacy. */
export function Cover({ src, alt, seed, label, eager, className }: { src?: string | null; alt: string; seed: string; label?: string; eager?: boolean; className?: string }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  if (!src || failed) return <GenArt seed={seed} label={label} />;
  return (
    <>
      {!loaded && <div className="sk" style={{ position: 'absolute', inset: 0, borderRadius: 0 }} />}
      <img
        className={className}
        src={src}
        alt={alt}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        style={{ opacity: loaded ? 1 : 0, transition: 'opacity 300ms' }}
      />
    </>
  );
}
