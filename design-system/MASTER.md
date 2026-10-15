# Pulse · Maison Noir (design system)

A luxury-cinema look: warm black, ivory type, champagne gold as the only accent.

## Type
- Display: **Bodoni Moda** (titles, numerals, italic accents). Self-hosted in `web/public/fonts`.
- UI: **Hanken Grotesk**. Labels, counters, timestamps: **DM Mono**, uppercase, wide tracking.

## Colour (tokens in `web/src/styles/noir.css`)
- Surfaces `--bg #0b0908` → `--surface` → `--raised` → `--elevated`. Text `--text #f4ede0` (ivory).
- Accent `--gold` / `--grad-gold`. Used for primary actions, progress, rings, focus and rank numerals. Never for large fills.
- `--amb-*` is tweened from the artwork on screen and only tints backgrounds and glows (muted on purpose).
- Light theme is a warm paper variant of the same tokens.

## Signature components
- **Coverflow hero** (`Hero.tsx`): 3D poster arc over a blurred, colour-matched backdrop. Drag with inertia, tap side poster to focus, tap centre to open.
- **Top ten** (`RankCard`): outlined Bodoni numerals tucked behind the poster.
- **Continue watching** (`ContinueCard`): circular gold progress ring around the play button.
- **Performers** (`PersonCard`): gold conic story ring that spins on hover.
- **Bento browse** (`Bento`): wide / tall / small tiles that always tile to a clean rectangle.
- **Dock**: floating gold-hairline capsule with a liquid indicator (GSAP squash-and-stretch).
- **Player**: serif title, gold scrubber, swipe-down to minimise, right edge = volume, left edge = brightness.
- **Lock screen**: monogram crest, diamond pin dots, gold keypad, three.js aurora.

## Motion rules
- GSAP drives everything that moves (`src/motion`). Animate transform and opacity only.
- Shared-element poster transition into the detail page (`motion/transition.ts`).
- `prefers-reduced-motion` and low-power devices skip decorative motion and the WebGL aurora.
- Append `?fx=1` to force effects on (testing only).

## Rules
- One accent colour. No emoji icons. Hit targets ≥ 44px. Text contrast ≥ 4.5:1.
- Posters 8px radius, cards and sheets 12–26px, controls pill.
