# UPDATE 3 — Nocturne Cinema UI/UX pass

Visual/UX only. No server, API, data or business-logic changes.

## New files
- `web/src/styles/nocturne.css` — final design layer (tokens, hero, rails, cards, dock, sheets, gate)
- `web/src/components/Rail.tsx` — snap rail with desktop arrows and edge fades
- `web/src/lib/useReveal.ts` — IntersectionObserver scroll-reveal (respects reduced motion)

## Changed files
- `web/src/pages/Home.tsx` — new hero (progress bars, eyebrow, meta, counter), rails use `<Rail>`, sections reveal on scroll
- `web/src/main.tsx` — loads Instrument Serif + nocturne.css
- `web/index.html`, `web/vite.config.ts` — theme colour `#06070a`
- `design-system/MASTER.md` — updated design notes

## Fixes
- Poster-card title overlay reused the modal `.scrim` class and inherited its blur/inset; now positioned correctly at the bottom.
- Chip rows no longer snap flush to the screen edge.

## Rebuild
```
cd web && npm install && npm run build
```
Checked: `tsc --noEmit` clean, `vite build` OK, 12 web unit tests pass, mobile (390px) and desktop (1360px) screenshots reviewed.
