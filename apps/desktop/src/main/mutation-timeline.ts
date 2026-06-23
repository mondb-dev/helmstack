import type { MutationKindCounts, MutationTimelineReport, TabId } from "../../../../packages/shared/src/index.js";
import { SELECTOR_FOR_SOURCE } from "../../../../packages/perception/src/page-selector.js";

/** Raw mutation tallies returned by the in-page sampler. */
export type RawMutationTimeline = {
  url: string;
  durationMs: number;
  byKind: MutationKindCounts;
  addedNodes: number;
  removedNodes: number;
  /** selector hint → per-kind mutation counts. */
  targets: Record<string, MutationKindCounts>;
};

const sumKinds = (k: MutationKindCounts): number => k.childList + k.attributes + k.characterData;

/**
 * Turn raw mutation tallies into a ranked report: total + per-kind counts and
 * the busiest subtrees first. Pure — unit-testable without a DOM.
 */
export function buildMutationReport(raw: RawMutationTimeline, tabId: TabId, capturedAt: number, limit = 20): MutationTimelineReport {
  const hotspots = Object.entries(raw.targets)
    .map(([selector, kinds]) => ({ selector, mutations: sumKinds(kinds), kinds }))
    .sort((a, b) => b.mutations - a.mutations || a.selector.localeCompare(b.selector))
    .slice(0, limit);

  return {
    tabId,
    url: raw.url,
    capturedAt,
    durationMs: raw.durationMs,
    totalMutations: sumKinds(raw.byKind),
    byKind: raw.byKind,
    addedNodes: raw.addedNodes,
    removedNodes: raw.removedNodes,
    hotspots
  };
}

/**
 * In-page sampler. Returns a string evaluating to a Promise<RawMutationTimeline>:
 * installs a MutationObserver, records for `durationMs`, then resolves with the
 * tallies. Must be evaluated with `awaitPromise: true`.
 */
export function mutationTimelineScript(durationMs = 1000): string {
  return `(() => new Promise((resolve) => {
    const byKind = { childList: 0, attributes: 0, characterData: 0 };
    const targets = {};
    let addedNodes = 0;
    let removedNodes = 0;

    const selectorFor = ${SELECTOR_FOR_SOURCE};

    const observer = new MutationObserver((records) => {
      for (const r of records) {
        const kind = r.type === "childList" ? "childList" : (r.type === "attributes" ? "attributes" : "characterData");
        byKind[kind]++;
        if (r.type === "childList") {
          addedNodes += r.addedNodes ? r.addedNodes.length : 0;
          removedNodes += r.removedNodes ? r.removedNodes.length : 0;
        }
        const sel = selectorFor(r.target);
        const bucket = targets[sel] || (targets[sel] = { childList: 0, attributes: 0, characterData: 0 });
        bucket[kind]++;
      }
    });

    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });

    setTimeout(() => {
      observer.disconnect();
      resolve({ url: location.href, durationMs: ${durationMs}, byKind, addedNodes, removedNodes, targets });
    }, ${durationMs});
  }))()`;
}
