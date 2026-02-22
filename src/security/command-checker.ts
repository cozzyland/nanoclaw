/**
 * Command Security Checker
 *
 * Analyzes commands for security risks using:
 * 1. Pattern-based detection (fast, deterministic)
 * 2. LLM-as-judge via Claude Haiku (context-aware, catches obfuscation)
 *
 * LLM-as-judge is invoked only for medium/unknown-risk commands to avoid
 * wasting API calls on clearly safe or clearly dangerous commands.
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../logger.js';

export interface CommandRiskAssessment {
  isHighRisk: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  reasons: string[];
  suggestedAction: 'allow' | 'warn' | 'block';
  safeAlternatives?: string[];
}

// LRU cache for LLM results (avoid redundant API calls)
const llmCache = new Map<string, { result: { isSafe: boolean; explanation: string }; expiry: number }>();
const LLM_CACHE_MAX = 1000;
const LLM_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic | null {
  if (anthropicClient) return anthropicClient;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const authToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN;
  if (!apiKey && !authToken) return null;

  anthropicClient = apiKey
    ? new Anthropic({ apiKey })
    : new Anthropic({ apiKey: undefined, authToken: authToken! });
  return anthropicClient;
}

/**
 * Pattern-based high-risk command detection.
 *
 * @param command The command to analyze
 * @param context Optional context (user message, session history)
 * @returns Risk assessment
 */
