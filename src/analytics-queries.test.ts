import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  upsertParaCache,
  upsertDailyPageCache,
  logNotionSync,
  storeMessage,
  storeChatMetadata,
  logTaskRun,
} from './db.js';
import {
  habitMoodCorrelation,
  taskCompletionRate,
  knowledgeGaps,
  messageActionRate,
  taskExecutionHealth,
  generateAnalytics,
} from './analytics-queries.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('habitMoodCorrelation', () => {
  it('returns correlation data for habits', () => {
    // Add daily pages with varied habits and moods
    upsertDailyPageCache({
      page_id: 'dp-1', title: 'Day 1', date: new Date().toISOString().split('T')[0],
      mood_morning: 'Good', mood_evening: 'Great',
      wakefulness_morning: 'Good', wakefulness_evening: 'Good',
      concerta_mg: 54, pregabalin_mg: null, caffeine_mg: 200,
      creatine_mg: 5, alcohol_units: 0, sleepies: null,
      micro_d: 0, prayer: 1, rosary: 0, mass: 0,
      theological_reflections: 0, piano: 1, b2b: 0, ate_healthy: 1,
      workout: '[]', time_asleep: null, deep_sleep: null, awake: null,
      night_wakings: null, lights_out: null,
      sleep_good: 1, sleep_bad: 0, angry_outburst: 0, fionn_woke: 0,
      midnight_snack: 0, too_late_to_bed: 0,
      headache: '[]', win: null, tasks_done: 3, tasks_total: 5,
      synced_at: new Date().toISOString(),
    });

    const corr = habitMoodCorrelation(30);
    expect(corr).toHaveLength(8); // 8 habits
    const prayer = corr.find((h) => h.habit === 'prayer');
    expect(prayer).toBeDefined();
    expect(prayer!.days_done).toBe(1);
    expect(prayer!.avg_mood_with).toBe(5); // Great = 5
  });

  it('returns null averages when no data', () => {
    const corr = habitMoodCorrelation(30);
    expect(corr).toHaveLength(8);
    expect(corr[0].avg_mood_with).toBeNull();
  });
});

describe('taskCompletionRate', () => {
  it('computes rate from daily pages', () => {
    const today = new Date().toISOString().split('T')[0];
    upsertDailyPageCache({
      page_id: 'dp-1', title: 'Day 1', date: today,
      mood_morning: null, mood_evening: null,
      wakefulness_morning: null, wakefulness_evening: null,
      concerta_mg: null, pregabalin_mg: null, caffeine_mg: null,
      creatine_mg: null, alcohol_units: null, sleepies: null,
      micro_d: 0, prayer: 0, rosary: 0, mass: 0,
      theological_reflections: 0, piano: 0, b2b: 0, ate_healthy: 0,
      workout: '[]', time_asleep: null, deep_sleep: null, awake: null,
      night_wakings: null, lights_out: null,
      sleep_good: 0, sleep_bad: 0, angry_outburst: 0, fionn_woke: 0,
      midnight_snack: 0, too_late_to_bed: 0,
      headache: '[]', win: null, tasks_done: 7, tasks_total: 10,
      synced_at: new Date().toISOString(),
    });

    const result = taskCompletionRate(30);
    expect(result.done).toBe(7);
    expect(result.total).toBe(10);
    expect(result.rate).toBe(70);
  });

  it('returns null rate when no tasks', () => {
    const result = taskCompletionRate(30);
    expect(result.rate).toBeNull();
  });
});

describe('knowledgeGaps', () => {
  it('finds active PARA items with missing links', () => {
    upsertParaCache({
      page_id: 'p1', name: 'No Notes', category: 'Area', status: 'Active',
      deadline: null, parent_para_id: null,
      task_count: 5, note_count: 0, content_count: 2,
      synced_at: new Date().toISOString(),
    });
    upsertParaCache({
      page_id: 'p2', name: 'Complete', category: 'Project', status: 'Active',
      deadline: null, parent_para_id: null,
      task_count: 3, note_count: 2, content_count: 1,
      synced_at: new Date().toISOString(),
    });
    upsertParaCache({
      page_id: 'p3', name: 'Archived', category: 'Area', status: 'Archived',
      deadline: null, parent_para_id: null,
      task_count: 0, note_count: 0, content_count: 0,
      synced_at: new Date().toISOString(),
    });

    const gaps = knowledgeGaps();
    expect(gaps).toHaveLength(1);
    expect(gaps[0].name).toBe('No Notes');
  });
});

describe('messageActionRate', () => {
  it('counts messages and Notion actions', () => {
    storeChatMetadata('group@g.us', new Date().toISOString());
    storeMessage({
      id: 'msg-1', chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net', sender_name: 'User',
      content: 'hello', timestamp: new Date().toISOString(),
      is_from_me: false,
    });
    storeMessage({
      id: 'msg-2', chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net', sender_name: 'User',
      content: 'world', timestamp: new Date().toISOString(),
      is_from_me: false,
    });

    logNotionSync({
      direction: 'local_to_notion',
      operation: 'create',
      notion_db: 'tasks',
      trigger_type: 'message',
    });

    const rate = messageActionRate(7);
    expect(rate.messages).toBe(2);
    expect(rate.actions).toBe(1);
  });
});

describe('taskExecutionHealth', () => {
  it('computes health from task run logs', () => {
    // Create parent tasks first (FK constraint)
    for (const id of ['t1', 't2']) {
      createTask({
        id, group_folder: 'main', chat_jid: 'g@g.us',
        prompt: 'test', schedule_type: 'once',
        schedule_value: new Date().toISOString(),
        context_mode: 'isolated', next_run: null,
        status: 'active', created_at: new Date().toISOString(),
      });
    }
    logTaskRun({
      task_id: 't1',
      run_at: new Date().toISOString(),
      duration_ms: 5000,
      status: 'success',
      result: 'ok',
      error: null,
    });
    logTaskRun({
      task_id: 't2',
      run_at: new Date().toISOString(),
      duration_ms: 15000,
      status: 'error',
      result: null,
      error: 'timeout',
    });

    const health = taskExecutionHealth(7);
    expect(health.total_runs).toBe(2);
    expect(health.successes).toBe(1);
    expect(health.errors).toBe(1);
    expect(health.avg_duration_ms).toBe(10000);
    expect(health.max_duration_ms).toBe(15000);
  });
});

describe('generateAnalytics', () => {
  it('produces full analytics object', () => {
    const analytics = generateAnalytics();
    expect(analytics).toHaveProperty('habitCorrelation');
    expect(analytics).toHaveProperty('taskCompletion');
    expect(analytics).toHaveProperty('knowledgeGaps');
    expect(analytics).toHaveProperty('messageActionRate');
    expect(analytics).toHaveProperty('taskHealth');
    expect(analytics).toHaveProperty('generatedAt');
  });
});
