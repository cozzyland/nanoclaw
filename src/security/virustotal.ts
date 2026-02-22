/**
 * VirusTotal Scanner — Phase 4: Background Hash-Based Malware Scanning
 *
 * Provides a second opinion after ClamAV by checking file SHA-256 hashes
 * against VirusTotal's database of 70+ antivirus engines.
 *
 * Key properties:
 * - Hash-only lookups (never uploads files — privacy safe)
 * - Async background scanning (zero latency impact on message delivery)
 * - Client-side rate limiting (4 req/min, free tier: 500/day)
 * - API key from macOS Keychain
 */

import { execSync } from 'child_process';
import { logger } from '../logger.js';
import { securityEvents } from './security-events.js';

export interface VTResult {
  status: 'clean' | 'malicious' | 'not_found' | 'rate_limited' | 'error';
  malicious?: number;
  totalEngines?: number;
  detectionNames?: string[];
}

export class VirusTotalScanner {
  private apiKey: string | null = null;
  private ready = false;

  // Rate limiting: max 4 requests per minute
  private requestTimestamps: number[] = [];
  private readonly MAX_REQUESTS_PER_MINUTE = 4;

  // Hash dedup cache: don't re-scan same hash within 24 hours
  private hashCache = new Map<string, { result: VTResult; expiry: number }>();
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  async init(): Promise<void> {
    try {
      // Try to load API key from macOS Keychain
      const key = execSync(
        'security find-generic-password -a "cozzymini" -s "virustotal-api-key" -w 2>/dev/null',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();

      if (key && key.length > 10) {
        this.apiKey = key;
        this.ready = true;
        logger.info('VirusTotal scanner initialized (API key from Keychain)');
      } else {
        logger.warn('VirusTotal API key not found in Keychain — scanner disabled');
      }
    } catch {
      logger.warn(
        'VirusTotal API key not configured — scanner disabled. ' +
        'To enable: security add-generic-password -a "cozzymini" -s "virustotal-api-key" -w "YOUR_KEY" -U',
      );
    }
  }

  isConfigured(): boolean {
    return this.ready;
  }

  /**
   * Look up a file hash in VirusTotal's database.
   * Returns detection results if the hash is known.
   *
   * This is a hash-only lookup — no file data is sent to VirusTotal.
   */
  async scanHash(sha256: string, label?: string): Promise<VTResult> {
    if (!this.ready || !this.apiKey) {
      return { status: 'error' };
    }

    // Check cache
    const cached = this.hashCache.get(sha256);
    if (cached && cached.expiry > Date.now()) {
      return cached.result;
    }

    // Rate limiting
    if (!this.checkRateLimit()) {
      logger.debug({ sha256 }, 'VirusTotal rate limited — skipping');
      return { status: 'rate_limited' };
    }

    try {
      const response = await fetch(
        `https://www.virustotal.com/api/v3/files/${sha256}`,
        {
          headers: { 'x-apikey': this.apiKey },
          signal: AbortSignal.timeout(5000), // 5 second timeout
        },
      );

      if (response.status === 404) {
        // Hash not in VT database — file has never been seen
        const result: VTResult = { status: 'not_found' };
        this.cacheResult(sha256, result);
        return result;
      }

      if (response.status === 429) {
        return { status: 'rate_limited' };
      }

      if (!response.ok) {
        logger.warn({ status: response.status, sha256 }, 'VirusTotal API error');
        return { status: 'error' };
      }

      const data = await response.json() as {
        data: {
          attributes: {
            last_analysis_stats: {
              malicious: number;
              undetected: number;
              suspicious: number;
              harmless: number;
            };
            last_analysis_results?: Record<string, {
              category: string;
              result: string | null;
            }>;
          };
        };
      };

      const stats = data.data.attributes.last_analysis_stats;
      const totalEngines = stats.malicious + stats.undetected + stats.suspicious + stats.harmless;

      if (stats.malicious > 0) {
        // Extract detection names
        const detectionNames: string[] = [];
        const results = data.data.attributes.last_analysis_results;
        if (results) {
          for (const [engine, result] of Object.entries(results)) {
            if (result.category === 'malicious' && result.result) {
              detectionNames.push(`${engine}: ${result.result}`);
            }
          }
        }

        const vtResult: VTResult = {
          status: 'malicious',
          malicious: stats.malicious,
          totalEngines,
          detectionNames: detectionNames.slice(0, 5), // Top 5 detections
        };

        this.cacheResult(sha256, vtResult);

        // Log security event
        securityEvents.log({
          type: 'media_file_rejected',
          severity: 'critical',
          source: 'virustotal',
          description: `VirusTotal: ${stats.malicious}/${totalEngines} engines flagged file as malicious`,
          details: { sha256, label, malicious: stats.malicious, totalEngines, detections: detectionNames.slice(0, 3) },
          actionTaken: 'Alert sent (post-delivery background scan)',
        });

        logger.error(
          { sha256, label, malicious: stats.malicious, totalEngines },
          'VIRUSTOTAL: File flagged as malicious',
        );

        return vtResult;
      }

      const cleanResult: VTResult = { status: 'clean', malicious: 0, totalEngines };
      this.cacheResult(sha256, cleanResult);
      return cleanResult;

    } catch (err) {
      logger.debug({ err, sha256 }, 'VirusTotal scan failed');
      return { status: 'error' };
    }
  }

  private checkRateLimit(): boolean {
    const now = Date.now();
    // Remove timestamps older than 1 minute
    this.requestTimestamps = this.requestTimestamps.filter(t => now - t < 60_000);

    if (this.requestTimestamps.length >= this.MAX_REQUESTS_PER_MINUTE) {
      return false;
    }

    this.requestTimestamps.push(now);
    return true;
  }

  private cacheResult(sha256: string, result: VTResult): void {
    this.hashCache.set(sha256, {
      result,
      expiry: Date.now() + this.CACHE_TTL_MS,
    });

    // Prune cache if too large
    if (this.hashCache.size > 1000) {
      const now = Date.now();
      for (const [key, value] of this.hashCache) {
        if (value.expiry < now) {
          this.hashCache.delete(key);
        }
      }
    }
  }
}
