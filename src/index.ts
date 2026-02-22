import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
} from './config.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getTaskById,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { formatMessages, formatOutbound } from './router.js';
import { runTask, startSchedulerLoop } from './task-scheduler.js';
import { NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { startCredentialProxy } from './credential-proxy.js';
import { EgressProxy, DEFAULT_EGRESS_CONFIG } from './security/egress-proxy.js';
import { MalwareScanner } from './security/malware-scanner.js';
import { PromptGuard } from './security/prompt-guard.js';
import { OutputMonitor } from './security/output-monitor.js';
import { VirusTotalScanner } from './security/virustotal.js';
import { MemoryIntegrity } from './security/memory-integrity.js';
import { writeCacheSnapshot, fullSync } from './notion-sync.js';
import { CanaryDeployer } from './security/canary-tokens.js';
import {
  ApprovalGate,
  ApprovalRequest,
} from './security/approval-gate.js';
import {
  createApprovalRequest,
  getPendingApprovals,
  resolveApproval,
  getExpiredApprovals,
  expireApproval,
} from './db.js';
import { startVncTunnel, stopVncTunnel } from './vnc-tunnel.js';
import { startWebhookServer } from './webhook-server.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

let whatsapp: WhatsAppChannel;
const queue = new GroupQueue();
let memIntegrity: MemoryIntegrity | null = null;

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.jid.endsWith('@g.us'))
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  // Phase 3: Snapshot memory files before agent session
  const memSnapshot = memIntegrity
    ? await memIntegrity.snapshotBefore(group.folder)
    : null;

  await whatsapp.setTyping(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await whatsapp.sendMessage(chatJid, `${ASSISTANT_NAME}: ${text}`);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await whatsapp.setTyping(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  // Phase 3: Verify memory integrity after agent session
  if (memIntegrity && memSnapshot) {
    try {
      const integrityResult = await memIntegrity.verifyAfter(group.folder, memSnapshot);
      if (!integrityResult.clean) {
        for (const change of integrityResult.suspiciousChanges) {
          if (change.severity === 'high' || change.severity === 'critical') {
            await whatsapp.sendMessage(chatJid,
              `[SECURITY] Suspicious memory modification detected and reverted in ${group.name}. ` +
              `Reason: ${change.reason}`);
          }
        }
      }
    } catch (err) {
      logger.error({ err, group: group.name }, 'Memory integrity check failed');
    }
  }

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Write Notion cache snapshot for the agent (main group only)
  if (isMain) {
    writeCacheSnapshot(group.folder);
  }

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    // Generate request ID for distributed tracing
    const requestId = crypto.randomUUID();

    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        requestId, // For correlating logs across orchestrator → container → proxies
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  try {
    execSync('container system status', { stdio: 'pipe' });
    logger.debug('Apple Container system already running');
  } catch {
    logger.info('Starting Apple Container system...');
    try {
      execSync('container system start', { stdio: 'pipe', timeout: 30000 });
      logger.info('Apple Container system started');
    } catch (err) {
      logger.error({ err }, 'Failed to start Apple Container system');
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: Apple Container system failed to start                 ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Agents cannot run without Apple Container. To fix:           ║',
      );
      console.error(
        '║  1. Install from: https://github.com/apple/container/releases ║',
      );
      console.error(
        '║  2. Run: container system start                               ║',
      );
      console.error(
        '║  3. Restart NanoClaw                                          ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('Apple Container system is required but failed to start');
    }
  }

  // Kill and clean up orphaned NanoClaw containers from previous runs
  try {
    const output = execSync('container ls --format json', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers: { status: string; configuration: { id: string } }[] = JSON.parse(output || '[]');
    const orphans = containers
      .filter((c) => c.status === 'running' && c.configuration.id.startsWith('nanoclaw-'))
      .map((c) => c.configuration.id);
    for (const name of orphans) {
      try {
        execSync(`container stop ${name}`, { stdio: 'pipe' });
      } catch { /* already stopped */ }
    }
    if (orphans.length > 0) {
      logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned containers');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');

  // Start credential proxy (Phase 2: Credential Isolation)
  // Proxies Anthropic API requests and injects credentials at runtime
  // Agents never see the real API key
  const credProxyPort = parseInt(process.env.CREDENTIAL_PROXY_PORT || '3001', 10);
  await startCredentialProxy(credProxyPort, '0.0.0.0');
  logger.info({ port: credProxyPort }, 'Credential proxy started');

  // Start network egress proxy (Phase 5: Network Egress Filtering)
  // Filters all outbound HTTP/HTTPS traffic from containers
  // Blocks unauthorized domains and prevents data exfiltration
  const egressProxyPort = parseInt(process.env.EGRESS_PROXY_PORT || '3002', 10);
  const egressProxy = new EgressProxy(DEFAULT_EGRESS_CONFIG);
  await egressProxy.start(egressProxyPort, '0.0.0.0');
  logger.info({ port: egressProxyPort }, 'Network egress proxy started');

  // Phase 6: Content Scanning Services
  // ClamAV malware scanner (connects to clamd TCP 3310)
  const malwareScanner = new MalwareScanner();
  await malwareScanner.init();

  // Prompt Guard ML injection detection (connects to FastAPI HTTP 3003)
  const promptGuard = new PromptGuard();
  await promptGuard.init();

  // Phase 1: Output monitoring (scans outbound messages)
  const outputMonitor = new OutputMonitor();

  // Phase 4: VirusTotal background scanning
  const vtScanner = new VirusTotalScanner();
  await vtScanner.init();

  // Phase 3: Memory integrity checker
  const groupsDir = path.join(DATA_DIR, '..', 'groups');
  memIntegrity = new MemoryIntegrity(groupsDir, DATA_DIR);

  // Phase 5: Canary token deployer
  const canaryDeployer = new CanaryDeployer(groupsDir);

  // Start VNC tunnel (Cloudflare Quick Tunnel for remote browser access)
  // URL written to /tmp/nanoclaw-vnc-url.txt for Raiden to read and send to users
  startVncTunnel().then((url) => {
    if (url) logger.info({ url }, 'VNC tunnel ready — remote browser access enabled');
  });

  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    stopVncTunnel();
    approvalGate?.shutdown();
    await queue.shutdown(10000);
    await whatsapp.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Phase 2: Approval gate (needs sendMessage, so initialized with lazy ref)
  let approvalGate: ApprovalGate | undefined;

  // Create WhatsApp channel
  whatsapp = new WhatsAppChannel({
    onMessage: (chatJid, msg) => storeMessage(msg),
    onChatMetadata: (chatJid, timestamp) => storeChatMetadata(chatJid, timestamp),
    registeredGroups: () => registeredGroups,
    malwareScanner,
    promptGuard,
    vtScanner,
    approvalGate: undefined, // Set after channel is created
  });

  // Now create approval gate with sendMessage from whatsapp
  const ownerJid = process.env.NANOCLAW_OWNER_JID || '';
  if (ownerJid) {
    approvalGate = new ApprovalGate({
      sendMessage: (jid, text) => whatsapp.sendMessage(jid, text),
      ownerJid,
      createApprovalRequest: (req) => createApprovalRequest(req),
      getPendingApprovals: (chatJid) => getPendingApprovals(chatJid),
      resolveApproval: (id, approved, respondedBy) => resolveApproval(id, approved, respondedBy),
      getExpiredApprovals: () => getExpiredApprovals(),
      expireApproval: (id) => expireApproval(id),
    });
    // Inject into whatsapp channel (it needs to intercept approval responses)
    (whatsapp as any).approvalGate = approvalGate;
    logger.info('Approval gate initialized');
  } else {
    logger.warn('NANOCLAW_OWNER_JID not set — approval gate disabled');
  }

  // Connect — resolves when first connected
  await whatsapp.connect();

  // Start subsystems (independently of connection handler)
  const schedulerDeps = {
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid: string, proc: import('child_process').ChildProcess, containerName: string, groupFolder: string) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid: string, rawText: string) => {
      const text = formatOutbound(whatsapp, rawText);
      if (text) await whatsapp.sendMessage(jid, text);
    },
  };
  startSchedulerLoop(schedulerDeps);

  // Notion cache sync (every 6 hours, skip if no NOTION_TOKEN)
  const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
  if (process.env.NOTION_TOKEN) {
    // Initial sync after 30s delay (let service stabilize)
    setTimeout(() => {
      fullSync().catch((err) =>
        logger.error({ err }, 'Initial Notion sync failed'),
      );
    }, 30_000);

    setInterval(() => {
      if (!queue.isAnyActive()) {
        fullSync().catch((err) =>
          logger.error({ err }, 'Periodic Notion sync failed'),
        );
      } else {
        logger.info('Skipping Notion sync — container active');
      }
    }, SYNC_INTERVAL_MS);
  }

  // Notion webhook server (real-time inbox processing)
  const webhookSecret = process.env.NOTION_WEBHOOK_SECRET;
  if (webhookSecret) {
    const webhookPort = parseInt(process.env.WEBHOOK_PORT || '3004', 10);
    startWebhookServer(
      webhookPort,
      webhookSecret,
      (chatJid, taskId, fn) => queue.enqueueTask(chatJid, taskId, fn),
      async (taskId) => {
        const task = getTaskById(taskId);
        if (task) await runTask(task, schedulerDeps);
      },
    );
  }
  startIpcWatcher({
    sendMessage: (jid, text) => whatsapp.sendMessage(jid, text),
    registeredGroups: () => registeredGroups,
    registerGroup: (jid, group) => {
      registerGroup(jid, group);
      // Phase 5: Deploy canary tokens for newly registered groups
      canaryDeployer.deploy(group.folder).catch((err) =>
        logger.error({ err, folder: group.folder }, 'Failed to deploy canary tokens'),
      );
    },
    syncGroupMetadata: (force) => whatsapp.syncGroupMetadata(force),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
    outputMonitor,
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();

  // Phase 5: Deploy canary tokens for all existing registered groups
  for (const group of Object.values(registeredGroups)) {
    canaryDeployer.deploy(group.folder).catch((err) =>
      logger.error({ err, folder: group.folder }, 'Failed to deploy canary tokens'),
    );
  }

  startMessageLoop();
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
