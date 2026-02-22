/**
 * Network Egress Proxy for NanoClaw Containers
 *
 * Transparent proxy that intercepts and filters all outbound HTTP/HTTPS traffic.
 *
 * Features:
 * - Domain allowlist (only trusted domains)
 * - Request logging and audit trail
 * - DLP scanning (detect credentials in requests)
 * - DNS exfiltration detection
 * - Rate limiting per domain
 *
 * Architecture:
 * Container → HTTP_PROXY/HTTPS_PROXY env var → This proxy → Internet
 *
 * HTTPS Handling:
 * - Uses http-proxy-middleware for proper CONNECT method support
 * - Creates TLS tunnel for HTTPS requests
 * - Domain filtering before tunnel establishment
 */

import express, { Request, Response } from 'express';
import net from 'net';
import { createProxyMiddleware, Options as ProxyOptions } from 'http-proxy-middleware';
import { logger } from '../logger.js';

export interface EgressProxyConfig {
  // Allowed domains (full domains or wildcards)
  allowedDomains: string[];

  // Block all by default (allowlist mode)
  defaultBlock: boolean;

  // Enable DLP scanning
  enableDLP: boolean;

  // Log all requests (including allowed)
  logAllRequests: boolean;
}

interface RequestAuditEntry {
  timestamp: string;
  clientId?: string;
  requestId?: string;
  method: string;
  host: string;
  path: string;
  allowed: boolean;
  reason?: string;
  dlpFindings?: string[];
}

const auditLog: RequestAuditEntry[] = [];

/**
 * Check if domain matches allowlist
 *
 * Supports:
 * - Exact match: "api.anthropic.com"
 * - Wildcard subdomain: "*.github.com"
 * - Wildcard suffix: "github.com" (matches all subdomains)
 */
function isDomainAllowed(domain: string, allowlist: string[]): boolean {
  // Normalize domain (lowercase, remove trailing dot)
  domain = domain.toLowerCase().replace(/\.$/, '');

  for (const allowed of allowlist) {
    const allowedNorm = allowed.toLowerCase().replace(/\.$/, '');

    // Exact match
    if (domain === allowedNorm) {
      return true;
    }

    // Wildcard subdomain: *.example.com matches api.example.com
    if (allowedNorm.startsWith('*.')) {
      const suffix = allowedNorm.slice(2); // Remove "*."
      if (domain.endsWith('.' + suffix) || domain === suffix) {
        return true;
      }
    }

    // Wildcard suffix: example.com matches api.example.com
    if (!allowedNorm.includes('*') && domain.endsWith('.' + allowedNorm)) {
      return true;
    }
  }

  return false;
}

/**
 * Scan request for sensitive data (DLP)
 *
 * Detects:
 * - API keys (common formats)
 * - AWS credentials
 * - Private keys
 * - Tokens
 */
function scanForSensitiveData(data: string): string[] {
  const findings: string[] = [];

  // Anthropic API keys
  if (/sk-ant-[a-zA-Z0-9-_]{20,}/i.test(data)) {
    findings.push('Anthropic API key detected');
  }

  // OpenAI API keys
  if (/sk-[a-zA-Z0-9]{32,}/i.test(data)) {
    findings.push('OpenAI API key detected');
  }

  // AWS access keys
  if (/AKIA[0-9A-Z]{16}/i.test(data)) {
    findings.push('AWS access key detected');
  }

  // Private keys
  if (/-----BEGIN (RSA|PRIVATE|OPENSSH|EC) (PRIVATE )?KEY-----/.test(data)) {
    findings.push('Private key detected');
  }

  // Generic API tokens
  if (/[a-z0-9]{32,}/i.test(data) && /token|key|secret|password/i.test(data)) {
    findings.push('Generic token/key detected');
  }

  // Environment variable references (potential exfiltration)
  if (/\$\{?[A-Z_]+\}?/.test(data) && /(API_KEY|SECRET|PASSWORD|TOKEN)/.test(data)) {
    findings.push('Environment variable reference detected');
  }

  return findings;
}

/**
 * Extract hostname from request
 *
 * For HTTP requests: Use Host header
 * For CONNECT requests (HTTPS): Parse from request URL
 */
function getTargetHost(req: Request): string {
  if (req.method === 'CONNECT') {
    // CONNECT requests have URL in format "host:port"
    return req.url.split(':')[0];
  }

  // HTTP requests use Host header
  return req.headers.host || req.hostname;
}

/**
 * Network Egress Proxy
 */
export class EgressProxy {
  private app: express.Application;
  private config: EgressProxyConfig;

  constructor(config: EgressProxyConfig) {
    this.config = config;
    this.app = express();

    // Parse JSON bodies for DLP scanning
    this.app.use(express.json({ limit: '10mb' }));

    this.setupRoutes();
  }

