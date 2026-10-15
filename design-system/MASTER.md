# Pulse · Violet Glass (design system)

Deep aubergine black, frosted glass surfaces, one violet accent. Tokens and shapes live in `web/src/styles/violet.css`.

## Type (self-hosted in `web/public/fonts`)
- Display: **Unbounded** (wide geometric, weights 500-700, tight tracking). Titles, numerals, wordmark.
- UI: **Outfit** (geometric sans). If you own a licensed face (Batica, Varien, Polea…), drop the file in `public/fonts` and change `--font-display` / `--font-sans`.

## Colour
- Surfaces `--bg #0c0913` → `--surface` → `--raised` → `--elevated`; glass = `--glass-bg` + 1px `--line-2` + blur.
- Accent `--v` / `--grad-v` (violet) for primary actions, progress, rings and focus. Text is lavender-white.
- `--amb-*` is tweened from the artwork on screen and only tints backgrounds and glows.

## Components
- Home: greeting, pill search, category circles, glass banner hero (swipe, story dots), stats row, rails, category cards.
- Cards: 20px radius glass poster cards with tilt + glare. Continue-watching with progress ring. Performers with violet story rings.
- Dock: frosted capsule with a liquid violet indicator (GSAP squash-and-stretch).
- Detail: full-bleed art, glass chips, violet Play pill, "At a glance" tiles.
- Player: violet scrubber, swipe-down to minimise, right edge volume, left edge brightness.
- Lock screen: violet app icon, glass keypad, three.js aurora.

## Motion
GSAP drives movement (`src/motion`): transform and opacity only. Shared-element poster transition into detail. `prefers-reduced-motion` and low-power devices skip decorative motion and WebGL. `?fx=1` forces effects on (testing).

## Rules
Hit targets ≥ 44px. Text contrast ≥ 4.5:1. One accent colour. No emoji icons.
