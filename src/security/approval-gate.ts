/**
 * Action Approval Gate — Phase 2: Human-in-the-Loop Confirmation
 *
 * High-risk agent actions (purchases, emails, new contacts, deletions)
 * require explicit human approval via WhatsApp before execution.
 *
 * Flow:
 * 1. Agent requests action via IPC
 * 2. ApprovalGate classifies risk → if HIGH/CRITICAL, send approval request
 * 3. User replies YES/NO in WhatsApp
 * 4. Action executes or is denied
 *
 * Default-deny on timeout. Audit trail for every request.
 * State persisted in SQLite (survives process restarts).
 */

import crypto from 'crypto';
import { logger } from '../logger.js';
import { securityEvents } from './security-events.js';

export type ActionType =
  | 'purchase'
  | 'send_email'
  | 'new_contact'
  | 'delete_files'
  | 'modify_config'
  | 'credential_access';

export interface PendingAction {
  id: string;
  type: ActionType;
  description: string;
  groupFolder: string;
  chatJid: string;
  requestedAt: number;
  timeoutMs: number;
  context: Record<string, unknown>;
}

export interface ApprovalResult {
  approved: boolean;
  respondedBy?: string;
  respondedAt?: number;
  timedOut: boolean;
}

export interface ApprovalGateDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  ownerJid: string; // Only the owner can approve
  createApprovalRequest: (request: ApprovalRequest) => void;
  getPendingApprovals: (chatJid: string) => ApprovalRequestLike[];
  resolveApproval: (id: string, approved: boolean, respondedBy: string) => void;
  getExpiredApprovals: () => ApprovalRequestLike[];
  expireApproval: (id: string) => void;
}

/** Relaxed type for DB rows where status is a generic string */
export interface ApprovalRequestLike {
  id: string;
  type: string;
  description: string;
  group_folder: string;
  chat_jid: string;
  requested_at: string;
  timeout_ms: number;
  status: string;
  responded_by?: string | null;
  responded_at?: string | null;
  context_json?: string | null;
}

export interface ApprovalRequest {
  id: string;
  type: string;
  description: string;
  group_folder: string;
  chat_jid: string;
  requested_at: string;
  timeout_ms: number;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  responded_by?: string;
  responded_at?: string;
  context_json: string;
}

