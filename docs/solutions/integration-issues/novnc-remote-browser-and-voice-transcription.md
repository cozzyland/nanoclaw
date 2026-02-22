---
title: "noVNC Remote Browser Access, Voice Transcription, and Container Hardening"
type: integration-issues
date: 2026-02-17
modules:
  - container
  - whatsapp
  - transcription
  - vnc
  - security
tags:
  - noVNC
  - cloudflare-tunnel
  - whisper
  - voice-transcription
  - apple-container
  - browser-persistence
  - container-memory
severity: high
resolution: solved
---

# noVNC Remote Browser Access, Voice Transcription, and Container Hardening

## Problem Statement

Multiple interconnected issues blocked reliable use of NanoClaw's browser agent for grocery ordering on Cloudflare-protected sites (Dunnes Stores):

1. **CDP Remote Debugging unreliable** — `chrome://inspect` required macOS host access, couldn't be used from iPhone/iPad, and failed to focus tabs during Cloudflare challenges at checkout
2. **Browser sessions lost between container restarts** — Cloudflare cookies, login state, and cart items disappeared because Chromium used an ephemeral `/tmp` user data directory
3. **Container OOM with headed Chromium** — 1GB RAM was insufficient; 927MB used with no headroom for page rendering
4. **No voice message support** — Users couldn't send voice notes to Raiden
5. **WhatsApp "waiting for this message"** — Error 479 from rapid restarts desynchronizing Signal encryption

## Investigation Steps

### CDP Approach (Failed)
- Exposed Chromium's `--remote-debugging-port=9222` via socat relay and Apple Container port forwarding
- User could connect via `chrome://inspect#devices` on host machine
- **Problem**: Required macOS host access; couldn't be used remotely from iPhone; tab focus issues during Cloudflare Turnstile challenges at checkout
- **Problem**: Wife also needed access — Tailscale per-device setup was impractical

### Cookie Injection (Failed Earlier)
- Attempted exporting `cf_clearance` cookie from host Chrome and injecting into container Chromium
- **Problem**: Cloudflare binds cookies to TLS fingerprint (JA3/JA4) — cookie from Chrome's TLS stack is rejected by Playwright's Chromium TLS stack

### Browser Session Loss (Root Cause Found)
- `container/scripts/launch-browser.sh` used `--user-data-dir=/tmp/chromium-clean`
- `/tmp` is ephemeral tmpfs inside the container — wiped on every restart
- All Cloudflare clearance cookies, Dunnes login sessions, and cart state lost

### Container Memory (Root Cause Found)
- Dunnes loaded fine on host browser but was extremely slow in container
- `container stats` showed 927MB used out of 1024MB limit
- Headed Chromium + Xvfb + noVNC + agent process exceeded 1GB

## Working Solution

### 1. noVNC Remote Browser Access (Replaced CDP)

**Architecture**: Chromium renders to Xvfb virtual display, x11vnc captures it, noVNC/websockify serves it as a web page, Cloudflare Quick Tunnel provides HTTPS access from anywhere.

```
Chromium → Xvfb :99 → x11vnc (VNC port 5900) → noVNC/websockify (HTTP port 6080) → Cloudflare Tunnel → User's browser (any device)
```

**Files changed:**

- `container/Dockerfile` — Added `x11vnc novnc python3-websockify socat` packages
- `container/entrypoint.sh` (NEW) — Orchestrates Xvfb, x11vnc (with VNC password), noVNC (served from tmpfs copy due to read-only root), socat CDP relay, TypeScript build, agent runner
- `src/vnc-tunnel.ts` (NEW) — Spawns `cloudflared tunnel --url http://localhost:6080`, parses URL from stderr, writes to `/tmp/nanoclaw-vnc-url.txt`
- `src/container-runner.ts` — Added `-p 127.0.0.1:6080:6080` port forward, writes VNC URL to IPC dir for agent access, added `VNC_PASSWORD` to env allowlist
- `src/index.ts` — Added `startVncTunnel()`/`stopVncTunnel()` to main lifecycle

**Key implementation details:**

```bash
# entrypoint.sh — noVNC served from tmpfs (container has --read-only root)
cp -r /usr/share/novnc /tmp/novnc-web
echo '<html><head><meta http-equiv="refresh" content="0;url=vnc.html?autoconnect=true&resize=remote"></head></html>' > /tmp/novnc-web/index.html
/usr/share/novnc/utils/novnc_proxy --vnc localhost:5900 --listen 0.0.0.0:6080 --web /tmp/novnc-web &
```

