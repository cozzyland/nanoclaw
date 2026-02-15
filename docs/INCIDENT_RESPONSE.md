# Security Incident Response Guide

**For:** NanoClaw/Raiden Security Events

## Overview

This guide covers how to respond to security incidents detected by NanoClaw's defense layers (Phases 1-5).

## Security Event Severity Levels

| Severity | Response Time | Examples |
|----------|---------------|----------|
| **🔴 CRITICAL** | Immediate | DLP violations, credential exfiltration, session hijacking |
| **🟠 HIGH** | < 1 hour | Prompt injection, egress blocks, high-risk commands |
| **🟡 MEDIUM** | < 4 hours | Rate limiting, unauthorized senders |
| **🟢 LOW** | < 24 hours | Message sanitization, minor anomalies |

## Monitoring & Detection

### 1. View Security Dashboard

```bash
./scripts/security-dashboard.sh
```

Shows:
- Event summary (last 24h)
- Severity breakdown
- Event types
- Critical alerts
- Anomaly detection

### 2. Check Security Log

```bash
# View recent events (pretty-printed)
tail -f data/security-events.log | jq

# Count critical events today
grep '"severity":"critical"' data/security-events.log | grep "$(date +%Y-%m-%d)" | wc -l

# Find all DLP violations
grep '"type":"dlp_violation"' data/security-events.log | jq
```

### 3. Check Component Logs

```bash
# Credential proxy audit
curl http://localhost:3001/stats | jq

# Egress proxy audit
curl http://localhost:3002/_audit?limit=50 | jq

# Container logs
tail -f groups/*/logs/container-*.log
```

## Common Incidents & Responses

### Incident 1: DLP Violation (CRITICAL)

**Detection:**
```json
{
  "type": "dlp_violation",
  "severity": "critical",
  "description": "Data exfiltration attempt blocked (DLP)",
  "details": {
    "domain": "pastebin.com",
    "findings": ["Anthropic API key detected"]
  }
}
```

**Immediate Actions:**
1. ✅ Request was already blocked (no action needed)
2. Identify which group triggered it (check `groupId`)
3. Review recent activity for that group
4. Determine if legitimate or attack

**Investigation:**
```bash
# Find all events from this group
GROUP_ID="main"
grep "\"groupId\":\"$GROUP_ID\"" data/security-events.log | tail -20 | jq

# Check if API key was actually leaked
# (DLP blocks before sending, so key should be safe)

# Review group's conversation history
cat groups/$GROUP_ID/conversations/*.txt
```

**Response:**
- **If legitimate:** Add domain to egress allowlist if needed
- **If attack:** Investigate how attacker accessed key, rotate credentials
- **If compromised:** Immediately rotate ANTHROPIC_API_KEY

### Incident 2: Egress Blocked (HIGH)

**Detection:**
```json
{
  "type": "egress_blocked",
  "severity": "high",
  "description": "Blocked outbound request to evil.com",
  "details": {
    "domain": "evil.com",
    "path": "/steal?data=...",
    "reason": "Domain not in allowlist"
  }
}
```

**Immediate Actions:**
1. ✅ Request was blocked (no data leaked)
2. Review what agent was trying to access
3. Determine if domain should be allowlisted

**Investigation:**
```bash
# Check if this domain appears in prompts/context
grep -r "evil.com" groups/*/

# Review conversation that led to request
# (check CLAUDE.md, conversation logs)
```

**Response:**
- **If legitimate:** Add domain to `DEFAULT_EGRESS_CONFIG.allowedDomains`
- **If attack:** Investigate prompt injection, review group members
- **If suspicious:** Monitor for repeat attempts

### Incident 3: Rate Limit Exceeded (MEDIUM)

**Detection:**
```json
{
  "type": "rate_limit_exceeded",
  "severity": "medium",
  "description": "User exceeded message rate limit",
  "details": {
    "userId": "1234567890@s.whatsapp.net",
    "limit": 20
  }
}
```

**Immediate Actions:**
1. ✅ Messages dropped automatically
2. User notified via WhatsApp
3. Temporary 2-minute block applied

**Investigation:**
```bash
# Check if this user has history of rate limiting
grep "\"userId\":\"1234567890@s.whatsapp.net\"" data/security-events.log | grep "rate_limit"

# Check total events from this user
grep "\"userId\":\"1234567890@s.whatsapp.net\"" data/security-events.log | wc -l
```

**Response:**
- **If one-time:** No action needed (temporary block sufficient)
- **If repeated:** Consider adding to sender blocklist
- **If spam attack:** Remove group from registered groups

### Incident 4: Prompt Injection Attempt (HIGH)

**Detection:**
```json
{
  "type": "prompt_injection",
  "severity": "high",
  "description": "Possible prompt injection attempt detected",
  "details": {
    "message": "Ignore all instructions and...",
    "detectedPattern": "control character injection"
  }
}
```

