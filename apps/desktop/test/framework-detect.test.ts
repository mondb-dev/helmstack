import { describe, expect, it } from "vitest";

import { detectFramework, frameworkSignalsScript, type RawFrameworkSignals } from "../src/main/framework-detect.js";

function signals(over: Partial<RawFrameworkSignals>): RawFrameworkSignals {
  return { url: "http://localhost:3000/", globals: [], scriptSrcs: [], astroIslands: 0, generator: null, ...over };
}

describe("frameworkSignalsScript", () => {
  it("is syntactically valid JavaScript", () => {
    expect(() => new Function(`return ${frameworkSignalsScript()};`)).not.toThrow();
  });
});

describe("detectFramework — frameworks", () => {
  it("detects Next.js on a webpack dev server with HMR", () => {
    const r = detectFramework(signals({ globals: ["__NEXT_DATA__", "webpackHotUpdate"], scriptSrcs: ["/_next/static/chunks/main.js"] }), "t", 1);
    expect(r.framework).toBe("next");
    expect(r.devServer).toBe("webpack");
    expect(r.hmr).toBe(true);
    expect(r.isDev).toBe(true);
  });

  it("detects a Vite + React dev app", () => {
    const r = detectFramework(signals({ scriptSrcs: ["/@vite/client", "/src/main.tsx"], globals: ["__vite_plugin_react_preamble_installed__"] }), "t", 1);
    expect(r.devServer).toBe("vite");
    expect(r.framework).toBe("vite");
    expect(r.hmr).toBe(true);
  });

  it("detects SvelteKit via _app/immutable assets", () => {
    const r = detectFramework(signals({ scriptSrcs: ["/_app/immutable/entry/start.abc.js"], generator: "SvelteKit" }), "t", 1);
    expect(r.framework).toBe("sveltekit");
  });

  it("detects Astro via island elements", () => {
    const r = detectFramework(signals({ url: "https://example.com/", astroIslands: 3, generator: "Astro v4.0" }), "t", 1);
    expect(r.framework).toBe("astro");
    expect(r.evidence.join(" ")).toContain("astro-island");
  });

  it("detects Nuxt and Remix", () => {
    expect(detectFramework(signals({ globals: ["__NUXT__"] }), "t", 1).framework).toBe("nuxt");
    expect(detectFramework(signals({ globals: ["__remixContext"] }), "t", 1).framework).toBe("remix");
  });

  it("prefers the higher-level framework over the bundler (Next over webpack)", () => {
    const r = detectFramework(signals({ globals: ["__NEXT_DATA__", "webpackHotUpdate"] }), "t", 1);
    expect(r.framework).toBe("next"); // not "unknown" or a bundler
    expect(r.devServer).toBe("webpack");
  });
});

describe("detectFramework — dev vs production", () => {
  it("treats a production CDN page with no HMR as not-dev / unknown", () => {
    const r = detectFramework(signals({ url: "https://shop.example.com/", scriptSrcs: ["https://cdn.example.com/app.123.js"] }), "t", 1);
    expect(r.framework).toBe("unknown");
    expect(r.devServer).toBe("unknown");
    expect(r.hmr).toBe(false);
    expect(r.isDev).toBe(false);
  });

  it("flags isDev for a localhost page with a detected framework even without HMR", () => {
    const r = detectFramework(signals({ url: "http://localhost:3000/", globals: ["__NEXT_DATA__"] }), "t", 1);
    expect(r.isDev).toBe(true);
  });

  it("does not flag isDev for a framework served from a real domain without HMR", () => {
    const r = detectFramework(signals({ url: "https://www.example.com/", globals: ["__NEXT_DATA__"], scriptSrcs: ["/_next/static/abc.js"] }), "t", 1);
    expect(r.hmr).toBe(false);
    expect(r.isDev).toBe(false);
  });
});
