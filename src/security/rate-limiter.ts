/**
 * Rate Limiter for WhatsApp Messages
 *
 * Prevents spam, flood attacks, and abuse by limiting message rate per sender.
 *
 * Features:
 * - Per-sender rate limiting
 * - Sliding window algorithm
 * - Configurable limits
 * - Automatic cleanup of old entries
 */

import { logger } from '../logger.js';

export interface RateLimitConfig {
  maxMessages: number;      // Max messages allowed
  windowMs: number;          // Time window in milliseconds
  blockDurationMs?: number;  // How long to block after exceeding (optional)
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
  blockedUntil?: number;  // Temporary block timestamp
}

export class RateLimiter {
  private limits = new Map<string, RateLimitEntry>();
  private config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = config;

    // Cleanup old entries every 5 minutes
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /**
   * Check if sender is allowed to send a message
   *
   * @param senderId Unique identifier for sender (WhatsApp JID)
   * @returns true if allowed, false if rate limited
   */
  check(senderId: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    const entry = this.limits.get(senderId);

    // Check if sender is temporarily blocked
    if (entry?.blockedUntil && now < entry.blockedUntil) {
      const remainingBlock = Math.ceil((entry.blockedUntil - now) / 1000);
      logger.warn(
        { senderId, remainingBlock },
        'Sender temporarily blocked due to rate limit violation'
      );
      return {
        allowed: false,
        remaining: 0,
        resetAt: entry.blockedUntil,
      };
    }

    // Initialize or reset window
    if (!entry || now > entry.resetAt) {
      this.limits.set(senderId, {
        count: 1,
        resetAt: now + this.config.windowMs,
      });
      return {
        allowed: true,
        remaining: this.config.maxMessages - 1,
        resetAt: now + this.config.windowMs,
      };
    }

    // Check if limit exceeded
    if (entry.count >= this.config.maxMessages) {
      // Apply temporary block if configured
      if (this.config.blockDurationMs) {
        entry.blockedUntil = now + this.config.blockDurationMs;
        logger.warn(
          {
            senderId,
            count: entry.count,
            limit: this.config.maxMessages,
            blockDuration: this.config.blockDurationMs / 1000,
          },
          'Rate limit exceeded - applying temporary block'
        );
      } else {
        logger.warn(
          {
            senderId,
            count: entry.count,
            limit: this.config.maxMessages,
          },
          'Rate limit exceeded'
        );
      }

      return {
        allowed: false,
        remaining: 0,
        resetAt: entry.resetAt,
      };
    }

    // Increment count
    entry.count++;

    return {
      allowed: true,
      remaining: this.config.maxMessages - entry.count,
      resetAt: entry.resetAt,
    };
  }

  /**
   * Get rate limit stats for a sender
   */
  getStats(senderId: string): {
    count: number;
    limit: number;
    remaining: number;
    resetAt: number;
    isBlocked: boolean;
  } | null {
    const entry = this.limits.get(senderId);
    if (!entry) return null;

    const now = Date.now();
    const isBlocked = !!(entry.blockedUntil && now < entry.blockedUntil);

    return {
      count: entry.count,
      limit: this.config.maxMessages,
      remaining: Math.max(0, this.config.maxMessages - entry.count),
      resetAt: isBlocked ? entry.blockedUntil! : entry.resetAt,
      isBlocked,
    };
  }

  /**
   * Manually reset rate limit for a sender
   */
  reset(senderId: string): void {
    this.limits.delete(senderId);
    logger.info({ senderId }, 'Rate limit reset for sender');
  }

  /**
   * Clean up expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [senderId, entry] of this.limits.entries()) {
      // Remove if window expired and not blocked
      if (now > entry.resetAt && (!entry.blockedUntil || now > entry.blockedUntil)) {
        this.limits.delete(senderId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug({ cleaned, remaining: this.limits.size }, 'Cleaned up expired rate limit entries');
    }
  }

  /**
   * Get total number of tracked senders
   */
  size(): number {
    return this.limits.size;
  }
}

/**
 * Default rate limit configurations for different scenarios
 */
export const RATE_LIMIT_PRESETS = {
  // Conservative: For untrusted groups
  strict: {
    maxMessages: 10,
    windowMs: 60 * 1000,      // 10 messages per minute
    blockDurationMs: 5 * 60 * 1000,  // 5 minute block
  },

  // Standard: For regular groups
  normal: {
    maxMessages: 20,
    windowMs: 60 * 1000,      // 20 messages per minute
    blockDurationMs: 2 * 60 * 1000,  // 2 minute block
  },

  // Relaxed: For trusted users (main group)
  relaxed: {
    maxMessages: 50,
    windowMs: 60 * 1000,      // 50 messages per minute
    blockDurationMs: undefined,  // No temporary block
  },
};
