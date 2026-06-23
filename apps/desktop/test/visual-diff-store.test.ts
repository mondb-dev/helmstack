import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// VisualDiffStore imports electron's nativeImage (used only by diff()); stub it
// so the module loads. These tests cover the cache/persistence surface; the
// pixel-diff logic is covered by pixel-compare/ignore-mask tests.
vi.mock("electron", () => ({ nativeImage: {} }));

import { VisualDiffStore } from "../src/main/visual-diff-store.js";
import type { PageScreenshot } from "../../../packages/shared/src/index.js";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function shot(tabId: string): PageScreenshot {
  return { tabId, capturedAt: 123, data: PNG_1X1, mimeType: "image/png", width: 1, height: 1 };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "helmstack-visualdiff-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("VisualDiffStore", () => {
  it("puts and gets a screenshot from the cache", () => {
    const store = new VisualDiffStore(dir);
    expect(store.get("a")).toBeUndefined();
    store.put("a", shot("tab-1"));
    expect(store.get("a")?.tabId).toBe("tab-1");
    expect([...store.entries()].map(([id]) => id)).toEqual(["a"]);
  });

  it("persists to disk by default — a fresh store rehydrates it", () => {
    new VisualDiffStore(dir).put("baseline", shot("tab-1"));
    const reopened = new VisualDiffStore(dir);
    expect(reopened.get("baseline")?.tabId).toBe("tab-1");
  });

  it("persist:false keeps it in memory only (not rehydrated)", () => {
    const store = new VisualDiffStore(dir);
    store.put("transient", shot("tab-1"), false);
    expect(store.get("transient")).toBeDefined();          // in this instance's cache
    expect(new VisualDiffStore(dir).get("transient")).toBeUndefined(); // not on disk
  });

  it("remove() deletes from cache and disk, reporting prior existence", () => {
    const store = new VisualDiffStore(dir);
    store.put("x", shot("tab-1"));
    expect(store.remove("x")).toBe(true);
    expect(store.get("x")).toBeUndefined();
    expect(new VisualDiffStore(dir).get("x")).toBeUndefined(); // gone from disk too
    expect(store.remove("missing")).toBe(false);
  });
});
