import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  WASocket,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import { STORE_DIR } from '../config.js';
import {
  getLastGroupSync,
  setLastGroupSync,
  updateChatName,
} from '../db.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';
import { RateLimiter, RATE_LIMIT_PRESETS } from '../security/rate-limiter.js';
import { SenderVerification, DEFAULT_SENDER_CONFIG } from '../security/sender-verification.js';
import { MediaValidator, DEFAULT_MEDIA_CONFIG } from '../security/media-validator.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Sanitize incoming message content to prevent prompt injection attacks.
 *
 * Defenses:
 * - Remove control characters (could break parsing)
 * - Normalize Unicode (prevent lookalike attacks)
 * - Limit message length (prevent resource exhaustion)
 * - Strip null bytes (could cause parser issues)
 *
 * @param text Raw message content
 * @returns Sanitized message content
 */
function sanitizeMessageContent(text: string): string {
  if (!text) return '';

  // Remove control characters (0x00-0x1F, 0x7F) except newlines/tabs
  // Preserves: \n (0x0A), \r (0x0D), \t (0x09)
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Normalize Unicode to NFKC (prevents lookalike character attacks)
  // Example: Cyrillic 'а' (U+0430) normalizes differently than Latin 'a' (U+0061)
  text = text.normalize('NFKC');

  // Limit message length to prevent resource exhaustion
  const MAX_MESSAGE_LENGTH = 10000;
  if (text.length > MAX_MESSAGE_LENGTH) {
    logger.warn({ originalLength: text.length }, 'Message truncated due to length');
    text = text.substring(0, MAX_MESSAGE_LENGTH) + '\n\n[Message truncated - exceeded 10,000 characters]';
  }

  // Strip null bytes (can cause issues in C-based parsers)
  text = text.replace(/\0/g, '');

  // Log if sanitization made changes (potential attack attempt)
  const changed = text !== arguments[0];
  if (changed) {
    logger.warn({ originalLength: arguments[0]?.length, newLength: text.length }, 'Message content was sanitized');
  }

  return text;
}

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';
  prefixAssistantName = true;

  private sock!: WASocket;
  private connected = false;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;

  private opts: WhatsAppChannelOpts;

  // Phase 4: WhatsApp Security
  private rateLimiter = new RateLimiter(RATE_LIMIT_PRESETS.normal);
  private senderVerification = new SenderVerification(DEFAULT_SENDER_CONFIG);
  private mediaValidator = new MediaValidator(DEFAULT_MEDIA_CONFIG);

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectInternal(resolve).catch(reject);
    });
  }

  private async connectInternal(onFirstOpen?: () => void): Promise<void> {
    const authDir = path.join(STORE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Chrome'),
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const msg =
          'WhatsApp authentication required. Run /setup in Claude Code.';
        logger.error(msg);
        exec(
          `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
        );
        setTimeout(() => process.exit(1), 1000);
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;

        // Phase 4: Session Security Monitoring
        // Log connection failures for security analysis
        if (reason === DisconnectReason.loggedOut) {
          logger.error(
            { reason: 'LOGGED_OUT' },
            '🔒 SECURITY: WhatsApp session logged out - possible session hijacking or manual logout'
          );
        } else if (reason === DisconnectReason.badSession) {
          logger.error(
            { reason: 'BAD_SESSION' },
            '🔒 SECURITY: WhatsApp bad session - possible session tampering'
          );
        } else if (reason === DisconnectReason.connectionLost) {
          logger.warn(
            { reason: 'CONNECTION_LOST' },
            'WhatsApp connection lost - network issue or service restart'
          );
        }

        logger.info({ reason, shouldReconnect, queuedMessages: this.outgoingQueue.length }, 'Connection closed');

        if (shouldReconnect) {
          logger.info('Reconnecting...');
          this.connectInternal().catch((err) => {
            logger.error({ err }, 'Failed to reconnect, retrying in 5s');
            setTimeout(() => {
              this.connectInternal().catch((err2) => {
                logger.error({ err: err2 }, 'Reconnection retry failed');
              });
            }, 5000);
          });
        } else {
          logger.info('Logged out. Run /setup to re-authenticate.');
          process.exit(0);
        }
      } else if (connection === 'open') {
        this.connected = true;

        // Phase 4: Session Security - Log successful connection
        logger.info(
          {
            userJid: this.sock.user?.id,
            lid: this.sock.user?.lid,
          },
          '✅ Connected to WhatsApp successfully'
        );

        // Build LID to phone mapping from auth state for self-chat translation
        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
            logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
          }
        }

        // Flush any messages queued while disconnected
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush outgoing queue'),
        );

        // Sync group metadata on startup (respects 24h cache)
        this.syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Initial group sync failed'),
        );
        // Set up daily sync timer (only once)
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch((err) =>
              logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }

        // Signal first connection to caller
        if (onFirstOpen) {
          onFirstOpen();
          onFirstOpen = undefined;
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message) continue;
        const rawJid = msg.key.remoteJid;
        if (!rawJid || rawJid === 'status@broadcast') continue;

        // Translate LID JID to phone JID if applicable
        const chatJid = await this.translateJid(rawJid);

        const timestamp = new Date(
          Number(msg.messageTimestamp) * 1000,
        ).toISOString();

        // Always notify about chat metadata for group discovery
        this.opts.onChatMetadata(chatJid, timestamp);

        // Only deliver full message for registered groups
        const groups = this.opts.registeredGroups();
        const isRegisteredGroup = !!groups[chatJid];

        if (isRegisteredGroup) {
          const sender = msg.key.participant || msg.key.remoteJid || '';
          const isFromMe = msg.key.fromMe || false;

          // Phase 4: Sender Verification
          // Check if sender is authorized (skip for own messages)
          if (!isFromMe) {
            const authCheck = this.senderVerification.isAuthorized(
              sender,
              chatJid,
              isFromMe,
              isRegisteredGroup
            );

            if (!authCheck.authorized) {
              logger.warn(
                { sender, chatJid, reason: authCheck.reason },
                'Message dropped: sender not authorized'
              );

              // Optionally send warning (disabled by default to avoid spam)
              // await this.sock.sendMessage(chatJid, {
              //   text: `⚠️ Unauthorized sender. This bot only responds to registered groups.`,
              // });

              continue; // Skip processing this message
            }
          }

          // Phase 4: Rate Limiting
          // Check if sender is rate limited (skip for own messages)
          if (!isFromMe) {
            const rateLimitCheck = this.rateLimiter.check(sender);
            if (!rateLimitCheck.allowed) {
              const resetIn = Math.ceil((rateLimitCheck.resetAt - Date.now()) / 1000);
              logger.warn(
                { sender, chatJid, resetIn },
                'Message dropped due to rate limit'
              );

              // Send rate limit warning to sender
              await this.sock.sendMessage(chatJid, {
                text: `⚠️ Rate limit exceeded. Please slow down. Try again in ${resetIn} seconds.`,
              });

              continue; // Skip processing this message
            }
          }

          // Phase 4: Media Validation
          // Validate media files if present
          if (msg.message && (msg.message.imageMessage || msg.message.videoMessage || msg.message.documentMessage)) {
            const imageMsg = msg.message.imageMessage;
            const videoMsg = msg.message.videoMessage;
            const docMsg = msg.message.documentMessage;

            const mediaMsg = imageMsg || videoMsg || docMsg;
            if (mediaMsg) {
              const fileName = docMsg?.fileName || undefined; // fileName only exists on documents
              const validation = this.mediaValidator.validate(
                mediaMsg.mimetype || 'application/octet-stream',
                Buffer.from(''), // We don't download the file yet, just check type
                fileName
              );

              if (!validation.valid) {
                logger.warn(
                  { sender, chatJid, reason: validation.reason },
                  'Media file rejected'
                );

                await this.sock.sendMessage(chatJid, {
                  text: `⚠️ Media file rejected: ${validation.reason}`,
                });

                continue; // Skip processing this message
              }
            }
          }

          const rawContent =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            '';

          // Sanitize message content to prevent prompt injection (Phase 1)
          const content = sanitizeMessageContent(rawContent);

          const senderName = msg.pushName || sender.split('@')[0];

          this.opts.onMessage(chatJid, {
            id: msg.key.id || '',
            chat_jid: chatJid,
            sender,
            sender_name: senderName,
            content,
            timestamp,
            is_from_me: isFromMe,
          });
        }
      }
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info({ jid, length: text.length, queueSize: this.outgoingQueue.length }, 'WA disconnected, message queued');
      return;
    }
    try {
      await this.sock.sendMessage(jid, { text });
      logger.info({ jid, length: text.length }, 'Message sent');
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text });
      logger.warn({ jid, err, queueSize: this.outgoingQueue.length }, 'Failed to send, message queued');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sock?.end(undefined);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      await this.sock.sendPresenceUpdate(isTyping ? 'composing' : 'paused', jid);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  /**
   * Sync group metadata from WhatsApp.
   * Fetches all participating groups and stores their names in the database.
   * Called on startup, daily, and on-demand via IPC.
   */
  async syncGroupMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping group sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing group metadata from WhatsApp...');
      const groups = await this.sock.groupFetchAllParticipating();

      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          updateChatName(jid, metadata.subject);
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];

    // Check local cache first
    const cached = this.lidToPhoneMap[lidUser];
    if (cached) {
      logger.debug({ lidJid: jid, phoneJid: cached }, 'Translated LID to phone JID (cached)');
      return cached;
    }

    // Query Baileys' signal repository for the mapping
    try {
      const pn = await this.sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.lidToPhoneMap[lidUser] = phoneJid;
        logger.info({ lidJid: jid, phoneJid }, 'Translated LID to phone JID (signalRepository)');
        return phoneJid;
      }
    } catch (err) {
      logger.debug({ err, jid }, 'Failed to resolve LID via signalRepository');
    }

    return jid;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info({ count: this.outgoingQueue.length }, 'Flushing outgoing message queue');
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        await this.sendMessage(item.jid, item.text);
      }
    } finally {
      this.flushing = false;
    }
  }
}
