import type { DetectedDevServer, DetectedFramework, FrameworkReport, TabId } from "../../../../packages/shared/src/index.js";

/** Raw page signals gathered in-page, before classification. */
export type RawFrameworkSignals = {
  url: string;
  /** Names from a probe list (plus dynamic webpack/sveltekit globals) present on `window`. */
  globals: string[];
  /** `<script src>` values on the page. */
  scriptSrcs: string[];
  /** Count of `<astro-island>` custom elements. */
  astroIslands: number;
  /** `<meta name="generator">` content, if present. */
  generator: string | null;
};

/** Window globals to probe for (dynamic webpack/sveltekit names are added in-page). */
const GLOBAL_PROBES = [
  "__NEXT_DATA__", "next",
  "__NUXT__", "$nuxt",
  "__remixContext", "__remixManifest",
  "__SVELTEKIT__", "__sveltekit_dev",
  "webpackHotUpdate", "__webpack_require__",
  "__vite_plugin_react_preamble_installed__",
  "__astro", "ng", "getAllAngularRootElements"
];

/** Build the in-page collector expression. Pure string — no Node access. */
export function frameworkSignalsScript(): string {
  return `(function() {
    var PROBES = ${JSON.stringify(GLOBAL_PROBES)};
    var globals = PROBES.filter(function(p) { try { return typeof window[p] !== "undefined"; } catch (e) { return false; } });
    try {
      for (var k in window) {
        if (/^webpackHotUpdate/.test(k) && globals.indexOf("webpackHotUpdate") < 0) globals.push("webpackHotUpdate");
        if (/^__sveltekit/.test(k) && globals.indexOf("__sveltekit_dev") < 0) globals.push("__sveltekit_dev");
      }
    } catch (e) {}
    var scriptSrcs = Array.prototype.slice.call(document.querySelectorAll("script[src]"))
      .map(function(s) { return s.getAttribute("src") || ""; });
    var gen = document.querySelector('meta[name="generator"]');
    return {
      url: location.href,
      globals: globals,
      scriptSrcs: scriptSrcs,
      astroIslands: document.querySelectorAll("astro-island").length,
      generator: gen ? gen.getAttribute("content") : null
    };
  })()`;
}

function has(globals: string[], name: string): boolean {
  return globals.includes(name);
}
function anyScript(scripts: string[], re: RegExp): boolean {
  return scripts.some((s) => re.test(s));
}

/**
 * Classify raw page signals into a framework + dev-server fingerprint. Pure — no
 * DOM/CDP access — so it is unit-tested directly. Detection order matters:
 * higher-level frameworks (Next/Nuxt/SvelteKit/Remix/Astro) are checked before
 * the bare bundlers (Vite/webpack) they sit on top of.
 */
export function detectFramework(signals: RawFrameworkSignals, tabId: TabId, capturedAt: number): FrameworkReport {
  const { globals, scriptSrcs, astroIslands, generator } = signals;
  const evidence: string[] = [];
  const gen = (generator ?? "").toLowerCase();

  // ── Dev server / bundler ──────────────────────────────────────────────────
  const hasViteClient = anyScript(scriptSrcs, /\/@vite\/client/) || anyScript(scriptSrcs, /\/@react-refresh/);
  const hasWebpackHot = has(globals, "webpackHotUpdate");
  const isTurbopack = anyScript(scriptSrcs, /\/_next\/static\/(chunks|development)\/.*turbopack/i);

  let devServer: DetectedDevServer = "unknown";
  if (hasViteClient || has(globals, "__vite_plugin_react_preamble_installed__")) {
    devServer = "vite";
    evidence.push(hasViteClient ? "Vite client script (/@vite/client)" : "Vite react-refresh global");
  } else if (isTurbopack) {
    devServer = "turbopack";
    evidence.push("Turbopack chunk path");
  } else if (hasWebpackHot) {
    devServer = "webpack";
    evidence.push("webpackHotUpdate global");
  }

  // ── HMR ───────────────────────────────────────────────────────────────────
  const hmr = hasViteClient || hasWebpackHot;
  if (hmr) evidence.push("HMR client present");

  // ── Framework (higher-level first) ────────────────────────────────────────
  let framework: DetectedFramework = "unknown";
  if (has(globals, "__NEXT_DATA__") || has(globals, "next") || anyScript(scriptSrcs, /\/_next\//)) {
    framework = "next";
    evidence.push("Next.js (__NEXT_DATA__ / _next assets)");
    if (devServer === "unknown") devServer = "webpack"; // Next dev defaults to webpack
  } else if (has(globals, "__NUXT__") || has(globals, "$nuxt") || anyScript(scriptSrcs, /\/_nuxt\//)) {
    framework = "nuxt";
    evidence.push("Nuxt (__NUXT__ / _nuxt assets)");
  } else if (has(globals, "__SVELTEKIT__") || has(globals, "__sveltekit_dev") || anyScript(scriptSrcs, /\/_app\/immutable\//) || gen.includes("sveltekit")) {
    framework = "sveltekit";
    evidence.push("SvelteKit (__sveltekit / _app assets)");
  } else if (has(globals, "__remixContext") || has(globals, "__remixManifest")) {
    framework = "remix";
    evidence.push("Remix (__remixContext)");
  } else if (astroIslands > 0 || gen.startsWith("astro")) {
    framework = "astro";
    evidence.push(astroIslands > 0 ? `Astro (${astroIslands} <astro-island>)` : "Astro (generator meta)");
  } else if (has(globals, "ng") || has(globals, "getAllAngularRootElements")) {
    framework = "angular";
    evidence.push("Angular (ng global)");
  } else if (anyScript(scriptSrcs, /\/static\/js\/bundle\.js/) || anyScript(scriptSrcs, /\/static\/js\/main\./)) {
    framework = "create-react-app";
    evidence.push("Create React App (static/js bundle)");
  } else if (devServer === "vite") {
    framework = "vite";
    evidence.push("Bare Vite app");
  }

  // ── Dev vs production ─────────────────────────────────────────────────────
  const localhost = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/.test(signals.url);
  const isDev = hmr || (localhost && (devServer !== "unknown" || framework !== "unknown"));
  if (isDev) evidence.push(hmr ? "dev build (HMR)" : "local dev host");

  return { tabId, url: signals.url, capturedAt, framework, devServer, isDev, hmr, evidence };
}
