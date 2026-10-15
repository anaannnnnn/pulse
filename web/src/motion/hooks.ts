import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { gsap, ScrollTrigger, reduced, finePointer, lowPower } from './gsap';

/** gsap.context scoped to a ref: everything created inside is reverted on unmount (React 19 / StrictMode safe). */
export function useGsapScope<T extends HTMLElement = HTMLDivElement>(fn: (ctx: gsap.Context) => void | (() => void), deps: unknown[] = []): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ctx = gsap.context((c) => fn(c), ref.current);
    return () => ctx.revert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

/** Cards/rails rise in as they enter the viewport, staggered per batch. */
export function useRailReveal(deps: unknown[] = []) {
  useEffect(() => {
    if (reduced()) return;
    const ctx = gsap.context(() => {
      gsap.utils.toArray<HTMLElement>('.section').forEach((sec) => {
        const head = sec.querySelector('.section-head');
        if (head) gsap.fromTo(head, { y: 22, opacity: 0 }, { y: 0, opacity: 1, duration: 0.7, ease: 'power3.out', scrollTrigger: { trigger: sec, start: 'top 92%', once: true } });
        const items = sec.querySelectorAll<HTMLElement>('.rail > *');
        if (!items.length) return;
        gsap.set(items, { opacity: 0, y: 36, scale: 0.94 });
        ScrollTrigger.batch(items, {
          start: 'top 98%',
          once: true,
          onEnter: (b) => gsap.to(b, { opacity: 1, y: 0, scale: 1, duration: 0.8, ease: 'power4.out', stagger: 0.07, overwrite: true, clearProps: 'transform,opacity' }),
        });
      });
    });
    // sections lazy-render content; let layout settle then recompute triggers
    const t = window.setTimeout(() => ScrollTrigger.refresh(), 350);
    return () => {
      window.clearTimeout(t);
      ctx.revert();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** Pointer tilt + moving glare. Touch devices get a press tilt toward the finger. */
export function useTilt<T extends HTMLElement>(ref: RefObject<T | null>, { max = 9, scale = 1.03 } = {}) {
  useEffect(() => {
    const el = ref.current;
    if (!el || reduced() || lowPower()) return;
    const rx = gsap.quickTo(el, 'rotationX', { duration: 0.5, ease: 'power3.out' });
    const ry = gsap.quickTo(el, 'rotationY', { duration: 0.5, ease: 'power3.out' });
    gsap.set(el, { transformPerspective: 700, transformOrigin: '50% 50%' });
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width;
      const py = (e.clientY - r.top) / r.height;
      ry((px - 0.5) * max * 2);
      rx((0.5 - py) * max * 2);
      el.style.setProperty('--gx', `${px * 100}%`);
      el.style.setProperty('--gy', `${py * 100}%`);
    };
    const enter = () => gsap.to(el, { scale, duration: 0.4, ease: 'power3.out', overwrite: 'auto' });
    const leave = () => {
      rx(0);
      ry(0);
      gsap.to(el, { scale: 1, duration: 0.6, ease: 'elastic.out(1,0.6)', overwrite: 'auto' });
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        gsap.to(el, { scale: 0.955, duration: 0.18, ease: 'power2.out', overwrite: 'auto' });
        move(e);
      }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerenter', enter);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', leave);
    el.addEventListener('pointercancel', leave);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerenter', enter);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', leave);
      el.removeEventListener('pointercancel', leave);
      gsap.killTweensOf(el);
    };
  }, [ref, max, scale]);
}

/** Buttons that lean toward a mouse pointer. No-op on touch. */
export function useMagnetic<T extends HTMLElement>(ref: RefObject<T | null>, strength = 0.28) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !finePointer() || reduced()) return;
    const x = gsap.quickTo(el, 'x', { duration: 0.6, ease: 'elastic.out(1,0.5)' });
    const y = gsap.quickTo(el, 'y', { duration: 0.6, ease: 'elastic.out(1,0.5)' });
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      x((e.clientX - (r.left + r.width / 2)) * strength);
      y((e.clientY - (r.top + r.height / 2)) * strength);
    };
    const leave = () => {
      x(0);
      y(0);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
    };
  }, [ref, strength]);
}

/** Splits a title into masked words for the staggered reveal. */
export function splitWords(text: string) {
  return text.split(/\s+/).filter(Boolean);
}
