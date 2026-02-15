/**
 * Sender Verification for WhatsApp Messages
 *
 * Controls which senders/groups are authorized to interact with the bot.
 *
 * Features:
 * - Allowlist/blocklist support
 * - Group-specific authorization
 * - Automatic allowlist from registered groups
 */

import { logger } from '../logger.js';

export interface SenderAuthConfig {
  // Explicit allowlist (phone numbers or group JIDs)
  allowlist?: string[];

  // Explicit blocklist (overrides allowlist)
  blocklist?: string[];

  // Allow all registered groups (default: true)
  allowRegisteredGroups?: boolean;

  // Allow messages from self (default: true)
  allowSelf?: boolean;
}

export class SenderVerification {
  private config: SenderAuthConfig;

  constructor(config: SenderAuthConfig = {}) {
    this.config = {
      allowRegisteredGroups: true,
      allowSelf: true,
      ...config,
    };
  }

  /**
   * Check if sender is authorized
   *
   * @param senderId WhatsApp JID of sender
   * @param chatJid WhatsApp JID of chat (could be group or individual)
   * @param isFromMe Whether message is from self
   * @param isRegisteredGroup Whether chat is a registered group
   * @returns Authorization result
   */
  isAuthorized(
    senderId: string,
    chatJid: string,
    isFromMe: boolean,
    isRegisteredGroup: boolean
  ): { authorized: boolean; reason?: string } {
    // Always allow own messages
    if (isFromMe && this.config.allowSelf) {
      return { authorized: true };
    }

    // Check blocklist first (highest priority)
    if (this.config.blocklist?.includes(senderId)) {
      logger.warn({ senderId, chatJid }, 'Sender is blocked');
      return {
        authorized: false,
        reason: 'Sender is blocked',
      };
    }

    // Check explicit allowlist
    if (this.config.allowlist?.includes(senderId)) {
      return { authorized: true };
    }

    // Check if chat is a registered group
    if (isRegisteredGroup && this.config.allowRegisteredGroups) {
      return { authorized: true };
    }

    // Default: deny
    logger.warn(
      { senderId, chatJid, isRegisteredGroup },
      'Sender not authorized - not in allowlist or registered group'
    );

    return {
      authorized: false,
      reason: 'Not authorized - only registered groups or allowlisted senders',
    };
  }

  /**
   * Add sender to allowlist
   */
  addToAllowlist(senderId: string): void {
    if (!this.config.allowlist) {
      this.config.allowlist = [];
    }
    if (!this.config.allowlist.includes(senderId)) {
      this.config.allowlist.push(senderId);
      logger.info({ senderId }, 'Added sender to allowlist');
    }
  }

  /**
   * Remove sender from allowlist
   */
  removeFromAllowlist(senderId: string): void {
    if (this.config.allowlist) {
      this.config.allowlist = this.config.allowlist.filter(id => id !== senderId);
      logger.info({ senderId }, 'Removed sender from allowlist');
    }
  }

  /**
   * Add sender to blocklist
   */
  addToBlocklist(senderId: string): void {
    if (!this.config.blocklist) {
      this.config.blocklist = [];
    }
    if (!this.config.blocklist.includes(senderId)) {
      this.config.blocklist.push(senderId);
      logger.info({ senderId }, 'Added sender to blocklist');
    }
  }

  /**
   * Remove sender from blocklist
   */
  removeFromBlocklist(senderId: string): void {
    if (this.config.blocklist) {
      this.config.blocklist = this.config.blocklist.filter(id => id !== senderId);
      logger.info({ senderId }, 'Removed sender from blocklist');
    }
  }

  /**
   * Get current config
   */
  getConfig(): SenderAuthConfig {
    return { ...this.config };
  }
}

/**
 * Default sender verification config
 *
 * By default:
 * - Allow all registered groups
 * - Allow own messages
 * - No explicit allowlist/blocklist (rely on group registration)
 */
export const DEFAULT_SENDER_CONFIG: SenderAuthConfig = {
  allowRegisteredGroups: true,
  allowSelf: true,
  allowlist: [],
  blocklist: [],
};
