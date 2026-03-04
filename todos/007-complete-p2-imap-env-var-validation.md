---
status: complete
priority: p2
issue_id: "007"
tags: [code-review, quality, imap]
dependencies: []
---

# Non-null Assertions on IMAP Env Vars Fail Silently

## Problem Statement

`container/agent-runner/src/imap-mcp-stdio.ts:12-15` uses `process.env.IMAP_HOST!` (non-null assertion) which produces `undefined` if vars are missing. Fails with obscure IMAP connection error instead of clear startup failure.

## Proposed Solutions

### Option A: requireEnv() Helper (Recommended)
```typescript
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[imap-mcp] Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}
const IMAP_HOST = requireEnv('IMAP_HOST');
```
- **Effort**: Small
- **Risk**: None

## Acceptance Criteria

- [ ] Missing env vars cause clear error message and process exit
- [ ] No non-null assertions on env vars
