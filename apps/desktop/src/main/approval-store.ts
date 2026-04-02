import { randomUUID } from "node:crypto";

import type { BrowserOutputCommand, PendingApproval, ProposedEffect, TabId } from "../../../../packages/shared/src/index.js";

type PendingApprovalRecord = PendingApproval;
type CreatedListener = (record: PendingApprovalRecord) => void;

export class ApprovalStore {
  private readonly pending = new Map<string, PendingApprovalRecord>();
  private readonly createdListeners = new Set<CreatedListener>();

  create(tabId: TabId, command: BrowserOutputCommand, effects: ProposedEffect[], summary: string): PendingApprovalRecord {
    const record: PendingApprovalRecord = {
      requestId: randomUUID(),
      tabId,
      command,
      effects,
      summary,
      createdAt: Date.now()
    };

    this.pending.set(record.requestId, record);
    for (const listener of this.createdListeners) {
      listener(record);
    }
    return record;
  }

  /** List all approvals currently awaiting a decision. */
  list(): PendingApprovalRecord[] {
    return [...this.pending.values()];
  }

  /** Subscribe to approval-created events for real-time agent notifications. */
  onCreated(listener: CreatedListener) {
    this.createdListeners.add(listener);
  }

  take(requestId: string): PendingApprovalRecord | null {
    const record = this.pending.get(requestId) ?? null;
    if (record) {
      this.pending.delete(requestId);
    }
    return record;
  }

  reject(requestId: string): PendingApprovalRecord | null {
    return this.take(requestId);
  }
}
