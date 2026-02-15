# Lightweight Command Guard Implementation Plan

**Created:** 2026-02-14
**Status:** Planning
**Priority:** High (Security Enhancement)

## Problem Statement

NanoClaw/Raiden is vulnerable to prompt injection attacks that could trick the AI into running destructive commands. While container isolation limits filesystem access, it doesn't prevent destruction of mounted directories.

**Current security gaps:**
- No command-level protection against destructive operations
- Prompt injection could cause: `git reset --hard`, `rm -rf /workspace/project`, `git clean -f`
- Agent credentials (ANTHROPIC_API_KEY) are mounted and accessible
- No audit trail of blocked commands

**Why not dcg?**
- dcg (Destructive Command Guard) is ideal but too resource-intensive to build in containers
- Compilation requires 4-8GB RAM, causes OOM in Docker build
- No ARM64 prebuilt binaries available

## Proposed Solution

Implement a **lightweight bash-based command guard** that:
- Intercepts Bash commands via Claude Code's PreToolUse hook
- Blocks destructive operations with pattern matching
- Supports whitelist for safe commands
- Logs all blocked attempts
- Fails open (allows commands if guard errors)
- ~100 lines of bash, no external dependencies

## Technical Approach

### Architecture

```
Claude Agent SDK
    ↓
PreToolUse hook → lightweight-guard (bash script)
    ↓
Pattern matching → BLOCK or ALLOW
    ↓
Original command execution
```

### Components

**1. Guard Script (`container/security/command-guard.sh`)**
- Main entry point called by PreToolUse hook
- Takes command as argument
- Returns exit code: 0=allow, 1=block

**2. Pattern Database (`container/security/blocked-patterns.conf`)**
- List of dangerous command patterns
- Supports regex matching
- Comments for documentation

**3. Allowlist (`container/security/allowlist.conf`)**
- Per-project exceptions
- Exact command matching
- Mounted from host (hot-reload without rebuild)

**4. Audit Log**
- Writes to `/workspace/group/logs/command-guard.log`
- Format: timestamp, command, action (blocked/allowed), reason

### Implementation Details

**Guard Logic:**
1. Check allowlist first (exact match) → ALLOW
2. Check blocked patterns → BLOCK if match
3. No match → ALLOW (fail-open)
4. On error → ALLOW (fail-open)

**Blocked Patterns:**
```bash
# Git destructive operations
^git\s+reset\s+--hard
^git\s+clean\s+-[df]
^git\s+checkout\s+--\s+\.

# Filesystem dangers
^rm\s+-rf?\s+(?!/tmp/)
^find\s+.*-delete
^dd\s+

# Embedded scripts
python\s+-c.*rm\s+-rf
bash\s+-c.*rm\s+-rf
```

**Hook Configuration:**
```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "/workspace/security/command-guard.sh"
      }]
    }]
  }
}
```

## Implementation Phases

### Phase 1: Core Guard Script (30 min)
- [ ] Create `/container/security/command-guard.sh`
- [ ] Implement pattern matching logic
- [ ] Add fail-open error handling
- [ ] Test basic blocking (git reset, rm -rf)

### Phase 2: Pattern Database (15 min)
- [ ] Create `/container/security/blocked-patterns.conf`
- [ ] Add git destructive patterns
- [ ] Add filesystem danger patterns
- [ ] Add embedded script detection
- [ ] Document each pattern

### Phase 3: Allowlist Support (15 min)
- [ ] Create `/container/security/allowlist.conf`
- [ ] Implement exact-match allowlist check
- [ ] Mount allowlist from host (hot-reload)
- [ ] Add management script for allowlist

### Phase 4: Docker Integration (20 min)
- [ ] Copy security scripts to container
- [ ] Update settings.json with PreToolUse hook
- [ ] Mount allowlist volume
- [ ] Test in container

### Phase 5: Logging & Audit (15 min)
- [ ] Implement audit logging
- [ ] Log format: timestamp, command, action, reason
- [ ] Rotate logs (simple rotation)
- [ ] Test log visibility

### Phase 6: Testing & Documentation (30 min)
- [ ] Test destructive commands get blocked
- [ ] Test safe commands pass through
- [ ] Test allowlist bypasses
- [ ] Test fail-open behavior
- [ ] Write docs/SECURITY.md section
- [ ] Create README with examples

## Acceptance Criteria

**Must Have:**
- ✅ Blocks `git reset --hard`
- ✅ Blocks `git clean -f`
- ✅ Blocks `rm -rf` (except /tmp)
- ✅ Allows safe git commands (status, diff, add)
- ✅ Allowlist works (exact match)
- ✅ Fails open on errors
- ✅ Logs blocked attempts
- ✅ Documentation complete

**Nice to Have:**
- Regex patterns for flexibility
- Per-group allowlists
- Metrics (blocks/hour)
- Interactive confirmation prompts

## File Structure

```
container/
├── security/
│   ├── command-guard.sh          # Main guard script
│   ├── blocked-patterns.conf     # Pattern database
│   └── allowlist.conf.example    # Allowlist template
├── Dockerfile                     # Copy security files
└── dcg-config/                    # (Remove - dcg abandoned)

scripts/
├── security-allowlist.sh          # Manage allowlist
└── test-command-guard.sh          # Test suite

docs/
└── SECURITY.md                    # Updated with guard docs

data/
└── security/
    └── allowlist.conf             # Mounted allowlist (host)
```

## Security Considerations

**What it protects:**
- Destructive git operations
- Recursive file deletion
- Embedded malicious scripts

**What it doesn't protect:**
- Sophisticated obfuscation
- Command chaining with ; or &&
- Slow data exfiltration
- Network-based attacks

**Trust model:**
- Main group (you): High trust, fewer patterns
- Non-main groups (others): Low trust, all patterns

## Performance

**Target:**
- < 1ms overhead per command (bash pattern matching)
- No noticeable delay
- Memory: ~100KB

**Benchmarks needed:**
- Time 1000 commands through guard
- Compare with/without guard latency

## Rollback Plan

If guard causes issues:
1. Remove PreToolUse hook from settings.json
2. Rebuild container
3. Revert to container-isolation-only

No code changes needed - just config.

## Alternative Considered

**dcg (Destructive Command Guard):**
- ✅ Comprehensive protection
- ✅ AST-based parsing
- ❌ Too heavy to build (4-8GB RAM)
- ❌ No ARM64 binaries
- **Decision:** Not viable for container build

## Success Metrics

**Week 1:**
- 0 successful prompt injection attacks
- < 5 false positives reported
- 100% of destructive commands blocked in tests

**Month 1:**
- Allowlist has < 10 entries (most commands work)
- No production incidents from blocked commands
- Documentation is clear (no confusion)

## Next Steps

After implementation:
1. Monitor logs for blocked attempts
2. Tune patterns based on false positives
3. Consider adding more patterns (database commands?)
4. Possibly upgrade to dcg if ARM64 binaries become available

---

**Ready to implement:** ✅
**Estimated effort:** 2-3 hours
**Risk:** Low (fail-open design prevents breaking changes)
