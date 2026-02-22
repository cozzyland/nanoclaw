import { getDb } from './db.js';

export interface HabitCorrelation {
  habit: string;
  avg_mood_with: number | null;
  avg_mood_without: number | null;
  days_done: number;
  days_missed: number;
}

export interface TaskCompletion {
  rate: number | null;
  done: number;
  total: number;
}

export interface ParaGap {
  page_id: string;
  name: string;
  category: string;
  status: string;
  task_count: number;
  note_count: number;
  content_count: number;
}

export interface MessageActionRate {
  messages: number;
  actions: number;
}

export interface TaskHealth {
  total_runs: number;
  successes: number;
  errors: number;
  avg_duration_ms: number | null;
  max_duration_ms: number | null;
}

const MOOD_CASE = `
  CASE mood_evening
    WHEN 'Very Bad' THEN 1 WHEN 'Bad' THEN 2
    WHEN 'OK' THEN 3 WHEN 'Good' THEN 4 WHEN 'Great' THEN 5
  END`;

const HABITS = [
  'prayer', 'rosary', 'mass', 'theological_reflections',
  'piano', 'b2b', 'ate_healthy', 'micro_d',
] as const;

/**
 * Habit-mood correlation: for each habit, compare avg evening mood
 * on days habit was done vs not done.
 */
export function habitMoodCorrelation(days: number = 30): HabitCorrelation[] {
  const db = getDb();
  const results: HabitCorrelation[] = [];

  for (const habit of HABITS) {
    const row = db.prepare(`
      SELECT
        ? as habit,
        AVG(CASE WHEN ${habit} = 1 THEN ${MOOD_CASE} END) as avg_mood_with,
        AVG(CASE WHEN ${habit} = 0 THEN ${MOOD_CASE} END) as avg_mood_without,
        SUM(${habit}) as days_done,
        COUNT(*) - SUM(${habit}) as days_missed
      FROM notion_daily_pages_cache
      WHERE date >= date('now', '-' || ? || ' days')
        AND mood_evening IS NOT NULL
    `).get(habit, days) as HabitCorrelation;
    results.push(row);
  }

  return results;
}

/**
 * Task completion rate from Daily Pages (tasks_done / tasks_total).
 */
export function taskCompletionRate(days: number = 30): TaskCompletion {
  const db = getDb();
  return db.prepare(`
    SELECT
      ROUND(100.0 * SUM(tasks_done) / NULLIF(SUM(tasks_total), 0), 1) as rate,
      SUM(tasks_done) as done,
      SUM(tasks_total) as total
    FROM notion_daily_pages_cache
    WHERE date >= date('now', '-' || ? || ' days')
  `).get(days) as TaskCompletion;
}

/**
 * Knowledge gaps: Active PARA items with zero linked tasks, notes, or content.
 */
export function knowledgeGaps(): ParaGap[] {
  const db = getDb();
  return db.prepare(`
    SELECT page_id, name, category, status, task_count, note_count, content_count
    FROM notion_para_cache
    WHERE status = 'Active'
      AND (task_count = 0 OR note_count = 0 OR content_count = 0)
    ORDER BY
      CASE WHEN note_count = 0 AND content_count = 0 THEN 0 ELSE 1 END,
      name
  `).all() as ParaGap[];
}

/**
 * Message-to-action conversion rate: messages received vs Notion creates.
 */
export function messageActionRate(days: number = 7): MessageActionRate {
  const db = getDb();
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM messages
       WHERE timestamp >= datetime('now', '-' || ? || ' days')
         AND is_from_me = 0) as messages,
      (SELECT COUNT(*) FROM notion_sync_log
       WHERE created_at >= datetime('now', '-' || ? || ' days')
         AND direction = 'local_to_notion'
         AND operation = 'create') as actions
  `).get(days, days) as MessageActionRate;
}

/**
 * Task execution health from task_run_logs.
 */
export function taskExecutionHealth(days: number = 7): TaskHealth {
  const db = getDb();
  return db.prepare(`
    SELECT
      COUNT(*) as total_runs,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successes,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors,
      ROUND(AVG(duration_ms)) as avg_duration_ms,
      MAX(duration_ms) as max_duration_ms
    FROM task_run_logs
    WHERE run_at >= datetime('now', '-' || ? || ' days')
  `).get(days) as TaskHealth;
}

/**
 * Generate a full analytics object for the cache snapshot.
 */
export function generateAnalytics(): {
  habitCorrelation: HabitCorrelation[];
  taskCompletion: TaskCompletion;
  knowledgeGaps: ParaGap[];
  messageActionRate: MessageActionRate;
  taskHealth: TaskHealth;
  generatedAt: string;
} {
  return {
    habitCorrelation: habitMoodCorrelation(30),
    taskCompletion: taskCompletionRate(30),
    knowledgeGaps: knowledgeGaps(),
    messageActionRate: messageActionRate(7),
    taskHealth: taskExecutionHealth(7),
    generatedAt: new Date().toISOString(),
  };
}
