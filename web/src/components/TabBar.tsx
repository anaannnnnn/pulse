import { useLayoutEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Home, LayoutGrid, Users, Download, Settings, Heart } from 'lucide-react';
import { gsap, reduced, haptic } from '../motion/gsap';

export function TabBar() {
  const loc = useLocation();
  const navRef = useRef<HTMLElement>(null);
  const blob = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);
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
  // Liquid indicator: slides with a squash-and-stretch, the new icon pops.
  useLayoutEffect(() => {
    const nav = navRef.current;
    const b = blob.current;
    const active = nav?.querySelector('a.active') as HTMLElement | null;
    if (!nav || !b || !active) return;
    const place = (animate: boolean) => {
      const to = { x: active.offsetLeft, y: active.offsetTop, width: active.offsetWidth, height: active.offsetHeight };
      if (!animate || reduced() || !placed.current) {
        gsap.set(b, { ...to, opacity: 1, scaleX: 1, scaleY: 1 });
        placed.current = true;
        return;
      }
      const dist = Math.abs(to.x - (gsap.getProperty(b, 'x') as number));
      gsap
        .timeline()
        .to(b, { x: to.x, y: to.y, width: to.width, height: to.height, duration: 0.55, ease: 'expo.out' }, 0)
        .to(b, { scaleX: 1 + Math.min(0.28, dist / 600), scaleY: 0.9, duration: 0.14, ease: 'power2.out' }, 0)
        .to(b, { scaleX: 1, scaleY: 1, duration: 0.5, ease: 'elastic.out(1,0.5)' }, 0.14);
      const ic = active.querySelector('svg');
      if (ic) gsap.fromTo(ic, { y: 6, scale: 0.8, rotate: -8 }, { y: -1, scale: 1.08, rotate: 0, duration: 0.6, ease: 'back.out(2.4)' });
    };
    place(true);
    const ro = new ResizeObserver(() => place(false));
    ro.observe(nav);
    return () => ro.disconnect();
  }, [loc.pathname, loc.search, stars, lib]);
  return (
    <div className="tabbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden /> Pulse
      </div>
      <nav aria-label="Main" ref={navRef}>
        <span className="tab-indicator" ref={blob} aria-hidden />
        {items.map(({ to, label, icon: I, active, desktopOnly }) => (
          <NavLink key={label} to={to} onClick={() => haptic(5)} className={() => `${active ? 'active' : ''} ${desktopOnly ? 'desktop-only' : ''}`} aria-current={active ? 'page' : undefined}>
            <I size={22} strokeWidth={active ? 2.3 : 1.8} aria-hidden />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}