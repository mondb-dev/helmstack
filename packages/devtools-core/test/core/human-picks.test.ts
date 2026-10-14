/**
 * "Select for agent": the core records the human's shell picks (latest per tab
 * plus a bounded cross-tab history) and announces them to listeners.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ElementPickResult, HumanElementPick, TabId } from "../../../shared/src/index.js";
import { HelmstackCore } from "../../src/core/helmstack-core.js";
import { HUMAN_PICK_HISTORY_LIMIT, HumanPickStore } from "../../src/core/stores/human-pick-store.js";
import { FakeBackend } from "./fakes.js";

function pickResult(tabId: TabId, overrides: Partial<ElementPickResult> = {}): ElementPickResult {
  return {
    tabId, url: "https://a.test/", capturedAt: 1, picked: true,
    selector: "button.cta", tagName: "BUTTON", text: "Buy now", id: null,
    ...overrides
  };
}

let dataDir: string;
let backend: FakeBackend;
let core: HelmstackCore;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "helmstack-picks-"));
  backend = new FakeBackend();
  core = new HelmstackCore(backend, { dataDir });
});

afterEach(() => {
  core.dispose();
  rmSync(dataDir, { recursive: true, force: true });
});

async function openTab(): Promise<TabId> {
  const tabs = await core.createTab("https://a.test/");
  return tabs.at(-1)!.id;
}

describe("HelmstackCore human picks", () => {
  it("records the latest pick per tab with pickedAt and notifies listeners", async () => {
    const t1 = await openTab();
    const t2 = await openTab();
    const seen: HumanElementPick[] = [];
    core.onElementPicked((p) => seen.push(p));

    expect(core.getLatestPick(t1)).toBeNull();
    const first = core.recordHumanPick(t1, pickResult(t1, { selector: "#a" }));
    core.recordHumanPick(t1, pickResult(t1, { selector: "#b" }));
    core.recordHumanPick(t2, pickResult(t2, { selector: "#c" }));

    expect(first).toMatchObject({ tabId: t1, pick: { selector: "#a" } });
    expect(typeof first!.pickedAt).toBe("number");
    expect(core.getLatestPick(t1)!.pick.selector).toBe("#b");
    expect(core.getLatestPick(t2)!.pick.selector).toBe("#c");
    expect(core.listPicks().map((p) => p.pick.selector)).toEqual(["#c", "#b", "#a"]);
    expect(seen.map((p) => p.pick.selector)).toEqual(["#a", "#b", "#c"]);
  });

  it("ignores cancelled picks and unknown tabs", async () => {
    const t1 = await openTab();
    const seen: HumanElementPick[] = [];
    core.onElementPicked((p) => seen.push(p));
    expect(core.recordHumanPick(t1, pickResult(t1, { picked: false, selector: "" }))).toBeNull();
    expect(core.recordHumanPick("nope" as TabId, pickResult("nope" as TabId))).toBeNull();
    expect(core.getLatestPick(t1)).toBeNull();
    expect(core.listPicks()).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("returns copies, forgets a closed tab's latest pick and supports unsubscribe", async () => {
    const t1 = await openTab();
    const seen: HumanElementPick[] = [];
    const off = core.onElementPicked((p) => seen.push(p));
    core.recordHumanPick(t1, pickResult(t1));
    core.getLatestPick(t1)!.pick.selector = "mutated";
    expect(core.getLatestPick(t1)!.pick.selector).toBe("button.cta");

    off();
    core.recordHumanPick(t1, pickResult(t1));
    expect(seen).toHaveLength(1);

    await core.closeTab(t1);
    expect(core.getLatestPick(t1)).toBeNull();
    expect(core.listPicks()).toHaveLength(2);
  });

  it("keeps a bounded history across tabs", async () => {
    const t1 = await openTab();
    for (let i = 0; i < HUMAN_PICK_HISTORY_LIMIT + 5; i++) {
      core.recordHumanPick(t1, pickResult(t1, { selector: `#p${i}` }));
    }
    const list = core.listPicks();
    expect(list).toHaveLength(HUMAN_PICK_HISTORY_LIMIT);
    expect(list[0]!.pick.selector).toBe(`#p${HUMAN_PICK_HISTORY_LIMIT + 4}`);
    expect(core.getLatestPick(t1)!.pick.selector).toBe(`#p${HUMAN_PICK_HISTORY_LIMIT + 4}`);
  });
});

describe("HumanPickStore", () => {
  it("bounds history to the configured limit, newest first", () => {
    const store = new HumanPickStore(2);
    store.record("a" as TabId, pickResult("a" as TabId, { selector: "#1" }), 1);
    store.record("b" as TabId, pickResult("b" as TabId, { selector: "#2" }), 2);
    store.record("a" as TabId, pickResult("a" as TabId, { selector: "#3" }), 3);
    expect(store.list().map((p) => [p.pick.selector, p.pickedAt])).toEqual([["#3", 3], ["#2", 2]]);
    expect(store.latestFor("b" as TabId)!.pick.selector).toBe("#2");
  });
});
