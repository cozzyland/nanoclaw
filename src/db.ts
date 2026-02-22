import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, STORE_DIR } from './config.js';
import { NewMessage, RegisteredGroup, ScheduledTask, TaskRunLog } from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add notion_page_id column for bidirectional traceability (Phase 2)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN notion_page_id TEXT`);
  } catch {
    /* column already exists */
  }
  database.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_notion_page ON scheduled_tasks(notion_page_id)`);

  // Notion cache tables (Phase 1)
  database.exec(`
    CREATE TABLE IF NOT EXISTS notion_para_cache (
      page_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      status TEXT,
      deadline TEXT,
      parent_para_id TEXT,
      task_count INTEGER DEFAULT 0,
      note_count INTEGER DEFAULT 0,
      content_count INTEGER DEFAULT 0,
      synced_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_para_cache_status ON notion_para_cache(status);
    CREATE INDEX IF NOT EXISTS idx_para_cache_category ON notion_para_cache(category);

    CREATE TABLE IF NOT EXISTS notion_relation_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_db TEXT NOT NULL,
      source_page_id TEXT NOT NULL,
      target_db TEXT NOT NULL,
      target_page_id TEXT NOT NULL,
      relation_property TEXT NOT NULL,
      synced_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_relation_source ON notion_relation_cache(source_db, source_page_id);
    CREATE INDEX IF NOT EXISTS idx_relation_target ON notion_relation_cache(target_db, target_page_id);

    CREATE TABLE IF NOT EXISTS notion_daily_pages_cache (
      page_id TEXT PRIMARY KEY,
      title TEXT,
      date TEXT NOT NULL,
      mood_morning TEXT,
      mood_evening TEXT,
      wakefulness_morning TEXT,
      wakefulness_evening TEXT,
      concerta_mg REAL,
      pregabalin_mg REAL,
      caffeine_mg REAL,
      creatine_mg REAL,
      alcohol_units REAL,
      sleepies INTEGER,
      micro_d INTEGER DEFAULT 0,
      prayer INTEGER DEFAULT 0,
      rosary INTEGER DEFAULT 0,
      mass INTEGER DEFAULT 0,
      theological_reflections INTEGER DEFAULT 0,
      piano INTEGER DEFAULT 0,
      b2b INTEGER DEFAULT 0,
      ate_healthy INTEGER DEFAULT 0,
      workout TEXT,
      time_asleep TEXT,
      deep_sleep TEXT,
      awake TEXT,
      night_wakings INTEGER,
      lights_out TEXT,
      sleep_good INTEGER DEFAULT 0,
      sleep_bad INTEGER DEFAULT 0,
      angry_outburst INTEGER DEFAULT 0,
      fionn_woke INTEGER DEFAULT 0,
      midnight_snack INTEGER DEFAULT 0,
      too_late_to_bed INTEGER DEFAULT 0,
      headache TEXT,
      win TEXT,
      tasks_done INTEGER DEFAULT 0,
      tasks_total INTEGER DEFAULT 0,
      synced_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_daily_pages_date ON notion_daily_pages_cache(date);

    CREATE TABLE IF NOT EXISTS notion_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL,
      operation TEXT NOT NULL,
      notion_db TEXT NOT NULL,
      notion_page_id TEXT,
      trigger_type TEXT NOT NULL,
      trigger_id TEXT,
      group_folder TEXT,
      details TEXT,
      status TEXT NOT NULL DEFAULT 'success',
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sync_log_page ON notion_sync_log(notion_page_id);
    CREATE INDEX IF NOT EXISTS idx_sync_log_trigger ON notion_sync_log(trigger_type, trigger_id);
    CREATE INDEX IF NOT EXISTS idx_sync_log_created ON notion_sync_log(created_at);
  `);

  // Phase 2: Approval gate requests table
  database.exec(`
    CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      timeout_ms INTEGER NOT NULL DEFAULT 900000,
      status TEXT NOT NULL DEFAULT 'pending',
      responded_by TEXT,
      responded_at TEXT,
      context_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_requests(status);
    CREATE INDEX IF NOT EXISTS idx_approval_chat ON approval_requests(chat_jid, status);
  `);
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
): void {
  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, name, timestamp);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, chatJid, timestamp);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
  );
}

