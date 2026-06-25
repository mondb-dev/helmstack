import { describe, expect, it } from "vitest";

import { icon, iconNames } from "../src/renderer/ui/icons.js";

describe("icon", () => {
  it("returns an aria-hidden <svg> with the .icon class", () => {
    const el = icon("x");
    expect(el.tagName.toLowerCase()).toBe("svg");
    expect(el.getAttribute("aria-hidden")).toBe("true");
    expect(el.classList.contains("icon")).toBe(true);
  });

  it("is theme-aware: stroke=currentColor, no fill, 24 viewBox", () => {
    const el = icon("plus");
    expect(el.getAttribute("stroke")).toBe("currentColor");
    expect(el.getAttribute("fill")).toBe("none");
    expect(el.getAttribute("viewBox")).toBe("0 0 24 24");
  });

  it("builds the expected shapes per icon", () => {
    expect(icon("x").querySelectorAll("path")).toHaveLength(2);
    expect(icon("chevron-down").querySelectorAll("path")).toHaveLength(1);
    expect(icon("chevron-right").querySelectorAll("path")).toHaveLength(1);
    expect(icon("sun").querySelector("circle")).not.toBeNull();
    expect(icon("moon").querySelectorAll("path")).toHaveLength(1);
  });

  it("honours size + extra className", () => {
    const el = icon("moon", { size: 20, className: "theme-icon" });
    expect(el.getAttribute("width")).toBe("20");
    expect(el.getAttribute("height")).toBe("20");
    expect(el.classList.contains("theme-icon")).toBe(true);
    expect(el.classList.contains("icon")).toBe(true);
  });

  it("exposes the available icon names", () => {
    const names = iconNames();
    for (const n of ["x", "plus", "chevron-down", "chevron-right", "sun", "moon"]) {
      expect(names).toContain(n);
    }
  });
});
