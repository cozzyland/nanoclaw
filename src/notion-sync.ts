import fs from 'fs';
import path from 'path';

import {
  getDb,
  upsertParaCache,
  clearParaCache,
  insertRelationCache,
  clearRelationCache,
  upsertDailyPageCache,
  clearDailyPagesCache,
  logNotionSync,
  pruneSyncLog,
  setRouterState,
  getRouterState,
  type ParaCacheRow,
  type DailyPageCacheRow,
  getAllParaCache,
  getDailyPagesCache,
} from './db.js';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { generateAnalytics } from './analytics-queries.js';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const RATE_LIMIT_MS = 350;
const MAX_RETRIES = 5;
const MIN_RETRY_SECONDS = 1;
const MAX_RETRY_SECONDS = 120;

const DB_IDS = {
  tasks: '202327f4955881b1a00aca5d9300f666',
  para: '202327f4955881d7bcbcf751c52783f9',
  notes: '202327f495588106a2eee5d2ebd7704c',
  content: '202327f49558819ca92ee4e6bff6ef76',
  daily_pages: '202327f4955881f3bb30cfdc96313d96',
} as const;

interface NotionPage {
  id: string;
  properties: Record<string, unknown>;
}

interface NotionQueryResult {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

function getNotionToken(): string {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error('NOTION_TOKEN not set');
  return token;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function notionFetch(
  endpoint: string,
  body?: object,
  attempt = 0,
): Promise<unknown> {
  const token = getNotionToken();
  const res = await fetch(`${NOTION_API}${endpoint}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 429) {
    if (attempt >= MAX_RETRIES) {
      throw new Error(`Notion API: max retries (${MAX_RETRIES}) exceeded on 429`);
    }
    const raw = parseInt(res.headers.get('Retry-After') || '2', 10);
    const retryAfter = Math.max(MIN_RETRY_SECONDS, Math.min(isNaN(raw) ? 2 : raw, MAX_RETRY_SECONDS));
    logger.warn({ retryAfter, attempt: attempt + 1, maxRetries: MAX_RETRIES }, 'Notion rate limited, backing off');
    await sleep(retryAfter * 1000);
    return notionFetch(endpoint, body, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API ${res.status}: ${text}`);
  }

  return res.json();
}

async function queryNotionDb(
  dbId: string,
  filter?: object,
  startCursor?: string,
): Promise<NotionQueryResult> {
  const body: Record<string, unknown> = { page_size: 100 };
  if (filter) body.filter = filter;
  if (startCursor) body.start_cursor = startCursor;
  return (await notionFetch(
    `/databases/${dbId}/query`,
    body,
  )) as NotionQueryResult;
}

async function queryAllPages(
  dbId: string,
  filter?: object,
): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let cursor: string | undefined;

  do {
    const result = await queryNotionDb(dbId, filter, cursor);
    pages.push(...result.results);
    cursor = result.has_more ? (result.next_cursor ?? undefined) : undefined;
    if (cursor) await sleep(RATE_LIMIT_MS);
  } while (cursor);

  return pages;
}

// --- Property extractors ---

function getTitle(props: Record<string, unknown>): string {
  const titleProp = Object.values(props).find(
    (p: unknown) => (p as { type?: string }).type === 'title',
  ) as { title?: Array<{ plain_text: string }> } | undefined;
  return titleProp?.title?.map((t) => t.plain_text).join('') || '';
}

function getSelect(
  props: Record<string, unknown>,
  name: string,
): string | null {
  const prop = props[name] as { select?: { name: string } | null } | undefined;
  return prop?.select?.name ?? null;
}

function getDate(
  props: Record<string, unknown>,
  name: string,
): string | null {
  const prop = props[name] as { date?: { start: string } | null } | undefined;
  return prop?.date?.start ?? null;
}

function getNumber(
  props: Record<string, unknown>,
  name: string,
): number | null {
  const prop = props[name] as { number?: number | null } | undefined;
  return prop?.number ?? null;
}

function getCheckbox(
  props: Record<string, unknown>,
  name: string,
): number {
  const prop = props[name] as { checkbox?: boolean } | undefined;
  return prop?.checkbox ? 1 : 0;
}

