import { afterEach, describe, expect, it } from "vitest";

import { buildComponentSourceReport, componentSourceCollectorScript, type RawComponentSources } from "../src/main/component-source.js";
import type { ComponentSource } from "../../../packages/shared/src/index.js";

afterEach(() => {
  document.body.innerHTML = "";
});

const el = (over: Partial<ComponentSource>): ComponentSource => ({
  selector: "div",
  component: "X",
  framework: "react",
  ...over
});

describe("buildComponentSourceReport", () => {
  it("dedupes components by name+file and counts instances, ranked", () => {
    const raw: RawComponentSources = {
      url: "https://example.com/",
      sampledElements: 100,
      elements: [
        el({ component: "Button", file: "src/ui/Button.tsx", line: 42 }),
        el({ component: "Button", file: "src/ui/Button.tsx", line: 42 }),
        el({ component: "Card", file: "src/ui/Card.tsx", line: 8 })
      ]
    };
    const report = buildComponentSourceReport(raw, "t", 5);
    expect(report.mappedElements).toBe(3);
    expect(report.sampledElements).toBe(100);
    expect(report.components[0]).toEqual({ component: "Button", file: "src/ui/Button.tsx", line: 42, instances: 2 });
    expect(report.components[1].component).toBe("Card");
  });

  it("infers framework: single, mixed, or unknown", () => {
    const base = { url: "u", sampledElements: 1 };
    expect(buildComponentSourceReport({ ...base, elements: [el({ framework: "react" })] }, "t", 0).framework).toBe("react");
    expect(buildComponentSourceReport({ ...base, elements: [el({ framework: "react" }), el({ framework: "svelte" })] }, "t", 0).framework).toBe("mixed");
    expect(buildComponentSourceReport({ ...base, elements: [] }, "t", 0).framework).toBe("unknown");
  });
});

describe("componentSourceCollectorScript", () => {
  it("is syntactically valid JavaScript", () => {
    expect(() => new Function(`return (${componentSourceCollectorScript()});`)).not.toThrow();
  });

  it("extracts a React fiber _debugSource from a planted node", () => {
    document.body.innerHTML = `<button class="cta">Buy</button>`;
    const node = document.querySelector("button") as unknown as HTMLElement & Record<string, unknown>;
    node["__reactFiber$test"] = {
      _debugSource: { fileName: "src/ui/Button.tsx", lineNumber: 42, columnNumber: 3 },
      type: { name: "PrimaryButton" },
      return: null
    };

    const result = eval(componentSourceCollectorScript()) as RawComponentSources;
    const match = result.elements.find((e) => e.component === "PrimaryButton");
    expect(match).toBeTruthy();
    expect(match).toMatchObject({ framework: "react", file: "src/ui/Button.tsx", line: 42, selector: "button.cta" });
  });

  it("extracts Svelte __svelte_meta loc", () => {
    document.body.innerHTML = `<div id="root">x</div>`;
    const node = document.querySelector("#root") as unknown as HTMLElement & Record<string, unknown>;
    node["__svelte_meta"] = { loc: { file: "src/App.svelte", line: 10, column: 2 } };

    const result = eval(componentSourceCollectorScript()) as RawComponentSources;
    const match = result.elements.find((e) => e.framework === "svelte");
    expect(match).toMatchObject({ component: "App", file: "src/App.svelte", line: 10 });
  });
});
