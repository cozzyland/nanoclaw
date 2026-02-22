/**
 * Image OCR via Claude Vision (Haiku)
 *
 * Describes WhatsApp images using Claude's vision capability so Raiden
 * can act on image content (appointments, receipts, documents, etc.).
 *
 * Pattern mirrors src/transcription.ts: download → process → text.
 */

import Anthropic from '@anthropic-ai/sdk';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import type { WAMessage } from '@whiskeysockets/baileys';
import { logger } from './logger.js';

const MODEL = 'claude-haiku-4-5-20251001';

let client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (client) return client;
  // Prefer API key; fall back to OAuth token (same auth Claude Code uses)
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const authToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN;
  if (!apiKey && !authToken) return null;
  client = apiKey ? new Anthropic() : new Anthropic({ apiKey: undefined, authToken: authToken! });
  return client;
}

/** Check if a message contains an image */
export function isImageMessage(msg: WAMessage): boolean {
  return !!msg.message?.imageMessage;
}

/** Describe a WhatsApp image using Claude Vision */
export async function describeImage(
  msg: WAMessage,
  sock: { updateMediaMessage: any },
): Promise<string | null> {
  const anthropic = getClient();
  if (!anthropic) {
    logger.warn('No ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN — image OCR disabled');
    return null;
  }

  const buffer = await downloadMediaMessage(
    msg,
    'buffer',
    {},
    {
      logger: console as any,
      reuploadRequest: sock.updateMediaMessage,
    },
  ) as Buffer;

  if (!buffer || buffer.length === 0) {
    logger.error('Failed to download image');
    return null;
  }

  const mime = msg.message?.imageMessage?.mimetype || 'image/jpeg';
  const base64 = buffer.toString('base64');

  logger.info({ bytes: buffer.length, mime }, 'Sending image to Claude Vision');

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mime as any, data: base64 },
          },
          {
            type: 'text',
            text: 'Extract all text from this image verbatim. If it shows an appointment, event, or schedule, identify date, time, location, and details. Be concise.',
          },
        ],
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  if (!text) return null;

  logger.info({ length: text.length }, 'Image described');
  return text;
}
