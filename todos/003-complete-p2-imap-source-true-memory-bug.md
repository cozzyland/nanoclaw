---
status: complete
priority: p2
issue_id: "003"
tags: [code-review, performance, security, imap]
dependencies: []
---

# `source: true` in get_message — Bug + Memory Risk

## Problem Statement

`get_message` in `container/agent-runner/src/imap-mcp-stdio.ts:221` passes `source: true` to `c.fetchOne()`, which downloads the **entire raw email** (including attachments) into heap. Two problems:

1. **Bug**: For multipart MIME emails, the naive `\r\n\r\n` split at line 239 returns raw MIME boundaries and base64 garbage as "body text". The correct `bodyStructure` fallback never executes because the broken source path returns non-empty garbage.

2. **Memory**: A 25MB email (Gmail's limit) → ~50MB allocation (Buffer + string copy) in a 2GB container sharing with Chromium (~1GB).

## Findings

- **Performance-oracle**: CRITICAL-2. 25MB+ heap allocation per email, peak 50MB with string conversion.
- **TypeScript-reviewer**: HIGH-8. Same finding, recommended removing source and using bodyStructure path.
- **Previous review** (`docs/code-review-2026-03-03.md`): Finding #2 (P1).

## Proposed Solutions

### Option A: Remove source: true, Use bodyStructure Only (Recommended)
Remove `source: true` from the fetchOne call. Make the `bodyStructure` + `bodyParts` path the primary (not fallback) extraction method.
- **Pros**: Fixes both the bug and memory issue. Only fetches text parts, not attachments.
- **Cons**: None — the bodyStructure path already exists as fallback
- **Effort**: Small (delete ~10 lines, adjust flow)
- **Risk**: Low

## Technical Details

- **Affected files**: `container/agent-runner/src/imap-mcp-stdio.ts` (lines 217-246)
- **Memory impact**: Up to 50MB per get_message call eliminated

## Acceptance Criteria

- [ ] `source: true` removed from fetchOne
- [ ] Raw source parsing block (lines 238-246) deleted
- [ ] bodyStructure path is primary, not fallback
- [ ] Multipart emails return clean text body

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-03 | Flagged in both code reviews | Consistent P1/P2 across reviews |
