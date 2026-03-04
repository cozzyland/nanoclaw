---
status: complete
priority: p3
issue_id: "011"
tags: [code-review, quality, typescript]
dependencies: []
---

# `buildMcpServers` Uses `Record<string, any>`

## Problem Statement

`container/agent-runner/src/index.ts:330` — The return type is `Record<string, any>`. The server config shape is well-known and identical across all three servers.

## Proposed Solutions

Define a proper interface:
```typescript
interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}
function buildMcpServers(...): Record<string, McpServerConfig> {
```
- **Effort**: Small

## Acceptance Criteria

- [ ] `McpServerConfig` interface defined
- [ ] No `any` types in buildMcpServers