/**
 * Store a message directly (for non-WhatsApp channels that don't use Baileys proto).
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter out bot's own messages by checking content prefix (not is_from_me, since user shares the account)
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders}) AND content NOT LIKE ?
    ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
): NewMessage[] {
  // Filter out bot's own messages by checking content prefix
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND timestamp > ? AND content NOT LIKE ?
    ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`) as NewMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at, notion_page_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
    task.notion_page_id ?? null,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
  };
}

export function setRegisteredGroup(
  jid: string,
  group: RegisteredGroup,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db
    .prepare('SELECT * FROM registered_groups')
    .all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    };
  }
  return result;
}

// --- Approval request accessors (Phase 2: Approval Gate) ---

export interface ApprovalRequestRow {
  id: string;
  type: string;
  description: string;
  group_folder: string;
  chat_jid: string;
  requested_at: string;
  timeout_ms: number;
  status: string;
  responded_by: string | null;
  responded_at: string | null;
  context_json: string | null;
}

export function createApprovalRequest(request: {
  id: string;
  type: string;
  description: string;
  group_folder: string;
  chat_jid: string;
  requested_at: string;
  timeout_ms: number;
  status: string;
  context_json: string;
}): void {
  db.prepare(
    `INSERT INTO approval_requests (id, type, description, group_folder, chat_jid, requested_at, timeout_ms, status, context_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    request.id,
    request.type,
    request.description,
    request.group_folder,
    request.chat_jid,
    request.requested_at,
    request.timeout_ms,
    request.status,
    request.context_json,
  );
}

export function getPendingApprovals(chatJid: string): ApprovalRequestRow[] {
  return db
    .prepare(`SELECT * FROM approval_requests WHERE chat_jid = ? AND status = 'pending' ORDER BY requested_at`)
    .all(chatJid) as ApprovalRequestRow[];
}

export function resolveApproval(id: string, approved: boolean, respondedBy: string): void {
  db.prepare(
    `UPDATE approval_requests SET status = ?, responded_by = ?, responded_at = ? WHERE id = ?`,
  ).run(approved ? 'approved' : 'denied', respondedBy, new Date().toISOString(), id);
}

export function getExpiredApprovals(): ApprovalRequestRow[] {
  // Find pending requests where requested_at + timeout_ms < now
  return db
    .prepare(
      `SELECT * FROM approval_requests
       WHERE status = 'pending'
       AND datetime(requested_at, '+' || (timeout_ms / 1000) || ' seconds') < datetime('now')`,
    )
    .all() as ApprovalRequestRow[];
}

export function expireApproval(id: string): void {
  db.prepare(
    `UPDATE approval_requests SET status = 'expired' WHERE id = ? AND status = 'pending'`,
  ).run(id);
}

// --- Database accessor (for modules needing direct transactional access) ---

export function getDb(): Database.Database {
  return db;
}

// --- Notion cache: PARA items ---

export interface ParaCacheRow {
  page_id: string;
  name: string;
  category: string | null;
  status: string | null;
  deadline: string | null;
  parent_para_id: string | null;
  task_count: number;
  note_count: number;
  content_count: number;
  synced_at: string;
}

export function upsertParaCache(item: ParaCacheRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO notion_para_cache
     (page_id, name, category, status, deadline, parent_para_id, task_count, note_count, content_count, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    item.page_id, item.name, item.category, item.status, item.deadline,
    item.parent_para_id, item.task_count, item.note_count, item.content_count, item.synced_at,
  );
}

export function getAllParaCache(): ParaCacheRow[] {
  return db.prepare('SELECT * FROM notion_para_cache ORDER BY name').all() as ParaCacheRow[];
}

export function getActiveParaCache(): ParaCacheRow[] {
  return db.prepare("SELECT * FROM notion_para_cache WHERE status = 'Active' ORDER BY name").all() as ParaCacheRow[];
}

export function clearParaCache(): void {
  db.prepare('DELETE FROM notion_para_cache').run();
}

// --- Notion cache: Relations ---

export interface RelationCacheRow {
  id?: number;
  source_db: string;
  source_page_id: string;
  target_db: string;
  target_page_id: string;
  relation_property: string;
  synced_at: string;
}

export function insertRelationCache(rel: Omit<RelationCacheRow, 'id'>): void {
  db.prepare(
    `INSERT INTO notion_relation_cache
     (source_db, source_page_id, target_db, target_page_id, relation_property, synced_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(rel.source_db, rel.source_page_id, rel.target_db, rel.target_page_id, rel.relation_property, rel.synced_at);
}

export function getRelationsForPage(pageId: string): RelationCacheRow[] {
  return db.prepare(
    `SELECT * FROM notion_relation_cache
     WHERE source_page_id = ? OR target_page_id = ?`,
  ).all(pageId, pageId) as RelationCacheRow[];
}

export function clearRelationCache(): void {
  db.prepare('DELETE FROM notion_relation_cache').run();
}

// --- Notion cache: Daily Pages ---

export interface DailyPageCacheRow {
  page_id: string;
  title: string | null;
  date: string;
  mood_morning: string | null;
  mood_evening: string | null;
  wakefulness_morning: string | null;
  wakefulness_evening: string | null;
  concerta_mg: number | null;
  pregabalin_mg: number | null;
  caffeine_mg: number | null;
  creatine_mg: number | null;
  alcohol_units: number | null;
  sleepies: number | null;
  micro_d: number;
  prayer: number;
  rosary: number;
  mass: number;
  theological_reflections: number;
  piano: number;
  b2b: number;
  ate_healthy: number;
  workout: string | null;
  time_asleep: string | null;
  deep_sleep: string | null;
  awake: string | null;
  night_wakings: number | null;
  lights_out: string | null;
  sleep_good: number;
  sleep_bad: number;
  angry_outburst: number;
  fionn_woke: number;
  midnight_snack: number;
  too_late_to_bed: number;
  headache: string | null;
  win: string | null;
  tasks_done: number;
  tasks_total: number;
  synced_at: string;
}

export function upsertDailyPageCache(page: DailyPageCacheRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO notion_daily_pages_cache
     (page_id, title, date, mood_morning, mood_evening, wakefulness_morning, wakefulness_evening,
      concerta_mg, pregabalin_mg, caffeine_mg, creatine_mg, alcohol_units, sleepies,
      micro_d, prayer, rosary, mass, theological_reflections, piano, b2b, ate_healthy,
      workout, time_asleep, deep_sleep, awake, night_wakings, lights_out,
      sleep_good, sleep_bad, angry_outburst, fionn_woke, midnight_snack, too_late_to_bed,
      headache, win, tasks_done, tasks_total, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    page.page_id, page.title, page.date, page.mood_morning, page.mood_evening,
    page.wakefulness_morning, page.wakefulness_evening,
    page.concerta_mg, page.pregabalin_mg, page.caffeine_mg, page.creatine_mg,
    page.alcohol_units, page.sleepies,
    page.micro_d, page.prayer, page.rosary, page.mass, page.theological_reflections,
    page.piano, page.b2b, page.ate_healthy,
    page.workout, page.time_asleep, page.deep_sleep, page.awake, page.night_wakings, page.lights_out,
    page.sleep_good, page.sleep_bad, page.angry_outburst, page.fionn_woke,
    page.midnight_snack, page.too_late_to_bed,
    page.headache, page.win, page.tasks_done, page.tasks_total, page.synced_at,
  );
}

export function getDailyPagesCache(sinceDaysAgo?: number): DailyPageCacheRow[] {
  if (sinceDaysAgo !== undefined) {
    return db.prepare(
      `SELECT * FROM notion_daily_pages_cache
       WHERE date >= date('now', '-' || ? || ' days')
       ORDER BY date DESC`,
    ).all(sinceDaysAgo) as DailyPageCacheRow[];
  }
  return db.prepare('SELECT * FROM notion_daily_pages_cache ORDER BY date DESC').all() as DailyPageCacheRow[];
}

export function clearDailyPagesCache(): void {
  db.prepare('DELETE FROM notion_daily_pages_cache').run();
}

// --- Notion sync log ---

export interface SyncLogEntry {
  direction: 'notion_to_local' | 'local_to_notion';
  operation: 'create' | 'update' | 'delete' | 'sync';
  notion_db: string;
  notion_page_id?: string | null;
  trigger_type: 'message' | 'scheduled_task' | 'webhook' | 'manual_sync';
  trigger_id?: string | null;
  group_folder?: string | null;
  details?: string | null;
  status?: 'success' | 'error';
  error_message?: string | null;
}

export function logNotionSync(entry: SyncLogEntry): void {
  db.prepare(
    `INSERT INTO notion_sync_log
     (direction, operation, notion_db, notion_page_id, trigger_type, trigger_id, group_folder, details, status, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.direction, entry.operation, entry.notion_db, entry.notion_page_id ?? null,
    entry.trigger_type, entry.trigger_id ?? null, entry.group_folder ?? null,
    entry.details ?? null, entry.status ?? 'success', entry.error_message ?? null,
    new Date().toISOString(),
  );
}

export function getSyncLog(limit: number = 100): Array<SyncLogEntry & { id: number; created_at: string }> {
  return db.prepare(
    'SELECT * FROM notion_sync_log ORDER BY created_at DESC LIMIT ?',
  ).all(limit) as Array<SyncLogEntry & { id: number; created_at: string }>;
}

export function pruneSyncLog(daysOld: number): number {
  const result = db.prepare(
    `DELETE FROM notion_sync_log WHERE created_at < datetime('now', '-' || ? || ' days')`,
  ).run(daysOld);
  return result.changes;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      setRegisteredGroup(jid, group);
    }
  }
}