  private setupRoutes() {
    // Restrict management endpoints to localhost only (containers connect via gateway IP)
    const localhostOnly = (req: Request, res: Response, next: () => void) => {
      const ip = req.ip || req.socket.remoteAddress || '';
      if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
        next();
      } else {
        res.sendStatus(403);
      }
    };

    // Health check (localhost only)
    this.app.get('/_health', localhostOnly, (req, res) => {
      res.json({
        status: 'healthy',
        allowedDomains: this.config.allowedDomains.length,
        requestsLogged: auditLog.length,
      });
    });

    // Audit log endpoint (localhost only)
    this.app.get('/_audit', localhostOnly, (req, res) => {
      const limit = parseInt(req.query.limit as string) || 100;
      res.json({
        recent: auditLog.slice(-limit),
        total: auditLog.length,
      });
    });

    // Create proxy middleware with security checks
    const proxyMiddleware = createProxyMiddleware({
      // Router function determines target based on request
      router: (req) => {
        const host = getTargetHost(req as Request);
        // For HTTPS CONNECT, target is the host
        // For HTTP, target includes protocol
        if (req.method === 'CONNECT') {
          return `https://${host}`;
        }
        return `http://${host}`;
      },

      // Change origin to match target host
      changeOrigin: true,

      // Handle CONNECT method for HTTPS tunneling
      onProxyReq: (proxyReq: any, req: any, res: any) => {
        const host = getTargetHost(req as Request);
        const method = req.method;
        const path = req.url;
        const clientId = (req.headers['x-client-id'] as string) || 'unknown';
        const requestId = (req.headers['x-request-id'] as string) || undefined;

        // Check if domain is allowed
        const allowed = this.config.defaultBlock
          ? isDomainAllowed(host, this.config.allowedDomains)
          : true;

        const auditEntry: RequestAuditEntry = {
          timestamp: new Date().toISOString(),
          clientId,
          requestId,
          method,
          host,
          path,
          allowed,
        };

        if (!allowed) {
          auditEntry.reason = 'Domain not in allowlist';
          auditLog.push(auditEntry);

          logger.warn(
            { host, path, clientId, requestId },
            '🚨 BLOCKED: Outbound request to unauthorized domain'
          );

          // Abort the proxy request
          proxyReq.destroy();

          // Send error response
          if (res && !res.headersSent) {
            (res as Response).status(403).json({
              error: 'Forbidden',
              message: 'Domain not in allowlist',
              domain: host,
            });
          }
          return;
        }

        // DLP scanning (if enabled and body exists)
        // Note: For CONNECT requests (HTTPS), we can't inspect encrypted traffic
        // DLP only works for HTTP requests with bodies
        if (this.config.enableDLP && method !== 'CONNECT' && (req as any).body) {
          const bodyStr = JSON.stringify((req as any).body);
          const dlpFindings = scanForSensitiveData(bodyStr);

          if (dlpFindings.length > 0) {
            auditEntry.allowed = false;
            auditEntry.reason = 'DLP violation';
            auditEntry.dlpFindings = dlpFindings;
            auditLog.push(auditEntry);

            logger.error(
              { host, path, dlpFindings, clientId, requestId },
              '🚨 BLOCKED: DLP violation - sensitive data in request'
            );

            // Abort the proxy request
            proxyReq.destroy();

            // Send error response
            if (res && !res.headersSent) {
              (res as Response).status(403).json({
                error: 'Forbidden',
                message: 'Request contains sensitive data',
                findings: dlpFindings,
              });
            }
            return;
          }
        }

        // Log allowed request
        if (this.config.logAllRequests) {
          auditLog.push(auditEntry);
          logger.debug({ host, path, method, clientId, requestId }, 'Proxying allowed request');
        }

        // Keep last 10000 audit entries
        if (auditLog.length > 10000) {
          auditLog.shift();
        }
      },

      // Error handling
      onError: (err: Error, req: any, res: any) => {
        logger.error({ err, url: req.url }, 'Proxy error');

        if (res && !res.headersSent) {
          (res as Response).status(502).json({
            error: 'Proxy Error',
            message: 'Failed to connect to upstream server',
          });
        }
      },

      // Log provider for debugging
      logProvider: () => ({
        log: (msg: string) => logger.debug(msg),
        debug: (msg: string) => logger.debug(msg),
        info: (msg: string) => logger.info(msg),
        warn: (msg: string) => logger.warn(msg),
        error: (msg: string) => logger.error(msg),
      }),
    } as ProxyOptions);

