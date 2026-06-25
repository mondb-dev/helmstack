import { afterEach, describe, expect, it } from "vitest";

import { applyRovingTabindex, attachRovingKeys, nextRovingIndex } from "../src/renderer/ui/roving.js";

afterEach(() => {
  document.body.replaceChildren();
});

describe("nextRovingIndex", () => {
  it("moves forward/back horizontally", () => {
    expect(nextRovingIndex("ArrowRight", 0, 3)).toBe(1);
    expect(nextRovingIndex("ArrowLeft", 1, 3)).toBe(0);
  });

  it("wraps at both ends by default", () => {
    expect(nextRovingIndex("ArrowRight", 2, 3)).toBe(0);
    expect(nextRovingIndex("ArrowLeft", 0, 3)).toBe(2);
  });

  it("clamps instead of wrapping when wrap=false", () => {
    expect(nextRovingIndex("ArrowRight", 2, 3, { wrap: false })).toBe(2);
    expect(nextRovingIndex("ArrowLeft", 0, 3, { wrap: false })).toBe(0);
  });

  it("supports Home/End", () => {
    expect(nextRovingIndex("Home", 2, 3)).toBe(0);
    expect(nextRovingIndex("End", 0, 3)).toBe(2);
  });

  it("enters from no-focus (current=-1): Next→first, Prev→last", () => {
    expect(nextRovingIndex("ArrowRight", -1, 3)).toBe(0);
    expect(nextRovingIndex("ArrowLeft", -1, 3)).toBe(2);
  });

  it("respects vertical orientation", () => {
    expect(nextRovingIndex("ArrowDown", 0, 3, { orientation: "vertical" })).toBe(1);
    expect(nextRovingIndex("ArrowLeft", 0, 3, { orientation: "vertical" })).toBeNull();
  });

  it("returns null for non-nav keys and empty sets", () => {
    expect(nextRovingIndex("a", 0, 3)).toBeNull();
    expect(nextRovingIndex("ArrowRight", 0, 0)).toBeNull();
  });
});

describe("applyRovingTabindex", () => {
  it("makes only the active item tabbable", () => {
    const els = [document.createElement("button"), document.createElement("button")];
    applyRovingTabindex(els, 1);
    expect(els.map((e) => e.tabIndex)).toEqual([-1, 0]);
  });
});

describe("attachRovingKeys (DOM)", () => {
  function setup(n: number): HTMLElement[] {
    const container = document.createElement("div");
    container.setAttribute("role", "tablist");
    const items: HTMLElement[] = [];
    for (let i = 0; i < n; i += 1) {
      const b = document.createElement("button");
      b.setAttribute("role", "tab");
      b.textContent = `tab ${i}`;
      container.append(b);
      items.push(b);
    }
    document.body.append(container);
    attachRovingKeys(container, '[role="tab"]');
    applyRovingTabindex(items, 0);
    items[0].focus();
    return items;
  }

  function arrow(key: string): void {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    );
  }

  it("ArrowRight moves focus and roving tabindex to the next tab", () => {
    const items = setup(3);
    arrow("ArrowRight");
    expect(document.activeElement).toBe(items[1]);
    expect(items.map((e) => e.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("wraps from last back to first", () => {
    const items = setup(3);
    items[2].focus();
    applyRovingTabindex(items, 2);
    arrow("ArrowRight");
    expect(document.activeElement).toBe(items[0]);
  });

  it("Home jumps to first, End to last", () => {
    const items = setup(3);
    items[1].focus();
    arrow("End");
    expect(document.activeElement).toBe(items[2]);
    arrow("Home");
    expect(document.activeElement).toBe(items[0]);
  });
});
