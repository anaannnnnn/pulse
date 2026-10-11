#!/usr/bin/env bash
# Start Pulse backend (port 8787) and, if present, the Vite dev server (5173).
# Usage: scripts/dev.sh [--demo] [--no-web]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEMO=0; WEB=1
for a in "$@"; do case "$a" in --demo) DEMO=1;; --no-web) WEB=0;; esac; done
cd "$ROOT/server"
[ -d node_modules ] || npm install
if [ "$DEMO" = 1 ]; then npm run demo & else npm run dev & fi
PIDS=($!)
if [ "$WEB" = 1 ] && [ -f "$ROOT/web/package.json" ]; then
  (cd "$ROOT/web" && { [ -d node_modules ] || npm install; } && npx vite) & PIDS+=($!)
fi
trap 'kill ${PIDS[*]} 2>/dev/null' EXIT INT TERM
wait
