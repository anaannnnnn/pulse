import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Home, LayoutGrid, Users, Download, Settings, Heart } from 'lucide-react';
import { gsap, reduced, haptic } from '../motion/gsap';

const wide = () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches;

/**
 * Liquid-glass dock.
 * - Touch or mouse: press anywhere on the dock and the glass lens follows your finger; icons swell like a Mac dock around it.
 * - Slide across to scrub between tabs (haptic tick per tab), lift to go there. A plain tap works the same way.
 * - On desktop (sidebar layout) it falls back to normal links.
 */
export function TabBar() {
  const loc = useLocation();
  const go = useNavigate();
  const navRef = useRef<HTMLElement>(null);
  const lens = useRef<HTMLSpanElement>(null);
  const els = useRef<(HTMLAnchorElement | null)[]>([]);
  const placed = useRef(false);
  const st = useRef({ down: false, id: -1, startX: 0, moved: false, hover: -1, handled: false });
  const tab = new URLSearchParams(loc.search).get('tab');
  const stars = loc.pathname.startsWith('/performer') || (loc.pathname === '/library' && tab === 'performers');
  const lib = (loc.pathname === '/library' && tab !== 'performers') || loc.pathname.startsWith('/scene') || loc.pathname.startsWith('/studio');
  const items = [
    { to: '/', label: 'Home', icon: Home, active: loc.pathname === '/' },
    { to: '/library', label: 'Library', icon: LayoutGrid, active: lib },
    { to: '/library?tab=performers', label: 'Stars', icon: Users, active: stars, desktopOnly: true },
    { to: '/favorites', label: 'My List', icon: Heart, active: loc.pathname.startsWith('/favorites') },
    { to: '/torbox', label: 'TorBox', icon: Download, active: loc.pathname.startsWith('/torbox') },
    { to: '/settings', label: 'Settings', icon: Settings, active: loc.pathname.startsWith('/settings') },
  ];

  const visible = () => items.map((it, i) => ({ it, i, el: els.current[i] })).filter((v) => v.el && v.el.offsetWidth > 0);

  /** Swell the icons around an x position (px inside the nav). null = relax. */
  const magnify = (px: number | null) => {
    visible().forEach(({ el }) => {
      const e = el as HTMLAnchorElement;
      const ico = e.querySelector('.ico');
      if (!ico) return;
      const c = e.offsetLeft + e.offsetWidth / 2;
      const w = e.offsetWidth;
      const g = px == null ? 0 : Math.exp(-((px - c) ** 2) / (2 * (w * 0.8) ** 2));
      e.classList.toggle('hot', g > 0.5);
      gsap.to(ico, { scale: 1 + 0.6 * g, y: -14 * g, duration: px == null ? 0.6 : 0.28, ease: px == null ? 'elastic.out(1,0.55)' : 'power3.out', overwrite: 'auto' });
    });
  };

  /** Park the lens on the active tab (squash-and-stretch when it travels). */
  const place = (animate: boolean) => {
    const nav = navRef.current;
    const b = lens.current;
    const active = nav?.querySelector('a.active') as HTMLElement | null;
    if (!nav || !b || !active || st.current.down) return;
    const to = { x: active.offsetLeft, y: active.offsetTop, width: active.offsetWidth, height: active.offsetHeight };
    if (!animate || reduced() || !placed.current) {
      gsap.set(b, { ...to, opacity: 1, scaleX: 1, scaleY: 1 });
      placed.current = true;
      return;
    }
    const dist = Math.abs(to.x - (gsap.getProperty(b, 'x') as number));
    gsap
      .timeline({ overwrite: 'auto' })
      .to(b, { x: to.x, y: to.y, width: to.width, height: to.height, duration: 0.6, ease: 'expo.out' }, 0)
      .to(b, { scaleX: 1 + Math.min(0.34, dist / 500), scaleY: 0.88, duration: 0.14, ease: 'power2.out' }, 0)
      .to(b, { scaleX: 1, scaleY: 1, duration: 0.6, ease: 'elastic.out(1,0.45)' }, 0.14);
  };

  useLayoutEffect(() => {
    place(true);
    const nav = navRef.current;
    if (!nav) return;
    const ro = new ResizeObserver(() => place(false));
    ro.observe(nav);
    return () => ro.disconnect();
  }, [loc.pathname, loc.search, stars, lib]);

  const localX = (e: React.PointerEvent) => e.clientX - (navRef.current?.getBoundingClientRect().left ?? 0);
  const nearest = (px: number) => {
    let best = -1, bd = Infinity;
    visible().forEach(({ i, el }) => {
      const e = el as HTMLAnchorElement;
      const d = Math.abs(px - (e.offsetLeft + e.offsetWidth / 2));
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };
  const followLens = (px: number) => {
    const b = lens.current, nav = navRef.current;
    if (!b || !nav) return;
    const w = (gsap.getProperty(b, 'width') as number) || 64;
    const x = Math.max(2, Math.min(nav.clientWidth - w - 2, px - w / 2));
    gsap.to(b, { x, duration: 0.22, ease: 'power3.out', overwrite: 'auto' });
  };

  const onDown = (e: React.PointerEvent) => {
    if (wide()) return;
    const s = st.current;
    s.down = true; s.id = e.pointerId; s.startX = e.clientX; s.moved = false; s.handled = false;
    s.hover = nearest(localX(e));
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    navRef.current?.setAttribute('data-press', '');
    const px = localX(e);
    if (!reduced()) gsap.to(lens.current, { scale: 1.16, duration: 0.45, ease: 'back.out(2.2)', overwrite: 'auto' });
    followLens(px);
    magnify(px);
    haptic(4);
  };
  const onMove = (e: React.PointerEvent) => {
    if (wide()) return;
    const s = st.current;
    const px = localX(e);
    if (!s.down) {
      if (e.pointerType === 'mouse') magnify(px);
      return;
    }
    if (e.pointerId !== s.id) return;
    if (Math.abs(e.clientX - s.startX) > 6) s.moved = true;
    followLens(px);
    magnify(px);
    const h = nearest(px);
    if (h !== s.hover) { s.hover = h; haptic(4); }
  };
  const finish = (e: React.PointerEvent, cancel: boolean) => {
    const s = st.current;
    if (!s.down || e.pointerId !== s.id) return;
    s.down = false;
    navRef.current?.removeAttribute('data-press');
    const target = cancel ? -1 : nearest(localX(e));
    gsap.to(lens.current, { scale: 1, duration: 0.5, ease: 'elastic.out(1,0.5)', overwrite: 'auto' });
    if (e.pointerType !== 'mouse') magnify(null);
    s.handled = true;
    window.setTimeout(() => { s.handled = false; }, 400);
    if (target >= 0) {
      haptic(10);
      const to = items[target].to;
      const same = items[target].active;
      if (!same) go(to);
      else place(true);
    } else place(true);
  };

  useEffect(() => () => { gsap.killTweensOf(lens.current); }, []);

  return (
    <div className="tabbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden /> Pulse
      </div>
      <nav
        aria-label="Main"
        ref={navRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={(e) => finish(e, false)}
        onPointerCancel={(e) => finish(e, true)}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse' && !st.current.down) magnify(null); }}
      >
        <span className="tab-indicator" ref={lens} aria-hidden>
          <i className="spec" />
        </span>
        {items.map(({ to, label, icon: I, active, desktopOnly }, n) => (
          <a
            key={label}
            ref={(el) => { els.current[n] = el; }}
            href={to}
            onClick={(e) => {
              e.preventDefault();
              if (st.current.handled) return; // the pointer path already navigated on pointer-up
              haptic(5);
              go(to);
            }}
            onKeyDown={(e) => { if (e.key === ' ') { e.preventDefault(); go(to); } }}
            className={`${active ? 'active' : ''} ${desktopOnly ? 'desktop-only' : ''}`}
            aria-current={active ? 'page' : undefined}
            draggable={false}
          >
            <span className="ico"><I size={22} strokeWidth={active ? 2.3 : 1.8} aria-hidden /></span>
            <span className="lb">{label}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}
