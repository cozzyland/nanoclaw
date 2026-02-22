/**
 * Centralized Security Event Logging
 *
 * Collects security events from all layers:
 * - Prompt injection attempts (Phase 1)
 * - Credential proxy access (Phase 2)
 * - Container security violations (Phase 3)
 * - WhatsApp abuse (Phase 4)
 * - Network exfiltration attempts (Phase 5)
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';

export type SecurityEventType =
  | 'prompt_injection'
  | 'rate_limit_exceeded'
  | 'unauthorized_sender'
  | 'media_file_rejected'
  | 'session_security'
  | 'credential_access'
  | 'egress_blocked'
  | 'dlp_violation'
  | 'high_risk_command'
  | 'message_sanitized'
  | 'outbound_blocked'
  | 'approval_requested'
  | 'memory_tampering'
  | 'canary_triggered'
  | 'malware_detected';

export type SecuritySeverity = 'low' | 'medium' | 'high' | 'critical';

export interface SecurityEvent {
  timestamp: string;
  type: SecurityEventType;
  severity: SecuritySeverity;
  source: string;          // Which layer detected it
  description: string;
  details?: Record<string, any>;
  actionTaken?: string;    // What was done (blocked, logged, etc.)
  groupId?: string;        // Which group/container
  userId?: string;         // WhatsApp sender ID
}

class SecurityEventLogger {
  private events: SecurityEvent[] = [];
  private maxEvents = 10000; // Keep last 10k events in memory
  private logFilePath?: string;

  constructor(logFilePath?: string) {
    this.logFilePath = logFilePath;

    // Ensure log directory exists
    if (logFilePath) {
      const dir = path.dirname(logFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    // Load only recent events from file (last 30 days) to avoid unbounded memory usage
    if (logFilePath && fs.existsSync(logFilePath)) {
      try {
        const data = fs.readFileSync(logFilePath, 'utf-8');
        const lines = data.trim().split('\n').filter(Boolean);
        const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
        this.events = lines
          .map(line => { try { return JSON.parse(line); } catch { return null; } })
          .filter((e): e is SecurityEvent =>
            e !== null && new Date(e.timestamp).getTime() > cutoff
          );
        logger.info({ loaded: this.events.length, total: lines.length }, 'Loaded recent security events');
      } catch (err) {
        logger.error({ err }, 'Failed to load existing security events');
      }
    }
  }

  /**
   * Log a security event
   */
  log(event: Omit<SecurityEvent, 'timestamp'>): void {
    const fullEvent: SecurityEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };

    // Add to in-memory array
    this.events.push(fullEvent);

    // Trim to max size
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }

    // Write to file (append-only)
    if (this.logFilePath) {
      try {
        fs.appendFileSync(
          this.logFilePath,
          JSON.stringify(fullEvent) + '\n',
          'utf-8'
        );
      } catch (err) {
        logger.error({ err }, 'Failed to write security event to file');
      }
    }

    // Also log to main logger
    const logLevel = event.severity === 'critical' ? 'error' :
                     event.severity === 'high' ? 'warn' :
                     event.severity === 'medium' ? 'info' : 'debug';

    logger[logLevel](
      {
        type: event.type,
        source: event.source,
        severity: event.severity,
        ...event.details,
      },
      `🔒 SECURITY: ${event.description}`
    );
  }

  /**
   * Get recent security events
   */
  getRecent(limit = 100, filters?: {
    type?: SecurityEventType;
    severity?: SecuritySeverity;
    source?: string;
    groupId?: string;
  }): SecurityEvent[] {
    let filtered = this.events;

    if (filters) {
      if (filters.type) {
        filtered = filtered.filter(e => e.type === filters.type);
      }
      if (filters.severity) {
        filtered = filtered.filter(e => e.severity === filters.severity);
      }
      if (filters.source) {
        filtered = filtered.filter(e => e.source === filters.source);
      }
      if (filters.groupId) {
        filtered = filtered.filter(e => e.groupId === filters.groupId);
      }
    }

    return filtered.slice(-limit);
  }

  /**
   * Get security metrics
   */
  getMetrics(timeWindowMs = 24 * 60 * 60 * 1000): {
    total: number;
    bySeverity: Record<SecuritySeverity, number>;
    byType: Record<string, number>;
    bySource: Record<string, number>;
    topGroups: Array<{ groupId: string; count: number }>;
  } {
    const cutoff = Date.now() - timeWindowMs;
    const recent = this.events.filter(
      e => new Date(e.timestamp).getTime() > cutoff
    );

    const bySeverity: Record<SecuritySeverity, number> = {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    };

    const byType: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    const groupCounts: Record<string, number> = {};

    for (const event of recent) {
      bySeverity[event.severity]++;
      byType[event.type] = (byType[event.type] || 0) + 1;
      bySource[event.source] = (bySource[event.source] || 0) + 1;

      if (event.groupId) {
        groupCounts[event.groupId] = (groupCounts[event.groupId] || 0) + 1;
      }
    }

    const topGroups = Object.entries(groupCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([groupId, count]) => ({ groupId, count }));

    return {
      total: recent.length,
      bySeverity,
      byType,
      bySource,
      topGroups,
    };
  }

  /**
   * Get critical alerts (events that need immediate attention)
   */
  getCriticalAlerts(limit = 20): SecurityEvent[] {
    return this.events
      .filter(e => e.severity === 'critical')
      .slice(-limit);
  }

  /**
   * Check if there's been unusual activity
   */
  detectAnomalies(timeWindowMs = 60 * 60 * 1000): {
    suspicious: boolean;
    reasons: string[];
  } {
    const cutoff = Date.now() - timeWindowMs;
    const recent = this.events.filter(
      e => new Date(e.timestamp).getTime() > cutoff
    );

    const reasons: string[] = [];

    // Check for high event rate
    if (recent.length > 100) {
      reasons.push(`High security event rate: ${recent.length} events in last hour`);
    }

    // Check for critical events
    const criticalCount = recent.filter(e => e.severity === 'critical').length;
    if (criticalCount > 0) {
      reasons.push(`${criticalCount} critical security events detected`);
    }

    // Check for repeated failures from same group
    const groupCounts: Record<string, number> = {};
    for (const event of recent) {
      if (event.groupId) {
        groupCounts[event.groupId] = (groupCounts[event.groupId] || 0) + 1;
      }
    }

    for (const [groupId, count] of Object.entries(groupCounts)) {
      if (count > 20) {
        reasons.push(`Group ${groupId} has ${count} security events (possible attack)`);
      }
    }

    return {
      suspicious: reasons.length > 0,
      reasons,
    };
  }

  /**
   * Clear old events (for maintenance)
   */
  clearOldEvents(daysToKeep = 30): number {
    const cutoff = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
    const originalCount = this.events.length;

    this.events = this.events.filter(
      e => new Date(e.timestamp).getTime() > cutoff
    );

    const removed = originalCount - this.events.length;
    if (removed > 0) {
      logger.info({ removed, remaining: this.events.length }, 'Cleared old security events');
    }

    return removed;
  }
}