export class ApprovalGate {
  private deps: ApprovalGateDeps;
  private timeoutChecker: ReturnType<typeof setInterval> | null = null;
  // Callbacks waiting for approval resolution
  private pendingCallbacks = new Map<string, {
    resolve: (result: ApprovalResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(deps: ApprovalGateDeps) {
    this.deps = deps;
    // Check for expired approvals every 30 seconds
    this.timeoutChecker = setInterval(() => this.checkTimeouts(), 30_000);
  }

  /**
   * Request approval for a high-risk action.
   * Sends a WhatsApp message and waits for response or timeout.
   */
  async requestApproval(action: PendingAction): Promise<ApprovalResult> {
    const request: ApprovalRequest = {
      id: action.id,
      type: action.type,
      description: action.description,
      group_folder: action.groupFolder,
      chat_jid: action.chatJid,
      requested_at: new Date(action.requestedAt).toISOString(),
      timeout_ms: action.timeoutMs,
      status: 'pending',
      context_json: JSON.stringify(action.context),
    };

    // Persist to database
    this.deps.createApprovalRequest(request);

    // Send approval message to chat
    const timeoutMin = Math.round(action.timeoutMs / 60_000);
    const message = [
      '[APPROVAL REQUIRED]',
      '',
      action.description,
      '',
      `Reply YES to approve or NO to deny.`,
      `Auto-denied in ${timeoutMin} minutes.`,
    ].join('\n');

    await this.deps.sendMessage(action.chatJid, message);

    logger.info(
      { actionId: action.id, type: action.type, chatJid: action.chatJid },
      'Approval requested',
    );

    securityEvents.log({
      type: 'high_risk_command',
      severity: 'high',
      source: 'approval-gate',
      description: `Approval requested: ${action.type} — ${action.description}`,
      details: { actionId: action.id, type: action.type },
      actionTaken: 'Awaiting human approval',
      groupId: action.groupFolder,
    });

    // Wait for response or timeout
    return new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCallbacks.delete(action.id);
        this.deps.expireApproval(action.id);

        logger.warn({ actionId: action.id, type: action.type }, 'Approval timed out — denied');

        resolve({
          approved: false,
          timedOut: true,
        });
      }, action.timeoutMs);

      this.pendingCallbacks.set(action.id, { resolve, timer });
    });
  }

  /**
   * Handle a potential approval response from a WhatsApp message.
   * Returns true if the message was an approval response (consumed).
   */
  handleResponse(messageContent: string, senderJid: string, chatJid: string): boolean {
    const trimmed = messageContent.trim().toLowerCase();
    const isApproval = /^(yes|approve|confirmed?|ok|go ahead)$/i.test(trimmed);
    const isDenial = /^(no|deny|denied|reject|cancel|stop)$/i.test(trimmed);

    if (!isApproval && !isDenial) return false;

    // Find pending approvals for this chat
    const pending = this.deps.getPendingApprovals(chatJid);
    if (pending.length === 0) return false;

    // Only owner can approve
    const senderBase = senderJid.split(':')[0].split('@')[0];
    const ownerBase = this.deps.ownerJid.split(':')[0].split('@')[0];
    if (senderBase !== ownerBase) {
      logger.warn(
        { senderJid, ownerJid: this.deps.ownerJid },
        'Non-owner attempted to respond to approval request',
      );
      return false;
    }

    // Take the most recent pending request
    const request = pending[pending.length - 1];
    const approved = isApproval;

    // Update database
    this.deps.resolveApproval(request.id, approved, senderJid);

    // Resolve the waiting callback
    const callback = this.pendingCallbacks.get(request.id);
    if (callback) {
      clearTimeout(callback.timer);
      this.pendingCallbacks.delete(request.id);
      callback.resolve({
        approved,
        respondedBy: senderJid,
        respondedAt: Date.now(),
        timedOut: false,
      });
    }

    logger.info(
      { actionId: request.id, approved, respondedBy: senderJid },
      `Approval ${approved ? 'granted' : 'denied'}`,
    );

    securityEvents.log({
      type: 'high_risk_command',
      severity: approved ? 'medium' : 'high',
      source: 'approval-gate',
      description: `Action ${approved ? 'approved' : 'denied'}: ${request.type}`,
      details: { actionId: request.id, approved, respondedBy: senderJid },
      actionTaken: approved ? 'Action will be executed' : 'Action blocked by user',
      groupId: request.group_folder,
      userId: senderJid,
    });

    return true;
  }

  /**
   * Check for expired approvals and clean up.
   */
  private checkTimeouts(): void {
    const expired = this.deps.getExpiredApprovals();
    for (const request of expired) {
      this.deps.expireApproval(request.id);

      const callback = this.pendingCallbacks.get(request.id);
      if (callback) {
        clearTimeout(callback.timer);
        this.pendingCallbacks.delete(request.id);
        callback.resolve({ approved: false, timedOut: true });
      }
    }
  }

  /**
   * Classify an IPC action's risk level.
   */
  static classifyRisk(
    actionType: string,
    details: Record<string, unknown>,
  ): { riskLevel: 'low' | 'medium' | 'high' | 'critical'; actionType?: ActionType } {
    // Purchases
    if (actionType === 'purchase' || actionType === 'checkout' || actionType === 'place_order') {
      const amount = typeof details.amount === 'number' ? details.amount : 0;
      return {
        riskLevel: amount > 50 ? 'critical' : 'high',
        actionType: 'purchase',
      };
    }

    // Email sending
    if (actionType === 'send_email') {
      return { riskLevel: 'critical', actionType: 'send_email' };
    }

    // File deletion
    if (actionType === 'delete_files' || actionType === 'bulk_delete') {
      return { riskLevel: 'high', actionType: 'delete_files' };
    }

    // Config modification
    if (actionType === 'modify_config' || actionType === 'update_config') {
      return { riskLevel: 'critical', actionType: 'modify_config' };
    }

    // Default: low risk
    return { riskLevel: 'low' };
  }

  shutdown(): void {
    if (this.timeoutChecker) {
      clearInterval(this.timeoutChecker);
      this.timeoutChecker = null;
    }
    // Clean up pending callbacks
    for (const [id, callback] of this.pendingCallbacks) {
      clearTimeout(callback.timer);
      callback.resolve({ approved: false, timedOut: true });
    }
    this.pendingCallbacks.clear();
  }
}
