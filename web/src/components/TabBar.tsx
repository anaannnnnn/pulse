import { useLayoutEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Home, LayoutGrid, Users, Download, Settings, Heart } from 'lucide-react';

export function TabBar() {
  const loc = useLocation();
  const navRef = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
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
  useLayoutEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector('a.active') as HTMLElement | null;
    if (!nav || !active) return;
    const place = () => {
      setPill({ x: active.offsetLeft, y: active.offsetTop, w: active.offsetWidth, h: active.offsetHeight });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [loc.pathname, loc.search, stars, lib]);
  return (
    <div className="tabbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden /> Pulse
      </div>
      <nav aria-label="Main" ref={navRef}>
        {pill && (
          <span
            className="tab-indicator"
            style={{ transform: `translate(${pill.x}px, ${pill.y}px)`, width: pill.w, height: pill.h }}
          />
        )}
        {items.map(({ to, label, icon: I, active, desktopOnly }) => (
          <NavLink key={label} to={to} className={() => `${active ? 'active' : ''} ${desktopOnly ? 'desktop-only' : ''}`} aria-current={active ? 'page' : undefined}>
            <I size={22} strokeWidth={active ? 2.3 : 1.8} aria-hidden />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}