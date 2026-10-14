import { randomUUID } from "node:crypto";

import type {
  ApprovalOutcome,
  ApprovalResolution,
  BrowserOutputCommand,
  PendingApproval,
  ProposedEffect,
  TabId
} from "../../../../shared/src/index.js";

type PendingApprovalRecord = PendingApproval;
type CreatedListener = (record: PendingApprovalRecord) => void;
type ChangedListener = (pending: PendingApprovalRecord[]) => void;
type ResolvedListener = (resolution: ApprovalResolution) => void;

/** Unanswered approvals lapse after this long (overridable per store). */
export const DEFAULT_APPROVAL_TTL_MS = 10 * 60_000;

/** Reason given to the agent when the page an approval was asked on is gone. */
export const PAGE_CHANGED_REASON = "Page changed before approval — ask again.";

/** How many settled requests are remembered so a late approve/reject explains itself. */
const RESOLVED_HISTORY = 200;

export type ApprovalStoreOptions = {
  /** Lifetime of a pending approval in ms. `0` or less disables expiry. */
  ttlMs?: number;
  now?: () => number;
};

/** The page an approval is bound to. */
export type ApprovalPageContext = { url?: string };

/**
 * Same page for approval purposes: identical URL once the fragment is dropped.
 * A query-string change counts as a different page (it usually selects
 * different content, e.g. `?id=` or a search), so it cancels.
 */
export function isSameApprovalPage(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return stripFragment(a) === stripFragment(b);
}

function stripFragment(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    const hash = url.indexOf("#");
    return hash < 0 ? url : url.slice(0, hash);
  }
}

