import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetAllTasks,
  mockGetDueTasks,
  mockGetTaskById,
  mockLogTaskRun,
  mockUpdateTaskAfterRun,
} = vi.hoisted(() => ({
  mockGetAllTasks: vi.fn(() => []),
  mockGetDueTasks: vi.fn(),
  mockGetTaskById: vi.fn(),
  mockLogTaskRun: vi.fn(),
  mockUpdateTaskAfterRun: vi.fn(),
}));

vi.mock('./config.js', () => ({
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1000,
  MAIN_GROUP_FOLDER: 'main',
  SCHEDULER_POLL_INTERVAL: 100,
  TIMEZONE: 'UTC',
}));

vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

vi.mock('./db.js', () => ({
  getAllTasks: mockGetAllTasks,
  getDueTasks: mockGetDueTasks,
  getTaskById: mockGetTaskById,
  logTaskRun: mockLogTaskRun,
  updateTaskAfterRun: mockUpdateTaskAfterRun,
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { startSchedulerLoop } from './task-scheduler.js';
import type { RegisteredGroup, ScheduledTask } from './types.js';

describe('startSchedulerLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not pre-advance task state and dedupes while in-flight', async () => {
    const task: ScheduledTask = {
      id: 'task-1',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'run task',
      schedule_type: 'once',
      schedule_value: new Date().toISOString(),
      context_mode: 'isolated',
      next_run: new Date().toISOString(),
      last_run: null,
      last_result: null,
      status: 'active',
      created_at: new Date().toISOString(),
    };

    const group: RegisteredGroup = {
      name: 'Other',
      folder: 'other-group',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
    };

    mockGetDueTasks.mockReturnValue([task]);
    mockGetTaskById.mockReturnValue(task);

    const enqueueTask = vi.fn();
    startSchedulerLoop({
      registeredGroups: () => ({ [task.chat_jid]: group }),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: vi.fn(),
      sendMessage: vi.fn(async () => {}),
    });

    // First poll should enqueue exactly once.
    expect(enqueueTask).toHaveBeenCalledTimes(1);
    expect(mockUpdateTaskAfterRun).not.toHaveBeenCalled();

    // Subsequent polls should not enqueue duplicates while task is in-flight.
    await vi.advanceTimersByTimeAsync(1000);
    expect(enqueueTask).toHaveBeenCalledTimes(1);
    expect(mockUpdateTaskAfterRun).not.toHaveBeenCalled();
  });
});
