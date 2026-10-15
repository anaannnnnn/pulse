import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, authEvents, ApiError, isMock } from './api';
import { ToastProvider } from './components/Toast';
import { PrefsProvider, usePrefs } from './lib/prefs';
import { PlayerProvider } from './player/PlayerContext';
import { Player, MiniPlayer } from './player/Player';
import { TabBar } from './components/TabBar';
import { LockScreen } from './components/Gate';
import { ErrorState } from './components/ui';
import Home from './pages/Home';
import Library from './pages/Library';

const SceneDetail = lazy(() => import('./pages/SceneDetail'));
const PerformerDetail = lazy(() => import('./pages/PerformerDetail'));
const Studio = lazy(() => import('./pages/Studio'));
const Favorites = lazy(() => import('./pages/Favorites'));
const TorBox = lazy(() => import('./pages/TorBox'));
const Settings = lazy(() => import('./pages/Settings'));
const PcloudSettings = lazy(() => import('./pages/PcloudSettings'));
const TorboxSettings = lazy(() => import('./pages/TorboxSettings'));
const OAuthCallback = lazy(() => import('./pages/OAuthCallback'));

// warm the heaviest routes while the browser is idle so navigation (and the poster transition) never waits on a chunk
if (typeof window !== 'undefined') {
  const warm = () => { void import('./pages/SceneDetail'); void import('./pages/PerformerDetail'); void import('./pages/Studio'); void import('./pages/Favorites'); };
  (window.requestIdleCallback || ((f: () => void) => window.setTimeout(f, 1500)))(warm);
}

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (n, e) => !(e instanceof ApiError && e.status < 500 && e.status !== 0) && n < 2,
    },
  },
});

function useOnline() {
  const [on, setOn] = useState(navigator.onLine);
  useEffect(() => {
    const u = () => setOn(navigator.onLine);
    window.addEventListener('online', u);
    window.addEventListener('offline', u);
    return () => {
      window.removeEventListener('online', u);
      window.removeEventListener('offline', u);
    };
  }, []);
  return on;
}

function ScrollTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
    document.documentElement.removeAttribute('data-nav-hidden');
  }, [pathname]);
  return null;
}

function Shell() {
  const { prefs } = usePrefs();
  const online = useOnline();
  useEffect(() => {
    document.body.classList.toggle('blur', prefs.blurThumbs);
  }, [prefs.blurThumbs]);
  useEffect(() => {
    let lastY = window.scrollY;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const y = window.scrollY;
        const root = document.documentElement;
        root.toggleAttribute('data-scrolled', y > 8);
        // Netflix-style dock: hide while reading down, return on any upward scroll or near the top.
        if (Math.abs(y - lastY) > 6) root.toggleAttribute('data-nav-hidden', y > lastY && y > 240);
        lastY = y;
      });
    };
    let startY = 0;
    let tracking = false;
    const onStart = (e: TouchEvent) => {
      if (window.scrollY > 2) return;
      startY = e.touches[0]?.clientY ?? 0;
      tracking = true;
    };
    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      const dy = (e.touches[0]?.clientY ?? 0) - startY;
      const pull = dy > 0 && window.scrollY <= 2 ? Math.min(72, dy * 0.35) : 0;
      document.documentElement.style.setProperty('--pull', `${pull}px`);
    };
    const onEnd = () => {
      if (!tracking) return;
      tracking = false;
      const pull = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pull')) || 0;
      document.documentElement.style.setProperty('--pull', '0px');
      if (pull > 52) window.dispatchEvent(new Event('pulse-refresh'));
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd);
    onScroll();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
    };
  }, []);
  return (
    <>
      <ScrollTop />
      <div className="pull-ind" aria-hidden>Refresh</div>
      {!online && <div className="offline-pill" role="status">You’re offline</div>}
      <Suspense fallback={<main className="page"><div className="spinner" style={{ margin: '30vh auto' }} /></main>}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/library" element={<Library />} />
          <Route path="/performers" element={<Navigate to="/library?tab=performers" replace />} />
          <Route path="/scene/:id" element={<SceneDetail />} />
          <Route path="/performer/:id" element={<PerformerDetail />} />
          <Route path="/studio/:id" element={<Studio />} />
          <Route path="/favorites" element={<Favorites />} />
          <Route path="/torbox" element={<TorBox />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/settings/pcloud" element={<PcloudSettings />} />
          <Route path="/settings/torbox" element={<TorboxSettings />} />
          <Route path="/oauth/pcloud" element={<OAuthCallback />} />
          <Route path="*" element={<main className="page"><ErrorState error={new Error('This page doesn’t exist.')} onRetry={() => history.back()} /></main>} />
        </Routes>
      </Suspense>
      <div className="dock-fade" aria-hidden />
      <MiniPlayer />
      <TabBar />
      <Player />
    </>
  );
}

