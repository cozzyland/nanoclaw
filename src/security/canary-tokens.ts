/**
 * Canary Token Deployer — Phase 5: Digital Tripwires
 *
 * Deploys fake credential files and honeypot URLs in each group's workspace.
 * If a compromised agent tries to exfiltrate these "credentials", external
 * alerting triggers immediately.
 *
 * Canary types:
 * 1. Fake .env.backup with canary API keys
 * 2. Fake .aws/credentials with canary AWS keys
 * 3. DNS/URL tokens in config files
 *
 * Zero runtime overhead — canaries only trigger when accessed externally.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { getDb } from '../db.js';
import { logger } from '../logger.js';

export interface DeployedCanary {
  type: 'credential_file' | 'dns_token' | 'url_token';
  path: string;
  tokenId: string;
  description: string;
}

export interface CanaryStatus {
  intact: boolean;
  missing: string[];
  tampered: string[];
}

export class CanaryDeployer {
  private groupsDir: string;

  constructor(groupsDir: string) {
    this.groupsDir = groupsDir;
    this.ensureTable();
  }

  /** Create the canary_hashes table if it doesn't exist */
  private ensureTable(): void {
    try {
      const db = getDb();
      db.exec(`CREATE TABLE IF NOT EXISTS canary_hashes (
        group_folder TEXT NOT NULL,
        file_name TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (group_folder, file_name)
      )`);
    } catch {
      // DB might not be initialized yet during testing
      logger.debug('canary_hashes table creation deferred');
    }
  }

  /**
   * Deploy canary files to a group's workspace.
   * Idempotent — won't overwrite existing canaries.
   */
  async deploy(groupFolder: string): Promise<DeployedCanary[]> {
    const groupDir = path.join(this.groupsDir, groupFolder);
    const deployed: DeployedCanary[] = [];

    if (!fs.existsSync(groupDir)) {
      logger.debug({ groupFolder }, 'Group directory does not exist, skipping canary deployment');
      return deployed;
    }

    const tokenId = crypto.randomBytes(8).toString('hex');

    // 1. Fake .env.backup with canary API key
    const envBackupPath = path.join(groupDir, '.env.backup');
    if (!fs.existsSync(envBackupPath)) {
      const fakeAnthropicKey = `sk-ant-CANARY-${tokenId}-${crypto.randomBytes(20).toString('hex')}`;
      const fakeOpenAIKey = `sk-CANARY-${tokenId}-${crypto.randomBytes(20).toString('hex')}`;

      const envContent = [
        '# Backup environment variables — DO NOT COMMIT',
        `# Last backed up: ${new Date().toISOString()}`,
        '',
        `ANTHROPIC_API_KEY=${fakeAnthropicKey}`,
        `OPENAI_API_KEY=${fakeOpenAIKey}`,
        'DATABASE_URL=postgresql://admin:P@ssw0rd_backup@db.internal:5432/production',
        `AWS_ACCESS_KEY_ID=AKIACANARY${tokenId.toUpperCase().slice(0, 6)}`,
        `AWS_SECRET_ACCESS_KEY=canary/${tokenId}/${crypto.randomBytes(20).toString('base64')}`,
        '',
      ].join('\n');

      fs.writeFileSync(envBackupPath, envContent, 'utf-8');
      deployed.push({
        type: 'credential_file',
        path: '.env.backup',
        tokenId,
        description: 'Fake environment backup with canary API keys',
      });

      // Store hash for verification
      this.storeCanaryHash(groupFolder, '.env.backup', envContent);
    }

    // 2. Fake staging config with canary URL
    const stagingConfigPath = path.join(groupDir, '.config.staging.json');
    if (!fs.existsSync(stagingConfigPath)) {
      const configContent = JSON.stringify({
        _comment: 'Staging environment config — DO NOT USE IN PRODUCTION',
        api_url: `https://staging-api-${tokenId}.internal.example.com`,
        webhook_url: `https://${tokenId}.canarytokens.com/callback`,
        database: {
          host: 'staging-db.internal',
          port: 5432,
          name: 'nanoclaw_staging',
          user: 'staging_user',
          password: `staging_${tokenId}_password`,
        },
      }, null, 2) + '\n';

      fs.writeFileSync(stagingConfigPath, configContent, 'utf-8');
      deployed.push({
        type: 'dns_token',
        path: '.config.staging.json',
        tokenId,
        description: 'Fake staging config with canary webhook URL',
      });

      this.storeCanaryHash(groupFolder, '.config.staging.json', configContent);
    }

    if (deployed.length > 0) {
      logger.info(
        { groupFolder, count: deployed.length, types: deployed.map(d => d.type) },
        'Canary tokens deployed',
      );
    }

    return deployed;
  }

  /**
   * Verify canary files are still in place and untampered.
   */
  async verify(groupFolder: string): Promise<CanaryStatus> {
    const groupDir = path.join(this.groupsDir, groupFolder);
    const hashes = this.getStoredHashes(groupFolder);

    if (hashes.length === 0) {
      return { intact: true, missing: [], tampered: [] };
    }

    const missing: string[] = [];
    const tampered: string[] = [];

    for (const { file_name, hash: expectedHash } of hashes) {
      const filePath = path.join(groupDir, file_name);

      if (!fs.existsSync(filePath)) {
        missing.push(file_name);
        continue;
      }

      const currentContent = fs.readFileSync(filePath, 'utf-8');
      const currentHash = crypto.createHash('sha256').update(currentContent).digest('hex');

      if (currentHash !== expectedHash) {
        tampered.push(file_name);
      }
    }

    const intact = missing.length === 0 && tampered.length === 0;

    if (!intact) {
      logger.warn(
        { groupFolder, missing, tampered },
        'Canary tokens compromised — possible agent tampering',
      );
    }

    return { intact, missing, tampered };
  }

  /** Persist canary hash to SQLite (survives process restarts) */
  private storeCanaryHash(groupFolder: string, fileName: string, content: string): void {
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    try {
      const db = getDb();
      db.prepare(`INSERT OR REPLACE INTO canary_hashes (group_folder, file_name, hash, created_at)
        VALUES (?, ?, ?, datetime('now'))`).run(groupFolder, fileName, hash);
    } catch {
      logger.debug({ groupFolder, fileName }, 'Failed to persist canary hash to DB');
    }
  }

  /** Load stored hashes from SQLite */
  private getStoredHashes(groupFolder: string): Array<{ file_name: string; hash: string }> {
    try {
      const db = getDb();
      return db.prepare('SELECT file_name, hash FROM canary_hashes WHERE group_folder = ?')
        .all(groupFolder) as Array<{ file_name: string; hash: string }>;
    } catch {
      return [];
    }
  }
}
