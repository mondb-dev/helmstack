import { describe, expect, it } from "vitest";

import { buildEmptyState, buildSkeletonRows } from "../src/renderer/ui/states.js";

describe("buildEmptyState", () => {
  it("produces an .empty-state node with the title", () => {
    const el = buildEmptyState({ title: "No accounts yet" });
    expect(el.classList.contains("empty-state")).toBe(true);
    expect(el.querySelector(".empty-state__title")?.textContent).toBe("No accounts yet");
  });

  it("omits the hint line when no hint is given", () => {
    const el = buildEmptyState({ title: "Empty" });
    expect(el.querySelector(".empty-state__hint")).toBeNull();
  });

  it("renders the hint when provided", () => {
    const el = buildEmptyState({ title: "No accounts yet", hint: "Add credentials above." });
    expect(el.querySelector(".empty-state__hint")?.textContent).toBe("Add credentials above.");
  });

  it("sets text via textContent (no HTML injection)", () => {
    const el = buildEmptyState({ title: "<img src=x onerror=1>" });
    expect(el.querySelector(".empty-state__title")?.children.length).toBe(0);
    expect(el.querySelector(".empty-state__title")?.textContent).toContain("<img");
  });
});

describe("buildSkeletonRows", () => {
  it("builds the requested number of .skeleton rows", () => {
    const frag = buildSkeletonRows(3);
    expect(frag.querySelectorAll(".skeleton.skeleton--row")).toHaveLength(3);
  });

  it("clamps negative counts to zero", () => {
    expect(buildSkeletonRows(-2).childNodes).toHaveLength(0);
  });
});
