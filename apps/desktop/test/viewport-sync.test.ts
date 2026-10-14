import { describe, expect, it, vi } from "vitest";

import { createViewportSync } from "../src/renderer/panels/viewport-sync.js";
import { flush } from "./helpers/shell-fixtures.js";

function setup(captureScreenshot = vi.fn(async () => ({ tabId: "t", capturedAt: 0, data: "AAA", mimeType: "image/png" as const, width: 1, height: 1 }))) {
  const frame = document.createElement("div");
  const freeze = document.createElement("img");
  freeze.hidden = true;
  frame.append(freeze);
  document.body.append(frame);
  const setViewport = vi.fn(async () => undefined);
  const sync = createViewportSync({ frame, freeze, bridge: { setViewport, captureScreenshot }, activeTabId: () => "t" });
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
});
