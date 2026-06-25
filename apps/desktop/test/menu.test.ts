import { afterEach, describe, expect, it } from "vitest";

import { createMenu } from "../src/renderer/ui/menu.js";

function setup(): { trigger: HTMLButtonElement; menu: HTMLElement; items: HTMLElement[] } {
  const trigger = document.createElement("button");
  trigger.id = "trg";
  trigger.textContent = "Demos";

  const menu = document.createElement("div");
  menu.id = "menu";
  menu.setAttribute("hidden", "");
  const items = ["a", "b", "c"].map((label) => {
    const b = document.createElement("button");
    b.setAttribute("role", "menuitem");
    b.textContent = label;
    menu.append(b);
    return b;
  });

  document.body.append(trigger, menu);
  createMenu(trigger, menu);
  return { trigger, menu, items };
}

function press(target: Element, key: string): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("createMenu", () => {
  it("sets ARIA wiring on the trigger and menu", () => {
    const { trigger, menu } = setup();
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-controls")).toBe("menu");
    expect(menu.getAttribute("role")).toBe("menu");
  });

  it("makes menu items non-tabbable (roving)", () => {
    const { items } = setup();
    expect(items.map((i) => i.tabIndex)).toEqual([-1, -1, -1]);
  });

  it("ArrowDown on the trigger opens and focuses the first item", () => {
    const { trigger, menu, items } = setup();
    press(trigger, "ArrowDown");
    expect(menu.hasAttribute("hidden")).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(items[0]);
  });

  it("ArrowUp on the trigger opens and focuses the last item", () => {
    const { trigger, items } = setup();
    press(trigger, "ArrowUp");
    expect(document.activeElement).toBe(items[2]);
  });

  it("↑/↓ cycle items with wraparound", () => {
    const { trigger, menu, items } = setup();
    press(trigger, "ArrowDown");
    press(menu, "ArrowDown");
    expect(document.activeElement).toBe(items[1]);
    press(menu, "ArrowUp");
    press(menu, "ArrowUp");
    expect(document.activeElement).toBe(items[2]); // wrapped past the top
  });

  it("Escape closes and restores focus to the trigger", () => {
    const { trigger, menu } = setup();
    press(trigger, "ArrowDown");
    press(menu, "Escape");
    expect(menu.hasAttribute("hidden")).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("clicking an item closes the menu", () => {
    const { trigger, menu, items } = setup();
    press(trigger, "ArrowDown");
    items[1].click();
    expect(menu.hasAttribute("hidden")).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("Tab closes the menu without restoring focus", () => {
    const { trigger, menu } = setup();
    press(trigger, "ArrowDown");
    press(menu, "Tab");
    expect(menu.hasAttribute("hidden")).toBe(true);
  });
});
