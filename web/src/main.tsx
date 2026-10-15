import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/pulse.css';
import './styles/noir.css';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (import.meta.env.PROD) {
  // Keep the PWA shell fresh: check for a new service worker on start and whenever the app comes back to the foreground, and reload once
  // when a new worker takes control so an old cached build can never keep running.
  import('virtual:pwa-register').then(({ registerSW }) => {
    registerSW({
      immediate: true,
      onRegisteredSW(_url, reg) {
        if (!reg) return;
        const check = () => reg.update().catch(() => {});
        document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
        setInterval(check, 30 * 60_000);
      },
    });
    if ('serviceWorker' in navigator) {
      const had = !!navigator.serviceWorker.controller;
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!had || reloaded) return;
        reloaded = true;
        location.reload();
      });
    }
  }).catch(() => {});
}
