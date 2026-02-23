/**
 * File Content Sanitizer for Indirect Prompt Injection Prevention
 *
 * Scans file and web content before the agent reads it to detect and neutralize
 * embedded malicious prompts that could manipulate the AI's behavior.
 *
 * Attack vectors addressed:
 * - Hidden text in README files
 * - Malicious instructions in code comments
 * - Embedded prompts in web pages
 * - Unicode tricks and invisible characters
 */

import { logger } from '../logger.js';

/**
 * Patterns that indicate potential indirect prompt injection attacks
 */
const DANGEROUS_PATTERNS = [
  // Direct instruction injection
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+(all\s+)?previous\s+(instructions|commands)/i,
  /forget\s+(all\s+)?previous\s+(instructions|context)/i,

  // Role manipulation
  /you\s+are\s+now\s+(in\s+)?(\w+\s+)?mode/i,
  /switch\s+to\s+(\w+\s+)?mode/i,
  /pretend\s+(to\s+be|you\s+are)/i,

  // System-level commands
  /system:\s*(run|execute|do)/i,
  /assistant:\s*(run|execute|do)/i,

  // Conditional execution
  /before\s+(responding|answering|replying).*?(run|execute|do)/i,
  /after\s+(reading|processing).*?(run|execute|do)/i,

  // Hidden instructions
  /\[hidden\]/i,
  /\[secret\]/i,
  /<!--.*?(ignore|run|execute).*?-->/is,

  // Steganography markers
  /\u200b/g, // Zero-width space
  /\ufeff/g, // Zero-width no-break space
  /\u200c/g, // Zero-width non-joiner
  /\u200d/g, // Zero-width joiner
];

/**
 * Suspicious command patterns that might be injected
 */
