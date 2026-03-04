/**
 * Container Runner for NanoClaw
 * Spawns agent execution in Apple Container and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
} from './config.js';
import { logger } from './logger.js';
import { validateAdditionalMounts, verifyMountInode } from './mount-security.js';
import { RegisteredGroup } from './types.js';
import { getConservativeHardening, getHardeningArgs } from './security/container-hardening.js';
import { getVncTunnelUrl } from './vnc-tunnel.js';

// --- Container Networking Health ---
// Apple Container VMs can lose network connectivity (stale Lima virtual NIC).
// When this happens, DNS fails inside containers with EAI_AGAIN/ETIMEOUT/EHOSTUNREACH.
// We detect these patterns and auto-restart the container system to recover.

const DNS_ERROR_PATTERNS = ['EAI_AGAIN', 'ETIMEOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'Unable to connect to API'];
let networkRepairInProgress = false;

function isNetworkError(output: string): boolean {
  return DNS_ERROR_PATTERNS.some((pattern) => output.includes(pattern));
}

export async function repairContainerNetworking(): Promise<boolean> {
  if (networkRepairInProgress) {
    logger.info('Container network repair already in progress, skipping');
    return false;
  }

  networkRepairInProgress = true;
  logger.warn('Detected container networking failure — restarting container system');

  try {
    await new Promise<void>((resolve, reject) => {
      exec('container system stop', { timeout: 30000 }, (err) => {
        if (err) {
          logger.warn({ err }, 'container system stop returned error (may be expected)');
        }
        // Always proceed to start regardless of stop result
        setTimeout(() => {
          exec('container system start', { timeout: 30000 }, (err2, stdout2) => {
            if (err2) {
              reject(new Error(`container system start failed: ${err2.message}`));
            } else {
              resolve();
            }
          });
        }, 2000);
      });
    });

    // Verify networking works with a lightweight test
    const dnsOk = await new Promise<boolean>((resolve) => {
      exec(
        `container run --rm --entrypoint node ${CONTAINER_IMAGE} -e "require('dns').resolve4('api.anthropic.com', (e, a) => { process.exit(e ? 1 : 0); })"`,
        { timeout: 15000 },
        (err) => resolve(!err),
      );
    });

    if (dnsOk) {
      logger.info('Container networking repaired successfully — DNS resolution working');
    } else {
      logger.error('Container networking repair failed — DNS still broken after restart');
    }

    return dnsOk;
  } catch (err) {
    logger.error({ err }, 'Failed to repair container networking');
    return false;
  } finally {
    networkRepairInProgress = false;
  }
}

/**
 * Kill all stale nanoclaw containers from previous sessions.
 * When NanoClaw restarts, old containers become orphaned — they hang
 * indefinitely waiting for IPC messages that never come. Over time,
 * stale vmnet attachments accumulate and corrupt the VM's networking.
 */
export async function cleanupStaleContainers(): Promise<void> {
  try {
    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      exec('container list --all --format json 2>/dev/null || container list --all 2>/dev/null', { timeout: 10000 }, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });

    // Parse container list output (text format: columns separated by whitespace)
    // Look for nanoclaw-* containers and buildkit
    const lines = stdout.trim().split('\n').filter((l) => l.trim());
    const staleIds: string[] = [];

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const id = parts[0];
      if (!id || id === 'ID') continue;

      // Kill any nanoclaw container (they're from previous sessions)
      // Also kill buildkit if stopped (it restarts automatically when needed)
      if (id.startsWith('nanoclaw-') || (id === 'buildkit' && line.includes('stopped'))) {
        staleIds.push(id);
      }
    }

    if (staleIds.length === 0) {
      logger.info('No stale containers found');
      return;
    }

    logger.warn({ count: staleIds.length, ids: staleIds }, 'Cleaning up stale containers from previous sessions');

    for (const id of staleIds) {
      try {
        // Stop first (if running), then remove
        await new Promise<void>((resolve) => {
          exec(`container stop ${id} 2>/dev/null; container rm ${id} 2>/dev/null`, { timeout: 15000 }, () => resolve());
        });
      } catch {
        // Ignore individual failures
      }
    }

    logger.info({ cleaned: staleIds.length }, 'Stale container cleanup complete');
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up stale containers (non-fatal)');
  }
}

/**
 * Periodic reaper: kill containers older than the max timeout.
 * Runs every 30 minutes to catch any containers that slipped through.
 */
let reaperInterval: ReturnType<typeof setInterval> | null = null;

