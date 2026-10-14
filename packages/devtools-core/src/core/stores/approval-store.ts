import { randomUUID } from "node:crypto";

import type { BrowserOutputCommand, PendingApproval, ProposedEffect, TabId } from "../../../../shared/src/index.js";

type PendingApprovalRecord = PendingApproval;
type CreatedListener = (record: PendingApprovalRecord) => void;
type ChangedListener = (pending: PendingApprovalRecord[]) => void;

export class ApprovalStore {
  private readonly pending = new Map<string, PendingApprovalRecord>();
  private readonly createdListeners = new Set<CreatedListener>();
  private readonly changedListeners = new Set<ChangedListener>();

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
    this.emitChanged();
    return record;
  }

  /** List all approvals currently awaiting a decision, oldest first. */
  list(): PendingApprovalRecord[] {
    return [...this.pending.values()];
  }

  /**
   * Subscribe to every change of the pending set (queued, approved, rejected,
   * dropped with its tab). Fires after `onCreated` listeners, with the full list.
   */
  onChanged(listener: ChangedListener): () => void {
    this.changedListeners.add(listener);
    return () => this.changedListeners.delete(listener);
  }

  /** Drop every pending approval for a tab (e.g. it closed). Returns how many were dropped. */
  clearTab(tabId: TabId): number {
    let dropped = 0;
    for (const [id, record] of this.pending) {
      if (record.tabId === tabId) {
        this.pending.delete(id);
        dropped++;
      }
    }
    if (dropped) this.emitChanged();
    return dropped;
  }

  private emitChanged(): void {
    if (this.changedListeners.size === 0) return;
    const pending = this.list();
    for (const listener of this.changedListeners) {
      listener(pending);
    }
  }

  /** Subscribe to approval-created events for real-time agent notifications. */
  onCreated(listener: CreatedListener) {
    this.createdListeners.add(listener);
  }

  take(requestId: string): PendingApprovalRecord | null {
    const record = this.pending.get(requestId) ?? null;
    if (record) {
      this.pending.delete(requestId);
      this.emitChanged();
    }
    return record;
  }

  reject(requestId: string): PendingApprovalRecord | null {
    return this.take(requestId);
  }
}
