import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  upsertParaCache,
  getAllParaCache,
  getActiveParaCache,
  clearParaCache,
  insertRelationCache,
  getRelationsForPage,
  clearRelationCache,
  upsertDailyPageCache,
  getDailyPagesCache,
  clearDailyPagesCache,
  logNotionSync,
  getSyncLog,
  pruneSyncLog,
  createTask,
  getTaskById,
  type ParaCacheRow,
  type DailyPageCacheRow,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// --- PARA Cache ---

function makeParaItem(overrides: Partial<ParaCacheRow> = {}): ParaCacheRow {
  return {
    page_id: 'para-1',
    name: 'Test Project',
    category: 'Project',
    status: 'Active',
    deadline: '2026-03-01',
    parent_para_id: null,
    task_count: 5,
    note_count: 3,
    content_count: 2,
    synced_at: '2026-02-22T00:00:00.000Z',
    ...overrides,
  };
}

describe('notion_para_cache', () => {
  it('upserts and retrieves PARA items', () => {
    upsertParaCache(makeParaItem());
    const items = getAllParaCache();
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('Test Project');
    expect(items[0].task_count).toBe(5);
  });

  it('updates existing item on upsert', () => {
    upsertParaCache(makeParaItem());
    upsertParaCache(makeParaItem({ name: 'Updated Project', task_count: 10 }));
    const items = getAllParaCache();
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('Updated Project');
    expect(items[0].task_count).toBe(10);
  });

  it('filters by active status', () => {
    upsertParaCache(makeParaItem({ page_id: 'p1', status: 'Active' }));
    upsertParaCache(makeParaItem({ page_id: 'p2', status: 'Archived', name: 'Old' }));
    upsertParaCache(makeParaItem({ page_id: 'p3', status: 'Active', name: 'Current' }));
    const active = getActiveParaCache();
    expect(active).toHaveLength(2);
  });

  it('clears all items', () => {
    upsertParaCache(makeParaItem({ page_id: 'p1' }));
    upsertParaCache(makeParaItem({ page_id: 'p2' }));
    clearParaCache();
    expect(getAllParaCache()).toHaveLength(0);
  });
});

// --- Relation Cache ---

describe('notion_relation_cache', () => {
  it('inserts and retrieves relations', () => {
    insertRelationCache({
      source_db: 'para',
      source_page_id: 'para-1',
      target_db: 'tasks',
      target_page_id: 'task-1',
      relation_property: 'Tasks',
      synced_at: '2026-02-22T00:00:00.000Z',
    });
    insertRelationCache({
      source_db: 'para',
      source_page_id: 'para-1',
      target_db: 'notes',
      target_page_id: 'note-1',
      relation_property: 'Notes',
      synced_at: '2026-02-22T00:00:00.000Z',
    });

    const rels = getRelationsForPage('para-1');
    expect(rels).toHaveLength(2);
    expect(rels.map((r) => r.target_db)).toContain('tasks');
    expect(rels.map((r) => r.target_db)).toContain('notes');
  });

  it('returns relations where page is target', () => {
    insertRelationCache({
      source_db: 'para',
      source_page_id: 'para-1',
      target_db: 'tasks',
      target_page_id: 'task-1',
      relation_property: 'Tasks',
      synced_at: '2026-02-22T00:00:00.000Z',
    });

    const rels = getRelationsForPage('task-1');
    expect(rels).toHaveLength(1);
    expect(rels[0].source_page_id).toBe('para-1');
  });

  it('clears all relations', () => {
    insertRelationCache({
      source_db: 'para',
      source_page_id: 'para-1',
      target_db: 'tasks',
      target_page_id: 'task-1',
      relation_property: 'Tasks',
      synced_at: '2026-02-22T00:00:00.000Z',
    });
    clearRelationCache();
    expect(getRelationsForPage('para-1')).toHaveLength(0);
  });
});

// --- Daily Pages Cache ---

