/**
 * Prompt Guard 2 — ML Prompt Injection Detection
 *
 * HTTP client for the Prompt Guard FastAPI service (Meta Prompt Guard 2 22M).
 * Classifies text as BENIGN, INJECTION, or JAILBREAK with a confidence score.
 *
 * Non-blocking startup: if service isn't running, detection is disabled.
 * Graceful degradation: returns BENIGN if service unavailable or slow (500ms timeout).
 */

import { logger } from '../logger.js';

export interface ClassificationResult {
  label: 'BENIGN' | 'INJECTION' | 'JAILBREAK';
  score: number;
  blocked: boolean;
}

const DEFAULT_THRESHOLD = 0.85;
const REQUEST_TIMEOUT_MS = 500;

export class PromptGuard {
  private baseUrl: string;
  private threshold: number;
  private ready = false;

  constructor(baseUrl = 'http://127.0.0.1:3003', threshold = DEFAULT_THRESHOLD) {
    this.baseUrl = baseUrl;
    this.threshold = threshold;
  }

  async init(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        this.ready = true;
        logger.info({ baseUrl: this.baseUrl }, 'Prompt Guard service connected');
      } else {
        logger.warn({ status: res.status }, 'Prompt Guard health check failed — injection detection disabled');
      }
    } catch (err) {
      logger.warn({ err }, 'Prompt Guard service not available — injection detection disabled');
    }
  }

  async classify(text: string): Promise<ClassificationResult> {
    if (!this.ready) {
      return { label: 'BENIGN', score: 0, blocked: false };
    }

    try {
      const res = await fetch(`${this.baseUrl}/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!res.ok) {
        logger.warn({ status: res.status }, 'Prompt Guard classify request failed');
        return { label: 'BENIGN', score: 0, blocked: false };
      }

      const data = (await res.json()) as { label: string; score: number };
      const label = data.label as ClassificationResult['label'];
      const score = data.score;
      const blocked = label !== 'BENIGN' && score > this.threshold;

      if (blocked) {
        logger.warn({ label, score, textLength: text.length }, 'PROMPT INJECTION DETECTED');
      }

      return { label, score, blocked };
    } catch (err) {
      // Timeout or network error — fail open
      logger.debug({ err }, 'Prompt Guard request failed, allowing message through');
      return { label: 'BENIGN', score: 0, blocked: false };
    }
  }

  isReady(): boolean {
    return this.ready;
  }
}
