import crypto from 'crypto';
import express from 'express';

import { MAIN_GROUP_FOLDER } from './config.js';
import { createTask, logNotionSync } from './db.js';
import { logger } from './logger.js';

const MAIN_JID = process.env.NANOCLAW_OWNER_JID || '';

// Simple in-memory rate limiter for webhook endpoint
const rateLimitWindow = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 10; // max requests per minute
const RATE_LIMIT_WINDOW_MS = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitWindow.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitWindow.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

/**
 * Sanitize a Notion page title for safe use in agent prompts.
 * Strips newlines, quotes, control chars, and truncates to prevent prompt injection.
 */
function sanitizePageTitle(raw: unknown): string {
  if (typeof raw !== 'string') return 'unknown item';
  return raw
    .replace(/[\n\r\t]/g, ' ')       // Replace newlines/tabs with spaces
    .replace(/["\\]/g, '')            // Strip quotes and backslashes
    .replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, '') // Strip control characters
    .trim()
    .slice(0, 200) || 'unknown item'; // Truncate to 200 chars
}

export function startWebhookServer(
  port: number,
  secret: string,
  enqueueTask: (chatJid: string, taskId: string, fn: () => Promise<void>) => void,
  runTaskFn: (taskId: string) => Promise<void>,
): void {
  if (!MAIN_JID) {
    throw new Error(
      'NANOCLAW_OWNER_JID is required to start webhook server (cannot route webhook tasks without owner chat JID)',
    );
  }

  const app = express();
  app.use(express.json({ limit: '16kb' })); // Webhook payloads are small

  app.post('/notion/inbox', (req, res) => {
    // Rate limiting
    const clientIp = req.ip || 'unknown';
    if (!checkRateLimit(clientIp)) {
      return res.sendStatus(429);
    }

    // Timing-safe secret comparison (prevents timing side-channel attacks)
    const headerValue = req.headers['x-webhook-secret'];
    if (
      typeof headerValue !== 'string' ||
      headerValue.length !== secret.length ||
      !crypto.timingSafeEqual(Buffer.from(headerValue), Buffer.from(secret))
    ) {
      return res.sendStatus(401);
    }

    const rawName =
      req.body?.data?.properties?.Name?.title?.[0]?.plain_text ||
      'unknown item';
    const name = sanitizePageTitle(rawName);
    const notionPageId: string | undefined = req.body?.data?.id;

    const taskId = `webhook-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    createTask({
      id: taskId,
      group_folder: MAIN_GROUP_FOLDER,
      chat_jid: MAIN_JID,
      prompt: `[SYSTEM INSTRUCTION: Process new SB_Inbox item per CLAUDE.md Inbox Processing instructions. Query SB_Inbox for this item and any other unprocessed items, then triage them. Use mcp__nanoclaw__send_message to report what you processed.]\n\n[ITEM TITLE]: ${name}`,
      schedule_type: 'once',
      schedule_value: new Date().toISOString(),
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: new Date().toISOString(),
      notion_page_id: notionPageId,
    });

    logNotionSync({
      direction: 'notion_to_local',
      operation: 'create',
      notion_db: 'inbox',
      notion_page_id: notionPageId,
      trigger_type: 'webhook',
      trigger_id: taskId,
      group_folder: MAIN_GROUP_FOLDER,
      details: JSON.stringify({ name }),
    });

    enqueueTask(MAIN_JID, taskId, () => runTaskFn(taskId));

    logger.info({ taskId, name, notionPageId }, 'Notion webhook received, task enqueued');
    res.sendStatus(200);
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.listen(port, '127.0.0.1', () => {
    logger.info({ port }, 'Webhook server listening');
  });
}
