import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, Info } from 'lucide-react';
import type { Item } from '../api';
import { Cover } from './Art';
import { gsap, reduced, haptic } from '../motion/gsap';
import { splitWords, useMagnetic } from '../motion/hooks';
import { setAmbient } from '../motion/ambient';
import { rememberPoster } from '../motion/transition';
import { cx, fmtDate, fmtDuration } from '../lib/format';
import { usePlayer } from '../player/PlayerContext';
import { itemSource } from '../lib/play';
import { usePrefs } from '../lib/prefs';

const FEATURE_MS = 7800;
const poster = (it: Item) => it.scene?.poster || it.scene?.background || it.thumb || null;
const backdrop = (it: Item) => it.scene?.background || it.scene?.poster || it.thumb || null;
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Featured "coverflow": posters on a 3D arc over a blurred, colour-matched backdrop.
 * Drag / swipe with inertia, tap a side poster to bring it forward, tap the centre one to open it.
 * `pos` is a continuous position so dragging, snapping and auto-advance all share one layout function.
 */
export function Hero({ items }: { items: Item[] }) {
  const n = items.length;
  const [i, setI] = useState(0);
  const [held, setHeld] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const root = useRef<HTMLElement>(null);
  const deck = useRef<HTMLDivElement>(null);
  const cards = useRef<(HTMLDivElement | null)[]>([]);
  const playBtn = useRef<HTMLButtonElement>(null);
  const pos = useRef({ v: 0 });
  const drag = useRef<{ x: number; id: number; start: number; moved: boolean; lastX: number; lastT: number; vel: number } | null>(null);
  const stop = useRef(0); // spacing between posters in px
  const player = usePlayer();
  const nav = useNavigate();
  const { prefs } = usePrefs();
  useMagnetic(playBtn);

  const layout = useCallback(() => {
    const step = stop.current || 160;
    cards.current.forEach((el, idx) => {
      if (!el) return;
      let d = idx - pos.current.v;
      d = ((((d + n / 2) % n) + n) % n) - n / 2;
      const ad = Math.abs(d);
      gsap.set(el, {
        x: d * step,
        z: -Math.min(ad, 3) * 150,
        rotateY: Math.max(-58, Math.min(58, -d * 44)),
        scale: 1 - Math.min(ad, 3) * 0.075,
        opacity: ad > 2.4 ? 0 : 1 - Math.min(ad, 2) * 0.12,
        zIndex: 100 - Math.round(ad * 10),
        pointerEvents: ad > 2.4 ? 'none' : 'auto',
        '--dim': Math.min(ad, 1.6) * 0.5,
      });
    });
  }, [n]);

  const goTo = useCallback(
    (target: number, dur = 1.15) => {
      const t = ((target % n) + n) % n;
      const base = Math.round(pos.current.v);
      let delta = (((t - base) % n) + n) % n;
      if (delta > n / 2) delta -= n;
      gsap.killTweensOf(pos.current);
      gsap.to(pos.current, { v: base + delta, duration: reduced() ? 0 : dur, ease: 'expo.out', onUpdate: layout });
      setI(t);
      haptic(6);
    },
    [n, layout],
  );

  // measure + initial sweep-in
  useLayoutEffect(() => {
    const measure = () => {
      const w = cards.current[0]?.offsetWidth || 220;
      stop.current = w * 0.6;
      layout();
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (deck.current) ro.observe(deck.current);
    if (!reduced()) {
      pos.current.v = -1.8;
      layout();
      gsap.to(pos.current, { v: 0, duration: 1.8, ease: 'expo.out', delay: 0.15, onUpdate: layout });
    }
    return () => {
      ro.disconnect();
      gsap.killTweensOf(pos.current);
    };
  }, [layout]);

  // auto advance
  useEffect(() => {
    if (n < 2 || held || reduced()) return;
    setEpoch((e) => e + 1);
    const t = setInterval(() => goTo(Math.round(pos.current.v) + 1), FEATURE_MS);
    return () => clearInterval(t);
  }, [n, held, i, goTo]);

  const it = items[i];
  useEffect(() => {
    if (it) void setAmbient(backdrop(it), it.id);
  }, [it?.id]);

  // text reveal on change
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || !it || reduced()) return;
    const ctx = gsap.context(() => {
      const words = gsap.utils.toArray<HTMLElement>('.cf-title .w > span');
      const rest = gsap.utils.toArray<HTMLElement>('.cf-fade');
      gsap.set(words, { yPercent: 115, rotate: 3 });
      gsap.set(rest, { opacity: 0, y: 14 });
      gsap
        .timeline({ delay: 0.12 })
        .to(words, { yPercent: 0, rotate: 0, duration: 1.05, stagger: 0.06, ease: 'expo.out' }, 0)
        .to(rest, { opacity: 1, y: 0, duration: 0.8, stagger: 0.06, ease: 'power3.out' }, 0.2);
    }, el);
    return () => ctx.revert();
  }, [it?.id]);

  // scroll: backdrop drifts slower than the page, deck + copy recede
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || reduced()) return;
    const ctx = gsap.context(() => {
      gsap.to('.cf-bdwrap', { yPercent: 14, ease: 'none', scrollTrigger: { trigger: el, start: 'top top', end: 'bottom top', scrub: true } });
      gsap.to('.cf-stage', { yPercent: -6, scale: 0.94, opacity: 0.2, ease: 'none', scrollTrigger: { trigger: el, start: '20% top', end: 'bottom top', scrub: true } });
    }, el);
    return () => ctx.revert();
  }, []);

  // drag with inertia
  const onDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, id: e.pointerId, start: pos.current.v, moved: false, lastX: e.clientX, lastT: performance.now(), vel: 0 };
    gsap.killTweensOf(pos.current);
    setHeld(true);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) > 8) {
      d.moved = true;
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    if (!d.moved) return;
    const now = performance.now();
    d.vel = (e.clientX - d.lastX) / Math.max(1, now - d.lastT);
    d.lastX = e.clientX;
    d.lastT = now;
    pos.current.v = d.start - dx / (stop.current || 160);
    layout();
    const near = ((Math.round(pos.current.v) % n) + n) % n;
    setI((cur) => (cur === near ? cur : near));
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    window.setTimeout(() => setHeld(false), 2500);
    if (!d || !d.moved) return;
    const throwBy = (-d.vel * 260) / (stop.current || 160);
    const dest = Math.max(d.start - 2, Math.min(d.start + 2, Math.round(pos.current.v + throwBy)));
    goTo(dest, 1.3);
  };
  const clickCard = (idx: number, el: HTMLElement | null) => {
    if (drag.current?.moved) return;
    if (idx === i) {
      rememberPoster(el);
      nav(`/scene/${items[idx].id}`);
    } else goTo(idx);
  };

  if (!it) return null;
  const cast = it.scene?.performers.slice(0, 2).map((p) => p.name).join(' & ');
  const words = splitWords(it.title);
  return (
    <section
      ref={root}
      className={cx('cf', prefs.blurThumbs && 'blur')}
      style={{ ['--feat-ms' as string]: `${FEATURE_MS}ms` }}
      aria-roledescription="carousel"
      aria-label="Featured"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') goTo(i + 1);
        if (e.key === 'ArrowLeft') goTo(i - 1);
      }}
    >
      <div className="cf-bdwrap" aria-hidden>
        {items.map((x, idx) => (
          <div key={x.id} className={cx('cf-bd', idx === i && 'on')}>
            <Cover src={backdrop(x)} alt="" seed={x.id} eager />
          </div>
        ))}
      </div>
      <div className="cf-shade" aria-hidden />

      <div className="cf-stage">
        <div className="cf-deck" ref={deck} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          {items.map((x, idx) => (
            <div
              key={x.id}
              ref={(el) => { cards.current[idx] = el; }}
              className={cx('cf-card', idx === i && 'on')}
              role="button"
              tabIndex={idx === i ? 0 : -1}
              aria-label={idx === i ? `Open ${x.title}` : `Show ${x.title}`}
              onClick={(e) => clickCard(idx, e.currentTarget)}
              onKeyDown={(e) => { if (e.key === 'Enter') clickCard(idx, e.currentTarget); }}
            >
              <div className="art">
                <Cover src={poster(x)} alt="" seed={x.id} eager />
                <span className="cf-gloss" aria-hidden />
                <span className="cf-dim" aria-hidden />
              </div>
            </div>
          ))}
        </div>

        <div className="cf-copy">
          <span className="cf-eyebrow cf-fade">
            <b className="no">№ {pad(i + 1)}</b>
            <span className="sep" aria-hidden />
            <span>{it.scene?.site?.name || 'From your library'}</span>
          </span>
          <h2 className="cf-title" aria-label={it.title}>
            {words.map((w, k) => (
              <Fragment key={`${it.id}-${k}`}>
                {k > 0 ? ' ' : ''}
                <span className={cx('w', k === words.length - 1 && words.length > 1 && 'it')} aria-hidden>
                  <span>{w}</span>
                </span>
              </Fragment>
            ))}
          </h2>
          <div className="cf-meta cf-fade">
            {cast && <span className="cast">{cast}</span>}
            {it.scene?.date && <span>{fmtDate(it.scene.date)}</span>}
            {it.duration ? <span>{fmtDuration(it.duration)}</span> : null}
            {it.resolution && /2160|4k/i.test(it.resolution) ? <span className="pill-4k">4K</span> : null}
          </div>
          <div className="cf-actions cf-fade">
            <button ref={playBtn} className="btn btn-gold btn-lg" onClick={() => { haptic(10); player.play(itemSource(it, items)); }}>
              <Play size={17} fill="currentColor" /> {it.progress && !it.progress.completed ? 'Resume' : 'Play'}
            </button>
            <button className="btn btn-outline btn-lg" onClick={() => nav(`/scene/${it.id}`)}>
              <Info size={17} /> Details
            </button>
          </div>
          {n > 1 && (
            <div className="cf-pager cf-fade" role="tablist" aria-label="Featured titles">
              <span className="num">{pad(i + 1)}</span>
              <div className="lines">
                {items.map((x, k) => (
                  <button key={x.id} role="tab" aria-selected={k === i} aria-label={`Show featured ${k + 1} of ${n}`} className={cx(k === i && 'on', k === i && held && 'held')} onClick={() => goTo(k)}>
                    <i key={k === i ? epoch : 0} />
                  </button>
                ))}
              </div>
              <span className="num dim">{pad(n)}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
