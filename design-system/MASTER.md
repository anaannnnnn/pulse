# Pulse — Nocturne Cinema

Direction: private cinema. Blue-black canvas, ivory type, one ember signal. Editorial serif for titles, Geist for UI.
Final visual layer: `web/src/styles/nocturne.css` (loaded after app/polish/house, so it wins).

## Tokens

| Token | Value |
|---|---|
| canvas | `#06070a` |
| surface / raised | `#0d0f15` / `#151821` |
| ivory (text, primary button) | `#f6f2e9` |
| ember (progress, live, active) | `#ff5a3c` -> `#ff9a4a` |
| display font | Instrument Serif (400) |
| UI font | Geist Sans / Geist Mono |
| radius | 12 / 16 / 22 / 28 / 999 |

## Signature moments

1. **Hero**: full-bleed under a transparent header, story-style progress bars (one per featured title, restart with the auto-advance timer, pause on touch), Ken Burns image, serif title, swipe left/right. Image and copy drift with scroll (CSS scroll-timeline, progressive).
2. **Rails**: snap rows with edge fades; prev/next arrows on pointer devices; cards stagger in when their section enters the viewport (`useReveal` + `data-reveal`).
3. **Dock**: floating glass pill tab bar on phones, ember dot under the active tab; side rail on desktop.
4. **Cards**: lift + soft spotlight on hover, ember progress line, title scrim.
5. **Detail pages**: serif title, parallax backdrop, glass play bar.

## Rules

- Animate transform and opacity only. Hover transforms are never owned by entrance animations (entrance uses `backwards` fill).
- `prefers-reduced-motion` disables ken-burns, parallax, stagger and progress animation.
- 44px+ tap targets, ivory focus ring, AA contrast on all text.
- Light theme tokens still work (`[data-theme='light']`).

## Anti-patterns avoided

- Purple/magenta gradients, glow on every control, default system or Inter type.
