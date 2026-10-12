# Host Pulse on your domain

Two options. Use a VPS if you want it always on. Use Cloudflare Tunnel if you prefer to keep the server on your Windows PC (PC must stay on while you watch).

Pulse is PIN-locked by default (6442); change it in Settings > Privacy before you share any public link.

## Option A — Ubuntu VPS + Caddy + pm2

On a fresh Ubuntu VPS (Hetzner, DigitalOcean, etc.):

```bash
# 1) Node 22+
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # should be v22.x or newer

# 2) Unpack the app (upload pulse-app.tgz first, e.g. with scp)
mkdir -p ~/pulse && cd ~/pulse
tar -xzf ~/pulse-app.tgz
# if the archive has a top folder, cd into it
cd pulse-app/server 2>/dev/null || cd server

cp .env.example .env
nano .env
# fill PCLOUD_CLIENT_ID, PCLOUD_CLIENT_SECRET, TPDB_API_KEY, TORBOX_API_KEY
# set PUBLIC_BASE_URL=https://pulse.yourdomain.com
# set HOST=0.0.0.0

npm install

# 3) Process manager
sudo npm i -g pm2
pm2 start npm --name pulse -- start
pm2 save
pm2 startup   # run the command it prints

# 4) DNS at your registrar: A record pulse.yourdomain.com -> this VPS IPv4

# 5) HTTPS with Caddy
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

sudo tee /etc/caddy/Caddyfile >/dev/null <<'CADDY'
pulse.yourdomain.com {
  reverse_proxy localhost:8787
}
CADDY
sudo systemctl reload caddy
```

In the pCloud developer console, add redirect URI:
`https://pulse.yourdomain.com/api/pcloud/callback`

Open `https://pulse.yourdomain.com`.

## Option C — Cloudways

Cloudways runs `npm install` and then `npm start`. It does not run a build, so the compiled server and web app are already in the repo. Node **22.13 or newer** (Node 24 is fine).

1. In Cloudways, add a **Node.js** application and set the Node version to **22** or newer. Point a domain at it.
2. Deploy this GitHub repo. Cloudways will detect `PORT` from its own `.env` (for example `3001`). Pulse listens on that port.
3. In the application `.env` (or Cloudways environment variables) set:

```
HOST=0.0.0.0
PUBLIC_BASE_URL=https://your-domain.com
PCLOUD_CLIENT_ID=
PCLOUD_CLIENT_SECRET=
TPDB_API_KEY=
STASHDB_API_KEY=
TORBOX_API_KEY=
```

Do not change `PORT`. Cloudways sets it.

4. The start command must stay:

```bash
npm start
```

5. In the pCloud app settings add this redirect URI:

`https://your-domain.com/api/pcloud/callback`

Redeploy after a new push. No `npm run build` on the server.
## Option B — Cloudflare Tunnel from your Windows PC

Keeps the server on your PC. Free. Your PC must stay on and running Pulse whenever you use the site.

1. Run Pulse locally as usual (`start-windows.cmd` or `npm start` in `server/`) so `http://localhost:8787` works.
2. Create a free Cloudflare account, add your domain (or use a subdomain you already have there).
3. Install `cloudflared` on Windows (from Cloudflare’s downloads page, or `winget install Cloudflare.cloudflared`).
4. In a PowerShell window:

```powershell
cloudflared tunnel login
cloudflared tunnel create pulse
cloudflared tunnel route dns pulse pulse.yourdomain.com
```

5. Create `%USERPROFILE%\.cloudflared\config.yml` (replace TUNNEL_ID with the id `tunnel create` printed):

```yaml
tunnel: TUNNEL_ID
credentials-file: C:\Users\Administrator\.cloudflared\TUNNEL_ID.json

ingress:
  - hostname: pulse.yourdomain.com
    service: http://localhost:8787
  - service: http_status:404
```

6. Run the tunnel (keep this window open, or install it as a Windows service with `cloudflared service install`):

```powershell
cloudflared tunnel run pulse
```

7. In `server\.env` set:

```
PUBLIC_BASE_URL=https://pulse.yourdomain.com
```