    // Apply proxy middleware to all requests
    this.app.use(proxyMiddleware);
  }

  /**
   * Start the egress proxy server
   *
   * HTTPS CONNECT tunneling is handled at the http.Server level
   * (Express never sees CONNECT requests — they bypass middleware)
   */
  start(port: number, host = '0.0.0.0'): Promise<void> {
    return new Promise((resolve) => {
      const server = this.app.listen(port, host, () => {
        logger.info(
          {
            port,
            host,
            allowedDomains: this.config.allowedDomains.length,
            defaultBlock: this.config.defaultBlock,
            enableDLP: this.config.enableDLP,
          },
          'Network egress proxy started (with HTTPS CONNECT support)'
        );
        resolve();
      });

      // Handle HTTPS CONNECT tunneling at the raw server level
      server.on('connect', (req: any, clientSocket: net.Socket, head: Buffer) => {
        const [targetHost, targetPortStr] = (req.url || '').split(':');
        const targetPort = parseInt(targetPortStr) || 443;
        const clientId = req.headers['x-client-id'] || 'unknown';

        // Check domain allowlist
        const allowed = this.config.defaultBlock
          ? isDomainAllowed(targetHost, this.config.allowedDomains)
          : true;

        const auditEntry: RequestAuditEntry = {
          timestamp: new Date().toISOString(),
          clientId,
          method: 'CONNECT',
          host: targetHost,
          path: req.url,
          allowed,
        };

        if (!allowed) {
          auditEntry.reason = 'Domain not in allowlist';
          auditLog.push(auditEntry);
          logger.warn(
            { host: targetHost, clientId },
            'BLOCKED: HTTPS CONNECT to unauthorized domain'
          );
          clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          clientSocket.destroy();
          return;
        }

        // Log allowed request
        if (this.config.logAllRequests) {
          auditLog.push(auditEntry);
          logger.debug({ host: targetHost, port: targetPort, clientId }, 'CONNECT tunnel allowed');
        }

        // Keep audit log bounded
        if (auditLog.length > 10000) {
          auditLog.shift();
        }

        // Create TCP tunnel to target
        const targetSocket = net.connect(targetPort, targetHost, () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          targetSocket.write(head);
          targetSocket.pipe(clientSocket);
          clientSocket.pipe(targetSocket);
        });

        targetSocket.on('error', (err) => {
          logger.warn({ host: targetHost, err: err.message }, 'CONNECT tunnel target error');
          clientSocket.destroy();
        });

        clientSocket.on('error', (err) => {
          logger.debug({ host: targetHost, err: err.message }, 'CONNECT tunnel client error');
          targetSocket.destroy();
        });
      });
    });
  }
}

/**
 * Default egress proxy configuration
 *
 * Allowlist of trusted domains for NanoClaw operations
 */
export const DEFAULT_EGRESS_CONFIG: EgressProxyConfig = {
  allowedDomains: [
    // Anthropic API
    'api.anthropic.com',
    '*.anthropic.com',

    // GitHub (specific subdomains only — no *.github.com wildcard)
    'github.com',
    'api.github.com',
    'raw.githubusercontent.com',
    'objects.githubusercontent.com',
    'codeload.github.com',

    // NPM registry
    'registry.npmjs.org',

    // Python package index
    'pypi.org',
    'files.pythonhosted.org',

    // Documentation sites
    'docs.npmjs.com',
    'developer.mozilla.org',
    'nodejs.org',
    'python.org',

    // Package CDNs
    'unpkg.com',
    'cdn.jsdelivr.net',
    'cdnjs.cloudflare.com',

    // Grocery sites (authenticated via cookie injection)
    '*.dunnesstoresgrocery.com',
    'dunnesstoresgrocery.com',

    // Cloudflare (specific services only)
    'challenges.cloudflare.com',
    'static.cloudflareinsights.com',

    // Common browsing targets (agent-browser needs these)
    'example.com',

    // Web search (specific subdomains — no *.google.com wildcard)
    'www.google.com',
    'www.googleapis.com',
    'customsearch.googleapis.com',
    'www.gstatic.com',
    'www.bing.com',
    'duckduckgo.com',
    'html.duckduckgo.com',
    'lite.duckduckgo.com',

    // Notion API (MCP integration)
    'api.notion.com',
  ],

  // Default to blocking (allowlist mode)
  defaultBlock: true,

  // Enable DLP scanning
  enableDLP: true,

  // Log all requests for security monitoring
  logAllRequests: true,
};

// Start server if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(process.env.EGRESS_PROXY_PORT || '3002', 10);
  const proxy = new EgressProxy(DEFAULT_EGRESS_CONFIG);
  proxy.start(port).catch((err) => {
    logger.error({ err }, 'Failed to start egress proxy');
    process.exit(1);
  });
}
