#!/bin/bash
# Start a Cloudflare Quick Tunnel exposing noVNC on port 6080
# The tunnel URL is written to a file so Raiden can read and send it
#
# Usage: ./scripts/start-vnc-tunnel.sh
# The tunnel URL will be written to: /tmp/nanoclaw-vnc-url.txt

TUNNEL_URL_FILE="/tmp/nanoclaw-vnc-url.txt"
LOG_FILE="/tmp/cloudflared-vnc.log"

# Kill any existing tunnel
pkill -f 'cloudflared.*6080' 2>/dev/null
sleep 1

echo "Starting Cloudflare Tunnel for noVNC (port 6080)..."

# Start cloudflared in background, capture the URL from stderr
cloudflared tunnel --url http://localhost:6080 2>"$LOG_FILE" &
TUNNEL_PID=$!
echo "cloudflared PID: $TUNNEL_PID"

# Wait for the tunnel URL to appear in logs (usually takes 5-10 seconds)
for i in $(seq 1 30); do
  URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_FILE" 2>/dev/null | head -1)
  if [ -n "$URL" ]; then
    echo "$URL" > "$TUNNEL_URL_FILE"
    echo ""
    echo "noVNC accessible at: $URL"
    echo "URL saved to: $TUNNEL_URL_FILE"
    echo ""
    echo "Open this URL on any device (phone, tablet, laptop) to see and interact"
    echo "with the container's browser. Use it for Cloudflare challenges, login,"
    echo "card entry, and 3D Secure prompts."
    exit 0
  fi
  sleep 1
done

echo "ERROR: Tunnel URL not found after 30 seconds. Check $LOG_FILE"
exit 1
