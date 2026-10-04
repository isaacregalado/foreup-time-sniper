#!/bin/bash
# Bethpage Sniper dashboard launcher (called by "Bethpage Sniper.app").
# Starts the UI server if it isn't running, then opens it in the browser.
# The server stays up afterwards — auto-arm schedules and VM runs need it.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd /Users/Isaac/bethpage-sniper || exit 1
mkdir -p logs
# A Playwright upgrade without its matching browser makes every run die at
# launch (found 2026-10-03). Self-heal on every app open; no-op when present.
if ! node -e "require('fs').accessSync(require('playwright').chromium.executablePath())" >/dev/null 2>&1; then
  osascript -e 'display notification "Installing the browser the sniper needs (one time, ~1 min)…" with title "Bethpage Sniper"' >/dev/null 2>&1
  npx playwright install chromium >> logs/ui.log 2>&1
fi
if ! lsof -tiTCP:4747 -sTCP:LISTEN >/dev/null 2>&1; then
  NO_OPEN=1 nohup npx tsx src/ui-server.ts >> logs/ui.log 2>&1 &
  for i in $(seq 1 60); do
    lsof -tiTCP:4747 -sTCP:LISTEN >/dev/null 2>&1 && break
    sleep 0.5
  done
fi
# Phone access rides on Tailscale (https://isaacs-macbook-pro.taila51196.ts.net:8443)
pgrep -qx Tailscale || open -ga Tailscale
open "http://localhost:4747"