Restart Pulse. In pCloud, register:
`https://pulse.yourdomain.com/api/pcloud/callback`

Open `https://pulse.yourdomain.com`.

## Provider proxy: when ThePornDB / StashDB are blocked on your network

Symptom: matching never works and **Settings > Test** (or `GET /api/tpdb/test`, `GET /api/stashdb/test`) says the host cannot be found
(`ENOTFOUND`, `EAI_AGAIN`), typical for ISPs that block DNS for these sites. Pulse tries three network paths, in this order, and the test
routes report the one that worked as `path` (`"proxy"`, `"direct"` or `"doh"`):

1. **proxy** – only when `PROVIDER_PROXY_URL` is set (below): every provider call goes through your own Cloudflare Worker.
2. **direct** – the normal system DNS.
3. **doh** – automatic fallback when the system DNS fails: the host name is resolved with DNS-over-HTTPS (cloudflare-dns.com, then dns.google, then
   their fixed IPs 1.1.1.1 / 8.8.8.8) and Pulse connects to that IP with the real host name for TLS (so certificates are still checked). Nothing to configure;
   disable with `PROVIDER_DOH=0`. If your ISP also blocks the IPs themselves, DoH is not enough: use the Worker.

### Set up the Worker (about 5 minutes, free plan is fine)

1. In the Cloudflare dashboard open **Workers & Pages > Create > Create Worker**, name it e.g. `pulse-proxy`, click **Deploy**, then **Edit code**.
2. Delete the sample code, paste the whole of `docs/cloudflare-proxy-worker.js` from this project, click **Deploy**.
3. Open the Worker's **Settings > Variables and Secrets > Add**: type **Secret**, name `PROXY_SECRET`, value a long random string
   (e.g. run `openssl rand -hex 32` or use a password generator, 32+ characters). Save and deploy.
   The Worker only forwards to `api.theporndb.net` and `stashdb.org` (change with an optional `ALLOWED_HOSTS` variable) and rejects every request without the secret.
4. Copy the Worker URL (shown on its overview page, like `https://pulse-proxy.<your-subdomain>.workers.dev`). If `workers.dev` itself is blocked for you, add a
   **custom domain** to the Worker (Settings > Domains & Routes) on a domain you own in Cloudflare and use that instead.
5. On the Pulse server add to `server/.env` (no quotes) and restart:
   ```
   PROVIDER_PROXY_URL=https://pulse-proxy.<your-subdomain>.workers.dev
   PROVIDER_PROXY_SECRET=the-same-long-random-string
   ```
6. Check: open **Settings** in Pulse and tap **Test** (ThePornDB) and **Test StashDB**, or call `/api/tpdb/test` and `/api/stashdb/test`; the answer
   should contain `"path":"proxy"`. A `403` / "proxy rejected the request" means the secret differs between the Worker and `.env`.

Quick manual check of the Worker (replace the URL and secret):
```
curl -s https://pulse-proxy.<sub>.workers.dev/ -H "X-Proxy-Secret: <secret>" -H "X-Proxy-Target: https://stashdb.org/graphql" \
  -H "Content-Type: application/json" -d '{"query":"{ __typename }"}'
```
→ `{"data":{"__typename":"Query"}}`. Without the secret it answers 403.

Other ways to point Pulse elsewhere: `TPDB_BASE_URL` (default `https://api.theporndb.net`) and `STASHDB_URL` (default `https://stashdb.org/graphql`) in `.env`, or per
install under Settings (`metadata.tpdbBaseUrl`, `metadata.stashdbUrl` via `PUT /api/settings`; empty = use the `.env` value). The Worker secret is only read from `.env`.
Only the metadata providers use this path; pCloud and TorBox are unaffected. API keys travel only in request headers (to the Worker over HTTPS, then on to the provider) and are never logged.

## Notes

- Replace `pulse.yourdomain.com` with your real hostname everywhere.
- `PUBLIC_BASE_URL` is what the app uses to build the pCloud OAuth redirect.
- Prefer Option A for a phone-friendly always-on setup.
