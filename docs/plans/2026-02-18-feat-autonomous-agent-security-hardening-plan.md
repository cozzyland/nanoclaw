---
title: "feat: Autonomous Agent Security Hardening"
type: feat
date: 2026-02-18
---

# Autonomous Agent Security Hardening

## Overview

NanoClaw has strong input-side defenses (prompt injection detection, malware scanning, rate limiting, sender verification, container isolation, egress proxy). But for Raiden to operate autonomously — heartbeats, initiative, email access, purchases — the system needs defenses on the **output side** and against **persistent compromise**.

This plan adds 6 security layers that cap the blast radius of a successful attack regardless of how it gets through:

1. **Output Monitoring** — scan what the agent sends
2. **Action Approval Gates** — human confirmation for high-risk actions
3. **Memory Integrity** — prevent persistent injection via memory files
4. **VirusTotal Integration** — background hash scanning (second opinion after ClamAV)
5. **Canary Tokens** — tripwires that detect exfiltration attempts
6. **LLM-as-Judge** — context-aware command safety assessment

## Problem Statement

Current security model protects against **inbound threats** (malicious messages, files, injections) but does not monitor or gate **outbound actions**. A single successful injection — from a web page, email, document, or crafted WhatsApp message — could cause Raiden to:

- Send messages to contacts (phishing, social engineering)
- Exfiltrate data (API keys, files, conversation history)
- Make unauthorized purchases
- Modify its own memory (CLAUDE.md) to persist the compromise
- All of the above amplified by scheduled heartbeats running unsupervised

Real-world precedent: $3.2M procurement fraud via compromised agent system (Q2-Q3 2025), AI-orchestrated espionage affecting 30+ targets (Sept 2025), 35% of AI security incidents in 2025 caused by simple prompts.

References: [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)

## Current Security Posture

| Layer | Module | Status |
|-------|--------|--------|
| ML injection detection | `src/security/prompt-guard.ts` | Done (ProtectAI DeBERTa-v3) |
| Regex sanitization | `src/channels/whatsapp.ts:sanitizeMessageContent()` | Done |
| File content sanitization | `src/security/file-sanitizer.ts` | Done |
| Command risk assessment | `src/security/command-checker.ts` | Done (LLM-as-judge stubbed) |
| Rate limiting | `src/security/rate-limiter.ts` | Done |
| Sender verification | `src/security/sender-verification.ts` | Done |
| Media validation | `src/security/media-validator.ts` | Done |
| Malware scanning | `src/security/malware-scanner.ts` | Done (ClamAV) |
| Container isolation | Apple Container (VM-level) | Done |
| Container hardening | `src/security/container-hardening.ts` | Done (conservative) |
| Credential proxy | `src/credential-proxy.ts` | Done |
| Egress proxy + DLP | `src/security/egress-proxy.ts` | Done |
| Security event logging | `src/security/security-events.ts` | Infra done, not fully wired |
| **Output monitoring** | — | **Missing** |
| **Action approval gates** | — | **Missing** |
| **Memory integrity** | — | **Missing** |
| **VirusTotal scanning** | — | **Missing** |
| **Canary tokens** | — | **Missing** |
| **LLM-as-judge** | Stubbed in `command-checker.ts:151` | **Not implemented** |

## Technical Approach

### Architecture

```
Agent Output (IPC)
  │
  ├─ send_message ──→ Output Monitor ──→ Risk Classifier ──┐
  │                    (PII, creds,      (low/med/high/     │
  │                     anomalies)        critical)          │
  │                                                         │
  │                                         ┌───────────────┘
  │                                         │
  │                              ┌──────────┴──────────┐
  │                              │                     │
  │                         LOW/MEDIUM            HIGH/CRITICAL
  │                         Allow + log           Approval gate
  │                                               (WhatsApp confirm)
  │                                                    │
  │                                              ┌─────┴─────┐
  │                                              │           │
  │                                           APPROVED    DENIED/TIMEOUT
  │                                           Execute     Block + log
  │
  ├─ File writes ──→ Memory Integrity Check
  │                  (hash CLAUDE.md before/after session)
  │
  └─ Media files ──→ ClamAV (sync) ──→ VirusTotal hash (async background)
```

