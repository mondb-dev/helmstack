import { randomUUID } from "node:crypto";

import type { AssertionTransition, AssertionWatch, TabId } from "../../../../packages/shared/src/index.js";

/** The evaluation a caller supplies for a single assertion against current page state. */
export type WatchEvaluation = { pass: boolean; explanation: string };

/**
 * Registry of standing assertions, re-evaluated on each page observation. Pure
 * state machine: the evaluator is injected (so it can reuse the page-graph
 * heuristics without a circular import) and `evaluateTab` emits a transition
 * only when a watch's pass/fail state actually changes. Unit-testable.
 */
export class AssertionWatchStore {
  private readonly watches = new Map<string, AssertionWatch>();

  add(tabId: TabId, assertion: string, now: number, id: string = randomUUID()): AssertionWatch {
    const watch: AssertionWatch = { id, tabId, assertion, lastPass: null, createdAt: now };
    this.watches.set(id, watch);
    return { ...watch };
  }

  remove(id: string): boolean {
    return this.watches.delete(id);
  }

  list(tabId?: TabId): AssertionWatch[] {
    const all = [...this.watches.values()];
    return (tabId ? all.filter((w) => w.tabId === tabId) : all).map((w) => ({ ...w }));
  }

  /** Drop every watch belonging to a tab (e.g. when the tab closes). */
  clearTab(tabId: TabId): void {
    for (const [id, w] of this.watches) {
      if (w.tabId === tabId) this.watches.delete(id);
    }
  }

  /**
   * Re-evaluate every watch on `tabId` using `evaluate`, update stored state,
   * and return one transition per watch whose pass/fail value changed.
   */
  evaluateTab(tabId: TabId, evaluate: (assertion: string) => WatchEvaluation, now: number): AssertionTransition[] {
    const transitions: AssertionTransition[] = [];
    for (const watch of this.watches.values()) {
      if (watch.tabId !== tabId) continue;
      const { pass, explanation } = evaluate(watch.assertion);
      if (pass !== watch.lastPass) {
        transitions.push({
          watchId: watch.id,
          tabId,
          assertion: watch.assertion,
          pass,
          previousPass: watch.lastPass,
          explanation,
          at: now
        });
        watch.lastPass = pass;
      }
    }
    return transitions;
  }
}