export function startContainerReaper(): void {
  if (reaperInterval) return;

  const REAPER_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

  reaperInterval = setInterval(async () => {
    try {
      const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        exec('container list --all 2>/dev/null', { timeout: 10000 }, (err, stdout, stderr) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        });
      });

      const lines = stdout.trim().split('\n').filter((l) => l.trim());
      const staleIds: string[] = [];

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const id = parts[0];
        if (!id || id === 'ID' || id === 'buildkit') continue;

        // Extract timestamp from nanoclaw container names (nanoclaw-{group}-{timestamp})
        if (id.startsWith('nanoclaw-')) {
          const match = id.match(/(\d{13})$/);
          if (match) {
            const createdAt = parseInt(match[1], 10);
            const ageMs = Date.now() - createdAt;
            // Kill anything older than 2 hours
            if (ageMs > 2 * 60 * 60 * 1000) {
              staleIds.push(id);
            }
          }
        }
      }

      if (staleIds.length > 0) {
        logger.warn({ count: staleIds.length, ids: staleIds }, 'Reaper: killing stale containers');
        for (const id of staleIds) {
          exec(`container stop ${id} 2>/dev/null; container rm ${id} 2>/dev/null`, { timeout: 15000 }, () => {});
        }
      }
    } catch {
      // Reaper is best-effort
    }
  }, REAPER_INTERVAL_MS);
}

/**
 * Verify container networking is healthy on startup.
 * Runs a lightweight DNS check inside a container and auto-repairs if broken.
 */
