---
status: complete
priority: p2
issue_id: "004"
tags: [code-review, performance, imap]
dependencies: ["003"]
---

# Double-Fetch Pattern for IMAP Body Parts (N+1 Queries)

## Problem Statement

In `container/agent-runner/src/imap-mcp-stdio.ts:254-262`, each text part is fetched with a separate `c.fetchOne()` call inside a loop. A typical multipart email issues 2-3 additional IMAP FETCH commands (100-300ms each to Gmail).

## Proposed Solutions

### Option A: Batch All Part IDs Into Single Fetch (Recommended)
```typescript
const partMsg = await c.fetchOne(String(args.uid), {
  uid: true,
  bodyParts: textParts, // all part IDs in one request
}, { uid: true });
```
- **Effort**: Small
- **Risk**: Low

## Technical Details

- **Affected files**: `container/agent-runner/src/imap-mcp-stdio.ts` (lines 254-262)
- **Latency impact**: Eliminates 100-300ms per additional text part

## Acceptance Criteria

- [ ] Single IMAP FETCH for all text parts
- [ ] `extractTextBody` still receives correct parts map