function Gatekeeper() {
  const client = useQueryClient();
  // The session is re-checked whenever the app regains focus (iOS PWA resume) and on reconnect; the server is the source of truth.
  const s = useQuery({ queryKey: ['session'], queryFn: api.session, retry: 1, staleTime: 15_000, refetchOnWindowFocus: true, refetchOnReconnect: true });
  useEffect(() => {
    const on = () => {
      // locked (manual, idle, expired session): drop every cached library response so nothing stays in memory
      client.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
      client.invalidateQueries({ queryKey: ['session'] });
    };
    authEvents.addEventListener('locked', on);
    return () => authEvents.removeEventListener('locked', on);
  }, [client]);
  // auto-lock after inactivity (server also enforces its own timeout)
  useEffect(() => {
    const d = s.data;
    if (!d?.lockEnabled || d.locked || !(d.lockTimeoutMin > 0)) return;
    let t = 0;
    const arm = () => {
      clearTimeout(t);
      t = window.setTimeout(() => api.lock().then(() => authEvents.dispatchEvent(new Event('locked'))), d.lockTimeoutMin * 60_000);
    };
    const evs = ['pointerdown', 'keydown', 'scroll'];
    evs.forEach((e) => window.addEventListener(e, arm, { passive: true }));
    arm();
    return () => {
      clearTimeout(t);
      evs.forEach((e) => window.removeEventListener(e, arm));
    };
  }, [s.data?.lockEnabled, s.data?.locked, s.data?.lockTimeoutMin]);

  if (s.isLoading)
    return (
      <main className="gate" aria-busy="true">
        <div className="aurora" aria-hidden><i /><i /><i /></div>
        <span className="brand-mark" role="img" aria-label="Pulse" />
        <div className="spinner" />
      </main>
    );
  if (s.isError)
    return (
      <main className="gate">
        <div className="aurora" aria-hidden><i /><i /><i /></div>
        <span className="brand-mark" aria-hidden />
        <ErrorState error={new Error(`Can’t reach your Pulse server. ${(s.error as Error).message}`)} onRetry={() => s.refetch()} />
        {!isMock && <a className="link-btn" href="/?mock=1">Explore with demo data instead</a>}
      </main>
    );
  if (s.data?.locked)
    return (
      <LockScreen
        pinLength={s.data.pinLength}
        onUnlocked={async () => {
          // Verify the server really accepts the new session before leaving the lock screen; never silently bounce back.
          const fresh = await client.fetchQuery({ queryKey: ['session'], queryFn: api.session, staleTime: 0 });
          if (fresh.locked) throw new Error('Unlocked, but this browser did not keep the session. Reload the page and try again.');
          client.setQueryData(['session'], fresh);
          client.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
        }}
      />
    );
  return (
    <PrefsProvider enabled>
      <PlayerProvider>
        <Shell />
      </PlayerProvider>
    </PrefsProvider>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <BrowserRouter>
          <Gatekeeper />
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