// Singleton instance — log stored outside project root to prevent container tampering
// Falls back to ~/Library/Logs/nanoclaw/ on macOS, ./data/ only if env var overrides
const defaultLogPath = process.platform === 'darwin'
  ? path.join(process.env.HOME || '/tmp', 'Library', 'Logs', 'nanoclaw', 'security-events.log')
  : './data/security-events.log';

export const securityEvents = new SecurityEventLogger(
  process.env.SECURITY_LOG_FILE || defaultLogPath
);

/**
 * Helper functions for common security events
 */

export function logPromptInjectionAttempt(details: {
  groupId: string;
  userId: string;
  message: string;
  detectedPattern?: string;
}) {
  securityEvents.log({
    type: 'prompt_injection',
    severity: 'high',
    source: 'phase1-prompt-defense',
    description: 'Possible prompt injection attempt detected',
    details,
    actionTaken: 'Message processed with sanitization',
    groupId: details.groupId,
    userId: details.userId,
  });
}

export function logRateLimitExceeded(details: {
  groupId: string;
  userId: string;
  limit: number;
}) {
  securityEvents.log({
    type: 'rate_limit_exceeded',
    severity: 'medium',
    source: 'phase4-whatsapp-hardening',
    description: 'User exceeded message rate limit',
    details,
    actionTaken: 'Messages dropped, user notified',
    groupId: details.groupId,
    userId: details.userId,
  });
}

export function logEgressBlocked(details: {
  groupId?: string;
  domain: string;
  path: string;
  reason: string;
}) {
  securityEvents.log({
    type: 'egress_blocked',
    severity: 'high',
    source: 'phase5-egress-filtering',
    description: `Blocked outbound request to ${details.domain}`,
    details,
    actionTaken: 'Request blocked with 403',
    groupId: details.groupId,
  });
}

export function logDLPViolation(details: {
  groupId?: string;
  domain: string;
  findings: string[];
}) {
  securityEvents.log({
    type: 'dlp_violation',
    severity: 'critical',
    source: 'phase5-egress-filtering',
    description: 'Data exfiltration attempt blocked (DLP)',
    details,
    actionTaken: 'Request blocked, sensitive data prevented from leaving',
    groupId: details.groupId,
  });
}

export function logHighRiskCommand(details: {
  groupId: string;
  command: string;
  riskLevel: string;
  reasons: string[];
}) {
  securityEvents.log({
    type: 'high_risk_command',
    severity: details.riskLevel === 'critical' ? 'critical' : 'high',
    source: 'phase1-command-checker',
    description: 'High-risk command detected',
    details,
    actionTaken: 'Command flagged for review',
    groupId: details.groupId,
  });
}
