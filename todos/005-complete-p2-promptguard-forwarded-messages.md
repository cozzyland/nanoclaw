---
status: complete
priority: p2
issue_id: "005"
tags: [code-review, security, prompt-injection]
dependencies: []
---

# PromptGuard Bypass Doesn't Consider Forwarded Messages

## Problem Statement

`src/channels/whatsapp.ts:486` skips PromptGuard for ALL `isFromMe` messages. Forwarded messages have `fromMe: true` but carry attacker-controlled content. A forwarded message with prompt injection would bypass scanning.

## Proposed Solutions

### Option A: Check isForwarded (Recommended)
```typescript
const isForwarded = msg.message?.extendedTextMessage?.contextInfo?.isForwarded;
if (content && (!isFromMe || isForwarded) && this.promptGuard?.isReady()) {
```
- **Effort**: Small (1 line)
- **Risk**: Low

## Technical Details

- **Affected files**: `src/channels/whatsapp.ts` (line 486)

## Acceptance Criteria

- [ ] Forwarded messages are scanned by PromptGuard even when `isFromMe` is true
- [ ] Direct own messages still skip PromptGuard