export function assessCommandRisk(
  command: string,
  context?: { userMessage?: string; isMain?: boolean }
): CommandRiskAssessment {
  const reasons: string[] = [];
  let riskLevel: 'low' | 'medium' | 'high' | 'critical' = 'low';
  const safeAlternatives: string[] = [];

  // CRITICAL: Destructive git operations
  if (/git\s+reset\s+--hard/i.test(command)) {
    reasons.push('git reset --hard destroys uncommitted work');
    riskLevel = 'critical';
    safeAlternatives.push('git stash');
    safeAlternatives.push('git status to review changes first');
  }

  if (/git\s+clean\s+-[df]/i.test(command)) {
    reasons.push('git clean -f deletes untracked files permanently');
    riskLevel = 'critical';
    safeAlternatives.push('git clean -n to preview what would be deleted');
  }

  if (/git\s+checkout\s+--\s+\./i.test(command)) {
    reasons.push('git checkout -- . discards all local changes');
    riskLevel = 'critical';
    safeAlternatives.push('git stash');
  }

  // CRITICAL: Recursive file deletion (catches -rf, -fr, --recursive, etc.)
  if (/rm\s+(-\w*r\w*|--recursive)\b/i.test(command) && !/\/tmp\b/.test(command)) {
    reasons.push('rm -rf outside /tmp can delete important files');
    riskLevel = 'critical';
    safeAlternatives.push('rm specific files instead of recursive deletion');
  }

  // CRITICAL: Shell command obfuscation / indirect execution
  if (/\beval\s/i.test(command) || /\bsource\s/i.test(command) || /\bexec\s/i.test(command)) {
    reasons.push('Indirect command execution (eval/source/exec) can hide malicious code');
    riskLevel = 'critical';
  }

  // CRITICAL: Pipe-to-shell patterns (base64 decode + execute, curl | sh, etc.)
  if (/\|\s*(ba)?sh\b/i.test(command) || /\|\s*bash\b/i.test(command)) {
    reasons.push('Pipe-to-shell pattern detected — possible code injection');
    riskLevel = 'critical';
  }

  // CRITICAL: Base64 decode to execution
  if (/base64\s+(-d|--decode)/i.test(command)) {
    reasons.push('Base64 decode detected — possible obfuscated command execution');
    riskLevel = 'critical';
  }

  // CRITICAL: Command substitution with dangerous operations
  if (/\$\(.*\b(curl|wget|nc|netcat)\b/i.test(command) || /`.*\b(curl|wget|nc|netcat)\b/i.test(command)) {
    reasons.push('Command substitution with network tool — possible exfiltration');
    riskLevel = 'critical';
  }

  // HIGH: Data exfiltration attempts
  if (/curl.*\$\{?[A-Z_]+\}?/i.test(command) || /wget.*\$\{?[A-Z_]+\}?/i.test(command)) {
    reasons.push('Possible credential exfiltration via environment variable');
    riskLevel = 'high';
  }

  // HIGH: Embedded scripts
  if (/(python|perl|ruby|node|php|lua)\s+-[ce]/i.test(command)) {
    reasons.push('Embedded script execution can hide malicious code');
    riskLevel = 'high';
  }

  // HIGH: Network tools — check target against allowlist
  const networkMatch = command.match(/\b(curl|wget|nc|netcat)\s+(?:-\S+\s+)*(\S+)/i);
  if (networkMatch) {
    const target = networkMatch[2];
    const ALLOWED_NETWORK_HOSTS = ['api.anthropic.com', 'github.com', 'npmjs.org', 'registry.npmjs.org', 'api.notion.com'];
    const isAllowed = ALLOWED_NETWORK_HOSTS.some(host => target.includes(host));
    if (!isAllowed) {
      reasons.push(`Network request to potentially unauthorized target: ${target.slice(0, 80)}`);
      if (riskLevel === 'low') riskLevel = 'high';
    }
  }

  // MEDIUM: Accessing credentials
  if (/\$ANTHROPIC_API_KEY|\$CLAUDE_CODE_OAUTH_TOKEN|cat.*\.env/i.test(command)) {
    reasons.push('Command accesses sensitive credentials');
    if (riskLevel === 'low') riskLevel = 'medium';
  }

  // MEDIUM: Command chaining (could hide malicious operations)
  if (/;\s*\w+|&&\s*\w+|\|\|\s*\w+/i.test(command)) {
    reasons.push('Command chaining detected - review each operation');
    if (riskLevel === 'low') riskLevel = 'medium';
  }

  // Determine suggested action based on risk level and context
  let suggestedAction: 'allow' | 'warn' | 'block';
  if (riskLevel === 'critical') {
    suggestedAction = 'block';
  } else if (riskLevel === 'high') {
    suggestedAction = context?.isMain ? 'warn' : 'block';
  } else if (riskLevel === 'medium') {
    suggestedAction = 'warn';
  } else {
    suggestedAction = 'allow';
  }

  const isHighRisk = riskLevel === 'high' || riskLevel === 'critical';

  if (isHighRisk) {
    logger.warn({
      command,
      riskLevel,
      reasons,
      suggestedAction,
      context,
    }, 'High-risk command detected');
  }

  return {
    isHighRisk,
    riskLevel,
    reasons,
    suggestedAction,
    safeAlternatives: safeAlternatives.length > 0 ? safeAlternatives : undefined,
  };
}

/**
 * LLM-as-judge: uses Claude Haiku for context-aware command safety assessment.
 *
 * Only invoked for commands that regex classified as 'medium' or when
 * pattern matching returns 'low' but the command looks complex.
 *
 * Behavior:
 * - 200ms timeout — falls back to pattern-based on slow/error
 * - LRU cache (1000 entries, 5 min TTL) — avoids redundant calls
 * - Uses ANTHROPIC_API_KEY from host environment
 */
export async function llmJudgeCommand(
  command: string,
  context: { userMessage?: string; isMain?: boolean }
): Promise<{ isSafe: boolean; explanation: string }> {
  // Always do pattern-based first
  const patternAssessment = assessCommandRisk(command, context);

  // If pattern-based is definitive (critical or low), don't waste an API call
  if (patternAssessment.riskLevel === 'critical') {
    return {
      isSafe: false,
      explanation: patternAssessment.reasons.join('; '),
    };
  }

  // Skip LLM for short, low-risk commands WITHOUT shell metacharacters
  const hasShellMeta = /[`$|;()\{\}]/.test(command);
  if (patternAssessment.riskLevel === 'low' && command.length < 50 && !hasShellMeta) {
    return {
      isSafe: true,
      explanation: 'No security concerns detected',
    };
  }

  // Check cache (include trust context to prevent cross-context poisoning)
  const cacheKey = `${command}::${context.isMain ? 'main' : 'secondary'}`;
  const cached = llmCache.get(cacheKey);
  if (cached && cached.expiry > Date.now()) {
    return cached.result;
  }

  // Try LLM judge
  const client = getAnthropicClient();
  if (!client) {
    // No API key — fall back to pattern-based
    return {
      isSafe: patternAssessment.suggestedAction !== 'block',
      explanation: patternAssessment.reasons.join('; ') || 'No security concerns detected',
    };
  }

  try {
    const response = await Promise.race([
      client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        system: `You are a security classifier for commands run in a sandboxed Linux container.
The container is a personal assistant (not a dev environment).
Respond with exactly one word on the first line: SAFE, WARN, or BLOCK.
Then a brief reason on the next line (max 20 words).

BLOCK if: destructive to user data, credential exfiltration, container escape, network abuse, reverse shells
WARN if: unusual but not necessarily dangerous, accessing sensitive paths, large downloads
SAFE if: normal assistant operations (file read/write, web browsing, package install, git operations)`,
        messages: [{
          role: 'user',
          content: `Command: ${command}\nTrust level: ${context.isMain ? 'high (main group)' : 'low (secondary group)'}`,
        }],
      }),
      // 3000ms timeout (200ms was too aggressive — cold Haiku calls need 500-2000ms)
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('LLM timeout')), 3000)),
    ]);

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const lines = text.trim().split('\n');
    const verdict = lines[0]?.trim().toUpperCase() || 'WARN';
    const reason = lines.slice(1).join(' ').trim() || 'LLM assessment';

    const result = {
      isSafe: verdict === 'SAFE',
      explanation: reason,
    };

    // Cache the result
    llmCache.set(cacheKey, { result, expiry: Date.now() + LLM_CACHE_TTL_MS });

    // Prune cache if too large
    if (llmCache.size > LLM_CACHE_MAX) {
      const now = Date.now();
      for (const [key, value] of llmCache) {
        if (value.expiry < now) llmCache.delete(key);
      }
      // If still too large, delete oldest entries
      if (llmCache.size > LLM_CACHE_MAX) {
        const keys = [...llmCache.keys()];
        for (let i = 0; i < keys.length - LLM_CACHE_MAX; i++) {
          llmCache.delete(keys[i]);
        }
      }
    }

    return result;
  } catch (err) {
    // Timeout or API error — fall back to pattern-based
    logger.debug({ err, command }, 'LLM judge fallback to pattern-based');
    return {
      isSafe: patternAssessment.suggestedAction !== 'block',
      explanation: patternAssessment.reasons.join('; ') || 'No security concerns detected (LLM unavailable)',
    };
  }
}