function originOf(url: string): string | undefined {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

export class ApprovalStore {
  private readonly pending = new Map<string, PendingApprovalRecord>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly resolved = new Map<string, ApprovalResolution>();
  private readonly createdListeners = new Set<CreatedListener>();
  private readonly changedListeners = new Set<ChangedListener>();
  private readonly resolvedListeners = new Set<ResolvedListener>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: ApprovalStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  create(
    tabId: TabId,
    command: BrowserOutputCommand,
    effects: ProposedEffect[],
    summary: string,
    page: ApprovalPageContext = {}
  ): PendingApprovalRecord {
    const createdAt = this.now();
    const origin = page.url ? originOf(page.url) : undefined;
    const record: PendingApprovalRecord = {
      requestId: randomUUID(),
      tabId,
      command,
      effects,
      summary,
      createdAt,
      ...(page.url ? { url: page.url } : {}),
      ...(origin ? { origin } : {}),
      ...(this.ttlMs > 0 ? { expiresAt: createdAt + this.ttlMs } : {})
    };

    this.pending.set(record.requestId, record);
    if (this.ttlMs > 0) {
      const timer = setTimeout(() => this.expire(record.requestId), this.ttlMs);
      timer.unref?.();
      this.timers.set(record.requestId, timer);
    }
    for (const listener of this.createdListeners) {
      listener(record);
    }
    this.emitChanged();
    return record;
  }

  /** List all approvals currently awaiting a decision, oldest first. */
  list(): PendingApprovalRecord[] {
    this.expireDue();
    return [...this.pending.values()];
  }

  get(requestId: string): PendingApprovalRecord | null {
    this.expireDue();
    return this.pending.get(requestId) ?? null;
  }

  /**
   * Subscribe to every change of the pending set (queued, approved, rejected,
   * cancelled, expired). Fires after `onCreated` listeners, with the full list.
   */
  onChanged(listener: ChangedListener): () => void {
    this.changedListeners.add(listener);
    return () => this.changedListeners.delete(listener);
  }

  /** Subscribe to every settled approval (approved, rejected, cancelled, expired). */
  onResolved(listener: ResolvedListener): () => void {
    this.resolvedListeners.add(listener);
    return () => this.resolvedListeners.delete(listener);
  }

  /** Subscribe to approval-created events for real-time agent notifications. */
  onCreated(listener: CreatedListener) {
    this.createdListeners.add(listener);
  }

  /**
   * Cancel every pending approval for a tab (main-frame navigation, close).
   * With `keepUrl`, approvals bound to that same page (fragment-only change)
   * survive. Returns how many were cancelled.
   */
  cancelTab(tabId: TabId, reason: string, keepUrl?: string): number {
    const doomed = [...this.pending.values()].filter(
      (record) => record.tabId === tabId && !(keepUrl && isSameApprovalPage(record.url, keepUrl))
    );
    for (const record of doomed) this.remove(record.requestId);
    for (const record of doomed) this.recordResolution(record, "cancelled", reason);
    if (doomed.length) this.emitChanged();
    return doomed.length;
  }

  /** Back-compat alias: drop a closed tab's approvals. */
  clearTab(tabId: TabId): number {
    return this.cancelTab(tabId, `${PAGE_CHANGED_REASON} (tab closed)`);
  }

  /** Cancel one pending approval (e.g. the approve-time URL check failed). */
  cancel(requestId: string, reason: string): PendingApprovalRecord | null {
    const record = this.pending.get(requestId);
    if (!record) return null;
    this.remove(requestId);
    this.recordResolution(record, "cancelled", reason);
    this.emitChanged();
    return record;
  }

  /**
   * Remove an approval to run it. The caller reports the outcome with
   * {@link settle} once the command finished.
   */
  take(requestId: string): PendingApprovalRecord | null {
    this.expireDue();
    const record = this.pending.get(requestId) ?? null;
    if (record) {
      this.remove(requestId);
      this.emitChanged();
    }
    return record;
  }

  reject(requestId: string): PendingApprovalRecord | null {
    const record = this.take(requestId);
    if (record) this.recordResolution(record, "rejected");
    return record;
  }

  /** Report how a taken approval ended. */
  settle(record: PendingApprovalRecord, outcome: ApprovalOutcome, extra: { reason?: string; status?: ApprovalResolution["status"] } = {}): void {
    this.recordResolution(record, outcome, extra.reason, extra.status);
  }

  /** How a no-longer-pending request ended, if it is still remembered. */
  resolution(requestId: string): ApprovalResolution | null {
    this.expireDue();
    return this.resolved.get(requestId) ?? null;
  }

  private expire(requestId: string): void {
    const record = this.pending.get(requestId);
    if (!record) return;
    this.remove(requestId);
    const minutes = Math.round(this.ttlMs / 60_000);
    const window = minutes >= 1 ? `${minutes} min` : `${Math.round(this.ttlMs / 1000)} s`;
    this.recordResolution(record, "expired", `Approval expired after ${window} without a decision — ask again.`);
    this.emitChanged();
  }

  /** Timers can lag (sleep, busy loop): never hand out an approval past its deadline. */
  private expireDue(): void {
    const now = this.now();
    for (const record of [...this.pending.values()]) {
      if (record.expiresAt !== undefined && record.expiresAt <= now) this.expire(record.requestId);
    }
  }

  private remove(requestId: string): void {
    this.pending.delete(requestId);
    const timer = this.timers.get(requestId);
    if (timer) clearTimeout(timer);
    this.timers.delete(requestId);
  }

  private recordResolution(record: PendingApprovalRecord, outcome: ApprovalOutcome, reason?: string, status?: ApprovalResolution["status"]): void {
    const resolution: ApprovalResolution = {
      requestId: record.requestId,
      tabId: record.tabId,
      outcome,
      ...(reason ? { reason } : {}),
      ...(status ? { status } : {}),
      ...(record.url ? { url: record.url } : {}),
      ...(record.origin ? { origin: record.origin } : {}),
      resolvedAt: this.now()
    };
    this.resolved.set(record.requestId, resolution);
    if (this.resolved.size > RESOLVED_HISTORY) {
      const oldest = this.resolved.keys().next().value;
      if (oldest !== undefined) this.resolved.delete(oldest);
    }
    for (const listener of this.resolvedListeners) listener(resolution);
  }

  private emitChanged(): void {
    if (this.changedListeners.size === 0) return;
    const pending = [...this.pending.values()];
    for (const listener of this.changedListeners) {
      listener(pending);
    }
  }
}
