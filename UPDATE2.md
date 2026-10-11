# Update 2 — lock fix + visible matching errors

Extract over your existing `pulse-app` folder (overwrite), then:

1. Stop the server (Ctrl+C).
2. Delete the old `web\dist` folder first (new files have new names), then extract.
3. `cd server`, `npm start` (no `npm install` needed; package.json did not change).
4. On the iPhone: fully close the Home-Screen app, open it again (it reloads once to pick up the new version). If it still shows the old screen, delete the Home-Screen icon and Add to Home Screen again.
5. In Cloudflare dashboard: Caching → Configuration → Purge Everything (the old `sw.js` was cached at the edge for 4 hours).

What changed
- Lock: session also works via an `Authorization: Bearer` token (stored in the browser) when a browser drops the cookie; `Secure` cookie only on real https; idle auto-lock is OFF unless you set it again in Settings; API responses are `no-store`; `sw.js`, `index.html`, manifest are never cached by Cloudflare/Safari; the service worker takes over immediately.
- Matching: real errors (HTTP status + response snippet / exception) in Review and `/api/match/status`; per-file reason; "Test ThePornDB" button in Settings (`GET /api/tpdb/test`); key sanitising; failed files retried automatically (1, 5, 15, 60 min) and by Retry matching; "Performer - Title.mp4" names that exist twice on TPDB now match.
