#!/bin/bash
set -e

# Source environment from mounted env-dir (workaround for Apple Container -i bug)
[ -f /workspace/env-dir/env ] && export $(cat /workspace/env-dir/env | xargs)

# Clean stale agent-browser sessions
rm -f ~/.agent-browser/*.pid ~/.agent-browser/*.sock 2>/dev/null || true

# Start Xvfb (virtual display for headed Chromium)
Xvfb :99 -screen 0 1280x720x24 &
export DISPLAY=:99

# Start x11vnc (captures Xvfb display, serves VNC on port 5900)
VNC_ARGS="-display :99 -listen 0.0.0.0 -xkb -ncache 10 -forever -shared -bg"
if [ -n "$VNC_PASSWORD" ]; then
  mkdir -p /tmp/vnc
  x11vnc -storepasswd "$VNC_PASSWORD" /tmp/vnc/passwd
  VNC_ARGS="$VNC_ARGS -rfbauth /tmp/vnc/passwd"
else
  VNC_ARGS="$VNC_ARGS -nopw"
fi
x11vnc $VNC_ARGS

# Start noVNC (web-based VNC client on port 6080)
# Copy noVNC web files to writable tmpfs and add index.html redirect
cp -r /usr/share/novnc /tmp/novnc-web
echo '<html><head><meta http-equiv="refresh" content="0;url=vnc.html?autoconnect=true&resize=remote"></head></html>' > /tmp/novnc-web/index.html
# Proxies websocket connections to x11vnc's VNC port
/usr/share/novnc/utils/novnc_proxy --vnc localhost:5900 --listen 0.0.0.0:6080 --web /tmp/novnc-web &

# CDP relay: socat forwards 0.0.0.0:9223 → 127.0.0.1:9222
# (Chromium binds debug port to loopback when --remote-debugging-pipe is also set)
socat TCP-LISTEN:9223,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:9222 &

# Build TypeScript agent runner
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Buffer stdin then run agent (Apple Container requires EOF to flush stdin pipe)
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
