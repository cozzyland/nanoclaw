/**
 * Memory Integrity Checker — Phase 3: Prevent Persistent Injection
 *
 * Takes SHA-256 snapshots of group memory files (CLAUDE.md, etc.) before
 * each agent session. After the session, diffs changes and flags suspicious
 * instruction-like additions.
 *
 * Suspicious patterns:
 * - Imperative instructions: "always do X", "never do Y", "ignore previous"
 * - Role manipulation: "you are now", "your new purpose", "act as"
 * - Hidden instructions: HTML comments, zero-width chars, base64 blocks
 * - Override attempts: "SYSTEM:", "ADMIN:", "[PRIORITY]"
 *
 * Response:
 * - HIGH/CRITICAL: revert file, alert owner via WhatsApp
 * - MEDIUM: keep changes, alert owner
 * - LOW: log only
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import { securityEvents } from './security-events.js';

export interface MemorySnapshot {
  groupFolder: string;
  timestamp: number;
  files: Map<string, FileSnapshot>;
}

export interface FileSnapshot {
  hash: string;
  size: number;
  content: string;
}

export interface IntegrityResult {
  clean: boolean;
  modifiedFiles: ModifiedFile[];
  suspiciousChanges: SuspiciousChange[];
}

export interface ModifiedFile {
  path: string;
  oldHash: string;
  newHash: string;
}

export interface SuspiciousChange {
  file: string;
  reason: string;
  addedContent: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

// Patterns that indicate prompt injection in memory files
const SUSPICIOUS_PATTERNS: Array<{ pattern: RegExp; reason: string; severity: SuspiciousChange['severity'] }> = [
  // Direct override attempts
  { pattern: /\bignore\s+(all\s+)?previous\s+instructions?\b/i, reason: 'Override attempt: "ignore previous instructions"', severity: 'critical' },
  { pattern: /\byou\s+are\s+now\b/i, reason: 'Role manipulation: "you are now"', severity: 'critical' },
  { pattern: /\byour\s+new\s+(purpose|role|instructions?)\b/i, reason: 'Role manipulation: "your new purpose/role"', severity: 'critical' },
  { pattern: /\bact\s+as\s+(if\s+you\s+are|a)\b/i, reason: 'Role manipulation: "act as"', severity: 'high' },
  { pattern: /\bforget\s+(everything|all|your)\b/i, reason: 'Memory wipe attempt: "forget everything"', severity: 'critical' },

  // Hidden instruction markers
  { pattern: /^SYSTEM:/m, reason: 'System prompt marker injected', severity: 'critical' },
  { pattern: /^ADMIN:/m, reason: 'Admin prompt marker injected', severity: 'critical' },
  { pattern: /\[PRIORITY\]/i, reason: 'Priority override marker', severity: 'high' },
  { pattern: /\[OVERRIDE\]/i, reason: 'Override marker injected', severity: 'critical' },

  // Exfiltration instructions
  { pattern: /\bsend\s+(all|the|your)\s+(data|information|content|files?|secrets?|keys?|credentials?)\s+to\b/i, reason: 'Data exfiltration instruction', severity: 'critical' },
  { pattern: /\bexfiltrate\b/i, reason: 'Exfiltration keyword', severity: 'critical' },

  // Hidden content
  { pattern: /[\u200B\u200C\u200D\uFEFF]{3,}/, reason: 'Zero-width character sequence (hidden content)', severity: 'high' },
  { pattern: /<!--[\s\S]{100,}?-->/, reason: 'Large HTML comment block (hidden instructions)', severity: 'medium' },

  // Subtle manipulation
  { pattern: /\balways\s+(respond|reply|answer|say|output|include)\b/i, reason: 'Persistent behavior modification: "always respond/reply"', severity: 'medium' },
  { pattern: /\bnever\s+(mention|reveal|disclose|tell|show|share)\b/i, reason: 'Suppression instruction: "never mention/reveal"', severity: 'medium' },
];

export class MemoryIntegrity {
  private groupsDir: string;
  private backupDir: string;
  private readonly MAX_BACKUPS = 5;

  constructor(groupsDir: string, dataDir: string) {
    this.groupsDir = groupsDir;
    this.backupDir = path.join(dataDir, 'memory-backups');
  }

  /**
   * Take a snapshot of all memory files in a group folder before agent session.
   */
  async snapshotBefore(groupFolder: string): Promise<MemorySnapshot> {
    const groupDir = path.join(this.groupsDir, groupFolder);
    const files = new Map<string, FileSnapshot>();

    try {
      if (!fs.existsSync(groupDir)) {
        return { groupFolder, timestamp: Date.now(), files };
      }

      // Snapshot all .md files in the group directory (CLAUDE.md, notes, etc.)
      const entries = fs.readdirSync(groupDir);
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        const filePath = path.join(groupDir, entry);
        try {
          const stat = fs.statSync(filePath);
          if (!stat.isFile()) continue;

          const content = fs.readFileSync(filePath, 'utf-8');
          const hash = crypto.createHash('sha256').update(content).digest('hex');

          files.set(entry, { hash, size: stat.size, content });
        } catch {
          // Skip files we can't read
        }
      }
    } catch (err) {
      logger.error({ err, groupFolder }, 'Failed to snapshot memory files');
    }

    return { groupFolder, timestamp: Date.now(), files };
  }

  /**
   * Verify memory file integrity after agent session.
   * Diffs against the before-snapshot and flags suspicious changes.
   */
  async verifyAfter(groupFolder: string, before: MemorySnapshot): Promise<IntegrityResult> {
    const groupDir = path.join(this.groupsDir, groupFolder);
    const modifiedFiles: ModifiedFile[] = [];
    const suspiciousChanges: SuspiciousChange[] = [];

    try {
      if (!fs.existsSync(groupDir)) {
        return { clean: true, modifiedFiles, suspiciousChanges };
      }

      // Check existing files for modifications
      const currentEntries = fs.readdirSync(groupDir).filter(e => e.endsWith('.md'));

      for (const entry of currentEntries) {
        const filePath = path.join(groupDir, entry);
        try {
          const stat = fs.statSync(filePath);
          if (!stat.isFile()) continue;

          const currentContent = fs.readFileSync(filePath, 'utf-8');
          const currentHash = crypto.createHash('sha256').update(currentContent).digest('hex');

          const beforeFile = before.files.get(entry);

          if (!beforeFile) {
            // New file created during session
            modifiedFiles.push({ path: entry, oldHash: '', newHash: currentHash });
            // Scan new file content for suspicious patterns
            const findings = this.scanForSuspiciousContent(currentContent);
            for (const finding of findings) {
              suspiciousChanges.push({ file: entry, ...finding });
            }
          } else if (beforeFile.hash !== currentHash) {
            // Existing file modified
            modifiedFiles.push({ path: entry, oldHash: beforeFile.hash, newHash: currentHash });

            // Scan both the added content (line diff) AND the full modified file
            // Line diff catches new injections; full scan catches cross-line injections
            // and modifications that bypass the line-based diff
            const addedContent = this.getAddedContent(beforeFile.content, currentContent);
            const textsToScan = [addedContent, currentContent].filter(Boolean);
            const seenReasons = new Set<string>();
            for (const text of textsToScan) {
              const findings = this.scanForSuspiciousContent(text);
              for (const finding of findings) {
                // Deduplicate by reason to avoid double-reporting
                if (!seenReasons.has(finding.reason)) {
                  seenReasons.add(finding.reason);
                  suspiciousChanges.push({ file: entry, ...finding });
                }
              }
            }
          }
        } catch {
          // Skip unreadable files
        }
      }

      // Handle suspicious changes
      for (const change of suspiciousChanges) {
        if (change.severity === 'high' || change.severity === 'critical') {
          // Revert to pre-session snapshot
          const beforeFile = before.files.get(change.file);
          if (beforeFile) {
            const filePath = path.join(groupDir, change.file);
            fs.writeFileSync(filePath, beforeFile.content, 'utf-8');
            logger.warn(
              { file: change.file, reason: change.reason, groupFolder },
              'Reverted suspicious memory modification',
            );
          }

          // Save backup before revert
          this.saveBackup(groupFolder, change.file, before);
        }

        securityEvents.log({
          type: 'prompt_injection',
          severity: change.severity,
          source: 'memory-integrity',
          description: `Suspicious memory modification: ${change.reason}`,
          details: {
            file: change.file,
            addedContentPreview: change.addedContent.slice(0, 200),
          },
          actionTaken: change.severity === 'high' || change.severity === 'critical'
            ? 'File reverted to pre-session state'
            : 'Logged for review',
          groupId: groupFolder,
        });
      }
    } catch (err) {
      logger.error({ err, groupFolder }, 'Memory integrity check failed');
    }

    return {
      clean: suspiciousChanges.length === 0,
      modifiedFiles,
      suspiciousChanges,
    };
  }

  /**
   * Scan text for suspicious injection patterns.
   */
  private scanForSuspiciousContent(text: string): Array<{ reason: string; addedContent: string; severity: SuspiciousChange['severity'] }> {
    const findings: Array<{ reason: string; addedContent: string; severity: SuspiciousChange['severity'] }> = [];

    for (const { pattern, reason, severity } of SUSPICIOUS_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        // Extract context around the match
        const idx = match.index || 0;
        const start = Math.max(0, idx - 50);
        const end = Math.min(text.length, idx + match[0].length + 50);
        const context = text.slice(start, end);

        findings.push({ reason, addedContent: context, severity });
      }
    }

    return findings;
  }

  /**
   * Simple line-based diff to find added content.
   */
  private getAddedContent(before: string, after: string): string {
    const beforeLines = new Set(before.split('\n'));
    const afterLines = after.split('\n');

    const added = afterLines.filter(line => !beforeLines.has(line));
    return added.join('\n');
  }

  /**
   * Save a backup of a file before reverting.
   */
  private saveBackup(groupFolder: string, fileName: string, snapshot: MemorySnapshot): void {
    try {
      const backupGroupDir = path.join(this.backupDir, groupFolder);
      fs.mkdirSync(backupGroupDir, { recursive: true });

      // Find the current version (before revert) and save it
      const groupDir = path.join(this.groupsDir, groupFolder);
      const filePath = path.join(groupDir, fileName);

      if (fs.existsSync(filePath)) {
        const currentContent = fs.readFileSync(filePath, 'utf-8');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(backupGroupDir, `${fileName}.${timestamp}.bak`);
        fs.writeFileSync(backupPath, currentContent, 'utf-8');

        // Prune old backups
        const backups = fs.readdirSync(backupGroupDir)
          .filter(f => f.startsWith(fileName) && f.endsWith('.bak'))
          .sort();
        while (backups.length > this.MAX_BACKUPS) {
          const oldest = backups.shift()!;
          fs.unlinkSync(path.join(backupGroupDir, oldest));
        }
      }
    } catch (err) {
      logger.error({ err, groupFolder, fileName }, 'Failed to save memory backup');
    }
  }
}
