---
status: complete
priority: p3
issue_id: "008"
tags: [code-review, quality, imap]
dependencies: []
---

# `get_unread` Duplicates `search` With `unseen: true`

## Problem Statement

`container/agent-runner/src/imap-mcp-stdio.ts:281-311` — `get_unread` is 30 lines of copy-pasted formatting. Agent can call `search({ unseen: true })` for identical results.

## Proposed Solutions

Remove `get_unread` tool entirely. Update `search` description to mention `unseen: true` for unread filtering.
- **Effort**: Small (delete 30 lines)

## Acceptance Criteria

- [ ] `get_unread` tool removed
- [ ] `search` tool description mentions unread filtering
