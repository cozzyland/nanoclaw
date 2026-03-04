---
status: complete
priority: p3
issue_id: "009"
tags: [code-review, quality, imap]
dependencies: []
---

# `collectTextParts` Collects All text/* Types

## Problem Statement

`container/agent-runner/src/imap-mcp-stdio.ts:318` matches `text/*` which includes `text/csv`, `text/calendar`, `text/x-vcard`, etc. But `extractTextBody` only processes `text/plain` and `text/html`. Extra parts are wasted IMAP fetches.

## Proposed Solutions

Restrict to `text/plain` and `text/html`:
```typescript
if (structure.type === 'text/plain' || structure.type === 'text/html') {
```
- **Effort**: Trivial (1 line)

## Acceptance Criteria

- [ ] Only `text/plain` and `text/html` parts are fetched
