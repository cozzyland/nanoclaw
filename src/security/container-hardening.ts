/**
 * Container Hardening Configuration
 *
 * Applies security restrictions to container runtime:
 * - Seccomp profiles (syscall filtering)
 * - Read-only root filesystem
 * - Capability dropping
 * - Resource limits
 */

import { logger } from '../logger.js';

export interface HardeningConfig {
  // Seccomp profile path (inside container)
  seccompProfile?: string;

  // Read-only root filesystem
  readOnlyRoot?: boolean;

  // Writable tmpfs directories (when readOnlyRoot=true)
  tmpfsDirs?: string[];

  // Linux capabilities to drop
  dropCapabilities?: string[];

  // Resource limits
  limits?: {
    memory?: string;      // e.g., "2g"
    memorySwap?: string;  // e.g., "2g"
    cpus?: string;        // e.g., "2"
    pidsLimit?: number;   // e.g., 100
  };
}

/**
 * Default hardening configuration for NanoClaw containers
 */
export const DEFAULT_HARDENING: HardeningConfig = {
  // Seccomp: Block dangerous syscalls (mount, ptrace, bpf, etc.)
  seccompProfile: '/etc/security/seccomp-profile.json',

  // Read-only root: Prevents malware persistence
  readOnlyRoot: true,

  // Writable tmpfs: Needed for temporary files
  tmpfsDirs: ['/tmp', '/var/tmp', '/home/node/.cache'],

  // Drop capabilities: Remove unnecessary privileges
  // Note: Apple Container may not support --cap-drop
  dropCapabilities: [
    'CAP_SYS_ADMIN',      // Most dangerous - allows many privilege escalations
    'CAP_NET_RAW',        // Prevents packet sniffing
    'CAP_SYS_PTRACE',     // Prevents debugging other processes
    'CAP_SYS_MODULE',     // Prevents loading kernel modules
    'CAP_SYS_BOOT',       // Prevents system reboot
    'CAP_SYS_TIME',       // Prevents changing system time
    'CAP_MKNOD',          // Prevents creating device files
    'CAP_AUDIT_WRITE',    // Prevents writing to audit log
    'CAP_SETFCAP',        // Prevents setting file capabilities
  ],

  // Resource limits: Prevent resource exhaustion
  limits: {
    memory: '2g',         // 2GB RAM limit
    memorySwap: '2g',     // No swap (total = memory + swap)
    cpus: '2',            // 2 CPU cores
    pidsLimit: 100,       // Max 100 processes (prevents fork bombs)
  },
};

/**
 * Generate container runtime arguments for hardening
 *
 * @param config Hardening configuration
 * @returns Array of arguments to pass to container run command
 */
export function getHardeningArgs(
  config: HardeningConfig = DEFAULT_HARDENING
): string[] {
  const args: string[] = [];

  // Seccomp profile
  // Note: Apple Container may not support --security-opt
  // This will need testing
  if (config.seccompProfile) {
    args.push('--security-opt', `seccomp=${config.seccompProfile}`);
    logger.debug({ seccompProfile: config.seccompProfile }, 'Applying seccomp profile');
  }

  // Read-only root filesystem
  if (config.readOnlyRoot) {
    args.push('--read-only');
    logger.debug('Enabling read-only root filesystem');

    // Add writable tmpfs directories
    if (config.tmpfsDirs) {
      for (const dir of config.tmpfsDirs) {
        args.push('--tmpfs', dir);
      }
      logger.debug({ tmpfsDirs: config.tmpfsDirs }, 'Adding writable tmpfs directories');
    }
  }

  // Drop Linux capabilities
  // Note: Apple Container may not support --cap-drop
  if (config.dropCapabilities && config.dropCapabilities.length > 0) {
    // Try dropping all first, then adding back necessary ones
    // This is more secure than selectively dropping
    args.push('--cap-drop', 'ALL');

    // Add back capabilities that Node.js/Claude Code needs
    const requiredCaps = [
      'CAP_CHOWN',          // Change file ownership
      'CAP_DAC_OVERRIDE',   // Bypass file permissions
      'CAP_SETGID',         // Set GID
      'CAP_SETUID',         // Set UID
      'CAP_NET_BIND_SERVICE', // Bind to ports < 1024 (unlikely needed but safe)
    ];

    for (const cap of requiredCaps) {
      args.push('--cap-add', cap);
    }

    logger.debug(
      { dropped: 'ALL', added: requiredCaps },
      'Applying capability restrictions'
    );
  }

  // Resource limits
  if (config.limits) {
    const appliedLimits: any = {};

    if (config.limits.memory) {
      args.push('--memory', config.limits.memory);
      appliedLimits.memory = config.limits.memory;
    }
    if (config.limits.memorySwap) {
      args.push('--memory-swap', config.limits.memorySwap);
      appliedLimits.memorySwap = config.limits.memorySwap;
    }
    if (config.limits.cpus) {
      args.push('--cpus', config.limits.cpus);
      appliedLimits.cpus = config.limits.cpus;
    }
    if (config.limits.pidsLimit) {
      args.push('--pids-limit', config.limits.pidsLimit.toString());
      appliedLimits.pidsLimit = config.limits.pidsLimit;
    }

    if (Object.keys(appliedLimits).length > 0) {
      logger.debug({ limits: appliedLimits }, 'Applying resource limits');
    }
  }

  return args;
}

/**
 * Check if container runtime supports hardening features
 *
 * Apple Container is based on macOS Virtualization.framework
 * and may not support all Docker/OCI security options.
 *
 * @returns Supported hardening features
 */
export async function checkHardeningSupport(): Promise<{
  seccomp: boolean;
  readOnly: boolean;
  capabilities: boolean;
  resourceLimits: boolean;
}> {
  // TODO: Implement runtime capability detection
  // For now, assume basic support and let errors surface during testing

  return {
    seccomp: false,        // Apple Container likely doesn't support seccomp
    readOnly: true,        // Likely supports --read-only
    capabilities: false,   // Likely doesn't support --cap-drop
    resourceLimits: true,  // Likely supports resource limits
  };
}

/**
 * Get conservative hardening config for Apple Container
 *
 * Applies only features validated to work with Apple Container.
 *
 * Validated support (2026-02-15):
 * - ✅ --read-only (read-only root filesystem)
 * - ✅ --tmpfs (writable temp directories)
 * - ✅ --cpus (CPU limits)
 * - ❌ --pids-limit (not supported)
 * - ❌ --cap-drop/--cap-add (not supported)
 * - ❌ --security-opt seccomp (not supported)
 * - ⚠️  --memory/--memory-swap (not verifiable, omitted for compatibility)
 */
export function getConservativeHardening(): HardeningConfig {
  return {
    // Skip seccomp (not supported by Apple Container)
    seccompProfile: undefined,

    // Read-only root (validated working)
    readOnlyRoot: true,
    tmpfsDirs: ['/tmp', '/var/tmp', '/home/node/.cache'],

    // Skip capabilities (not supported by Apple Container)
    dropCapabilities: [],

    // Resource limits (only --cpus is supported)
    limits: {
      // Memory limits not verifiable on Apple Container (cgroup v2 or unsupported)
      // Omitting to avoid errors
      memory: undefined,
      memorySwap: undefined,

      // CPU limits validated working
      cpus: '2',

      // PIDs limit not supported by Apple Container
      pidsLimit: undefined,
    },
  };
}
