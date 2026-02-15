/**
 * Credential Proxy for NanoClaw
 *
 * Proxies Anthropic API requests and injects credentials at runtime.
 * Agents never see the real API key - it's injected by this trusted host process.
 *
 * Benefits:
 * - Zero-trust: Agents can't exfiltrate what they can't see
 * - Revocable: Stop proxy to cut off all agent API access
 * - Auditable: All API calls logged with context
 * - Rate-limited: Prevent abuse and cost overruns
 */

import express, { Request, Response } from 'express';
import fetch from 'node-fetch';
import https from 'https';
import { logger } from './logger.js';

// HTTPS Agent with connection pooling
// Reuses TCP connections to api.anthropic.com for better performance
// Expected improvement: 10-25% latency reduction (saves 50-100ms per request)
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10, // Allow up to 10 concurrent connections
  keepAliveMsecs: 60000, // Keep connections alive for 1 minute
});

const app = express();
app.use(express.json({ limit: '10mb' }));

// Load API key from environment (host only, never mounted to containers)
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  logger.error('ANTHROPIC_API_KEY not set in environment');
  process.exit(1);
}

// Rate limiter: Track API calls per group
class RateLimiter {
  private limits = new Map<string, { count: number; resetAt: number }>();

  check(clientId: string, maxCalls = 100, windowMs = 60000): boolean {
    const now = Date.now();
    const limit = this.limits.get(clientId);

    if (!limit || now > limit.resetAt) {
      this.limits.set(clientId, { count: 1, resetAt: now + windowMs });
      return true;
    }

    if (limit.count >= maxCalls) {
      return false; // Rate limited
    }

    limit.count++;
    return true;
  }

  getStats(clientId: string): { count: number; remaining: number; resetAt: number } | null {
    const limit = this.limits.get(clientId);
    if (!limit) return null;

    const maxCalls = 100;
    return {
      count: limit.count,
      remaining: Math.max(0, maxCalls - limit.count),
      resetAt: limit.resetAt,
    };
  }
}

const rateLimiter = new RateLimiter();

// Audit log structure
interface AuditEntry {
  timestamp: string;
  clientId: string;
  requestId?: string;
  method: string;
  path: string;
  model?: string;
  messageCount?: number;
  maxTokens?: number;
  responseStatus: number;
  durationMs: number;
}

const auditLog: AuditEntry[] = [];

function logAudit(entry: AuditEntry) {
  auditLog.push(entry);
  logger.info(entry, 'API request proxied');

  // Keep last 1000 entries in memory
  if (auditLog.length > 1000) {
    auditLog.shift();
  }
}

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    auditLogSize: auditLog.length,
  });
});

// Stats endpoint (for debugging) - with specific client
app.get('/stats/:clientId', (req: Request, res: Response) => {
  const clientIdParam = req.params.clientId;
  const clientId = Array.isArray(clientIdParam) ? clientIdParam[0] : clientIdParam;
  const stats = rateLimiter.getStats(clientId);
  res.json({ clientId, stats });
});

// Stats endpoint (for debugging) - all stats
app.get('/stats', (req: Request, res: Response) => {
  // Return recent audit log entries
  res.json({
    recentCalls: auditLog.slice(-20),
    totalCalls: auditLog.length,
  });
});

// Proxy /v1/messages endpoint
app.post('/v1/messages', async (req: Request, res: Response) => {
  const startTime = Date.now();
  const clientIdHeader = req.headers['x-client-id'];
  const clientId = (Array.isArray(clientIdHeader) ? clientIdHeader[0] : clientIdHeader) || 'unknown';
  const requestIdHeader = req.headers['x-request-id'];
  const requestId = (Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader) || undefined;

  // Rate limiting
  if (!rateLimiter.check(clientId)) {
    logger.warn({ clientId, requestId }, 'Rate limit exceeded');
    return res.status(429).json({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'Too many requests. Please slow down.',
      },
    });
  }

  try {
    // Forward request to Anthropic API with injected credentials
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY, // Injected here - never visible to agent
        'anthropic-version': (() => {
          const v = req.headers['anthropic-version'];
          return (Array.isArray(v) ? v[0] : v) || '2023-06-01';
        })(),
      },
      body: JSON.stringify(req.body),
      agent: httpsAgent, // Use connection pooling for better performance
    });

    const data = await response.json();
    const durationMs = Date.now() - startTime;

    // Audit logging
    logAudit({
      timestamp: new Date().toISOString(),
      clientId,
      requestId,
      method: 'POST',
      path: '/v1/messages',
      model: req.body.model,
      messageCount: req.body.messages?.length,
      maxTokens: req.body.max_tokens,
      responseStatus: response.status,
      durationMs,
    } as AuditEntry);

    // Forward response
    res.status(response.status).json(data);
  } catch (err) {
    const durationMs = Date.now() - startTime;
    logger.error({ err, clientId, requestId, durationMs }, 'Proxy request failed');

    res.status(500).json({
      type: 'error',
      error: {
        type: 'proxy_error',
        message: 'Credential proxy encountered an error',
      },
    });
  }
});

// Catch-all for other endpoints
app.use((req: Request, res: Response) => {
  const path = req.path;
  const clientIdHeader = req.headers['x-client-id'];
  const clientId = (Array.isArray(clientIdHeader) ? clientIdHeader[0] : clientIdHeader) || 'unknown';

  logger.warn({ path, clientId }, 'Unsupported API endpoint requested');

  res.status(404).json({
    type: 'error',
    error: {
      type: 'not_found',
      message: `Endpoint ${path} not supported by credential proxy`,
    },
  });
});

export function startCredentialProxy(port = 3001, host = '0.0.0.0'): Promise<void> {
  return new Promise((resolve) => {
    app.listen(port, host, () => {
      logger.info({ port, host }, 'Credential proxy server started');
      resolve();
    });
  });
}

// Start server if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(process.env.CREDENTIAL_PROXY_PORT || '3001', 10);
  startCredentialProxy(port).catch((err) => {
    logger.error({ err }, 'Failed to start credential proxy');
    process.exit(1);
  });
}
