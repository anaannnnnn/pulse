# Pulse — web (PWA)

Vite + React 18 + TypeScript. The mobile-first PWA follows the Figma kit "08 · Pulse — Immersive Sound".

## Run

```bash
export PATH=$HOME/.local/node/bin:$PATH
cd web && npm install
npm run dev            # http://localhost:5173, proxies /api to http://127.0.0.1:8787 (override with PULSE_API=...)
npm run build && npm run preview   # production build + SW on :4173 (same proxy)
```

The backend in `../server` has to be running on :8787. To browse without a backend, open any URL with `?mock=1`; this uses bundled demo data and is remembered until `?mock=0`. You can also build with `VITE_API_MOCK=1`.

## Scripts

- `npm test`: adapter unit tests (vitest).
- `npm run screens [baseUrl]`: QA screenshots at 390×844@2x in demo mode, saved to `../docs/screens/`. Needs `/usr/bin/google-chrome` (override with `CHROME=`).
- `node scripts/smoke-real.mjs [baseUrl]`: visits every screen against the real backend, then reports API errors and failed requests. Its screenshots (`real-*.png`) are git-ignored.
- `npm run icons`: regenerates the PWA icons from `public/favicon.svg`.

## Structure

- `src/api/types.ts`: UI domain types. `client.ts` maps the `docs/API.md` wire format onto them, and `mock.ts` is the same interface backed by demo data.
- `caps` in `src/api/index.ts` lists what the server supports. The UI hides anything it doesn't support (watchlist, device list, pause/resume of TorBox jobs, save-to-pCloud, server-side data reset).
- `src/player/`: the custom player. Controls: play/pause, ±skip, waveform scrubber, speed, quality (original / pCloud transcodes / HLS through hls.js), subtitles, PiP, fullscreen (including iOS), resume, autoplay next, keyboard shortcuts, double-tap to seek, MediaSession. If a direct link fails, it retries through the server proxy, then a transcoded variant, then re-resolves the link.
- `src/pages/`: Home, Library (scenes, stars, studios, review queue), Scene, Performer, Studio, Favorites, TorBox, Settings, pCloud settings and TorBox settings.

No secrets live in the frontend. API keys and the pCloud client secret stay on the server.
