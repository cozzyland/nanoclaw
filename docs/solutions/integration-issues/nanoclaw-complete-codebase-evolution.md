---
title: "NanoClaw Complete Codebase Evolution"
problem_type: integration_issue
component: full-system
severity: informational
date_documented: 2026-02-16
tags:
  - architecture
  - security
  - whatsapp
  - containers
  - streaming
  - agent-teams
  - cloudflare
  - cdp
  - ipc
related_files:
  - src/index.ts
  - src/container-runner.ts
  - src/channels/whatsapp.ts
  - src/group-queue.ts
  - src/ipc.ts
  - src/router.ts
  - src/security/egress-proxy.ts
  - src/security/container-hardening.ts
  - src/mount-security.ts
  - container/Dockerfile
  - container/agent-runner/src/index.ts
  - container/agent-runner/src/ipc-mcp-stdio.ts
---

# NanoClaw Complete Codebase Evolution

Comprehensive knowledge base documenting every feature, fix, and architectural decision from the original NanoClaw repository (gavrielc/nanoclaw) and the cozzymini fork, covering 109 commits across 17 days of development.

## Repository Info

- **Upstream:** https://github.com/gavrielc/nanoclaw.git
- **Fork:** https://github.com/cozzyland/nanoclaw.git
- **Timeline:** January 31 - February 16, 2026
- **Total commits:** 109 on main (140 across all branches)

---

## 1. Core Architecture

### Message Flow

```
WhatsApp (Baileys) --> sanitizeMessageContent() --> SenderVerification
  --> RateLimiter --> MediaValidator --> storeMessage() --> SQLite
  --> Polling Loop (2s) --> TRIGGER_PATTERN check
  --> GroupQueue (max 5 concurrent containers)
  --> runContainerAgent() --> Container entrypoint.sh
  --> agent-runner/index.ts --> Claude Agent SDK query()
  --> OUTPUT_START/END markers --> Stream parse --> WhatsApp reply
```

### Key Files

| File | Purpose | Lines |
|------|---------|-------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation | ~460 |
| `src/channels/whatsapp.ts` | WhatsApp connection via Baileys, auth, send/receive | ~280 |
| `src/container-runner.ts` | Spawns Apple Container, manages mounts and streaming | ~730 |
| `src/group-queue.ts` | Per-group queue with global concurrency limit | ~250 |
| `src/ipc.ts` | File-based IPC watcher and task processing | ~380 |
| `src/router.ts` | XML message formatting, outbound routing | ~46 |
| `src/db.ts` | SQLite via better-sqlite3 | ~300 |
| `src/task-scheduler.ts` | Polls for due tasks, delegates to GroupQueue | ~150 |
| `container/agent-runner/src/index.ts` | In-container agent bootstrap, SDK query loop | ~385 |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP server: send_message, schedule_task, etc. | ~270 |

### Design Principles

