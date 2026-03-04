---
status: complete
priority: p3
issue_id: "012"
tags: [code-review, performance]
dependencies: []
---

# Document Save Uses writeFileSync (Blocks Event Loop)

## Problem Statement

`src/channels/whatsapp.ts:414` — `fs.writeFileSync(filePath, buffer)` blocks the event loop for the duration of a potentially large disk write (10-50ms for 10MB). During this time, no other WhatsApp messages can be processed.

## Proposed Solutions

Use async `fs.promises.writeFile`:
```typescript
await fs.promises.writeFile(filePath, buffer);
```
- **Effort**: Trivial (1 line)

## Acceptance Criteria

- [ ] `writeFileSync` replaced with `await fs.promises.writeFile`
- [ ] `mkdirSync` replaced with `await fs.promises.mkdir`
