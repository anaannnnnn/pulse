/* One place that registers GSAP plugins and answers "should we animate?". */
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { Flip } from 'gsap/Flip';

gsap.registerPlugin(ScrollTrigger, Flip);
gsap.config({ nullTargetWarn: false });
ScrollTrigger.config({ ignoreMobileResize: true });

export { gsap, ScrollTrigger, Flip };

export const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Weak phones skip the expensive extras (WebGL, tilt). */
export const lowPower = () => {
  if (reduced()) return true;
  if (typeof location !== 'undefined' && /[?&]fx=1\b/.test(location.search)) return false; // debug: force effects on
  const n = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  return (n.hardwareConcurrency ?? 8) <= 2 || (n.deviceMemory ?? 8) <= 2 || !!n.connection?.saveData;
};
export const finePointer = () => typeof matchMedia !== 'undefined' && matchMedia('(hover: hover) and (pointer: fine)').matches;
export const haptic = (ms = 8) => {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not supported */
  }
};
/** Shared easing vocabulary so every screen moves the same way. */
export const EASE = { out: 'power4.out', expo: 'expo.out', soft: 'power3.out', inOut: 'power3.inOut', spring: 'back.out(1.6)', elastic: 'elastic.out(1, 0.55)' } as const;