function makeDailyPage(overrides: Partial<DailyPageCacheRow> = {}): DailyPageCacheRow {
  return {
    page_id: 'dp-1',
    title: 'Friday 21 February 2026',
    date: '2026-02-21',
    mood_morning: 'Good',
    mood_evening: 'Great',
    wakefulness_morning: 'Good',
    wakefulness_evening: 'Good',
    concerta_mg: 54,
    pregabalin_mg: null,
    caffeine_mg: 200,
    creatine_mg: 5,
    alcohol_units: 0,
    sleepies: null,
    micro_d: 0,
    prayer: 1,
    rosary: 0,
    mass: 0,
    theological_reflections: 0,
    piano: 1,
    b2b: 0,
    ate_healthy: 1,
    workout: '["Walk"]',
    time_asleep: '7h 30m',
    deep_sleep: '1h 45m',
    awake: '30m',
    night_wakings: 1,
    lights_out: '22:30',
    sleep_good: 1,
    sleep_bad: 0,
    angry_outburst: 0,
    fionn_woke: 0,
    midnight_snack: 0,
    too_late_to_bed: 0,
    headache: '[]',
    win: 'Finished the SQLite cache implementation',
    tasks_done: 5,
    tasks_total: 8,
    synced_at: '2026-02-22T00:00:00.000Z',
    ...overrides,
  };
}

describe('notion_daily_pages_cache', () => {
  it('upserts and retrieves daily pages', () => {
    upsertDailyPageCache(makeDailyPage());
    const pages = getDailyPagesCache();
    expect(pages).toHaveLength(1);
    expect(pages[0].mood_morning).toBe('Good');
    expect(pages[0].prayer).toBe(1);
    expect(pages[0].concerta_mg).toBe(54);
  });

  it('clears all daily pages', () => {
    upsertDailyPageCache(makeDailyPage());
    clearDailyPagesCache();
    expect(getDailyPagesCache()).toHaveLength(0);
  });
});

// --- Sync Log ---

describe('notion_sync_log', () => {
  it('logs and retrieves sync entries', () => {
    logNotionSync({
      direction: 'notion_to_local',
      operation: 'sync',
      notion_db: 'para',
      trigger_type: 'manual_sync',
    });
    logNotionSync({
      direction: 'local_to_notion',
      operation: 'create',
      notion_db: 'tasks',
      notion_page_id: 'task-abc',
      trigger_type: 'message',
      trigger_id: 'msg-123',
      group_folder: 'main',
    });

    const logs = getSyncLog();
    expect(logs).toHaveLength(2);
    expect(logs[0].direction).toBe('local_to_notion'); // most recent first
    expect(logs[0].notion_page_id).toBe('task-abc');
    expect(logs[1].direction).toBe('notion_to_local');
  });

  it('logs error entries', () => {
    logNotionSync({
      direction: 'notion_to_local',
      operation: 'sync',
      notion_db: 'all',
      trigger_type: 'manual_sync',
      status: 'error',
      error_message: 'Rate limited',
    });

    const logs = getSyncLog();
    expect(logs[0].status).toBe('error');
    expect(logs[0].error_message).toBe('Rate limited');
  });

  it('prunes old entries', () => {
    // Insert entries (current timestamp)
    logNotionSync({
      direction: 'notion_to_local',
      operation: 'sync',
      notion_db: 'all',
      trigger_type: 'manual_sync',
    });

    // Pruning entries older than 90 days should keep recent ones
    const pruned = pruneSyncLog(90);
    expect(pruned).toBe(0);
    expect(getSyncLog()).toHaveLength(1);
  });
});

// --- Task with notion_page_id ---

describe('task notion_page_id', () => {
  it('creates task with notion_page_id', () => {
    createTask({
      id: 'webhook-task-1',
      group_folder: 'main',
      chat_jid: 'owner@s.whatsapp.net',
      prompt: 'Process inbox item',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
      notion_page_id: 'abc-123-def',
    });

    const task = getTaskById('webhook-task-1');
    expect(task).toBeDefined();
    expect(task!.notion_page_id).toBe('abc-123-def');
  });

  it('creates task without notion_page_id', () => {
    createTask({
      id: 'normal-task',
      group_folder: 'main',
      chat_jid: 'owner@s.whatsapp.net',
      prompt: 'Regular task',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const task = getTaskById('normal-task');
    expect(task).toBeDefined();
    expect(task!.notion_page_id).toBeNull();
  });
});