### Implementation Phases

---

#### Phase 1: Output Monitoring (Critical)

Scan every outbound message the agent sends via IPC before delivery.

**File:** `src/security/output-monitor.ts` (NEW)

```typescript
export class OutputMonitor {
  // Scans outbound messages for dangerous content
  async scanOutbound(text: string, context: OutboundContext): Promise<ScanResult>
}

export interface OutboundContext {
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  recipientJid?: string;  // For send_message to different JIDs
}

export interface ScanResult {
  allowed: boolean;
  flags: OutboundFlag[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

export type OutboundFlag =
  | 'pii_detected'        // Names, phone numbers, addresses
  | 'credential_leaked'   // API keys, tokens, passwords
  | 'anomalous_volume'    // Too many messages in short window
  | 'new_recipient'       // Message to JID agent hasn't contacted before
  | 'financial_content'   // Payment details, purchase confirmations
  | 'instruction_like'    // Content that looks like system prompts
  | 'url_suspicious';     // Links to unknown/suspicious domains
```

**Detection patterns:**

1. **Credential leakage** — reuse `SECRET_PATTERNS` from `egress-proxy.ts:101-135` (Anthropic keys, AWS keys, private keys, JWTs, env var references). These patterns are already battle-tested.
2. **PII detection** — phone numbers (`\+?\d{10,15}`), email addresses, credit card patterns. Light regex, not a full PII classifier.
3. **Anomalous volume** — sliding window: flag if agent sends >10 messages in 60 seconds (normal is 1-3).
4. **New recipient check** — maintain a set of known JIDs per group. Flag first-time contacts.
5. **Financial content** — keywords: "purchase", "payment", "order", "charge", "$", currency patterns.
6. **Instruction-like content** — detect if agent is outputting system-prompt-like text (could indicate injection echoing back instructions).

**Integration point:** `src/ipc.ts` — the `processMessage()` function (line ~76) where IPC `send_message` commands are handled. Scan `content` before calling `sendMessage()`.

```typescript
// In ipc.ts processMessage(), before sendMessage():
if (outputMonitor) {
  const scan = await outputMonitor.scanOutbound(content, {
    groupFolder, chatJid, isMain
  });
  if (!scan.allowed) {
    logger.warn({ flags: scan.flags, riskLevel: scan.riskLevel },
      'OUTBOUND MESSAGE BLOCKED');
    securityEvents.log({ type: 'outbound_blocked', ... });
    return; // Don't deliver
  }
  if (scan.riskLevel === 'high' || scan.riskLevel === 'critical') {
    // Route to approval gate (Phase 2)
  }
}
```

**Graceful degradation:** If output monitor throws, log error and allow message through. Output monitoring is defense-in-depth, not a hard gate.

**Files modified:**
- `src/security/output-monitor.ts` — NEW
- `src/ipc.ts` — add scanning before `sendMessage()`
- `src/index.ts` — initialize OutputMonitor, pass to IPC watcher

---

#### Phase 2: Action Approval Gates (Critical)

High-risk actions require explicit human approval via WhatsApp before execution.

**File:** `src/security/approval-gate.ts` (NEW)