export async function ensureContainerNetworking(): Promise<void> {
  const dnsOk = await new Promise<boolean>((resolve) => {
    exec(
      `container run --rm --entrypoint node ${CONTAINER_IMAGE} -e "require('dns').resolve4('api.anthropic.com', (e) => { process.exit(e ? 1 : 0); })"`,
      { timeout: 15000 },
      (err) => resolve(!err),
    );
  });

  if (dnsOk) {
    logger.info('Container networking health check passed');
    return;
  }

  logger.warn('Container networking health check failed — attempting repair');
  const repaired = await repairContainerNetworking();
  if (!repaired) {
    logger.error('Container networking is broken and could not be repaired — containers will fail until fixed');
  }
}

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function getHomeDir(): string {
  const home = process.env.HOME || os.homedir();
  if (!home) {
    throw new Error(
      'Unable to determine home directory: HOME environment variable is not set and os.homedir() returned empty',
    );
  }
  return home;
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  // Override the default model (e.g. 'claude-haiku-4-5-20251001' for quick responses)
  model?: string;
  // Request ID for distributed tracing across services
  // Allows correlating logs from orchestrator → container → credential proxy → egress proxy
  requestId?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const homeDir = getHomeDir();
  const projectRoot = process.cwd();

  if (isMain) {
    // Main gets the entire project root mounted
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Apple Container only supports directory mounts, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({
      env: {
        // Enable agent swarms (subagent orchestration)
        // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        // Load CLAUDE.md from additional mounted directories
        // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        // Enable Claude's memory feature (persists user preferences between sessions)
        // https://code.claude.com/docs/en/memory#manage-auto-memory
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
    }, null, 2) + '\n');
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.mkdirSync(dstDir, { recursive: true });
      for (const file of fs.readdirSync(srcDir)) {
        const srcFile = path.join(srcDir, file);
        const dstFile = path.join(dstDir, file);
        fs.copyFileSync(srcFile, dstFile);
      }
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  // Write VNC tunnel URL so Raiden can send it to users for browser interaction
  const vncUrl = getVncTunnelUrl();
  if (vncUrl) {
    fs.writeFileSync(path.join(groupIpcDir, 'vnc-url.txt'), vncUrl);
  }

  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Environment file directory (workaround for Apple Container -i env var bug)
  // Only expose specific auth variables needed by Claude Code, not the entire .env
  const envDir = path.join(DATA_DIR, 'env');
  fs.mkdirSync(envDir, { recursive: true });
  const envFile = path.join(projectRoot, '.env');
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    // SECURITY: ANTHROPIC_API_KEY removed from container environment (Phase 2: Credential Isolation)
    // API key is now injected by credential proxy at runtime - agents never see it
    const allowedVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'VNC_PASSWORD', 'NOTION_TOKEN',
      'GMAIL_USER', 'GMAIL_PASS', 'ICLOUD_USER', 'ICLOUD_PASS'];
    const filteredLines = envContent.split('\n').filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return false;
      return allowedVars.some((v) => trimmed.startsWith(`${v}=`));
    });

    if (filteredLines.length > 0) {
      fs.writeFileSync(
        path.join(envDir, 'env'),
        filteredLines.join('\n') + '\n',
      );
      mounts.push({
        hostPath: envDir,
        containerPath: '/workspace/env-dir',
        readonly: true,
      });
    }
  }

  // Mount agent-runner source from host — recompiled on container startup.
  // Bypasses Apple Container's sticky build cache for code changes.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({
    hostPath: agentRunnerSrc,
    containerPath: '/app/src',
    readonly: true,
  });

  // Mount utility scripts (cookie injection, etc.)
  const scriptsDir = path.join(projectRoot, 'container', 'scripts');
  if (fs.existsSync(scriptsDir)) {
    mounts.push({
      hostPath: scriptsDir,
      containerPath: '/app/scripts',
      readonly: true,
    });
  }

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildContainerArgs(mounts: VolumeMount[], containerName: string): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Phase 2: Credential Isolation
  // ANTHROPIC_API_KEY is NOT passed to the container — it's host-only (image OCR, credential proxy).
  // The container uses CLAUDE_CODE_OAUTH_TOKEN (mounted via /workspace/env-dir/env) for Claude SDK auth.

  // Phase 5: Network Egress Filtering
  // Route all other HTTP/HTTPS requests through egress proxy
  // Lima VM gateway IP (container's default route, from /etc/resolv.conf nameserver)
  const limaGatewayIp = '192.168.64.1';
  const egressProxyUrl = `http://${limaGatewayIp}:${process.env.EGRESS_PROXY_PORT || '3002'}`;
  args.push('-e', `HTTP_PROXY=${egressProxyUrl}`);
  args.push('-e', `HTTPS_PROXY=${egressProxyUrl}`);
  args.push('-e', `NO_PROXY=localhost,127.0.0.1,api.anthropic.com,api.notion.com,imap.gmail.com,imap.mail.me.com,${limaGatewayIp}`);

  // Phase 6: Content scanning services accessible from containers
  args.push('-e', `CLAMAV_HOST=${limaGatewayIp}`);
  args.push('-e', 'CLAMAV_PORT=3310');
  args.push('-e', `PROMPT_GUARD_URL=http://${limaGatewayIp}:3003`);

  // Notion API: NOTION_TOKEN passed to container for direct REST API access via curl.
  // api.notion.com is in NO_PROXY so requests bypass the egress proxy.

  // Anti-detection flags for agent-browser (Chromium)
  // --disable-blink-features=AutomationControlled: hides navigator.webdriver flag from bot detectors
  // --no-sandbox: required for Chromium in containers
  // --no-proxy-server: browser connects directly (egress proxy is for CLI tools, not browser;
  //   proxying breaks Cloudflare TLS fingerprinting challenge)
  args.push('-e', 'AGENT_BROWSER_ARGS=--disable-blink-features=AutomationControlled,--no-sandbox,--no-proxy-server,--remote-debugging-port=9222');
  // Run browser headed (into Xvfb) so CDP screencast works for remote inspection
  args.push('-e', 'AGENT_BROWSER_HEADED=1');

  // Expose CDP for agent-browser --cdp 9222 (programmatic browser control)
  // Chromium binds debug port to 127.0.0.1 when --remote-debugging-pipe is also set,
  // so socat inside the container relays 0.0.0.0:9223 → 127.0.0.1:9222
  args.push('-p', '127.0.0.1:9222:9223');

  // Expose noVNC for remote browser interaction (Cloudflare challenges, payments, 3D Secure)
  // Users access via browser on any device — no app install needed
  // Cloudflare Tunnel makes this accessible from anywhere
  args.push('-p', '127.0.0.1:6080:6080');

  // Phase 3: Container Hardening
  // Apply security restrictions (read-only FS, resource limits, etc.)
  // Using conservative config for Apple Container compatibility
  const hardeningArgs = getHardeningArgs(getConservativeHardening());
  args.push(...hardeningArgs);

  // SDK needs writable home directory for config files
  // Mount /home/node as tmpfs (ephemeral, wiped on container exit)
  args.push('--tmpfs', '/home/node');

  // Verify inode for all mounts before mounting (TOCTOU prevention)
  // Filter out any mounts where inode has changed
  const verifiedMounts = mounts.filter((mount) => {
    // Only verify mounts that have inode information (additional mounts)
    if ('ino' in mount && 'dev' in mount) {
      const isValid = verifyMountInode(mount as any);
      if (!isValid) {
        logger.error(
          { mount: mount.hostPath },
          '🚨 SECURITY: Skipping mount due to TOCTOU attack detection',
        );
      }
      return isValid;
    }
    // Standard mounts (project, group folders) don't have inode info - always allow
    return true;
  });

  // Apple Container: --mount for readonly, -v for read-write
  for (const mount of verifiedMounts) {
    if (mount.readonly) {
      args.push(
        '--mount',
        `type=bind,source=${mount.hostPath},target=${mount.containerPath},readonly`,
      );
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn('container', containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Write input and close stdin (Apple Container doesn't flush pipe without EOF)
    const inputJson = JSON.stringify(input);
    logger.debug(
      { inputLength: inputJson.length, promptLength: input.prompt.length, group: group.name },
      'Writing input to container stdin',
    );
    container.stdin.write(inputJson);
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error({ group: group.name, containerName }, 'Container timeout, stopping gracefully');
      exec(`container stop ${containerName}`, { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn({ group: group.name, containerName, err }, 'Graceful stop failed, force killing');
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(timeoutLog, [
          `=== Container Run Log (TIMEOUT) ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${group.name}`,
          `Container: ${containerName}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          `Had Streaming Output: ${hadStreamingOutput}`,
        ].join('\n'));

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          }).catch((err) => {
            logger.error({ group: group.name, containerName, err }, 'outputChain rejected in idle cleanup path');
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        // Auto-repair container networking if DNS/network errors detected
        const combinedOutput = stderr + stdout;
        if (isNetworkError(combinedOutput)) {
          // Fire-and-forget: repair networking so the next retry works
          repairContainerNetworking().catch((err) => {
            logger.error({ err }, 'Background network repair failed');
          });
        }

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        }).catch((err) => {
          logger.error({ group: group.name, containerName, err }, 'outputChain rejected in streaming close path');
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ group: group.name, containerName, error: err }, 'Container spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