- **Single Node.js process** on host, agents in isolated Linux containers
- **File-based IPC** with directory-level identity (container can't impersonate another group)
- **Skills over features** -- community contributes Claude Code skills, not source patches
- **AI-native** -- Claude Code guides setup, debugging, customization
- **Long-lived containers** -- stay alive for follow-up messages, 30-min idle timeout

---

## 2. Development Timeline

### Phase 1: Genesis (January 31)

**12 commits in one day** established the entire core:

- Initial monolithic `index.ts` (457 lines) with WhatsApp + Claude Agent SDK
- Extracted modules: `config.ts`, `types.ts`, `db.ts`
- Standalone WhatsApp auth script with QR code and macOS notifications
- Built-in task scheduler with MCP tools (schedule_task, list_tasks, etc.)
- **Containerization** -- moved agent execution into Apple Container
  - `container/Dockerfile`: Node 22 + Chromium + agent-browser + Claude Code
  - `container/agent-runner/`: reads JSON from stdin, runs SDK, outputs JSON
  - `src/container-runner.ts`: host-side spawn with volume mounts
  - File-based IPC for container-to-host communication

**Key fix:** Include missed messages when catching up after restart (prevents message loss).

### Phase 2: Stabilization (February 1)

**27 commits** -- the most intense development day:

- **Container fixes:** session persistence, auto-start container system, mount project root for main channel
- **OAuth token support** as alternative to API key
- **Typing indicator** in WhatsApp while container processes
- **PreCompact hook** -- archives conversation transcripts before SDK compaction
- **First security hardening wave (6 fixes):**
  1. IPC authorization checks on task operations
  2. **CRITICAL:** Stopped mounting entire `.env` into containers (was exposing all secrets)
  3. Per-group IPC namespaces (identity from filesystem path, not self-reported)
  4. Fixed hardcoded home directory (`/Users/gavrielc`)
  5. Removed message content from info-level logs
  6. Message loss prevention (cursor only advances on success)
- **Mount security allowlist** (`~/.config/nanoclaw/mount-allowlist.json`) -- external to project, blocks `.ssh`, `.gnupg`, `.aws`, etc., resolves symlinks

### Phase 3: Isolation & Extensibility (February 2)

- **Per-group session isolation** -- each group gets own `.claude/` directory (was shared)
- **Dynamic group registration** -- main agent can register groups at runtime via IPC
- **`/convert-to-docker` skill** (community contribution)
- **CONTRIBUTING.md** with skills-only contribution model

### Phase 4: Integration Skills (February 3-5)

- `/x-integration` skill for X/Twitter
- `/add-voice-transcription` skill (OpenAI Whisper, ~$0.006/min)
- **WhatsApp LID translation fix** -- WhatsApp changed self-chat format from `@s.whatsapp.net` to `@lid`, breaking the main channel
- **Reconnect-stacking fix** -- WhatsApp reconnections were spawning duplicate loops
- Interactive setup UX with `AskUserQuestion`

### Phase 5: Per-Group Queue & SQLite Migration (February 6)

One of the largest changes -- `src/group-queue.ts` (248 lines, new):

- **Per-group container locking** with global concurrency limit (`MAX_CONCURRENT_CONTAINERS=5`)
- **JSON-to-SQLite migration** -- `registered_groups.json`, `sessions.json`, `router_state.json` all migrated with automatic one-time migration
- **Graceful shutdown** with SIGTERM/SIGINT handlers
- **Startup recovery** -- detects messages missed during crash
- **Exponential backoff retry** (5s, 10s, 20s, 40s, 80s, max 5 attempts)

### Phase 6: Streaming Containers & Agent Swarms (February 7-9)

The biggest architectural shift -- from single-shot to long-lived streaming containers:

- **Agent runner query loop** -- `AsyncIterable` prompt keeps stdin open for multi-turn
- **New stdio MCP server** (`ipc-mcp-stdio.ts`) -- inheritable by subagents
- **Real-time streaming** -- OUTPUT_START/END markers parsed as they arrive, sent to WhatsApp immediately
- **Follow-up messages** -- host writes to `ipc/{group}/input/`, agent polls every 500ms
- **Agent teams** -- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` enables subagent orchestration
- **Container idle timeout** -- 30-min idle then `_close` sentinel
- **`<internal>` tag support** -- agent reasoning stripped before WhatsApp delivery

**9 streaming bug fixes** in rapid succession:
1. Scheduled tasks hanging (missing `onOutput` callback)
2. Timeout disabled (stderr resetting timer continuously)
3. Trigger bypass for piped follow-up messages
4. Non-atomic IPC writes causing partial reads (fixed: temp + rename)
5. Resume branching from agent teams (fixed: `resumeSessionAt` anchor)
6. Cursor rollback losing messages on retry
7. Apple Container format differences (`--format json` vs Docker template)
8. Null results resetting idle timer
9. `splice(0)` losing messages on flush error (switched to `shift()`)

### Phase 7: The Great Refactor (February 9-11)

- **Telegram channel** via `grammy` library (later moved to skill)
- **index.ts split** from 1088-line monolith into focused modules:
  - `src/channels/whatsapp.ts` (WhatsAppChannel class)
  - `src/ipc.ts` (IPC watcher with dependency injection)
  - `src/router.ts` (message formatting and routing)
- **98-test regression suite** across 5 test files
- **Timeout race condition fix** -- container timeout and idle timeout both at 30min were racing; hard timeout now = idle + 30s minimum

### Phase 8: WhatsApp Deep Dive (February 12-13)

- **38 WhatsApp connector tests** (connection lifecycle, auth, reconnection, message types, LID, queue, metadata)
- **Pairing code auth** with 515 stream error handling
- **Robust LID-to-phone translation** via `signalRepository.getPNForLID`
- **`requiresTrigger` IPC propagation** and additional directory auto-discovery

---

## 3. Security Architecture (6-Phase Hardening)

Implemented in commit `9518777` (14,430 lines across 48 files) on the cozzymini fork.

### Phase 1: Input Sanitization

| Component | File | What It Does |
|-----------|------|-------------|
| Message sanitization | `src/channels/whatsapp.ts` | Control char removal, Unicode NFKC normalization, 10K char limit, null byte stripping |
| File sanitizer | `src/security/file-sanitizer.ts` | Detects "ignore previous instructions", role manipulation, zero-width chars, hidden HTML |
| Command checker | `src/security/command-checker.ts` | Pattern-based detection of destructive git ops, recursive deletion, credential exfiltration |

### Phase 2: Credential Isolation

- **Credential proxy** (`src/credential-proxy.ts`, port 3001) -- injects API key at proxy level
- Per-group rate limiting (100 calls/min)
- **Pragmatic note:** Agent SDK ignores `ANTHROPIC_BASE_URL`, so API key is passed directly to containers. Credential proxy exists but isn't used for the SDK path. Comment: "Acceptable risk given strong egress filtering, read-only FS, and ephemeral containers"

### Phase 3: Container Hardening

- Read-only root filesystem (`--read-only`)
- Writable tmpfs at `/tmp`, `/var/tmp`, `/home/node/.cache`, `/home/node`
- CPU limit: 2 cores
- Non-root user (`node`)
- Seccomp profile: ~250 allowed syscalls, blocks `mount`, `ptrace`, `bpf`, etc.
- **Apple Container limitations:** `--pids-limit`, `--cap-drop`, `--security-opt seccomp` not supported

### Phase 4: WhatsApp Hardening

- Per-sender rate limiting (20 msg/min normal, configurable)
- Sender verification (allowlist/blocklist, auto from registered groups)
- Media validation (MIME whitelist, 10MB limit, extension check)

### Phase 5: Network Egress Filtering

- **Egress proxy** (`src/security/egress-proxy.ts`, port 3002) -- domain allowlist, DLP scanning
- Detects: Anthropic keys (`sk-ant-`), OpenAI keys, AWS keys, private keys, env var references
- Containers route via `HTTP_PROXY`/`HTTPS_PROXY` to Lima gateway IP `192.168.64.1:3002`
- **Critical exception:** Browser bypasses proxy (`--no-proxy-server`) because proxying breaks Cloudflare TLS fingerprinting
- **Bug found and fixed:** Original `http-proxy` package doesn't support CONNECT method; switched to `http-proxy-middleware`

### Phase 6: Mount Security (TOCTOU Prevention)

- Inode + device numbers captured during validation, re-verified before mounting
- Symlink resolution via `fs.realpathSync()`
- External allowlist at `~/.config/nanoclaw/mount-allowlist.json` (never mounted into containers)
- Blocked patterns: `.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker`, `.env`, `id_rsa`, `credentials`, etc.
- Non-main groups forced read-only regardless of config

### Centralized Security Events

- `src/security/security-events.ts` -- append-only log, in-memory ring buffer (10K events)
- Anomaly detection: >100 events/hour, any critical events, >20 from single group

---

## 4. Container System Deep Dive

### Dockerfile

```
Base: node:22-slim
Installs: chromium, fonts, libgbm1, libnss3, libgtk-3-0, curl, git, socat, xvfb
Global NPM: agent-browser, @anthropic-ai/claude-code
User: node (non-root)
Entrypoint: /app/entrypoint.sh
```

### Entrypoint Script

```bash
set -e
[ -f /workspace/env-dir/env ] && export $(cat /workspace/env-dir/env | xargs)
rm -f ~/.agent-browser/*.pid ~/.agent-browser/*.sock 2>/dev/null || true
Xvfb :99 -screen 0 1280x720x24 &          # Virtual display for headed Chromium
export DISPLAY=:99
socat TCP-LISTEN:9223,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:9222 &  # CDP relay
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2   # Recompile agent-runner
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
```

### Volume Mounts

**Main group:**
| Container Path | Host Path | Access |
|---|---|---|
| `/workspace/project` | Project root | read-write |
| `/workspace/group` | `groups/main/` | read-write |
| `/home/node/.claude` | `data/sessions/main/.claude/` | read-write |
| `/workspace/ipc` | `data/ipc/main/` | read-write |
| `/workspace/env-dir` | `data/env/` | read-only |
| `/app/src` | `container/agent-runner/src/` | read-only |
| `/app/scripts` | `container/scripts/` | read-only |

**Other groups:** Same but `/workspace/group` points to their folder, `/workspace/global` (read-only) for shared memory, no project root access.

### IPC Mechanism

Entirely file-based with atomic writes (temp + `fs.renameSync`):

- **Outbound (container -> host):** JSON files to `/workspace/ipc/messages/` and `/workspace/ipc/tasks/`, host polls every 1s
- **Inbound (host -> container):** JSON to `data/ipc/{group}/input/`, container polls every 500ms
- **Close sentinel:** Empty `_close` file signals container to exit
- **Identity:** Determined by directory path, not self-reported -- impossible for container to impersonate another group

### Source-Mounted Recompilation

Agent-runner TypeScript source is mounted read-only from host, recompiled on every container start. This bypasses Apple Container's sticky build cache. Compiled output goes to `/tmp/dist` (tmpfs) and is made read-only.

### Apple Container Build Cache Workaround

`--no-cache` alone doesn't invalidate COPY steps. Must destroy and recreate the builder:
```bash
container builder stop && container builder rm && container builder start
./container/build.sh
```

---

## 5. Browser Automation & Cloudflare Bypass

### agent-browser Integration

- Globally installed NPM package wrapping Playwright/Chromium
- Snapshot-based interaction model with element refs (`@e1`, `@e2`)
- Anti-detection flags: `--disable-blink-features=AutomationControlled`, `--no-sandbox`, `--no-proxy-server`
- `AGENT_BROWSER_HEADED=1` runs headed mode into Xvfb virtual display

### CDP Remote Debugging

Chromium's debug port is exposed to the host for manual browser interaction:

- Chromium binds `--remote-debugging-port=9222` to `127.0.0.1` inside container
- **Problem:** `--remote-debugging-address=0.0.0.0` is ignored when `--remote-debugging-pipe` (Playwright's transport) is also set
- **Solution:** socat relay in entrypoint: `0.0.0.0:9223 -> 127.0.0.1:9222`
- Port forwarding: `-p 127.0.0.1:9222:9223` maps host `localhost:9222` to container's socat
- Chrome on host auto-discovers via `chrome://inspect#devices` (pre-configured with `localhost:9222`)

### Cloudflare Turnstile Bypass

Playwright's automation flags (`--enable-automation` and dozens of `--disable-features`) are fingerprinted by Cloudflare, causing the challenge to loop infinitely even with real human clicks.

**Solution: Clean Chromium launch**
- `container/scripts/launch-browser.sh` starts Chromium directly (no Playwright) with minimal flags
- User solves challenge through `chrome://inspect` DevTools screencast
- Agent then uses `agent-browser --cdp 9222` to interact with the same browser instance

**What failed:**
- Cookie injection from host Chrome (cf_clearance bound to TLS fingerprint)
- curl-impersonate (can't execute JavaScript, Dunnes is a SPA)
- agent-browser directly (Playwright automation signals detected)
- `--remote-debugging-address=0.0.0.0` (ignored with `--remote-debugging-pipe`)
- Headless Chrome DevTools (no visual surface for screencast -- needed Xvfb + headed mode)

### Cookie Pipeline

`container/scripts/inject-cookies.js` converts Cookie-Editor browser extension exports to Playwright `storageState` format. Useful for sites requiring authentication, but NOT for Cloudflare bypass (TLS fingerprint mismatch).

---

## 6. Streaming Output Protocol

Container output uses sentinel markers for robust parsing:

```
---NANOCLAW_OUTPUT_START---
{"status":"success","result":"Hello! How can I help?","newSessionId":"abc123"}
---NANOCLAW_OUTPUT_END---
```

- Parsed as stdout data arrives (real-time streaming to WhatsApp)
- Robust against SDK debug output and stderr noise
- Multiple marker pairs per container lifecycle (long-lived containers)
- `newSessionId` propagated for session persistence
- Activity resets the hard timeout; idle detection only on streaming output (not stderr)

---

## 7. Session Management

- Sessions stored in SQLite (`sessions` table) with group folder, session ID, last assistant UUID
- `resumeSessionAt` anchors resume to correct branch (prevents agent teams branching issues)
- PreCompact hook archives full transcript to `conversations/` before SDK compaction
- Per-group Claude sessions at `data/sessions/{group}/.claude/` (isolated)

---

## 8. Scheduled Tasks

Three schedule types:
- **cron:** Standard cron expressions with timezone (uses `cron-parser`)
- **interval:** Milliseconds between runs
- **once:** ISO 8601 timestamp for one-time execution

Two context modes:
- **group:** Uses existing conversation session (has chat history)
- **isolated:** Fresh session each run (all context in prompt)

Scheduler polls every 60 seconds. Tasks have status tracking (active/paused/completed) and run logging.

---

## 9. Skills System

### Development-Side Skills (`.claude/skills/`)

| Skill | Purpose |
|-------|---------|
| `/setup` | First-time installation, auth, service config |
| `/customize` | Adding channels, integrations, behavior changes |
| `/debug` | Container troubleshooting |
| `/add-telegram` | Telegram channel |
| `/add-telegram-swarm` | Telegram with agent swarm bots |
| `/add-gmail` | Gmail integration |
| `/add-voice-transcription` | OpenAI Whisper voice transcription |
| `/add-parallel` | Parallel AI research |
| `/convert-to-docker` | Docker migration |
| `/x-integration` | X/Twitter posting |

### Container-Side Skills (`container/skills/`)

Synced to each group's `.claude/skills/` on container spawn. Currently: `agent-browser` skill with comprehensive browser automation reference.

---

## 10. Notable Bugs and Their Fixes

### Message Replay Loop (PR #164)
**Symptom:** Same messages processed over and over.
**Root cause:** Container timeout and idle timeout both at 30 minutes, racing. Hard kill returned error, rolling back cursor even though output was already sent.
**Fix:** Hard timeout = idle + 30s minimum; timeout-after-output resolves as success.

### HTTPS Egress Proxy Silent Failure
**Symptom:** All HTTPS requests from containers failing silently.
**Root cause:** `http-proxy` npm package doesn't support HTTP CONNECT method.
**Fix:** Switched to `http-proxy-middleware` which handles CONNECT properly.

### WhatsApp LID Breaking Self-Chat
**Symptom:** Bot stopped responding to self-chat messages (main channel).
**Root cause:** WhatsApp changed self-chat format from `@s.whatsapp.net` to `@lid`.
**Fix:** Build LID-to-phone mapping using `signalRepository.getPNForLID`.

### Reconnect-Stacking Duplicate Responses
**Symptom:** Multiple responses to same message after WhatsApp reconnection.
**Root cause:** Each reconnect called `startMessageLoop`/`startSchedulerLoop` again without stopping previous.
**Fix:** Guard flags for once-per-lifetime loop starts.

### Non-Atomic IPC Writes
**Symptom:** Garbled JSON in IPC messages, parse errors.
**Root cause:** Race condition -- host reading file while container is still writing.
**Fix:** Write to `.tmp` file, then `fs.renameSync()` (atomic on same filesystem).

### Agent Teams Resume Branching
**Symptom:** Conversations becoming confused, mixing subagent contexts.
**Root cause:** Subagents write to JSONL session log in parallel, creating invisible branches.
**Fix:** Pass `resumeSessionAt` with last assistant UUID to anchor resume.

### .env File Mounted Into Containers
**Symptom:** All environment variables (including secrets) exposed to containers.
**Root cause:** Entire `.env` file was being mounted.
**Fix:** Filter to only `CLAUDE_CODE_OAUTH_TOKEN`. API key injected separately.

---

## 11. Unique/Novel Approaches

1. **Directory-based IPC identity** -- container can't impersonate another group because mount determines identity
2. **Source-mounted recompilation** -- bypass build cache by recompiling on every container start
3. **Sentinel-based output protocol** -- robust against any stdout noise from SDK/dependencies
4. **Skills-as-codebase-transforms** -- community contributes transformation instructions, not features
5. **PreCompact conversation archival** -- searchable history survives SDK context compaction
6. **Clean Chromium for Cloudflare** -- separate browser process without Playwright's automation fingerprint
7. **socat CDP relay** -- workaround for Chromium ignoring `--remote-debugging-address` with pipes
8. **Bot message filtering via content prefix** -- checks `NOT LIKE 'Andy:%'` instead of `is_from_me`
9. **Graceful shutdown via detach** -- doesn't kill active containers, lets them finish via idle timeout
10. **Exponential backoff with cursor rollback** -- rolls back only if no output sent to user

---

## 12. Prevention Strategies

### For Container/IPC Issues
- Always use atomic file writes (temp + rename) for IPC
- Test with concurrent containers to catch race conditions
- Verify IPC authorization for every new MCP tool

### For WhatsApp Integration
- Test LID-to-JID translation on every Baileys upgrade
- Guard against reconnect-stacking with once-per-lifetime flags
- Always sanitize input before storing in SQLite

### For Security
- Never mount host secrets into containers -- filter env vars
- Keep mount allowlist external to project (can't be modified by containers)
- Test egress proxy with both HTTP and HTTPS (CONNECT method)
- Re-verify TOCTOU inodes before every mount

### For Browser Automation
- Use clean Chromium launch for Cloudflare-protected sites
- Always verify CDP port is reachable after container start
- Xvfb required for headed mode in containers (no physical display)

### For Build/Deploy
- Always reset build cache before container rebuild: `container builder stop && rm && start`
- Verify rebuild: `container run --entrypoint wc nanoclaw-agent:latest -l /app/src/index.ts`
- Run test suite before deploying: `npm test`