```typescript
export class ApprovalGate {
  // Request approval for a high-risk action
  async requestApproval(action: PendingAction): Promise<ApprovalResult>
  // Process incoming approval/denial from user
  handleResponse(messageContent: string, senderJid: string): void
  // Check for timed-out requests
  checkTimeouts(): void
}

export interface PendingAction {
  id: string;               // UUID
  type: ActionType;
  description: string;       // Human-readable: "Purchase $45.99 of groceries from Dunnes"
  groupFolder: string;
  chatJid: string;
  requestedAt: number;
  timeoutMs: number;         // Default: 15 minutes
  context: Record<string, unknown>; // Action-specific data
}

export type ActionType =
  | 'purchase'           // Any financial transaction
  | 'send_email'         // Email to external address
  | 'new_contact'        // Message to previously unknown JID
  | 'delete_files'       // Bulk file deletion
  | 'modify_config'      // Changes to system configuration
  | 'credential_access'; // Accessing stored credentials

export interface ApprovalResult {
  approved: boolean;
  respondedBy?: string;  // JID of approver
  respondedAt?: number;
  timedOut: boolean;
}
```

**Risk classification:**

| Risk Level | Actions | Gate |
|------------|---------|------|
| LOW | Read files, search web, answer questions, git status | None — fully autonomous |
| MEDIUM | Write/edit workspace files, send WhatsApp to known contacts, run safe commands | Log only |
| HIGH | Send to new contacts, purchases under $50, delete files | WhatsApp approval (15 min timeout) |
| CRITICAL | Purchases over $50, send emails, modify system config, access credentials | WhatsApp approval (5 min timeout) |

**Approval UX:**

```
Raiden: [APPROVAL REQUIRED]
I need to place a grocery order for $47.50 from Dunnes Stores.

Items: Milk, bread, eggs, chicken (see full list in chat)

Reply YES to approve or NO to deny.
Auto-denied in 15 minutes.
```

**Implementation details:**

1. Pending actions stored in SQLite (`approval_requests` table) — survives process restarts
2. Approval messages matched by: recent pending request for that chatJid + message starts with "yes"/"no"/"approve"/"deny"
3. Default-deny on timeout — the safe default
4. Audit trail: every request, response, and timeout logged to security events
5. Owner JID whitelist — only the account owner can approve (not random group members)

**Integration point:** Called from `src/ipc.ts` when processing IPC commands. Before executing any IPC action, classify its risk level. If high/critical, route through approval gate instead of executing immediately.

**Edge cases:**
- Agent sends approval request, user responds, but container already timed out → store approval, agent picks it up on next invocation
- Multiple pending approvals → each has unique ID, user response matched to most recent pending action for that chat
- User responds after timeout → log late response, don't execute (timeout = denial)

**Files modified:**
- `src/security/approval-gate.ts` — NEW
- `src/db.ts` — add `approval_requests` table
- `src/ipc.ts` — risk classification + approval routing
- `src/channels/whatsapp.ts` — intercept approval responses in message handler
- `src/index.ts` — initialize ApprovalGate, pass to IPC

---

#### Phase 3: Memory Integrity (Critical)

Prevent prompt injection from persisting in agent memory files.

**File:** `src/security/memory-integrity.ts` (NEW)

```typescript
export class MemoryIntegrity {
  // Snapshot memory state before agent session
  async snapshotBefore(groupFolder: string): Promise<MemorySnapshot>
  // Verify and audit changes after agent session
  async verifyAfter(groupFolder: string, before: MemorySnapshot): Promise<IntegrityResult>
}

export interface MemorySnapshot {
  groupFolder: string;
  timestamp: number;
  files: Map<string, FileSnapshot>; // path -> hash + content
}

export interface FileSnapshot {
  hash: string;        // SHA-256
  size: number;
  content: string;     // For diffing
}

export interface IntegrityResult {
  clean: boolean;
  modifiedFiles: ModifiedFile[];
  suspiciousChanges: SuspiciousChange[];
}

export interface SuspiciousChange {
  file: string;
  reason: string;      // e.g. "Added instruction-like content"
  addedContent: string; // The suspicious addition
  severity: 'low' | 'medium' | 'high' | 'critical';
}
```

**How it works:**

1. **Before** each container invocation: snapshot all memory files in the group folder (CLAUDE.md, any .md files in the group directory). Store SHA-256 hashes in SQLite.

2. **After** each container session completes: diff memory files against snapshot.