**VNC password protection:** x11vnc `-rfbauth` with password from `VNC_PASSWORD` env var stored in `.env`.

### 2. Browser Session Persistence

**File changed:** `container/scripts/launch-browser.sh`

```bash
# Before (ephemeral — lost on restart):
--user-data-dir=/tmp/chromium-clean

# After (persistent — survives restarts):
--user-data-dir=/workspace/group/.chromium-data
```

`/workspace/group/` is bind-mounted from the host, so Chromium's cookies, localStorage, IndexedDB, and login sessions persist across container restarts.

### 3. Container Memory Bump

**File changed:** `src/security/container-hardening.ts`

```typescript
// Before:
memory: undefined  // defaults to 1GB

// After:
memory: '2g'
```

Confirmed via web search that Apple Container supports `-m 2g` / `--memory 2g` flag (identical to Docker syntax).

### 4. Local Voice Transcription (whisper.cpp)

**File created:** `src/transcription.ts`

- Uses `whisper-cli` (from `brew install whisper-cpp`) with `ggml-base.en.bin` model (142MB)
- Audio downloaded via Baileys' `downloadMediaMessage`, converted OGG→WAV with ffmpeg, transcribed locally
- Audio never leaves the machine — zero third-party dependency
- Post-processing strips `<|endoftext|>` and similar tokens: `result.replace(/<\|[^>]+\|>/g, '').trim()`

**File changed:** `src/channels/whatsapp.ts`

- Detects voice messages via `isVoiceMessage(msg)` (checks `audioMessage.ptt === true`)
- Transcribes before content sanitization
- Result formatted as `[Voice: <transcript>]`

### 5. WhatsApp "Waiting for This Message" Fix

- Error 479 in logs from rapid service restarts desynchronizing Signal Protocol encryption
- Missing `link-preview-js` package (required by Baileys for link previews)
- Fixed by installing package and doing a clean restart

## Prevention Strategies

### Read-Only Filesystem Awareness
Apple Container runs with `--read-only` root filesystem. Any file writes must target:
- `/tmp` (tmpfs, ephemeral)
- `/workspace` (bind-mounted, persistent)
- Never attempt to write to `/usr/share`, `/app`, or other root paths

### Persistent Storage Planning
Before using any stateful service in a container, explicitly plan where its data directory goes:
- **Ephemeral data** (temp files, build artifacts) → `/tmp`
- **Session data** (browser profiles, cookies) → `/workspace/group/.chromium-data`
- **Agent memory** (CLAUDE.md, conversation state) → `/workspace/group/`

### Container Memory Planning
Headed Chromium with Xvfb requires at minimum:
- Chromium: ~600-800MB
- Xvfb + x11vnc: ~50MB
- Node.js agent process: ~150MB
- Buffer: ~200MB
- **Total: 2GB minimum** for headed browser workflows

### WhatsApp Session Stability
- Avoid rapid restarts (< 30 seconds apart) — desynchronizes Signal Protocol encryption
- Always stop orphaned containers before starting new ones
- Install all Baileys optional dependencies (`link-preview-js`)

### Cloudflare Tunnel URL Management
- Cloudflare Quick Tunnel URLs change on every restart (no account, no fixed URL)
- Always write fresh URL to IPC dir before container spawn
- Agent reads URL from `/workspace/ipc/vnc-url.txt` at runtime

## Cross-References

- `groups/main/CLAUDE.md` — Raiden's instructions for noVNC and Cloudflare challenge handling
- `groups/main/GROCERY_ORDERING_SETUP.md` — Complete grocery ordering workflow with noVNC
- `container/entrypoint.sh` — Container service orchestration
- `src/vnc-tunnel.ts` — Cloudflare Tunnel lifecycle management
- `src/transcription.ts` — Local whisper.cpp transcription module
- `src/security/container-hardening.ts` — Container security and resource limits

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| noVNC over CDP | Works from any device (iPhone, iPad), no Chrome-specific setup, wife can also use it |
| Cloudflare Tunnel over Tailscale | Zero per-device setup, shareable URL, wife doesn't need Tailscale installed |
| Local Whisper over OpenAI/Groq | Most secure — audio never leaves machine, free forever, no API keys needed |
| VNC password over open access | Anyone with the Cloudflare Tunnel URL could view the browser session |
| 2GB over 1GB container memory | Headed Chromium + Xvfb needs headroom; 1GB caused slow page loads |
| Persistent browser data on /workspace | Bind-mounted directory survives container restarts; /tmp does not |
