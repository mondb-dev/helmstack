import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PerceptionBaselineStore, ScreenshotBaselineStore } from "../src/main/baseline-store.js";
import type { PageGraph, PageScreenshot } from "../../../packages/shared/src/index.js";

// 1×1 transparent PNG.
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "helmstack-baseline-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function screenshot(tabId: string): PageScreenshot {
  return { tabId, capturedAt: 123, data: PNG_1X1, mimeType: "image/png", width: 1, height: 1 };
}

function graph(tabId: string): PageGraph {
  return {
    tabId,
    url: "https://example.com/",
    title: "Example",
    kind: "landing",
    headings: ["Hello"],
    forms: [],
    actions: [],
    alerts: [],
    media: [],
    oauthProviders: [],
    accessibility: { nodeCount: 0, roleCounts: {}, headingTrail: [], interactiveNodes: [] },
    signals: { documentCount: 1, accessibilityNodeCount: 0, formCount: 0, actionCount: 0, capturedAt: 123 }
  };
}

describe("ScreenshotBaselineStore", () => {
  it("round-trips a screenshot across store instances (survives restart)", () => {
    const store = new ScreenshotBaselineStore(dir);
    store.put("before-deploy", screenshot("tab-1"));

    // A fresh instance simulates an app restart reading the same userData dir.
    const reloaded = new ScreenshotBaselineStore(dir);
    const all = reloaded.all();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("before-deploy");
    expect(all[0].shot.data).toBe(PNG_1X1);
    expect(all[0].shot.width).toBe(1);
    expect(all[0].shot.tabId).toBe("tab-1");
  });

  it("removes a screenshot from disk", () => {
    const store = new ScreenshotBaselineStore(dir);
    store.put("a", screenshot("tab-1"));
    store.remove("a");
    expect(new ScreenshotBaselineStore(dir).all()).toHaveLength(0);
  });

  it("handles ids with filesystem-unsafe characters", () => {
    const store = new ScreenshotBaselineStore(dir);
    const weirdId = "tab-1__mobile/desktop__a:b";
    store.put(weirdId, screenshot("tab-1"));
    const reloaded = new ScreenshotBaselineStore(dir).all();
    expect(reloaded[0].id).toBe(weirdId);
  });
});

describe("PerceptionBaselineStore", () => {
  it("round-trips a perception baseline across instances", () => {
    const store = new PerceptionBaselineStore(dir);
    store.put("pre", { graph: graph("tab-9"), tabId: "tab-9", url: "https://example.com/", title: "Example", capturedAt: 123 });

    const reloaded = new PerceptionBaselineStore(dir).all();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].id).toBe("pre");
    expect(reloaded[0].entry.graph.headings).toEqual(["Hello"]);
    expect(reloaded[0].entry.title).toBe("Example");
  });

  it("removes a perception baseline from disk", () => {
    const store = new PerceptionBaselineStore(dir);
    store.put("pre", { graph: graph("t"), tabId: "t", url: "u", title: "T", capturedAt: 1 });
    store.remove("pre");
    expect(new PerceptionBaselineStore(dir).all()).toHaveLength(0);
  });
});
