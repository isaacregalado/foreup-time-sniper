#!/bin/bash
# Bethpage Sniper dashboard launcher (called by "Bethpage Sniper.app").
# Starts the UI server if it isn't running, then opens it in the browser.
# The server stays up afterwards — auto-arm schedules and VM runs need it.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd /Users/Isaac/bethpage-sniper || exit 1
mkdir -p logs
if ! lsof -tiTCP:4747 -sTCP:LISTEN >/dev/null 2>&1; then
  NO_OPEN=1 nohup npx tsx src/ui-server.ts >> logs/ui.log 2>&1 &
  for i in $(seq 1 60); do
    lsof -tiTCP:4747 -sTCP:LISTEN >/dev/null 2>&1 && break
    sleep 0.5
  done
fi
open "http://localhost:4747"
