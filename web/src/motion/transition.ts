/* Shared-element transition: the poster you tap grows into the detail page backdrop.
   1. rememberPoster() (on tap) drops an identical "ghost" of the poster right on top of the card, so there is no visual gap while the route loads.
   2. startPosterIn() (detail route mounted) grows the ghost to hero size.
   3. endPosterIn() (hero rendered) crossfades ghost -> real backdrop and staggers the content in. */
import { gsap, reduced } from './gsap';

let ghost: HTMLDivElement | null = null;
let grow: gsap.core.Timeline | null = null;
let fresh = 0; // timestamp of the tap
let safety = 0;

const clear = () => {
  window.clearTimeout(safety);
  grow?.kill();
  ghost?.remove();
  ghost = null;
  grow = null;
  fresh = 0;
};

export function rememberPoster(card: HTMLElement | null) {
  clear();
  if (!card || reduced()) return;
  const art = (card.querySelector('.art') as HTMLElement) || card;
  const img = art.querySelector('img') as HTMLImageElement | null;
  if (!img?.currentSrc || !img.complete) return;
  const r = art.getBoundingClientRect();
  const g = document.createElement('div');
  Object.assign(g.style, {
    position: 'fixed', zIndex: '140', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
    borderRadius: getComputedStyle(art).borderTopLeftRadius, backgroundImage: `url("${img.currentSrc}")`, backgroundSize: 'cover', backgroundPosition: 'center',
    pointerEvents: 'none', willChange: 'left,top,width,height', boxShadow: '0 30px 80px -20px rgba(0,0,0,.7)',
  });
  document.body.appendChild(g);
  ghost = g;
  fresh = performance.now();
  safety = window.setTimeout(clear, 5000); // never leave a ghost behind if the tap did not navigate / the page fails to load
}

/** Detail route mounted. Safe to call twice (React StrictMode). */
export function startPosterIn() {
  if (!ghost || performance.now() - fresh > 2500) return false;
  if (grow) return true;
  grow = gsap.timeline().to(ghost, { left: 0, top: 0, width: window.innerWidth, height: Math.min(window.innerHeight * 0.7, 600), borderRadius: 0, duration: 0.62, ease: 'expo.inOut' });
  return true;
}

/** Detail hero is on screen. Returns true when the ghost took part. */
export function endPosterIn(hero: HTMLElement) {
  const g = ghost;
  if (!g) return false;
  const bg = hero.querySelector('.bg') as HTMLElement | null;
  const content = hero.querySelectorAll('.detail-top, .detail-hero > .stack > *');
  gsap.set(bg, { opacity: 0 });
  gsap.set(content, { opacity: 0, y: 24 });
  const run = () => {
    gsap.timeline({ onComplete: clear })
      .to(bg, { opacity: 1, duration: 0.35, ease: 'none' }, 0)
      .to(g, { opacity: 0, duration: 0.35, ease: 'none' }, 0.05)
      .to(content, { opacity: 1, y: 0, duration: 0.6, stagger: 0.06, ease: 'power4.out', clearProps: 'transform,opacity' }, 0);
  };
  if (!grow) startPosterIn();
  if (grow && grow.progress() < 1) grow.eventCallback('onComplete', run);
  else run();
  return true;
}
