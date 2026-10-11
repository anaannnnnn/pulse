#!/usr/bin/env bash
# Expose the backend (which also serves web/dist) through a Cloudflare quick tunnel.
# The URL changes every run; for a stable pCloud redirect URI use a named tunnel or set PUBLIC_BASE_URL.
exec cloudflared tunnel --no-autoupdate --protocol http2 --url "http://localhost:${PORT:-8787}"
