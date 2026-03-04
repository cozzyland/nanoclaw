---
status: complete
priority: p1
issue_id: "002"
tags: [code-review, security, path-traversal]
dependencies: []
---

# Path Traversal via Document fileName in WhatsApp Handler

## Problem Statement

The `fileName` from WhatsApp `documentMessage` is used unsanitized in `path.join()` + `fs.writeFileSync()` at `src/channels/whatsapp.ts:412-414`. A malicious sender can set `fileName` to `../../CLAUDE.md` or `../../../.env` and overwrite arbitrary files.

`path.join('/a/b', '../../etc/passwd')` resolves to `/etc/passwd`.

## Findings

- **Security-sentinel**: CRITICAL-2. Arbitrary file write via path traversal. Can overwrite CLAUDE.md (persistent prompt injection), .env (credential theft), or source files.
- **TypeScript-reviewer**: CRITICAL-1. Same finding, recommended `path.basename()` + character restriction.
- **Architecture-strategist**: MEDIUM priority. Confirmed the gap, recommended `path.basename()`.
- **Agent-native-reviewer**: WARNING. Filename not sanitized.
- **Simplicity-reviewer**: Not flagged (different focus).

## Proposed Solutions

### Option A: path.basename() Sanitization (Recommended)
```typescript
const rawName = docMessage.fileName || `document_${Date.now()}`;
const fileName = path.basename(rawName);
if (!fileName || fileName === '.' || fileName === '..') {
  fileName = `document_${Date.now()}`;
}
```
- **Pros**: Simple, effective, preserves original filename for user experience
- **Cons**: Allows special characters in filename (could cause issues on some filesystems)
- **Effort**: Small (2 lines)
- **Risk**: None

### Option B: path.basename() + Character Restriction
```typescript
const rawName = docMessage.fileName || `document_${Date.now()}`;
const sanitized = path.basename(rawName).replace(/[^\w.\-]/g, '_');
const fileName = sanitized || `document_${Date.now()}`;
```
- **Pros**: Handles special characters, null bytes, etc.
- **Cons**: Renames files (user may not recognize the filename)
- **Effort**: Small (3 lines)
- **Risk**: Low (filename changes may confuse agent)

### Option C: basename() + Path Containment Check
Same as A/B, plus verify resolved path is within receivedDir:
```typescript
const filePath = path.join(receivedDir, fileName);
if (!filePath.startsWith(receivedDir)) {
  logger.warn({ rawName, chatJid }, 'Path traversal attempt blocked');
  continue;
}
```
- **Pros**: Defense-in-depth
- **Cons**: Slightly more code
- **Effort**: Small
- **Risk**: None

## Recommended Action

Option A (minimum). Option C for defense-in-depth.

## Technical Details

- **Affected files**: `src/channels/whatsapp.ts` (lines 412-414)
- **Attack vector**: WhatsApp document message with crafted fileName field
- **Prerequisite**: Attacker must be in a registered WhatsApp group

## Acceptance Criteria

- [ ] `path.basename()` strips directory components from fileName
- [ ] Filenames like `../../CLAUDE.md` are sanitized to `CLAUDE.md`
- [ ] Empty/dot-only filenames fall back to `document_{timestamp}`
- [ ] Log warning on attempted path traversal

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-03 | Initial finding from code review | All security-focused agents flagged this |

## Resources

- OWASP Path Traversal: https://owasp.org/www-community/attacks/Path_Traversal