function getRelationIds(
  props: Record<string, unknown>,
  name: string,
): string[] {
  const prop = props[name] as { relation?: Array<{ id: string }> } | undefined;
  return prop?.relation?.map((r) => r.id) ?? [];
}

function getMultiSelect(
  props: Record<string, unknown>,
  name: string,
): string[] {
  const prop = props[name] as {
    multi_select?: Array<{ name: string }>;
  } | undefined;
  return prop?.multi_select?.map((s) => s.name) ?? [];
}

function getRichText(
  props: Record<string, unknown>,
  name: string,
): string | null {
  const prop = props[name] as {
    rich_text?: Array<{ plain_text: string }>;
  } | undefined;
  const text = prop?.rich_text?.map((t) => t.plain_text).join('');
  return text || null;
}

/**
 * Full sync: clear caches and re-populate from Notion.
 * Wrapped in a transaction — on error, rolls back to previous state.
 */
export async function fullSync(): Promise<{
  paraCount: number;
  dailyPageCount: number;
  durationMs: number;
}> {
  const syncStatus = getRouterState('sync_status');
  if (syncStatus === 'syncing') {
    logger.warn('Full sync already in progress, skipping');
    return { paraCount: 0, dailyPageCount: 0, durationMs: 0 };
  }

  setRouterState('sync_status', 'syncing');
  const startTime = Date.now();

  try {
    // Fetch all data from Notion first (before touching the DB)
    logger.info('Starting Notion full sync — fetching PARA items');
    const paraPages = await queryAllPages(DB_IDS.para);

    logger.info('Fetching Daily Pages (last 30 days)');
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - 30);
    const sinceStr = sinceDate.toISOString().split('T')[0];
    const dailyPages = await queryAllPages(DB_IDS.daily_pages, {
      property: 'Date',
      date: { on_or_after: sinceStr },
    });

    // Now write to DB in a single transaction
    const db = getDb();
    const now = new Date().toISOString();

    const writeTransaction = db.transaction(() => {
      clearParaCache();
      clearRelationCache();
      clearDailyPagesCache();

      // PARA items
      for (const page of paraPages) {
        const p = page.properties;
        upsertParaCache({
          page_id: page.id,
          name: getTitle(p),
          category: getSelect(p, 'Category'),
          status: getSelect(p, 'Status'),
          deadline: getDate(p, 'Deadline'),
          parent_para_id: getRelationIds(p, 'PARA')[0] ?? null,
          task_count: getRelationIds(p, 'Tasks').length,
          note_count: getRelationIds(p, 'Notes').length,
          content_count: getRelationIds(p, 'Content').length,
          synced_at: now,
        });

        // Relations from PARA
        for (const targetId of getRelationIds(p, 'Tasks')) {
          insertRelationCache({
            source_db: 'para', source_page_id: page.id,
            target_db: 'tasks', target_page_id: targetId,
            relation_property: 'Tasks', synced_at: now,
          });
        }
        for (const targetId of getRelationIds(p, 'Notes')) {
          insertRelationCache({
            source_db: 'para', source_page_id: page.id,
            target_db: 'notes', target_page_id: targetId,
            relation_property: 'Notes', synced_at: now,
          });
        }
        for (const targetId of getRelationIds(p, 'Content')) {
          insertRelationCache({
            source_db: 'para', source_page_id: page.id,
            target_db: 'content', target_page_id: targetId,
            relation_property: 'Content', synced_at: now,
          });
        }
      }

      // Daily Pages
      for (const page of dailyPages) {
        const p = page.properties;
        upsertDailyPageCache({
          page_id: page.id,
          title: getTitle(p),
          date: getDate(p, 'Date') ?? '',
          mood_morning: getSelect(p, 'Mood Morning'),
          mood_evening: getSelect(p, 'Mood Evening'),
          wakefulness_morning: getSelect(p, 'Wakefulness Morning'),
          wakefulness_evening: getSelect(p, 'Wakefulness Evening'),
          concerta_mg: getNumber(p, 'Concerta (mg)'),
          pregabalin_mg: getNumber(p, 'Pregabalin (mg)'),
          caffeine_mg: getNumber(p, 'Caffeine(mg)'),
          creatine_mg: getNumber(p, 'Creatine (mg)'),
          alcohol_units: getNumber(p, 'Alchohol (Units)'),
          sleepies: getNumber(p, 'Sleepies'),
          micro_d: getCheckbox(p, 'MicroD'),
          prayer: getCheckbox(p, 'Prayer'),
          rosary: getCheckbox(p, 'Rosary'),
          mass: getCheckbox(p, 'Mass'),
          theological_reflections: getCheckbox(p, 'Theological Reflections'),
          piano: getCheckbox(p, 'Piano'),
          b2b: getCheckbox(p, 'B2B'),
          ate_healthy: getCheckbox(p, 'Ate healthy'),
          workout: JSON.stringify(getMultiSelect(p, 'Workout')),
          time_asleep: getRichText(p, 'Time asleep'),
          deep_sleep: getRichText(p, 'Deep sleep'),
          awake: getRichText(p, 'Awake'),
          night_wakings: getNumber(p, 'Night wakings'),
          lights_out: getRichText(p, 'Lights Out'),
          sleep_good: getCheckbox(p, 'Sleep (Note: Good)'),
          sleep_bad: getCheckbox(p, 'Sleep (Note: Bad)'),
          angry_outburst: getCheckbox(p, 'Angry Outburst'),
          fionn_woke: getCheckbox(p, 'Fionn Woke'),
          midnight_snack: getCheckbox(p, 'Midnight Snack'),
          too_late_to_bed: getCheckbox(p, 'Too late to bed'),
          headache: JSON.stringify(getMultiSelect(p, 'Headache')),
          win: getRichText(p, 'Win'),
          tasks_done: 0,
          tasks_total: getRelationIds(p, 'Tasks').length,
          synced_at: now,
        });

        // Daily Page → PARA relations
        for (const targetId of getRelationIds(p, 'PARA')) {
          insertRelationCache({
            source_db: 'daily_pages', source_page_id: page.id,
            target_db: 'para', target_page_id: targetId,
            relation_property: 'PARA', synced_at: now,
          });
        }
      }
    });

    writeTransaction();

    const durationMs = Date.now() - startTime;
    setRouterState('sync_status', 'complete');
    setRouterState('last_sync', now);

    logNotionSync({
      direction: 'notion_to_local',
      operation: 'sync',
      notion_db: 'all',
      trigger_type: 'manual_sync',
      details: JSON.stringify({
        paraCount: paraPages.length,
        dailyPageCount: dailyPages.length,
        durationMs,
      }),
    });

    // Prune old sync logs (90 day retention)
    const pruned = pruneSyncLog(90);
    if (pruned > 0) logger.info({ pruned }, 'Pruned old sync log entries');

    logger.info(
      { paraCount: paraPages.length, dailyPageCount: dailyPages.length, durationMs },
      'Notion full sync complete',
    );

    return {
      paraCount: paraPages.length,
      dailyPageCount: dailyPages.length,
      durationMs,
    };
  } catch (err) {
    setRouterState('sync_status', 'failed');
    logNotionSync({
      direction: 'notion_to_local',
      operation: 'sync',
      notion_db: 'all',
      trigger_type: 'manual_sync',
      status: 'error',
      error_message: err instanceof Error ? err.message : String(err),
    });
    logger.error({ err }, 'Notion full sync failed');
    throw err;
  }
}

/**
 * Write cache data as JSON snapshots for the container to read.
 * Written to the group's IPC directory before container spawn.
 */
export function writeCacheSnapshot(groupFolder: string): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const paraItems = getAllParaCache();
  const dailyPages = getDailyPagesCache(30);
  const syncStatus = getRouterState('sync_status') ?? 'unknown';
  const lastSync = getRouterState('last_sync') ?? null;

  const cacheSnapshot = {
    syncStatus,
    lastSync,
    paraItems,
    dailyPages,
    generatedAt: new Date().toISOString(),
  };

  const snapshotPath = path.join(groupIpcDir, 'notion_cache.json');
  const tmpPath = `${snapshotPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(cacheSnapshot, null, 2));
  fs.renameSync(tmpPath, snapshotPath);

  // Write pre-computed analytics
  const analytics = generateAnalytics();
  const analyticsPath = path.join(groupIpcDir, 'analytics_cache.json');
  const analyticsTmpPath = `${analyticsPath}.tmp`;
  fs.writeFileSync(analyticsTmpPath, JSON.stringify(analytics, null, 2));
  fs.renameSync(analyticsTmpPath, analyticsPath);
}
