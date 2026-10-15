import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, ArrowRight, Info } from 'lucide-react';
import type { Item } from '../api';
import { Cover } from './Art';
import { gsap, reduced, haptic } from '../motion/gsap';
import { splitWords, useMagnetic } from '../motion/hooks';
import { setAmbient } from '../motion/ambient';
import { cx, fmtDate, fmtDuration } from '../lib/format';
import { usePlayer } from '../player/PlayerContext';
import { itemSource } from '../lib/play';
import { usePrefs } from '../lib/prefs';

const FEATURE_MS = 7500;
const poster = (it: Item) => it.scene?.poster || it.scene?.background || it.thumb || null;
const backdrop = (it: Item) => it.scene?.background || it.scene?.poster || it.thumb || null;
const pad = (n: number) => String(n).padStart(2, '0');

/** Featured banner: glass card, serif title, poster fading in from the right. Swipe or tap the dots. */
export function Hero({ items }: { items: Item[] }) {
  const n = items.length;
  const [i, setI] = useState(0);
  const [held, setHeld] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const root = useRef<HTMLElement>(null);
  const playBtn = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ x: number; y: number; id: number; on: boolean } | null>(null);
  const dir = useRef(1);
  const player = usePlayer();
  const nav = useNavigate();
  const { prefs } = usePrefs();
  useMagnetic(playBtn, 0.25);

  const go = useCallback(
    (to: number, d = 1) => {
      dir.current = d;
      setI(((to % n) + n) % n);
      haptic(6);
    },
    [n],
  );

  useEffect(() => {
    if (n < 2 || held || reduced()) return;
    setEpoch((e) => e + 1);
    const t = setInterval(() => go(i + 1, 1), FEATURE_MS);
    return () => clearInterval(t);
  }, [n, held, i, go]);

  const it = items[i];
  useEffect(() => {
    if (it) void setAmbient(backdrop(it), it.id);
  }, [it?.id]);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el || !it || reduced()) return;
    const ctx = gsap.context(() => {
      const d = dir.current;
      const words = gsap.utils.toArray<HTMLElement>('.bn-title .w > span');
      const rest = gsap.utils.toArray<HTMLElement>('.bn-fade');
      gsap.set(words, { yPercent: 110 });
      gsap.set(rest, { opacity: 0, y: 12 });
      gsap
        .timeline()
        .fromTo('.bn-art', { opacity: 0, x: 46 * d, scale: 1.12 }, { opacity: 1, x: 0, scale: 1, duration: 1.1, ease: 'expo.out' }, 0)
        .to(words, { yPercent: 0, duration: 0.9, stagger: 0.05, ease: 'expo.out' }, 0.05)
        .to(rest, { opacity: 1, y: 0, duration: 0.7, stagger: 0.06, ease: 'power3.out' }, 0.18);
    }, el);
    return () => ctx.revert();
  }, [it?.id]);

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button,a')) return;
    drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId, on: false };
    setHeld(true);
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    window.setTimeout(() => setHeld(false), 2500);
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) go(i + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1);
  };

  if (!it) return null;
  const words = splitWords(it.title);
  const cast = it.scene?.performers.slice(0, 2).map((p) => p.name).join(' & ');
  return (
    <section
      ref={root}
      className={cx('banner', prefs.blurThumbs && 'blur')}
      style={{ ['--feat-ms' as string]: `${FEATURE_MS}ms` }}
      aria-roledescription="carousel"
      aria-label="Featured"
      onPointerDown={onDown}
      onPointerUp={onUp}
      onPointerCancel={() => { drag.current = null; }}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
    >
      <div className="bn-art" aria-hidden>
        <Cover src={poster(it)} alt="" seed={it.id} eager />
      </div>
      <div className="bn-copy">
        <span className="bn-eyebrow bn-fade">{it.scene?.site?.name ? `Featured · ${it.scene.site.name}` : 'Featured'}</span>
        <h2 className="bn-title" aria-label={it.title}>
          {words.map((w, k) => (
            <Fragment key={`${it.id}-${k}`}>
              {k > 0 ? ' ' : ''}
              <span className="w" aria-hidden><span>{w}</span></span>
            </Fragment>
          ))}
        </h2>
        <div className="bn-meta bn-fade">
          {it.scene?.date ? fmtDate(it.scene.date) : cast}
          {it.duration ? <> · {fmtDuration(it.duration)}</> : null}
          {it.resolution && /2160|4k/i.test(it.resolution) ? <> · 4K</> : null}
        </div>
        <div className="bn-actions bn-fade">
          <button ref={playBtn} className="btn btn-primary" onClick={() => { haptic(10); player.play(itemSource(it, items)); }}>
            {it.progress && !it.progress.completed ? 'Resume' : 'Play now'} <ArrowRight size={16} />
          </button>
          <button className="icon-btn" aria-label="Details" onClick={() => nav(`/scene/${it.id}`)}>
            <Info size={18} />
          </button>
        </div>
      </div>
      {n > 1 && (
        <div className="bn-pager" role="tablist" aria-label="Featured titles">
          {items.map((x, k) => (
            <button key={x.id} role="tab" aria-selected={k === i} aria-label={`Show featured ${k + 1} of ${n}`} className={cx(k === i && 'on', k === i && held && 'held')} onClick={() => go(k, k > i ? 1 : -1)}>
              <i key={k === i ? epoch : 0} />
            </button>
          ))}
          <span className="cnt">{pad(i + 1)}<em>/{pad(n)}</em></span>
        </div>
      )}
    </section>
  );
}
