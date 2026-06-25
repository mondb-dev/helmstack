import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// vitest runs from the repo root.
const html = readFileSync("apps/desktop/src/renderer/index.html", "utf8");
const doc = new DOMParser().parseFromString(html, "text/html");

describe("index.html landmarks + skip link", () => {
  it("has a single banner header and a single main", () => {
    expect(doc.querySelectorAll("header")).toHaveLength(1);
    expect(doc.querySelectorAll("main")).toHaveLength(1);
  });

  it("labels the nav and the aside, distinctly", () => {
    const navLabel = doc.querySelector("nav")?.getAttribute("aria-label");
    const asideLabel = doc.querySelector("aside")?.getAttribute("aria-label");
    expect(navLabel).toBeTruthy();
    expect(asideLabel).toBeTruthy();
    expect(navLabel).not.toBe(asideLabel);
  });

  it("provides a skip link pointing at an element that exists", () => {
    const link = doc.querySelector("a.skip-link");
    const href = link?.getAttribute("href") ?? "";
    expect(href.startsWith("#")).toBe(true);
    expect(doc.getElementById(href.slice(1))).not.toBeNull();
  });

  it("exposes the tablist + tabpanel pair", () => {
    expect(doc.querySelector('[role="tablist"]')).not.toBeNull();
    expect(doc.querySelector('[role="tabpanel"]')).not.toBeNull();
  });

  it("keeps every static aria-label unique (no ambiguous landmarks/controls)", () => {
    const labels = Array.from(doc.querySelectorAll("[aria-label]")).map((el) => el.getAttribute("aria-label"));
    expect(new Set(labels).size).toBe(labels.length);
  });
});
