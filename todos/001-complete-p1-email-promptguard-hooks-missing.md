---
status: complete
priority: p1
issue_id: "001"
tags: [code-review, security, prompt-injection]
dependencies: []
---

# Email MCP Tools Missing PromptGuard PostToolUse Hooks

## Problem Statement

`mcp__gmail__*` and `mcp__icloud__*` tools are added to `allowedTools` in `container/agent-runner/src/index.ts` but have **no PostToolUse hooks** registered. Email is the #1 vector for indirect prompt injection — anyone who sends an email can inject instructions that reach the agent unscreened.

The previously existing Notion hook was also removed in this changeset. While Notion content now flows through curl → Bash hook (which does scan network commands), email content flows through MCP tool responses that bypass the Bash hook entirely.

## Findings

- **Security-sentinel**: CRITICAL-1. Email bodies (up to 8000 chars) returned directly to LLM context with zero prompt injection scanning.
- **Architecture-strategist**: Confirmed gap. MCP tool responses do NOT flow through Bash hook.
- **Agent-native-reviewer**: Confirmed. Email tools registered but no PostToolUse hooks.
- **TypeScript-reviewer**: Not flagged (type safety focus).
- **Learnings-researcher**: Past solution docs confirm PostToolUse hooks are the standard enforcement mechanism.

## Proposed Solutions

### Option A: Add PostToolUse Hooks (Recommended)
Add two lines to the PostToolUse hooks array in `container/agent-runner/src/index.ts`:
```typescript
{ matcher: 'mcp__gmail__*', hooks: [createExternalContentHook('Gmail')] },
{ matcher: 'mcp__icloud__*', hooks: [createExternalContentHook('iCloud')] },
```
- **Pros**: 2-line fix, uses existing infrastructure, consistent with WebFetch/WebSearch pattern
- **Cons**: None
- **Effort**: Small (5 minutes)
- **Risk**: None

### Option B: Add Hooks + Restore Notion Hook
Same as A, plus re-add the removed Notion hook as defense-in-depth:
```typescript
{ matcher: 'mcp__notion__*', hooks: [createExternalContentHook('Notion')] },
```
- **Pros**: Belt-and-suspenders for Notion (Bash hook already covers curl, but this catches edge cases like shell aliases)
- **Cons**: Slightly redundant since Bash hook catches curl
- **Effort**: Small
- **Risk**: None

## Recommended Action

Option A (minimum). Option B if being thorough.

## Technical Details

- **Affected files**: `container/agent-runner/src/index.ts` (lines 471-477)
- **Components**: PostToolUse hooks system, external-content-hooks.ts
- **Agent runs with**: `permissionMode: 'bypassPermissions'` — can execute any tool

## Acceptance Criteria

- [ ] `mcp__gmail__*` PostToolUse hook fires on email tool calls
- [ ] `mcp__icloud__*` PostToolUse hook fires on email tool calls
- [ ] PromptGuard scans email content before agent processes it
- [ ] Regex pre-screen catches obvious injection patterns in emails

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-03 | Initial finding from code review | All 5 security-aware agents flagged this |

## Resources

- Previous code review: `docs/code-review-2026-03-03.md` (Finding #1)
- External content hooks: `container/agent-runner/src/external-content-hooks.ts`
