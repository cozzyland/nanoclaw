---
title: "Notion MCP Server Blocked by Egress Proxy in Apple Container"
date: 2026-02-21
category: integration-issues
tags:
  - notion-mcp
  - egress-proxy
  - container-networking
  - apple-container
  - no-proxy
  - mcp-integration
severity: high
component: src/container-runner.ts
status: resolved
symptoms:
  - "Notion MCP server unable to reach Notion API"
  - "Proxy/redirect errors when connecting to api.notion.com"
  - "URL mangling: api.notion.comhttps://api.notion.com/v1/search"
---

# Notion MCP Server Blocked by Egress Proxy in Apple Container

## Problem Statement

After integrating the Notion MCP server (`@notionhq/notion-mcp-server`) into NanoClaw's container image, Raiden couldn't reach the Notion API. The agent reported "proxy/redirect errors" and the logs showed URL mangling: `api.notion.comhttps://api.notion.com/v1/search`.

## Investigation Steps

1. **Checked NanoClaw logs** — found agent output: `The Notion MCP server appears to be misconfigured - the proxy URL is malformed (doubling the host: "api.notion.comhttps://api.notion.com/v1/search")`
2. **Checked egress proxy audit log** — no Notion entries (requests never reached the proxy handler correctly)
3. **Examined container environment** — `HTTPS_PROXY=http://192.168.64.1:3002` set for all outbound traffic
4. **Checked NO_PROXY** — was `localhost,127.0.0.1,api.anthropic.com,{limaGatewayIp}` — missing `api.notion.com`
5. **Confirmed Node.js behavior** — the Notion MCP server uses standard Node.js HTTP client which automatically respects `HTTPS_PROXY`

## Root Cause

Node.js HTTP clients (including the Notion MCP server) automatically honor the `HTTPS_PROXY` environment variable. When `api.notion.com` was not listed in `NO_PROXY`, the egress proxy intercepted the request and mangled the URL by prepending the target host to the full URL:

```
Expected: https://api.notion.com/v1/search
Actual:   api.notion.comhttps://api.notion.com/v1/search
```

This is a general issue when adding any new MCP server or external API integration to the container — the domain must be added to `NO_PROXY` to bypass the egress proxy.

## Solution

### 1. Add domain to `NO_PROXY` (`src/container-runner.ts:250`)

```typescript
// Before:
args.push('-e', `NO_PROXY=localhost,127.0.0.1,api.anthropic.com,${limaGatewayIp}`);

// After:
args.push('-e', `NO_PROXY=localhost,127.0.0.1,api.anthropic.com,api.notion.com,${limaGatewayIp}`);
```

### 2. Add domain to egress proxy allowlist (`src/security/egress-proxy.ts`)

```typescript
// Notion API (MCP integration)
'api.notion.com',
```

### 3. Pass token to container (`src/container-runner.ts`)

```typescript
const notionToken = process.env.NOTION_TOKEN;
if (notionToken) {
  args.push('-e', `NOTION_TOKEN=${notionToken}`);
}
```

### 4. Add MCP server to agent runner (`container/agent-runner/src/index.ts`)

```typescript
mcpServers: {
  nanoclaw: { /* existing */ },
  ...(process.env.NOTION_TOKEN ? {
    notion: {
      command: 'notion-mcp-server',
      args: [],
      env: { NOTION_TOKEN: process.env.NOTION_TOKEN },
    },
  } : {}),
},
```

### 5. Add to allowed tools

```typescript
allowedTools: [
  // ... existing tools
  'mcp__notion__*'
],
```

### 6. Install in container (`container/Dockerfile`)

```dockerfile
RUN npm install -g agent-browser @anthropic-ai/claude-code @notionhq/notion-mcp-server
```

### 7. Store token (`.env`)

```
NOTION_TOKEN=ntn_your_token_here
```

## Verification

```bash
# Test API connectivity from host
curl -s https://api.notion.com/v1/users/me \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28"

# After rebuild and restart, message Raiden:
# "@Raiden list my Notion pages"

# Check logs for successful Notion MCP activity
grep -i "notion" logs/nanoclaw.log
```

## Prevention: Checklist for Adding New MCP Servers

When adding any new MCP server or external API to the container:

1. **Add domain to `NO_PROXY`** in `src/container-runner.ts` — prevents HTTPS_PROXY interception
2. **Add domain to egress proxy allowlist** in `src/security/egress-proxy.ts` — allows traffic if it does go through the proxy
3. **Pass authentication token** as env var in `src/container-runner.ts`
4. **Register MCP server** in `container/agent-runner/src/index.ts` mcpServers config
5. **Add tool pattern** to `allowedTools` (e.g., `'mcp__servicename__*'`)
6. **Install package** in `container/Dockerfile` globally
7. **Store credentials** in `.env` (sourced by launchd) or macOS Keychain
8. **Rebuild container image** — bust cache with `container builder stop && container builder rm && container builder start`
9. **Test connectivity** before deploying to production

## Related Documentation

- `docs/solutions/security-issues/container-security-architecture-lima-proxy.md` — Egress proxy architecture and NO_PROXY handling
- `docs/APPLE-CONTAINER-NETWORKING.md` — Lima VM gateway networking (192.168.64.1)
- `docs/SECURITY.md` — Phase 5: Network Egress Filtering
- `MEMORY.md` — Container Networking section (egress proxy port 3002, Lima gateway IP)

## Key Insight

The `NO_PROXY` and egress proxy allowlist must be kept in sync. Any domain added to one should be added to the other. Consider creating a shared domain registry (`src/security/domain-registry.ts`) as a single source of truth if more integrations are added.
