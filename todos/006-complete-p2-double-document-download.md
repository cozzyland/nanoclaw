---
status: complete
priority: p2
issue_id: "006"
tags: [code-review, performance]
dependencies: []
---

# Double Document Download (ClamAV Scan + Save)

## Problem Statement

When a document passes ClamAV scanning (`src/channels/whatsapp.ts:362`) and then hits the document save block (line 406), `downloadMediaMessage` is called **twice**. This doubles bandwidth, latency, and peak memory.

## Proposed Solutions

### Option A: Cache Buffer From Malware Scan (Recommended)
Declare `let cachedMediaBuffer: Buffer | null = null;` before the ClamAV block. Store the buffer after scanning. Reuse in the document save block:
```typescript
const buffer = cachedMediaBuffer ?? await downloadMediaMessage(...) as Buffer;
```
- **Effort**: Small (3 lines)
- **Risk**: Low

## Technical Details

- **Affected files**: `src/channels/whatsapp.ts` (lines 358-421)
- **Impact**: Eliminates one WhatsApp CDN round-trip (500ms-2s) per document

## Acceptance Criteria

- [ ] Document downloaded only once when ClamAV scanning is active
- [ ] Fallback download still works when ClamAV is not available
