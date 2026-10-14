import { describe, expect, it } from "vitest";

import type { TabSummary } from "../../../packages/shared/src/index.js";
import { createTabLabelCache } from "../src/renderer/ui/tab-labels.js";

const tab = (id: string, url: string, title = ""): TabSummary => ({ id, url, title, isActive: false, status: "idle" as TabSummary["status"] });

describe("tab label cache", () => {
  it("labels open tabs by host, falling back to the title", () => {
    const cache = createTabLabelCache();
    cache.remember([tab("a", "http://localhost:3000/x"), tab("b", "", "Untitled doc")]);
    expect(cache.label("a")).toBe("localhost:3000");
    expect(cache.label("b")).toBe("Untitled doc");
  });

  it("keeps the last known label for closed tabs", () => {
    const cache = createTabLabelCache();
    cache.remember([tab("a", "https://example.com/"), tab("b", "https://acme.test/")]);
    cache.remember([tab("b", "https://acme.test/")]);
    expect(cache.label("a")).toBe("example.com (closed)");
    expect(cache.label("b")).toBe("acme.test");
  });

  it("returns undefined for never-seen tabs so callers can say 'Closed tab'", () => {
    expect(createTabLabelCache().label("9f1c2d3e-uuid")).toBeUndefined();
  });

  it("is bounded", () => {
    const cache = createTabLabelCache(2);
    cache.remember([tab("a", "https://a.test/")]);
    cache.remember([tab("b", "https://b.test/")]);
    cache.remember([tab("c", "https://c.test/")]);
    expect(cache.label("a")).toBeUndefined();
    expect(cache.label("c")).toBe("c.test");
  });
});
