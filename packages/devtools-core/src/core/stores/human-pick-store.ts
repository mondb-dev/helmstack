import type { ElementPickResult, HumanElementPick, TabId } from "../../../../shared/src/index.js";

/** Default size of the cross-tab pick history. */
export const HUMAN_PICK_HISTORY_LIMIT = 10;

/**
 * Elements the human selected with "Select for agent": the latest pick per
 * tab plus a bounded cross-tab history (newest first). In memory only.
 */
export class HumanPickStore {
  private readonly latest = new Map<TabId, HumanElementPick>();
  private readonly history: HumanElementPick[] = [];

  constructor(private readonly historyLimit = HUMAN_PICK_HISTORY_LIMIT) {}

  /** Records a completed pick; cancelled picks (`picked: false`) are ignored and return null. */
  record(tabId: TabId, pick: ElementPickResult, now = Date.now()): HumanElementPick | null {
    if (!pick.picked) return null;
    const entry: HumanElementPick = { tabId, pickedAt: now, pick: { ...pick, tabId } };
    this.latest.set(tabId, entry);
    this.history.unshift(entry);
    if (this.history.length > this.historyLimit) this.history.length = this.historyLimit;
    return clone(entry);
  }

  latestFor(tabId: TabId): HumanElementPick | null {
    const entry = this.latest.get(tabId);
    return entry ? clone(entry) : null;
  }

  /** Newest first. */
  list(): HumanElementPick[] {
    return this.history.map(clone);
  }

  /** Forget a closed tab's latest pick (history keeps it until it ages out). */
  clearTab(tabId: TabId): void {
    this.latest.delete(tabId);
  }
}

function clone(entry: HumanElementPick): HumanElementPick {
  return { ...entry, pick: { ...entry.pick } };
}