3. **Classify changes:**
   - Normal additions (notes, conversation summaries) → allow, update stored hash
   - Instruction-like additions → flag as suspicious
   - Detection patterns for suspicious content:
     - Imperative instructions: "always do X", "never do Y", "ignore previous"
     - Role manipulation: "you are now", "your new purpose", "act as"
     - Hidden instructions: HTML comments, zero-width characters, base64 encoded blocks
     - Override attempts: "SYSTEM:", "ADMIN:", "[PRIORITY]"

4. **Response to suspicious changes:**
   - HIGH severity: revert file to pre-session snapshot, alert owner via WhatsApp
   - MEDIUM severity: keep changes but alert owner with diff
   - LOW severity: log only

5. **Backup system:** Keep last 5 snapshots per group in `data/memory-backups/{groupFolder}/`. Allows manual rollback if automated detection misses something.

**Integration point:** `src/index.ts` — wrap `processGroupMessages()` with before/after snapshot calls.

```typescript
// In processGroupMessages():
const memSnapshot = await memoryIntegrity.snapshotBefore(group.folder);
// ... run agent ...
const integrityResult = await memoryIntegrity.verifyAfter(group.folder, memSnapshot);
if (!integrityResult.clean) {
  for (const change of integrityResult.suspiciousChanges) {
    if (change.severity === 'high' || change.severity === 'critical') {
      await whatsapp.sendMessage(chatJid,
        `[SECURITY] Suspicious memory modification detected and reverted in ${group.name}. ` +
        `Reason: ${change.reason}`);
    }
  }
}
```

**Files modified:**
- `src/security/memory-integrity.ts` — NEW
- `src/index.ts` — wrap agent invocations with snapshot/verify
- `src/db.ts` — add `memory_hashes` table

---

#### Phase 4: VirusTotal Integration (High)

Background hash-based malware scanning as second opinion after ClamAV.

**File:** `src/security/virustotal.ts` (NEW)

```typescript
export class VirusTotalScanner {
  private apiKey: string;

  async scanHash(sha256: string, label?: string): Promise<VTResult>
  isConfigured(): boolean
}

export interface VTResult {
  status: 'clean' | 'malicious' | 'not_found' | 'rate_limited' | 'error';
  malicious?: number;    // Number of engines flagging as malicious
  totalEngines?: number;
  detectionNames?: string[];
}
```

**Integration pattern — async background scan:**

```typescript
// In whatsapp.ts, after ClamAV scan passes and message is delivered:
if (buffer && vtScanner?.isConfigured()) {
  // Fire and forget — don't block message delivery
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  vtScanner.scanHash(hash, fileName).then((result) => {
    if (result.status === 'malicious') {
      logger.error({ hash, fileName, detections: result.malicious },
        'VIRUSTOTAL: File flagged as malicious (post-delivery)');
      // Alert the group
      whatsapp.sendMessage(chatJid,
        `[SECURITY] A file sent earlier was flagged as malicious by ` +
        `${result.malicious}/${result.totalEngines} antivirus engines. ` +
        `File: ${fileName}`);
    }
  }).catch((err) => {
    logger.debug({ err }, 'VirusTotal background scan failed');
  });
}
```

**Rate limiting:** Built-in client-side rate limiter — max 4 requests/minute, queue excess. Free tier allows 500/day which is plenty for WhatsApp media volume.

**Privacy:** Hash-only lookups. NEVER upload user files to VirusTotal's public API. The hash reveals nothing about file contents — VT only checks if this hash has been seen before in their database.

**API key storage:** Store in macOS Keychain (same pattern as GitHub PAT):
```bash
security add-generic-password -a "cozzymini" -s "virustotal-api-key" -w "YOUR_KEY" -U
```

**Files modified:**
- `src/security/virustotal.ts` — NEW
- `src/channels/whatsapp.ts` — add async VT scan after ClamAV
- `src/index.ts` — initialize VTScanner, pass to WhatsApp channel
- `package.json` — no new deps (uses native `fetch`)