const COMMAND_INJECTION_PATTERNS = [
  /curl\s+https?:\/\/[^\s]+/i,
  /wget\s+https?:\/\/[^\s]+/i,
  /bash\s+-c/i,
  /python\s+-c/i,
  /node\s+-e/i,
  /eval\s*\(/i,
  /exec\s*\(/i,
  /subprocess\.run/i,
  /child_process\.exec/i,
  /os\.system/i,
];

/**
 * HTML/Markdown tricks to hide content
 */
const HIDING_TECHNIQUES_PATTERNS = [
  // White text on white background
  /style=["'].*?color:\s*white.*?["']/i,
  /style=["'].*?opacity:\s*0/i,
  /style=["'].*?display:\s*none/i,

  // Tiny font sizes
  /style=["'].*?font-size:\s*[01]px/i,

  // Off-screen positioning
  /style=["'].*?position:\s*absolute.*?left:\s*-\d+/i,
];

export interface SanitizationResult {
  sanitized: string;
  wasModified: boolean;
  findings: string[];
  severity: 'none' | 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Sanitize file content to prevent indirect prompt injection
 *
 * @param content - The file content to sanitize
 * @param filePath - Optional file path for logging
 * @param options - Sanitization options
 * @returns Sanitization result with modified content and findings
 */
export function sanitizeFileContent(
  content: string,
  filePath?: string,
  options: {
    stripComments?: boolean;
    stripHtml?: boolean;
    maxLength?: number;
  } = {},
): SanitizationResult {
  const findings: string[] = [];
  let sanitized = content;
  let wasModified = false;
  let severity: SanitizationResult['severity'] = 'none';

  // Check for dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(sanitized)) {
      const match = sanitized.match(pattern);
      findings.push(`Dangerous instruction pattern: "${match?.[0]?.substring(0, 50)}..."`);

      // Replace with warning marker
      sanitized = sanitized.replace(pattern, '[REDACTED: SUSPICIOUS CONTENT]');
      wasModified = true;
      severity = updateSeverity(severity, 'critical');
    }
  }

  // Check for command injection attempts
  for (const pattern of COMMAND_INJECTION_PATTERNS) {
    if (pattern.test(sanitized)) {
      const match = sanitized.match(pattern);
      findings.push(`Command injection attempt: "${match?.[0]?.substring(0, 50)}..."`);
      severity = updateSeverity(severity, 'high');
      // Don't remove - might be legitimate code examples
      // Just flag for logging
    }
  }

  // Check for hiding techniques
  for (const pattern of HIDING_TECHNIQUES_PATTERNS) {
    if (pattern.test(sanitized)) {
      findings.push(`Content hiding technique detected: ${pattern.source.substring(0, 30)}...`);
      severity = updateSeverity(severity, 'medium');
    }
  }

  // Strip zero-width characters (often used in steganography)
  const zeroWidthCount = (sanitized.match(/[\u200b\ufeff\u200c\u200d]/g) || []).length;
  if (zeroWidthCount > 0) {
    sanitized = sanitized.replace(/[\u200b\ufeff\u200c\u200d]/g, '');
    findings.push(`Removed ${zeroWidthCount} zero-width characters (steganography)`);
    wasModified = true;
    severity = updateSeverity(severity, 'medium');
  }

  // Strip HTML comments if requested
  if (options.stripHtml) {
    const htmlCommentCount = (sanitized.match(/<!--[\s\S]*?-->/g) || []).length;
    if (htmlCommentCount > 0) {
      sanitized = sanitized.replace(/<!--[\s\S]*?-->/g, '[HTML COMMENT REMOVED]');
      findings.push(`Removed ${htmlCommentCount} HTML comments`);
      wasModified = true;
      severity = updateSeverity(severity, 'low');
    }
  }

  // Limit length if specified
  if (typeof options.maxLength === 'number' && sanitized.length > options.maxLength) {
    const suffix = '\n\n[Content truncated - exceeded maximum length]';
    if (options.maxLength <= suffix.length) {
      sanitized = sanitized.substring(0, options.maxLength);
    } else {
      const headLength = options.maxLength - suffix.length;
      sanitized = sanitized.substring(0, headLength) + suffix;
    }
    findings.push(`Content truncated from ${content.length} to ${options.maxLength} characters`);
    wasModified = true;
    severity = updateSeverity(severity, 'low');
  }

  // Log findings if any
  if (findings.length > 0) {
    logger.warn(
      {
        filePath,
        findings,
        severity,
        originalLength: content.length,
        sanitizedLength: sanitized.length,
      },
      '🚨 File content sanitization detected suspicious patterns',
    );
  }

  return {
    sanitized,
    wasModified,
    findings,
    severity,
  };
}

/**
 * Quick check if content should be deeply sanitized
 * Returns true if content contains ANY suspicious patterns
 */
export function shouldSanitize(content: string): boolean {
  // Quick keyword pre-filter for performance
  const suspiciousKeywords = [
    'ignore',
    'disregard',
    'forget',
    'you are now',
    'switch to',
    'pretend',
    'system:',
    'assistant:',
    'before responding',
    'hidden',
    'secret',
  ];

  const lowerContent = content.toLowerCase();
  return suspiciousKeywords.some((keyword) => lowerContent.includes(keyword));
}

/**
 * Sanitize content read from web URLs
 *
 * More aggressive sanitization for web content since it's more likely
 * to contain malicious embedded prompts.
 */
export function sanitizeWebContent(content: string, url?: string): SanitizationResult {
  return sanitizeFileContent(content, url, {
    stripComments: true,
    stripHtml: true,
    maxLength: 50000, // 50KB max for web content
  });
}

/**
 * Sanitize content from user-provided files
 *
 * Moderate sanitization - remove obvious attacks but preserve code examples
 */
export function sanitizeUserFile(content: string, filePath?: string): SanitizationResult {
  return sanitizeFileContent(content, filePath, {
    stripComments: false, // Preserve code comments
    stripHtml: false, // Preserve HTML in source files
    maxLength: 100000, // 100KB max for files
  });
}

/**
 * Update severity to the higher of current and new severity
 */
function updateSeverity(
  current: SanitizationResult['severity'],
  newSeverity: SanitizationResult['severity'],
): SanitizationResult['severity'] {
  const levels: SanitizationResult['severity'][] = ['none', 'low', 'medium', 'high', 'critical'];
  const currentLevel = levels.indexOf(current);
  const newLevel = levels.indexOf(newSeverity);
  return levels[Math.max(currentLevel, newLevel)];
}

/**
 * Get a summary of sanitization results for a batch of files
 */
export function summarizeSanitization(results: SanitizationResult[]): {
  totalFiles: number;
  modifiedFiles: number;
  criticalFindings: number;
  highFindings: number;
  mediumFindings: number;
  lowFindings: number;
} {
  return {
    totalFiles: results.length,
    modifiedFiles: results.filter((r) => r.wasModified).length,
    criticalFindings: results.filter((r) => r.severity === 'critical').length,
    highFindings: results.filter((r) => r.severity === 'high').length,
    mediumFindings: results.filter((r) => r.severity === 'medium').length,
    lowFindings: results.filter((r) => r.severity === 'low').length,
  };
}
