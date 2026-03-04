---
status: complete
priority: p3
issue_id: "010"
tags: [code-review, quality, imap]
dependencies: []
---

# No Graceful IMAP Shutdown (SIGTERM Handler)

## Problem Statement

`container/agent-runner/src/imap-mcp-stdio.ts` — No SIGTERM handler. Ghost connections count against Gmail's 15-connection limit.

## Proposed Solutions

```typescript
process.on('SIGTERM', async () => {
  if (client) {
    try { await client.logout(); } catch { /* ignore */ }
  }
  process.exit(0);
});
```
- **Effort**: Small (5 lines)

## Acceptance Criteria

- [ ] SIGTERM triggers clean IMAP logout
