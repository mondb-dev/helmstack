import { afterEach, describe, expect, it } from "vitest";

import { openDialog } from "../src/renderer/ui/dialog.js";

function press(key: string, shiftKey = false): void {
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
}

function setup(html: string): { dialog: HTMLElement; opener: HTMLButtonElement } {
  const opener = document.createElement("button");
  opener.textContent = "Open";
  document.body.append(opener);
  opener.focus();

  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.innerHTML = html;
  document.body.append(dialog);
  return { dialog, opener };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("openDialog", () => {
  it("focuses [data-autofocus] when present", () => {
    const { dialog } = setup(`<button id="a">A</button><button id="b" data-autofocus>B</button>`);
    openDialog(dialog);
    expect(document.activeElement?.id).toBe("b");
  });

  it("falls back to the first focusable when no autofocus", () => {
    const { dialog } = setup(`<button id="a">A</button><button id="b">B</button>`);
    openDialog(dialog);
    expect(document.activeElement?.id).toBe("a");
  });

  it("Tab from the last focusable wraps to the first", () => {
    const { dialog } = setup(`<button id="a">A</button><button id="b">B</button>`);
    openDialog(dialog);
    document.getElementById("b")!.focus();
    press("Tab");
    expect(document.activeElement?.id).toBe("a");
  });

  it("Shift+Tab from the first focusable wraps to the last", () => {
    const { dialog } = setup(`<button id="a">A</button><button id="b">B</button>`);
    openDialog(dialog);
    document.getElementById("a")!.focus();
    press("Tab", true);
    expect(document.activeElement?.id).toBe("b");
  });

  it("Escape closes when dismissable and restores focus to the opener", () => {
    const { dialog, opener } = setup(`<button id="a">A</button>`);
    let closedCount = 0;
    openDialog(dialog, { dismissable: true, onClose: () => (closedCount += 1) });
    press("Escape");
    expect(closedCount).toBe(1);
    expect(document.activeElement).toBe(opener);
  });

  it("Escape does NOT close when not dismissable", () => {
    const { dialog } = setup(`<button id="a">A</button>`);
    let closedCount = 0;
    openDialog(dialog, { dismissable: false, onClose: () => (closedCount += 1) });
    press("Escape");
    expect(closedCount).toBe(0);
    expect(document.activeElement?.id).toBe("a");
  });

  it("handle.close() restores focus to the opener and is idempotent", () => {
    const { dialog, opener } = setup(`<button id="a">A</button>`);
    let closedCount = 0;
    const handle = openDialog(dialog, { onClose: () => (closedCount += 1) });
    handle.close();
    handle.close();
    expect(closedCount).toBe(1);
    expect(document.activeElement).toBe(opener);
  });

  it("ignores disabled and [hidden] elements when trapping", () => {
    const { dialog } = setup(
      `<button id="a">A</button><button id="x" disabled>X</button><button id="b">B</button>`
    );
    openDialog(dialog);
    expect(document.activeElement?.id).toBe("a");
    document.getElementById("b")!.focus();
    press("Tab");
    expect(document.activeElement?.id).toBe("a");
  });
});
