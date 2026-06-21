import { afterEach, describe, expect, it } from "vitest";

import { buildDomTraversalScript } from "../src/main/dom-actuator.js";
import { designTokenCollectorScript } from "../src/main/design-tokens.js";
import { layoutIssueDetectorScript } from "../src/main/layout-issues.js";
import { mediaStateCollectorScript } from "../src/main/media-state.js";

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

/** Parse a script string without executing it — guards against template breakage. */
function parses(script: string): boolean {
  try {
    // Wrap so both IIFE expressions and `function(){}` declarations parse.
    new Function(`return (${script.trim().startsWith("function") ? script : `() => ${script}`});`);
    return true;
  } catch {
    return false;
  }
}

describe("injected scripts — syntactic validity", () => {
  it("every generated in-page script is valid JavaScript", () => {
    expect(parses(designTokenCollectorScript())).toBe(true);
    expect(parses(layoutIssueDetectorScript())).toBe(true);
    expect(parses(mediaStateCollectorScript())).toBe(true);
    // The actuator's DOM-traversal payload handler is a `function (payload) {...}`.
    expect(() => new Function(`return (${buildDomTraversalScript()});`)).not.toThrow();
  });
});

describe("designTokenCollectorScript — executes in a DOM", () => {
  it("collects colors, font sizes, and a stable shape", () => {
    document.head.innerHTML = `<style>:root { --brand: #2563eb; }</style>`;
    document.body.innerHTML = `<div style="color: rgb(1, 2, 3); background-color: rgb(4, 5, 6); font-size: 16px; border-radius: 8px;">x</div>`;

    const result = eval(designTokenCollectorScript()) as {
      counts: Record<string, Record<string, number>>;
      cssVariables: Record<string, string>;
      sampledElements: number;
    };

    expect(result.sampledElements).toBeGreaterThan(0);
    expect(Object.keys(result.counts.colors).length).toBeGreaterThan(0);
    expect(result.counts.fontSizes["16px"]).toBeGreaterThan(0);
    expect(typeof result.cssVariables).toBe("object");
  });
});

describe("mediaStateCollectorScript — executes in a DOM", () => {
  it("returns the expected shape even when matchMedia is limited", () => {
    const result = eval(mediaStateCollectorScript()) as {
      features: Record<string, string>;
      viewport: { width: number; height: number };
      mediaQueries: Array<{ query: string; matches: boolean }>;
    };

    expect(typeof result.features).toBe("object");
    expect(typeof result.viewport.width).toBe("number");
    expect(Array.isArray(result.mediaQueries)).toBe(true);
  });
});

describe("layoutIssueDetectorScript — executes in a DOM", () => {
  it("returns the expected report shape", () => {
    document.body.innerHTML = `<div><span>content</span></div>`;

    const result = eval(layoutIssueDetectorScript()) as {
      hasHorizontalOverflow: boolean;
      documentScrollWidth: number;
      viewport: { width: number; height: number };
      issues: unknown[];
    };

    expect(typeof result.hasHorizontalOverflow).toBe("boolean");
    expect(typeof result.documentScrollWidth).toBe("number");
    expect(Array.isArray(result.issues)).toBe(true);
    expect(typeof result.viewport.width).toBe("number");
  });
});
