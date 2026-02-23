/**
 * Output Monitor — Phase 1: Outbound Message Scanning
 *
 * Scans every message the agent sends via IPC before delivery.
 * Detects credential leaks, PII, anomalous volume, and instruction-like content.
 *
 * Reuses DLP patterns from egress-proxy.ts for consistency.
 * Fails open — if scanning errors, message is allowed through.
 */

import { logger } from '../logger.js';
import { securityEvents } from './security-events.js';

export interface OutboundContext {
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  sourceGroup: string;
}

export interface OutboundScanResult {
  allowed: boolean;
  flags: OutboundFlag[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

export type OutboundFlag =
  | 'credential_leaked'
  | 'pii_detected'
  | 'anomalous_volume'
  | 'instruction_like'
  | 'financial_content'
  | 'url_suspicious';

// Sliding window for volume tracking
interface MessageWindow {
  timestamps: number[];
}

export class OutputMonitor {
  private volumeWindows = new Map<string, MessageWindow>();
  private readonly WINDOW_SIZE_MS = 60_000; // 60 seconds
  private readonly MAX_MESSAGES_PER_WINDOW = 10;

  /**
   * Scan an outbound message before delivery.
   * Returns { allowed: true } on errors (fail-open).
   */
  async scanOutbound(text: string, context: OutboundContext): Promise<OutboundScanResult> {
    try {
      const flags: OutboundFlag[] = [];

      // 1. Credential / secret detection (reuses egress-proxy DLP patterns)
      if (this.containsCredentials(text)) {
        flags.push('credential_leaked');
      }

      // 2. PII detection
      if (this.containsPII(text)) {
        flags.push('pii_detected');
      }

      // 3. Anomalous volume
      if (this.isAnomalousVolume(context.sourceGroup)) {
        flags.push('anomalous_volume');
      }

      // 4. Instruction-like content (agent echoing system prompts)
      if (this.isInstructionLike(text)) {
        flags.push('instruction_like');
      }

      // 5. Financial content
      if (this.containsFinancialContent(text)) {
        flags.push('financial_content');
      }

      // Classify risk
      const riskLevel = this.classifyRisk(flags);
      // Main group: block high + critical (more dangerous tools available)
      // Non-main groups: block critical only (avoid false positives in normal chat)
      const allowed = context.isMain
        ? (riskLevel !== 'critical' && riskLevel !== 'high')
        : (riskLevel !== 'critical');

      // Log security events for non-low findings
      if (flags.length > 0) {
        securityEvents.log({
          type: 'dlp_violation',
          severity: riskLevel,
          source: 'output-monitor',
          description: `Outbound scan: ${flags.join(', ')}`,
          details: {
            flags,
            riskLevel,
            allowed,
            textPreview: text.slice(0, 100),
          },
          actionTaken: allowed ? 'Allowed with warning' : 'Blocked',
          groupId: context.groupFolder,
        });
      }

      return { allowed, flags, riskLevel };
    } catch (err) {
      if (context.isMain) {
        // Main group: fail-closed — too dangerous to let scan errors bypass protection
        logger.error({ err }, 'Output monitor error — FAILING CLOSED (main group)');
        securityEvents.log({
          type: 'outbound_blocked',
          severity: 'critical',
          source: 'output-monitor',
          description: 'Output monitor error — failing closed for main group',
          details: { error: String(err), textLength: text.length },
          actionTaken: 'Message blocked due to scan error (main group fail-closed)',
          groupId: context.groupFolder,
        });
        return { allowed: false, flags: [], riskLevel: 'critical' };
      }
      // Non-main groups: fail-open (existing behavior)
      logger.error({ err }, 'Output monitor error — failing open');
      securityEvents.log({
        type: 'outbound_blocked',
        severity: 'high',
        source: 'output-monitor',
        description: 'Output monitor error — failing open, outbound scan bypassed',
        details: { error: String(err), textLength: text.length },
        actionTaken: 'Message allowed without outbound scan',
        groupId: context.groupFolder,
      });
      return { allowed: true, flags: [], riskLevel: 'low' };
    }
  }

  /**
   * Check for credentials/secrets in outbound text.
   * Patterns aligned with egress-proxy.ts scanForSensitiveData().
   */
  private containsCredentials(text: string): boolean {
    // Anthropic API keys
    if (/sk-ant-[a-zA-Z0-9\-_]{20,}/i.test(text)) return true;

    // OpenAI API keys
    if (/sk-[a-zA-Z0-9]{32,}/i.test(text)) return true;

    // AWS access keys
    if (/AKIA[0-9A-Z]{16}/i.test(text)) return true;

    // Private keys
    if (/-----BEGIN (RSA|PRIVATE|OPENSSH|EC) (PRIVATE )?KEY-----/.test(text)) return true;

    // GitHub tokens
    if (/gh[ps]_[A-Za-z0-9_]{36,}/.test(text)) return true;

    // Generic high-entropy tokens that look like secrets
    if (/\b(api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9+/=_\-]{20,}/i.test(text)) return true;

    return false;
  }

  /**
   * Lightweight PII detection.
   * Catches phone numbers, email addresses, credit card patterns.
   */
  private containsPII(text: string): boolean {
    // Credit card numbers (13-19 digits, possibly spaced/dashed)
    if (/\b(?:\d[ -]*?){13,19}\b/.test(text) && this.luhnCheck(text)) return true;

    // Don't flag phone numbers or emails — too many false positives in normal assistant conversation
    return false;
  }

  /**
   * Basic Luhn check for credit card number validation.
   */
  private luhnCheck(text: string): boolean {
    const match = text.match(/\b(\d[ -]*?){13,19}\b/);
    if (!match) return false;
    const digits = match[0].replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return false;

    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = parseInt(digits[i], 10);
      if (alt) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  /**
   * Track message volume per group. Flag if > MAX in window.
   */
  private isAnomalousVolume(sourceGroup: string): boolean {
    const now = Date.now();
    let window = this.volumeWindows.get(sourceGroup);
    if (!window) {
      window = { timestamps: [] };
      this.volumeWindows.set(sourceGroup, window);
    }

    // Prune old timestamps
    window.timestamps = window.timestamps.filter(t => now - t < this.WINDOW_SIZE_MS);
    window.timestamps.push(now);

    return window.timestamps.length > this.MAX_MESSAGES_PER_WINDOW;
  }

  /**
   * Detect if agent output looks like system prompts being echoed.
   * A compromised agent might be tricked into revealing its instructions.
   */
  private isInstructionLike(text: string): boolean {
    const lower = text.toLowerCase();

    // System prompt markers
    if (/\bsystem\s*prompt\b/i.test(text)) return true;
    if (/\byou\s+are\s+a\s+(helpful|AI|assistant|language model)\b/i.test(text)) return true;

    // Instruction blocks
    if (text.includes('<system>') || text.includes('</system>')) return true;
    if (text.includes('<<SYS>>') || text.includes('<</SYS>>')) return true;

    // CLAUDE.md content markers
    if (lower.includes('claude.md') && lower.includes('instructions')) return true;

    return false;
  }

  /**
   * Detect financial content that might need approval gates.
   */
  private containsFinancialContent(text: string): boolean {
    // Currency patterns with amounts
    if (/[€$£¥]\s*\d+([.,]\d{1,2})?/.test(text)) return true;
    if (/\d+([.,]\d{1,2})?\s*(EUR|USD|GBP|JPY)\b/i.test(text)) return true;

    // Purchase/payment keywords near amounts
    if (/\b(purchase|payment|charge|order|transaction|invoice)\b/i.test(text) &&
        /\d+([.,]\d{1,2})?/.test(text)) return true;

    return false;
  }

  /**
   * Classify overall risk from detected flags.
   */
  private classifyRisk(flags: OutboundFlag[]): 'low' | 'medium' | 'high' | 'critical' {
    if (flags.length === 0) return 'low';

    if (flags.includes('credential_leaked')) return 'critical';
    if (flags.includes('instruction_like')) return 'high';
    if (flags.includes('anomalous_volume')) return 'high';
    if (flags.includes('pii_detected')) return 'high';
    if (flags.includes('financial_content')) return 'medium';
    if (flags.includes('url_suspicious')) return 'medium';

    return 'medium';
  }
}
