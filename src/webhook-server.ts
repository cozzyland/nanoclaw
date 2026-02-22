import express from 'express';

import { MAIN_GROUP_FOLDER } from './config.js';
import { createTask, logNotionSync } from './db.js';
import { logger } from './logger.js';

const MAIN_JID = process.env.NANOCLAW_OWNER_JID || '';

export function startWebhookServer(
  port: number,
  secret: string,
  enqueueTask: (chatJid: string, taskId: string, fn: () => Promise<void>) => void,
  runTaskFn: (taskId: string) => Promise<void>,
): void {
  const app = express();
  app.use(express.json());

  app.post('/notion/inbox', (req, res) => {
    if (req.headers['x-webhook-secret'] !== secret) {
      return res.sendStatus(401);
    }

    const name =
      req.body?.data?.properties?.Name?.title?.[0]?.plain_text ||
      req.body?.data?.properties?.Name ||
      'unknown item';
    const notionPageId: string | undefined = req.body?.data?.id;

    const taskId = `webhook-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    createTask({
      id: taskId,
      group_folder: MAIN_GROUP_FOLDER,
      chat_jid: MAIN_JID,
      prompt: `A new item was just added to SB_Inbox: "${name}". Process it immediately following the Inbox Processing instructions in CLAUDE.md. Query SB_Inbox for this item and any other unprocessed items, then triage them. Use mcp__nanoclaw__send_message to report what you processed.`,
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
