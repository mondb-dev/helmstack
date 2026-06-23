import { describe, expect, it } from "vitest";

import { elementPickerScript } from "../src/main/element-picker.js";

type Pick = { selector: string; tagName: string; text: string; id: string | null } | null;

/** Start the picker overlay; returns the pending promise the way the page would. */
function startPicker(): Promise<Pick> {
  return eval(`(${elementPickerScript()})()`) as Promise<Pick>;
}

const OVERLAY = "#__helmstack_pick_overlay__";

describe("elementPickerScript", () => {
  it("is syntactically valid JavaScript", () => {
    expect(() => new Function(`return (${elementPickerScript()});`)).not.toThrow();
  });

  it("installs a highlight overlay while active and removes it after a pick", async () => {
    document.body.innerHTML = `<button id="go">Go</button>`;
    const promise = startPicker();
    expect(document.querySelector(OVERLAY)).not.toBeNull(); // overlay present while picking

    const btn = document.getElementById("go")!;
    btn.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    await promise;
    expect(document.querySelector(OVERLAY)).toBeNull(); // cleaned up after pick
  });

  it("resolves with an id selector when the clicked element has an id", async () => {
    document.body.innerHTML = `<form><input id="email" type="email" /></form>`;
    const promise = startPicker();
    const el = document.getElementById("email")!;
    el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    const pick = await promise;
    expect(pick).toMatchObject({ selector: "#email", tagName: "input", id: "email" });
  });

  it("prefers data-testid over a positional path when there's no id", async () => {
    document.body.innerHTML = `<div><span data-testid="price">$9</span></div>`;
    const promise = startPicker();
    const el = document.querySelector("[data-testid=price]")!;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    const pick = await promise;
    expect(pick?.selector).toBe('[data-testid="price"]');
    expect(pick?.text).toBe("$9");
  });

  it("builds an nth-of-type path for an element with no id/testid", async () => {
    document.body.innerHTML = `<ul><li>a</li><li>b</li><li id="wrap-skip" class="x"><a>link</a></li></ul>`;
    const promise = startPicker();
    // the <a> has no id; its parent <li> has an id → path stops at the id
    const el = document.querySelector("li.x > a")!;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    const pick = await promise;
    expect(pick?.selector).toBe("#wrap-skip > a:nth-of-type(1)");
  });

  it("resolves null when the human cancels with Escape", async () => {
    document.body.innerHTML = `<button id="go">Go</button>`;
    const promise = startPicker();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    const pick = await promise;
    expect(pick).toBeNull();
    expect(document.querySelector(OVERLAY)).toBeNull();
  });
});
