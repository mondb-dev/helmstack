import { describe, expect, it, vi } from "vitest";

import { createViewportSync } from "../src/renderer/panels/viewport-sync.js";
import { flush } from "./helpers/shell-fixtures.js";

type Shot = { tabId: string; capturedAt: number; data: string; mimeType: "image/png"; width: number; height: number };
const shot = (data = "AAA"): Shot => ({ tabId: "t", capturedAt: 0, data, mimeType: "image/png", width: 1, height: 1 });

function setup(
  captureScreenshot: (tabId: string) => Promise<Shot> = vi.fn(async () => shot()),
  extra: { emulatedSize?: () => { width: number; height: number } | null; captureTimeoutMs?: number } = {}
) {
  const frame = document.createElement("div");
  const freeze = document.createElement("img");
  freeze.hidden = true;
  frame.append(freeze);
  document.body.append(frame);
  const setViewport = vi.fn(async () => undefined);
  const sync = createViewportSync({ frame, freeze, bridge: { setViewport, captureScreenshot }, activeTabId: () => "t", ...extra });
  return { sync, setViewport, freeze, captureScreenshot };
}

describe("viewport sync", () => {
  it("reports the frame rect", () => {
    const { sync, setViewport } = setup();
    sync.layoutNow();
    expect(setViewport).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 320, height: 40 });
  });

  it("hides the native view behind a still frame while occluded, and restores on last release", async () => {
    const { sync, setViewport, freeze, captureScreenshot } = setup();
    await sync.occlude("popover");
    await sync.occlude("dialog");
    expect(captureScreenshot).toHaveBeenCalledTimes(1);
    expect(freeze.hidden).toBe(false);
    expect(freeze.getAttribute("src")).toBe("data:image/png;base64,AAA");
    expect(setViewport).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 });

    sync.release("popover");
    expect(sync.isOccluded()).toBe(true);
    sync.release("dialog");
    await flush();
    expect(sync.isOccluded()).toBe(false);
    expect(freeze.hidden).toBe(true);
    expect(setViewport).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 320, height: 40 });
  });

  it("still hides the view when the screenshot fails", async () => {
    const { sync, setViewport, freeze } = setup(vi.fn(async () => {
      throw new Error("no tab");
    }));
    await sync.occlude("x");
    expect(freeze.hidden).toBe(true);
    expect(setViewport).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("stretches the still frame over the page area when there's no viewport override", async () => {
    const { sync, freeze } = setup(undefined, { emulatedSize: () => null });
    await sync.occlude("dialog");
    expect(freeze.dataset.fit).toBe("fill");
    expect(freeze.style.width).toBe("");
  });

  it("draws the still frame at its natural CSS size when the tab has a viewport override", async () => {
    const { sync, freeze } = setup(undefined, { emulatedSize: () => ({ width: 390, height: 844 }) });
    await sync.occlude("approval");
    expect(freeze.hidden).toBe(false);
    expect(freeze.dataset.fit).toBe("natural");
    expect(freeze.style.width).toBe("390px");
    expect(freeze.style.height).toBe("844px");
    sync.release("approval");
    expect(freeze.dataset.fit).toBeUndefined();
    expect(freeze.style.width).toBe("");
  });

  it("still paints a capture that arrives after the timeout while the dialog is open", async () => {
    let resolve!: (value: Shot) => void;
    const slow = vi.fn(() => new Promise<Shot>((r) => (resolve = r)));
    const { sync, freeze, setViewport } = setup(slow, { captureTimeoutMs: 5 });
    await sync.occlude("settings");
    expect(setViewport).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 });
    expect(freeze.hidden).toBe(true);
    resolve(shot("LATE"));
    await flush();
    expect(freeze.hidden).toBe(false);
    expect(freeze.getAttribute("src")).toBe("data:image/png;base64,LATE");
  });

  it("drops a late capture once the overlay has closed", async () => {
    let resolve!: (value: Shot) => void;
    const slow = vi.fn(() => new Promise<Shot>((r) => (resolve = r)));
    const { sync, freeze } = setup(slow, { captureTimeoutMs: 5 });
    await sync.occlude("settings");
    sync.release("settings");
    resolve(shot("LATE"));
    await flush();
    expect(freeze.hidden).toBe(true);
    expect(freeze.hasAttribute("src")).toBe(false);
  });
});
