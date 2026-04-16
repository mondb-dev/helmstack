import { randomUUID } from "node:crypto";

import type { HumanHandoffRecord, TabId } from "../../../../packages/shared/src/index.js";

/**
 * In-memory store for pending human-handoff requests.
 *
 * When an agent issues `{ type: "await_human", reason: "captcha" | "2fa" | ... }`,
 * a HandoffRecord is created here. The UI surfaces it as a modal prompt.
 * When the user clicks "Done", `resolve()` removes it and the agent is unblocked.
 */
export class HandoffStore {
  private readonly pending = new Map<string, HumanHandoffRecord>();

  create(
    tabId: TabId,
    reason: HumanHandoffRecord["reason"],
    details: Pick<HumanHandoffRecord, "relatedTabIds" | "groupId" | "origin" | "title"> = { relatedTabIds: [tabId] }
  ): HumanHandoffRecord {
    const record: HumanHandoffRecord = {
      requestId: randomUUID(),
      tabId,
      relatedTabIds: details.relatedTabIds.length ? details.relatedTabIds : [tabId],
      reason,
      groupId: details.groupId,
      origin: details.origin,
      title: details.title,
      createdAt: Date.now()
    };
    this.pending.set(record.requestId, record);
    return record;
  }

  list(): HumanHandoffRecord[] {
    return [...this.pending.values()];
  }

  /** Remove and return the record if it exists. Returns null if already gone. */
  take(requestId: string): HumanHandoffRecord | null {
    const record = this.pending.get(requestId) ?? null;
    this.pending.delete(requestId);
    return record;
  }
}
