/**
 * Command Security Checker
 *
 * Analyzes commands for security risks and potential prompt injection attacks.
 * Foundation for LLM-as-judge pattern - can be enhanced to call Anthropic API
 * for sophisticated analysis.
 */

import { logger } from '../logger.js';

export interface CommandRiskAssessment {
  isHighRisk: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  reasons: string[];
  suggestedAction: 'allow' | 'warn' | 'block';
  safeAlternatives?: string[];
}

/**
 * Pattern-based high-risk command detection.
 * TODO: Enhance with LLM-as-judge for sophisticated analysis.
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

  // CRITICAL: Recursive file deletion
  if (/rm\s+-r(f)?.*\/(?!tmp)/i.test(command)) {
    reasons.push('rm -rf outside /tmp can delete important files');
    riskLevel = 'critical';
    safeAlternatives.push('rm specific files instead of recursive deletion');
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

  // MEDIUM: Accessing credentials
  if (/\$ANTHROPIC_API_KEY|\$CLAUDE_CODE_OAUTH_TOKEN|cat.*\.env/i.test(command)) {
    reasons.push('Command accesses sensitive credentials');
    riskLevel = 'medium';
  }

  // MEDIUM: Network access to unknown domains
  if (/(curl|wget|nc|netcat)\s+.*(?!api\.anthropic\.com|github\.com|npmjs\.org)/i.test(command)) {
    reasons.push('Network request to potentially unauthorized domain');
    riskLevel = 'medium';
  }

  // MEDIUM: Command chaining (could hide malicious operations)
  if (/;\s*\w+|&&\s*\w+|\|\|\s*\w+/i.test(command)) {
    reasons.push('Command chaining detected - review each operation');
    riskLevel = Math.max(riskLevel === 'low' ? 0 : riskLevel === 'medium' ? 1 : riskLevel === 'high' ? 2 : 3, 1) === 0 ? 'low' :
               Math.max(riskLevel === 'low' ? 0 : riskLevel === 'medium' ? 1 : riskLevel === 'high' ? 2 : 3, 1) === 1 ? 'medium' :
               Math.max(riskLevel === 'low' ? 0 : riskLevel === 'medium' ? 1 : riskLevel === 'high' ? 2 : 3, 1) === 2 ? 'high' : 'critical';
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
 * Future enhancement: Call Anthropic API to get LLM judgment on command safety.
 *
 * Example implementation:
 * ```
 * async function llmJudgeCommand(command: string, userMessage: string): Promise<boolean> {
 *   const response = await anthropic.messages.create({
 *     model: 'claude-3-haiku-20240307',
 *     max_tokens: 100,
 *     system: 'You are a security expert. Respond with SAFE or UNSAFE.',
 *     messages: [{
 *       role: 'user',
 *       content: `User asked: "${userMessage}"\nCommand to execute: "${command}"\nIs this safe?`
 *     }]
 *   });
 *   return response.content[0].text.includes('SAFE');
 * }
 * ```
 *
 * This would provide:
 * - Context-aware analysis (understands user intent)
 * - Detection of sophisticated obfuscation
 * - Natural language explanations
 */
export async function llmJudgeCommand(
  command: string,
  context: { userMessage?: string; isMain?: boolean }
): Promise<{ isSafe: boolean; explanation: string }> {
  // TODO: Implement LLM-as-judge by calling Anthropic API
  // For now, fall back to pattern-based detection
  const assessment = assessCommandRisk(command, context);

  return {
    isSafe: assessment.suggestedAction !== 'block',
    explanation: assessment.reasons.join('; ') || 'No security concerns detected',
  };
}
