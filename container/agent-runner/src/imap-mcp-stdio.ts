/**
 * Read-only IMAP MCP Server for NanoClaw
 * Provides email reading tools via IMAP (Gmail, iCloud, etc.)
 * Parameterized by env vars: IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASS, IMAP_LABEL
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ImapFlow } from 'imapflow';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[imap-mcp] Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const IMAP_HOST = requireEnv('IMAP_HOST');
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993', 10);
const IMAP_USER = requireEnv('IMAP_USER');
const IMAP_PASS = requireEnv('IMAP_PASS');
const IMAP_LABEL = process.env.IMAP_LABEL || 'Email';

const MAX_BODY_LENGTH = 8000;

// Lazy singleton connection
let client: ImapFlow | null = null;

async function getClient(): Promise<ImapFlow> {
  if (client) return client;

  client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false,
    tls: { rejectUnauthorized: true },
  });

  await client.connect();
  return client;
}

async function withClient<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = await getClient();
  try {
    return await fn(c);
  } catch (err) {
    // Only reset on connection-level failures
    if (!c.usable) {
      client = null;
    }
    throw err;
  }
}

/**
 * Extract plain text body from a MIME message structure.
 * Handles multipart messages, base64, quoted-printable.
 */
function extractTextBody(bodyStructure: any, parts: Record<string, any>): string {
  // Direct text/plain
  if (bodyStructure.type === 'text/plain') {
    const partId = bodyStructure.part || '1';
    const content = parts[partId];
    if (content) return bufferToString(content);
  }

  // Multipart — recurse into child parts
  if (bodyStructure.childNodes) {
    // Prefer text/plain over text/html
    for (const child of bodyStructure.childNodes) {
      if (child.type === 'text/plain') {
        const partId = child.part || '1';
        const content = parts[partId];
        if (content) return bufferToString(content);
      }
    }
    // Fallback: strip HTML from text/html
    for (const child of bodyStructure.childNodes) {
      if (child.type === 'text/html') {
        const partId = child.part || '1';
        const content = parts[partId];
        if (content) return stripHtml(bufferToString(content));
      }
    }
    // Recurse deeper (e.g. multipart/mixed containing multipart/alternative)
    for (const child of bodyStructure.childNodes) {
      if (child.childNodes) {
        const result = extractTextBody(child, parts);
        if (result) return result;
      }
    }
  }

  // Single-part text/html fallback
  if (bodyStructure.type === 'text/html') {
    const partId = bodyStructure.part || '1';
    const content = parts[partId];
    if (content) return stripHtml(bufferToString(content));
  }

  return '';
}

