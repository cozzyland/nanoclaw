#!/bin/bash
# Launch clean Chromium for Cloudflare-protected sites.
# No Playwright automation flags — Cloudflare can't detect automation.
# Usage: launch-browser.sh [url]
# After solving Cloudflare, use: agent-browser --cdp 9222 snapshot

URL="${1:-about:blank}"

# Persist browser state (cookies, login) across container runs
# /workspace/group is mounted from host, so this survives restarts
BROWSER_DATA="/workspace/group/.chromium-data"
mkdir -p "$BROWSER_DATA"

# Kill any existing Chromium instances
pkill -f 'chromium.*--remote-debugging-port' 2>/dev/null
sleep 1

exec /usr/bin/chromium \
  --no-sandbox \
  --disable-blink-features=AutomationControlled \
  --no-proxy-server \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  --disable-infobars \
  --remote-debugging-port=9222 \
  --user-data-dir="$BROWSER_DATA" \
  "$URL"