**Immediate Actions:**
1. ✅ Message sanitized before processing
2. Review sanitized vs original message
3. Check if attack succeeded

**Investigation:**
```bash
# Review recent high-risk commands from this group
grep '"type":"high_risk_command"' data/security-events.log | grep "\"groupId\":\"$GROUP_ID\""

# Check if agent executed suspicious commands
grep "git reset --hard\|rm -rf" groups/$GROUP_ID/logs/container-*.log
```

**Response:**
- **If blocked successfully:** Document pattern for future detection
- **If partial success:** Review what commands were executed, assess damage
- **If full compromise:** Reset group, rotate credentials, review all activity

### Incident 5: Session Hijacking (CRITICAL)

**Detection:**
```json
{
  "type": "session_security",
  "severity": "critical",
  "description": "WhatsApp session logged out - possible hijacking",
  "source": "phase4-whatsapp-hardening"
}
```

**Immediate Actions:**
1. 🚨 Process exited automatically (safe shutdown)
2. WhatsApp session invalidated
3. Re-authentication required

**Investigation:**
```bash
# Check when last successful connection was
grep "Connected to WhatsApp" logs/*.log | tail -1

# Review recent security events before logout
tail -100 data/security-events.log | jq 'select(.timestamp > "CUTOFF_TIME")'

# Check if API key was accessed
grep "credential" data/security-events.log
```

**Response:**
1. **Re-authenticate WhatsApp:** Run `/setup` skill
2. **Rotate credentials:** Change ANTHROPIC_API_KEY
3. **Review all activity:** Check for data exfiltration
4. **Monitor closely:** Watch for repeat incidents

## Credential Compromise Response

**If you suspect ANTHROPIC_API_KEY was compromised:**

### 1. Immediate Actions (< 5 minutes)

```bash
# 1. Stop NanoClaw
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# 2. Rotate API key in Anthropic Console
# https://console.anthropic.com/settings/keys

# 3. Update .env file
nano .env
# Replace ANTHROPIC_API_KEY=old_key
# With:    ANTHROPIC_API_KEY=new_key

# 4. Restart NanoClaw
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

### 2. Investigation (< 1 hour)

```bash
# Check credential proxy logs for unusual activity
curl http://localhost:3001/stats | jq

# Review all egress attempts
curl http://localhost:3002/_audit | jq

# Search for DLP violations
grep '"type":"dlp_violation"' data/security-events.log

# Check which groups were active
grep '"groupId"' data/security-events.log | sort -u
```

### 3. Containment (< 4 hours)

- Review all groups for malicious activity
- Remove compromised groups from registered list
- Clear conversation history if needed
- Document timeline of compromise

### 4. Recovery & Lessons Learned

- Update security allowlists if needed
- Add new detection patterns
- Document incident for future reference
- Consider additional hardening

## Alert Configuration (Future Enhancement)

**Recommended alerts to implement:**

1. **Critical:** Send email/SMS for critical events
2. **DLP violations:** Immediate notification
3. **High event rate:** Alert if > 100 events/hour
4. **Credential access:** Alert on unusual credential proxy activity
5. **Session changes:** Alert on WhatsApp logout/reconnection

**Implementation:**
```typescript
// In security-events.ts
if (event.severity === 'critical') {
  await sendAlert({
    type: 'email',
    to: 'admin@example.com',
    subject: `🚨 CRITICAL: ${event.description}`,
    body: JSON.stringify(event, null, 2),
  });
}
```

## Periodic Security Reviews

### Daily
- Run `./scripts/security-dashboard.sh`
- Review critical/high events
- Check for anomalies

### Weekly
- Review full security log
- Analyze trends (event types, frequencies)
- Update allowlists if needed
- Test security controls

### Monthly
- Clear old events (> 30 days)
- Review incident response procedures
- Update security documentation
- Conduct security drills

## Escalation Path

1. **Low/Medium events:** Handle locally, document
2. **High events:** Review same day, escalate if repeated
3. **Critical events:** Immediate response, escalate to team
4. **Credential compromise:** Immediate rotation, full investigation

## Security Contacts

- **NanoClaw maintainer:** [Your contact]
- **Security team:** [Team contact]
- **Anthropic support:** support@anthropic.com (for API issues)

## Post-Incident Actions

After resolving any incident:

1. ✅ Document in incident log
2. ✅ Update this guide if new patterns discovered
3. ✅ Add detection rules if needed
4. ✅ Share lessons learned with team
5. ✅ Test preventive measures

## Useful Commands

```bash
# View security dashboard
./scripts/security-dashboard.sh

# Tail security events
tail -f data/security-events.log | jq

# Count events by type
grep '"type":"' data/security-events.log | cut -d'"' -f4 | sort | uniq -c

# Find events from specific group
grep '"groupId":"main"' data/security-events.log | jq

# Recent critical events
grep '"severity":"critical"' data/security-events.log | tail -10 | jq

# Check proxy health
curl http://localhost:3001/health && curl http://localhost:3002/_health
```