---

#### Phase 5: Canary Tokens (High)

Deploy digital tripwires in mounted directories. Zero runtime overhead — they only trigger on access.

**File:** `src/security/canary-tokens.ts` (NEW)

```typescript
export class CanaryDeployer {
  // Deploy canary files to a group's workspace
  async deploy(groupFolder: string): Promise<DeployedCanary[]>
  // Verify canaries are still in place (not deleted by agent)
  async verify(groupFolder: string): Promise<CanaryStatus>
}

export interface DeployedCanary {
  type: 'credential_file' | 'dns_token' | 'url_token';
  path: string;          // Where the canary is placed
  tokenId: string;       // For tracking in Thinkst/self-hosted
  description: string;
}
```

**Canary types to deploy:**

1. **Fake credential files** — place in each group's workspace:
   - `.env.backup` containing `ANTHROPIC_API_KEY=sk-ant-CANARY-{unique_id}...`
   - `.aws/credentials` with fake AWS keys
   - The "API key" is actually a [Thinkst Canarytoken](https://canarytokens.org/) — if anyone uses it, you get an alert

2. **DNS canary tokens** — unique hostnames embedded in fake config files:
   - `config.staging.json` containing `"api_url": "https://{token}.canarytokens.com/..."`
   - If the agent resolves this hostname (e.g., tries to exfiltrate data), the DNS lookup triggers an alert

3. **Canary URLs** — placed in CLAUDE.md as "do not access" markers:
   - `<!-- INTERNAL: staging API at https://{token}.canarytokens.com/api - DO NOT ACCESS -->`
   - A compromised agent might be tricked into accessing this URL

**Deployment:** Run once per group setup (in `registerGroup()`). Verify periodically (daily scheduled task).

**Detection flow:**
```
Agent gets injected → tries to exfiltrate fake credentials
    → uses sk-ant-CANARY-xxx as API key
    → Thinkst Canarytoken triggers
    → Email/webhook alert to owner
    → NanoClaw logs security event
```

**Files modified:**
- `src/security/canary-tokens.ts` — NEW
- `src/index.ts` — deploy canaries on group registration
- `groups/{folder}/` — canary files written to each group workspace

---

#### Phase 6: LLM-as-Judge (Medium)

Complete the stubbed LLM-as-judge in `command-checker.ts` for context-aware command safety assessment.

**File:** `src/security/command-checker.ts` (MODIFY — complete the stub at line 151)

```typescript
async function llmJudgeCommand(
  command: string,
  context: CommandContext
): Promise<CommandRisk> {
  // Use Claude Haiku for fast, cheap classification
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 100,
    system: `You are a security classifier. Assess if this command is safe to execute in a sandboxed container.
The container runs as a personal assistant (not a development environment).
Respond with exactly one word: SAFE, WARN, or BLOCK.
Then a brief reason on the next line.

BLOCK if: destructive to user data, credential exfiltration, container escape attempt, network abuse
WARN if: unusual but not necessarily dangerous, accessing sensitive paths
SAFE if: normal assistant operations (file read/write, web browsing, package install)`,
    messages: [{
      role: 'user',
      content: `Command: ${command}\nGroup: ${context.groupFolder}\nTrust level: ${context.isMain ? 'high' : 'low'}`
    }]
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const [verdict, ...reasonParts] = text.trim().split('\n');
  // ... map to CommandRisk
}
```

**Key design decisions:**
- Use Haiku (fast, cheap — ~$0.001 per classification)
- 200ms timeout — if slow, fall back to regex patterns
- Cache results for identical commands (LRU cache, 1000 entries, 5 min TTL)
- Only invoke for commands that regex classified as `medium` or `unknown` — don't waste API calls on clearly safe or clearly dangerous commands

**Integration:** Already integrated via `command-checker.ts`. The `llmJudgeCommand()` function is called but currently falls back to pattern matching (line 155). Complete the implementation and remove the fallback.

**API key:** Uses the same `ANTHROPIC_API_KEY` already available on the host. This runs on the host side (not in container), so no credential isolation concern.

**Files modified:**
- `src/security/command-checker.ts` — complete LLM-as-judge implementation
- `package.json` — add `@anthropic-ai/sdk` if not already present

---

## Existing Gaps to Fix (Discovered During Research)

These are issues found in the current codebase that should be fixed alongside the new layers:

### 1. Security Event Helpers Not Wired

`src/security/security-events.ts` defines helper functions (`logPromptInjectionAttempt`, `logEgressBlocked`, `logDLPViolation`, `logHighRiskCommand`) but they are not called from the actual security checkpoints in `whatsapp.ts` or `egress-proxy.ts`.

**Fix:** Wire the helpers into all security checkpoints. This is a prerequisite for anomaly detection to work.

### 2. Media Validation Passes Empty Buffer

`whatsapp.ts` line 316-318 passes `Buffer.from('')` to the media validator for size validation. Actual file size is not verified until the ClamAV scan downloads the file.

**Fix:** Move the download step before media validation, or validate size from the WhatsApp message metadata (`fileLength` field) instead of the buffer.

### 3. CLAUDE.md Writable by Agent

The group's CLAUDE.md is mounted read-write (`/workspace/group/`). The agent can modify it directly, which is the memory poisoning vector.

**Fix (Phase 3):** Memory integrity verification after each session. Optionally, make the group mount read-only and require memory updates to go through IPC (host writes the file, not the agent). This is a bigger architectural change — start with integrity verification.

### 4. Browser Bypasses Egress Proxy

Chromium runs with `--no-proxy-server`, meaning browser traffic has unrestricted internet access. This is necessary for Cloudflare compatibility but means the domain allowlist doesn't apply to browser navigation.

**Mitigation:** Browser actions are logged via CDP. Add a PostToolUse hook on `agent-browser` commands that logs the target URL and checks it against a browser-specific allowlist. This is informational/alerting, not blocking (blocking would break Cloudflare).

## Acceptance Criteria

### Functional Requirements

- [ ] Outbound messages scanned for credentials, PII, and anomalous patterns before delivery
- [ ] High-risk actions (purchases, emails, new contacts) require WhatsApp approval
- [ ] Approval requests auto-deny after configurable timeout (default 15 min)
- [ ] CLAUDE.md integrity verified after every agent session
- [ ] Suspicious memory modifications automatically reverted with owner notification
- [ ] VirusTotal hash lookups run in background without blocking message delivery
- [ ] Canary token files deployed in each group workspace
- [ ] LLM-as-judge classifies ambiguous commands with 200ms budget

### Non-Functional Requirements

- [ ] Zero added latency to normal message flow (output monitoring <10ms, VT is async)
- [ ] All new security layers fail open — service outage doesn't block messages
- [ ] All security events logged to centralized `security-events.ts`
- [ ] Approval gate state persists across process restarts (SQLite)

### Quality Gates

- [ ] Each phase includes integration test with the real WhatsApp flow
- [ ] Memory integrity tested with simulated injection (agent writes "ignore instructions" to CLAUDE.md)
- [ ] Approval gate tested end-to-end (send approval request, respond, verify execution/denial)
- [ ] VirusTotal tested with EICAR hash
- [ ] All fail-open paths verified (stop ClamAV, Prompt Guard, VT — messages still flow)

## Success Metrics

- Zero credential leaks via outbound messages (output monitor catches 100%)
- Zero unauthorized purchases (approval gate blocks 100%)
- Memory poisoning attempts detected and reverted within one session
- <10ms added latency to message delivery for output monitoring
- Canary token alerts fire within 60 seconds of access

## Dependencies & Prerequisites

- ClamAV running on host (port 3310) — **DONE**
- Prompt Guard service running (port 3003) — **DONE**
- VirusTotal API key (free tier) — needs signup at virustotal.com
- Thinkst Canarytokens account (free) — needs setup at canarytokens.org
- `@anthropic-ai/sdk` npm package for LLM-as-judge — likely already in deps

## Risk Analysis & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Output monitor false positives block legitimate messages | Agent appears broken to user | Fail open on errors, conservative thresholds, log-only mode initially |
| Approval gate UX friction | User gets annoyed, disables it | Only gate genuinely high-risk actions, keep LOW/MEDIUM autonomous |
| Memory integrity check too aggressive | Reverts legitimate agent memory updates | Pattern-based detection, not blanket "any change = suspicious" |
| VirusTotal rate limit hit | Background scans queue up | Client-side rate limiter, hash dedup cache |
| LLM-as-judge API latency | Command execution delayed | 200ms timeout, regex fallback, result caching |
| Canary tokens detected by agent | Agent avoids canaries | Deploy with realistic names/content, don't mention in CLAUDE.md |

## Files Summary

| File | Change | Phase |
|------|--------|-------|
| `src/security/output-monitor.ts` | NEW — outbound message scanning | 1 |
| `src/security/approval-gate.ts` | NEW — human approval workflow | 2 |
| `src/security/memory-integrity.ts` | NEW — CLAUDE.md hash verification | 3 |
| `src/security/virustotal.ts` | NEW — VT API hash lookups | 4 |
| `src/security/canary-tokens.ts` | NEW — tripwire deployment | 5 |
| `src/security/command-checker.ts` | MODIFY — complete LLM-as-judge | 6 |
| `src/ipc.ts` | MODIFY — output scanning + approval routing | 1, 2 |
| `src/channels/whatsapp.ts` | MODIFY — VT async scan, approval responses | 2, 4 |
| `src/index.ts` | MODIFY — initialize all new services | 1-6 |
| `src/db.ts` | MODIFY — approval_requests + memory_hashes tables | 2, 3 |
| `src/security/security-events.ts` | MODIFY — wire helpers into checkpoints | Fix |

## Service Ports Summary

| Port | Service | Purpose |
|------|---------|---------|
| 3001 | Credential Proxy | Injects Anthropic API key |
| 3002 | Egress Proxy | Filters outbound container traffic |
| 3003 | Prompt Guard | ML prompt injection classification |
| 3310 | ClamAV (clamd) | Malware file scanning |

## References & Research

### Internal References

- Current security architecture: `src/security/` (10 modules)
- Container isolation model: `src/container-runner.ts`
- IPC system: `src/ipc.ts`, `container/agent-runner/src/ipc-mcp-stdio.ts`
- Security event logging: `src/security/security-events.ts`
- Existing command checker stub: `src/security/command-checker.ts:151`
- DLP patterns: `src/security/egress-proxy.ts:101-135`
- Container docs: `docs/SECURITY.md`, `docs/DCG_SECURITY.md`

### External References

- [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)
- [Anthropic Prompt Injection Defenses](https://www.anthropic.com/research/prompt-injection-defenses)
- [Design Patterns for Securing LLM Agents (arXiv 2025)](https://arxiv.org/abs/2506.08837)
- [VirusTotal API v3 Documentation](https://docs.virustotal.com/reference/overview)
- [Thinkst Canarytokens](https://canarytokens.org/)
- [Guardrails AI Framework](https://www.guardrailsai.com/)
- [A-MemGuard: Memory Poisoning Defense](https://unit42.paloaltonetworks.com/indirect-prompt-injection-poisons-ai-longterm-memory/)
- [HITL Approval Framework](https://agentic-patterns.com/patterns/human-in-loop-approval-framework/)
- [Agent Sandbox Comparison (E2B, Modal, Fly.io)](https://getathenic.com/blog/e2b-vs-modal-vs-flyio-sandbox-comparison)
- [Adversa AI 2025 Security Incidents Report](https://adversa.ai/blog/adversa-ai-unveils-explosive-2025-ai-security-incidents-report-revealing-how-generative-and-agentic-ai-are-already-under-attack/)
