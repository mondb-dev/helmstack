import type { ApprovalPolicyKey, TabId } from "../../../../shared/src/index.js";

/** How long an approved fill/type pre-authorizes the matching submit. */
export const APPROVAL_GRANT_TTL_MS = 5 * 60_000;

type ApprovalGrant = {
  tabId: TabId;
  formId: string;
  /** Document URL the approval was given on; any other URL voids the grant. */
  url: string;
  effectTypes: Set<ApprovalPolicyKey>;
  expiresAt: number;
};

/**
 * Short-lived, single-use grants that stop a form from prompting twice.
 *
 * Rule: when a human (or, on the daemon, the agent) approves a fill/type into
 * form F on tab T, the *next* submit of F on T is not re-queued if
 *   - the tab is still on the same document URL (any navigation clears it),
 *   - the submit's effect kinds are a subset of the approved effect kinds
 *     (e.g. a signup submit adding `create_account` still asks), and
 *   - it happens within {@link APPROVAL_GRANT_TTL_MS}.
 * The grant is consumed by that submit. `block` policies always win.
 */
export class ApprovalGrantStore {
  private readonly grants: ApprovalGrant[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  record(tabId: TabId, formId: string, url: string, effectTypes: Iterable<ApprovalPolicyKey>): void {
    const types = new Set(effectTypes);
    const existing = this.grants.find((grant) => grant.tabId === tabId && grant.formId === formId && grant.url === url);
    const expiresAt = this.now() + APPROVAL_GRANT_TTL_MS;
    if (existing) {
      for (const type of types) existing.effectTypes.add(type);
      existing.expiresAt = expiresAt;
      return;
    }
    this.grants.push({ tabId, formId, url, effectTypes: types, expiresAt });
  }

  /** Consumes and returns true when a live grant covers every effect kind. */
  consume(tabId: TabId, formId: string, url: string, effectTypes: Iterable<ApprovalPolicyKey>): boolean {
    this.prune();
    const index = this.grants.findIndex((grant) => grant.tabId === tabId && grant.formId === formId);
    if (index < 0) return false;
    const grant = this.grants[index];
    if (grant.url !== url) {
      this.grants.splice(index, 1);
      return false;
    }
    if (![...effectTypes].every((type) => grant.effectTypes.has(type))) return false;
    this.grants.splice(index, 1);
    return true;
  }

  /** Drop every grant for a tab (navigation, close). */
  clearTab(tabId: TabId): void {
    for (let i = this.grants.length - 1; i >= 0; i--) {
      if (this.grants[i].tabId === tabId) this.grants.splice(i, 1);
    }
  }

  private prune(): void {
    const now = this.now();
    for (let i = this.grants.length - 1; i >= 0; i--) {
      if (this.grants[i].expiresAt <= now) this.grants.splice(i, 1);
    }
  }
}
