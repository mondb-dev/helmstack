import { describe, expect, it } from "vitest";

import { AssertionWatchStore } from "../src/main/assertion-watch.js";

/** Evaluator stub driven by a lookup table. */
const evaluator = (table: Record<string, boolean>) => (assertion: string) => ({
  pass: table[assertion] ?? false,
  explanation: `eval(${assertion})=${table[assertion]}`
});

describe("AssertionWatchStore", () => {
  it("emits a transition on first evaluation (null → pass/fail)", () => {
    const store = new AssertionWatchStore();
    store.add("tab-1", "checkout button is visible", 0, "w1");
    const t = store.evaluateTab("tab-1", evaluator({ "checkout button is visible": true }), 100);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ watchId: "w1", pass: true, previousPass: null, at: 100 });
  });

  it("emits a transition only when the result changes", () => {
    const store = new AssertionWatchStore();
    store.add("tab-1", "a", 0, "w1");
    expect(store.evaluateTab("tab-1", evaluator({ a: true }), 1)).toHaveLength(1); // null→true
    expect(store.evaluateTab("tab-1", evaluator({ a: true }), 2)).toHaveLength(0); // true→true (no change)
    const flip = store.evaluateTab("tab-1", evaluator({ a: false }), 3);          // true→false
    expect(flip).toHaveLength(1);
    expect(flip[0]).toMatchObject({ pass: false, previousPass: true });
  });

  it("only evaluates watches for the given tab", () => {
    const store = new AssertionWatchStore();
    store.add("tab-1", "a", 0, "w1");
    store.add("tab-2", "a", 0, "w2");
    const t = store.evaluateTab("tab-1", evaluator({ a: true }), 1);
    expect(t.map((x) => x.watchId)).toEqual(["w1"]);
  });

  it("lists and removes watches, and clears a tab's watches", () => {
    const store = new AssertionWatchStore();
    store.add("tab-1", "a", 0, "w1");
    store.add("tab-1", "b", 0, "w2");
    store.add("tab-2", "c", 0, "w3");
    expect(store.list("tab-1").map((w) => w.id).sort()).toEqual(["w1", "w2"]);
    expect(store.remove("w1")).toBe(true);
    expect(store.remove("missing")).toBe(false);
    store.clearTab("tab-2");
    expect(store.list().map((w) => w.id)).toEqual(["w2"]);
  });
});