function bufferToString(data: Buffer | string | unknown): string {
  if (Buffer.isBuffer(data)) return data.toString('utf-8');
  if (typeof data === 'string') return data;
  return String(data);
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatAddress(addr: any): string {
  if (!addr) return '';
  if (Array.isArray(addr)) {
    return addr.map(a => a.name ? `${a.name} <${a.address}>` : a.address).join(', ');
  }
  if (addr.name) return `${addr.name} <${addr.address}>`;
  return addr.address || String(addr);
}

/**
 * Collect part IDs for text/plain and text/html parts from a bodyStructure tree.
 */
function collectTextParts(structure: any): string[] {
  const parts: string[] = [];
  if (structure.type === 'text/plain' || structure.type === 'text/html') {
    parts.push(structure.part || '1');
  }
  if (structure.childNodes) {
    for (const child of structure.childNodes) {
      parts.push(...collectTextParts(child));
    }
  }
  return parts;
}

// --- MCP Server ---

const server = new McpServer({
  name: `nanoclaw-imap-${IMAP_LABEL.toLowerCase()}`,
  version: '1.0.0',
});

server.tool(
  'list_mailboxes',
  `List all mailboxes/folders in ${IMAP_LABEL}`,
  {},
  async () => {
    return withClient(async (c) => {
      const mailboxes = await c.list();
      const lines = mailboxes.map(m => {
        const flags = m.flags ? ` [${Array.from(m.flags).join(', ')}]` : '';
        return `- ${m.path}${flags}`;
      });
      return { content: [{ type: 'text' as const, text: lines.join('\n') || 'No mailboxes found.' }] };
    });
  },
);

server.tool(
  'search',
  `Search emails in ${IMAP_LABEL}. Returns matching message UIDs with date, from, and subject. Use unseen: true for unread messages only.`,
  {
    folder: z.string().default('INBOX').describe('Mailbox/folder to search (e.g. "INBOX", "[Gmail]/Sent Mail")'),
    from: z.string().optional().describe('Filter by sender address or name'),
    subject: z.string().optional().describe('Filter by subject text'),
    since: z.string().optional().describe('Messages since this date (YYYY-MM-DD)'),
    before: z.string().optional().describe('Messages before this date (YYYY-MM-DD)'),
    text: z.string().optional().describe('Full-text search in message body'),
    unseen: z.boolean().optional().describe('Only unread messages'),
    limit: z.number().default(20).describe('Max results to return'),
  },
  async (args) => {
    return withClient(async (c) => {
      const lock = await c.getMailboxLock(args.folder);
      try {
        // Build IMAP search query
        const query: Record<string, any> = {};
        if (args.from) query.from = args.from;
        if (args.subject) query.subject = args.subject;
        if (args.since) query.since = args.since;
        if (args.before) query.before = args.before;
        if (args.text) query.body = args.text;
        if (args.unseen) query.seen = false;

        // If no criteria, search all
        if (Object.keys(query).length === 0) query.all = true;

        const results: string[] = [];
        for await (const msg of c.fetch(query, { envelope: true, uid: true })) {
          if (results.length >= args.limit) break;
          const env = msg.envelope!;
          const from = formatAddress(env.from);
          const date = env.date ? env.date.toISOString().split('T')[0] : 'unknown';
          results.push(`UID ${msg.uid} | ${date} | ${from} | ${env.subject || '(no subject)'}`);
        }

        if (results.length === 0) {
          return { content: [{ type: 'text' as const, text: `No messages found in ${args.folder} matching criteria.` }] };
        }

        return { content: [{ type: 'text' as const, text: `Found ${results.length} message(s) in ${args.folder}:\n\n${results.join('\n')}` }] };
      } finally {
        lock.release();
      }
    });
  },
);

server.tool(
  'get_message',
  `Get full email content by UID from ${IMAP_LABEL}. Returns headers and text body (truncated at ${MAX_BODY_LENGTH} chars).`,
  {
    uid: z.number().describe('Message UID (from search results)'),
    folder: z.string().default('INBOX').describe('Mailbox/folder the message is in'),
  },
  async (args) => {
    return withClient(async (c) => {
      const lock = await c.getMailboxLock(args.folder);
      try {
        // Fetch envelope + bodyStructure (NOT source — avoids loading full email with attachments)
        const msg = await c.fetchOne(String(args.uid), {
          uid: true,
          envelope: true,
          bodyStructure: true,
        }, { uid: true });

        if (!msg || typeof msg === 'boolean') {
          return { content: [{ type: 'text' as const, text: `Message UID ${args.uid} not found in ${args.folder}.` }] };
        }

        const env = msg.envelope!;
        const headers = [
          `From: ${formatAddress(env.from)}`,
          `To: ${formatAddress(env.to)}`,
          env.cc ? `CC: ${formatAddress(env.cc)}` : null,
          `Date: ${env.date ? env.date.toISOString() : 'unknown'}`,
          `Subject: ${env.subject || '(no subject)'}`,
        ].filter(Boolean).join('\n');

        // Fetch text parts via bodyStructure (only text/plain and text/html, not attachments)
        let body = '';
        if (msg.bodyStructure) {
          const textParts = collectTextParts(msg.bodyStructure);
          if (textParts.length > 0) {
            // Batch all text part IDs into a single IMAP FETCH
            const partMsg = await c.fetchOne(String(args.uid), {
              uid: true,
              bodyParts: textParts,
            }, { uid: true });

            const parts: Record<string, any> = {};
            if (partMsg && typeof partMsg !== 'boolean') {
              const bodyParts = partMsg.bodyParts;
              if (bodyParts) {
                for (const partId of textParts) {
                  const data = bodyParts.get(partId);
                  if (data) parts[partId] = data;
                }
              }
            }
            body = extractTextBody(msg.bodyStructure, parts);
          }
        }

        if (body.length > MAX_BODY_LENGTH) {
          body = body.slice(0, MAX_BODY_LENGTH) + '\n\n[truncated]';
        }

        return { content: [{ type: 'text' as const, text: `${headers}\n\n---\n\n${body || '(no text body)'}` }] };
      } finally {
        lock.release();
      }
    });
  },
);

// Graceful IMAP shutdown on container exit
process.on('SIGTERM', async () => {
  if (client) {
    try { await client.logout(); } catch { /* ignore */ }
  }
  process.exit(0);
});

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
