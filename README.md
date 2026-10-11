# Pulse — personal streaming app (mobile web / PWA)

Requires **Node.js 22.13 or newer** (Node 24 LTS recommended). The database uses Node's built-in
`node:sqlite`, so there is nothing to compile: no Visual Studio, Python or build tools needed.
The web app is already built (`web/dist`), so you only install the server.

## Windows (PowerShell)
```powershell
cd $HOME\Downloads\pulse-app\server     # wherever you extracted it
node -v                                  # must print v22.13 or newer (v24.x is ideal)
Copy-Item .env.example .env
notepad .env                             # fill in PCLOUD_CLIENT_ID, PCLOUD_CLIENT_SECRET, TPDB_API_KEY, STASHDB_API_KEY (optional), TORBOX_API_KEY, save
npm install
npm start                                # open http://localhost:8787
```
Or just double-click `start-windows.cmd` in the top folder (it creates `server\.env` on first run, opens it in
Notepad, installs and starts the server).

The server reads `server\.env` by itself (a `.env` in the top folder also works). Real environment
variables win over the file.

Phone on the same Wi-Fi: open `http://<your-PC-IP>:8787` (find the IP with `ipconfig`, "IPv4 Address") and use
"Add to Home Screen". If it doesn't load, allow Node.js through Windows Firewall for Private networks.
**PIN lock:** Pulse is always locked until a PIN is entered, and this is enforced by the server (every `/api` route, including video streams and thumbnails, returns 423 without a valid session cookie). The default PIN is **6442** — change it in **Settings > Privacy > Passcode lock** (needs your current PIN). "Lock now" in the same place signs this device out. Sessions last 30 days; 5 wrong tries lock that IP out for 1 minute, escalating on repeats. To set or reset the PIN from the server, put `APP_PIN=123456` (4–8 digits) in `server/.env` and restart; it is applied when its value changes, and only a salted hash is stored. Behind a Cloudflare Tunnel the real client IP is read from `CF-Connecting-IP`.

Optional demo with sample data (port 8788, no pCloud needed): `npm run demo`

## macOS / Linux
```bash
cd server && cp .env.example .env    # fill in your keys
npm install && npm start             # http://localhost:8787
```

## Rebuilding the web app (only if you change it)
```
cd web
npm install
npm run build
```

## Connect pCloud
In your pCloud app settings register the redirect URI: `http://localhost:8787/api/pcloud/callback`
(works when you authorize from the computer running the server). Or use the paste-a-code option on the pCloud page in the app.

## Metadata sources: ThePornDB + StashDB
Pulse matches your files against **ThePornDB** (`TPDB_API_KEY`) and, optionally, **StashDB** (`STASHDB_API_KEY`, from your StashDB account > API key; it is a long token starting with `eyJ`, paste it whole, no quotes).
Both are searched at the same time and the best-scoring candidate wins; the same scene found on both is merged. Scenes, performers (images, aliases, measurements, birthdate...), studios and tags
show which source they came from, and a scene shows a "Matched via ThePornDB/StashDB" badge. In **Settings > Sources** you can test each key (Test / Test StashDB) and switch either provider on or off.
`GET /api/stashdb/test` returns `{ ok, status, hint }`. Details: docs/API.md.
If your ISP blocks these hosts ("ENOTFOUND"), Pulse falls back to DNS-over-HTTPS automatically; if that is blocked too, deploy the free Cloudflare Worker in `docs/cloudflare-proxy-worker.js` and set `PROVIDER_PROXY_URL` / `PROVIDER_PROXY_SECRET` (step by step in docs/hosting.md). The Test buttons show which path works (direct / doh / proxy).

## Tests
`cd server && npm test` (and `npm run typecheck`).

API contract for the future iOS app: docs/API.md
