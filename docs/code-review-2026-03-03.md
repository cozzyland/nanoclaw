# Code Review: IMAP Email Integration + Notion MCP Removal

**Date:** 2026-03-03
**Branch:** main (uncommitted changes)
**Scope:** 11 modified files + 2 new files

## Changes Reviewed

- IMAP email integration (Gmail, iCloud) via new MCP server
- Notion MCP server removal (switched to direct REST API via curl)
- PromptGuard bypass for own messages
- Build resilience (better-sqlite3 postinstall, .npmrc)
- Agent instructions refactoring (CLAUDE.md → context modules)
- Grocery automation common list workflow

## Findings

### P1 — Critical (Blocks Merge)

#### 1. IMAP email content not scanned by PromptGuard

- **File:** `container/agent-runner/src/index.ts`
- **Issue:** `mcp__gmail__*` and `mcp__icloud__*` tools have no PostToolUse hook. Email is the #1 vector for indirect prompt injection — anyone who sends an email can inject instructions.
- **Fix (2 lines):** Add to the PostToolUse hooks array:
  ```typescript
  { matcher: 'mcp__gmail__*', hooks: [createExternalContentHook('Gmail')] },
  { matcher: 'mcp__icloud__*', hooks: [createExternalContentHook('iCloud')] },
  ```

#### 2. `source: true` in `get_message` — bug + memory risk

- **File:** `container/agent-runner/src/imap-mcp-stdio.ts:217-246`
- **Bug:** For multipart MIME emails, naive `\r\n\r\n` split returns raw MIME boundaries and base64 garbage as "body text". The correct `bodyStructure` fallback never executes because the broken source path returns non-empty garbage.
- **Memory:** `source: true` fetches entire raw email (including attachments) into heap. A 20MB PDF → ~40MB allocation in a 2GB container sharing with Chromium (~1GB).
- **Fix:** Remove `source: true` from fetchOne, delete raw source parsing block (lines 238-246), rely solely on `bodyStructure` + `bodyParts`.

---

### P2 — Important (Should Fix)

#### 3. Double-fetch pattern for body parts

- **File:** `imap-mcp-stdio.ts:254-262`
- **Issue:** Separate IMAP FETCH per text part in a loop. Each round-trip to Gmail adds 50-200ms.
- **Fix:** Batch all text part IDs into single `bodyParts: textParts` fetch.

#### 4. Unbounded IMAP search iteration

- **File:** `imap-mcp-stdio.ts:186-192`
- **Issue:** `for await` with `break` at limit still causes ImapFlow to buffer all server results. A 50K-message Gmail inbox with `query.all = true` buffers all 50K envelopes.
- **Fix:** Use `c.search()` first to get UIDs, then FETCH only the needed slice.

#### 5. Non-null assertions on env vars fail silently

- **File:** `imap-mcp-stdio.ts:12-15`
- **Issue:** `process.env.IMAP_HOST!` produces `undefined` if vars missing. Fails with obscure IMAP error.
- **Fix:** Add `requireEnv()` helper that throws with the missing variable name.

#### 6. No graceful IMAP shutdown

- **File:** `imap-mcp-stdio.ts`
- **Issue:** No SIGTERM handler. Ghost connections count against Gmail's 15-connection limit.
- **Fix:** Add `process.on('SIGTERM', ...)` handler calling `client.logout()`.

#### 7. PromptGuard bypass doesn't consider forwarded messages

- **File:** `src/channels/whatsapp.ts:454`
- **Issue:** `!isFromMe` skips scanning for ALL own messages. Forwarded messages have `fromMe: true` but carry attacker-controlled content.
- **Fix:** Check `contextInfo.isForwarded` to re-enable scanning for forwarded content.

---

### P3 — Nice-to-Have

#### 8. `get_unread` duplicates `search` with `unseen: true`

- **File:** `imap-mcp-stdio.ts:281-311`
- 30 lines of copy-pasted formatting. Agent can call `search({ unseen: true })`.

#### 9. `collectTextParts` collects all text/* types

- **File:** `imap-mcp-stdio.ts:316-327`
- Includes text/csv, text/calendar, etc. Filter to `text/plain` and `text/html` only.

#### 10. `stripHtml` should truncate before regex chain

- **File:** `imap-mcp-stdio.ts:104-122`
- 12 regex passes on potentially large HTML. Add early truncation before the chain.

#### 11. `buildMcpServers` uses `Record<string, any>`

- **File:** `index.ts:330`
- Should use a proper `McpServerConfig` interface.

#### 12. Connection reset on all errors

- **File:** `imap-mcp-stdio.ts:38-47`
- `withClient` resets connection on any error type. Should only reset on connection-level failures.

---

## Positive Findings

- **CLAUDE.md refactoring** — strongest change. ~700 lines reduced to context modules loaded on-demand. Significant token savings.
- **`buildMcpServers()` extraction** — clean, well-motivated refactoring.
- **WhatsApp PromptGuard fix** — surgical and correct.
- **Build resilience** (postinstall + .npmrc) — addresses documented pain point.
- **IMAP MCP is read-only** — no send, delete, or move operations. Good security.
- **Credential pipeline** — consistent 3-layer allowlist pattern.
- **Notion to curl** — reasonable trade-off; Bash content hook still covers curl requests.

## Review Agents Used

- kieran-typescript-reviewer
- security-sentinel
- performance-oracle
- architecture-strategist
- code-simplicity-reviewer
