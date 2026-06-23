import { SELECTOR_FOR_SOURCE } from "../../../../packages/perception/src/page-selector.js";
import type { ComponentSource, ComponentSourceReport, ComponentSourceSummary, TabId } from "../../../../packages/shared/src/index.js";

/** Raw element→source pairs returned by the in-page collector. */
export type RawComponentSources = {
  url: string;
  sampledElements: number;
  elements: ComponentSource[];
};

/**
 * Roll raw element→source pairs into a report: dedupe components by name+file
 * (counting instances), rank by instance count, and infer the page framework.
 * Pure — unit-testable without a DOM.
 */
export function buildComponentSourceReport(raw: RawComponentSources, tabId: TabId, capturedAt: number, limit = 200): ComponentSourceReport {
  const byKey = new Map<string, ComponentSourceSummary>();
  const frameworks = new Set<string>();

  for (const el of raw.elements) {
    if (el.framework !== "unknown") frameworks.add(el.framework);
    const key = `${el.component}@${el.file ?? ""}:${el.line ?? ""}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.instances += 1;
    } else {
      byKey.set(key, { component: el.component, file: el.file, line: el.line, instances: 1 });
    }
  }

  const components = [...byKey.values()].sort(
    (a, b) => b.instances - a.instances || a.component.localeCompare(b.component)
  );

  const framework =
    frameworks.size === 0 ? "unknown" : frameworks.size > 1 ? "mixed" : ([...frameworks][0] as ComponentSourceReport["framework"]);

  return {
    tabId,
    url: raw.url,
    capturedAt,
    framework,
    sampledElements: raw.sampledElements,
    mappedElements: raw.elements.length,
    components,
    elements: raw.elements.slice(0, limit)
  };
}

/**
 * In-page collector. Returns a string evaluating to a `RawComponentSources`.
 * Reads dev-build source metadata: React fiber `_debugSource` (+ owner name),
 * Svelte `__svelte_meta.loc`, and Vue `__vueParentComponent.type.__file`.
 */
export function componentSourceCollectorScript(cap = 4000): string {
  return `(() => {
    const out = [];
    const selectorFor = ${SELECTOR_FOR_SOURCE};
    const baseName = (file) => {
      if (!file) return "";
      const f = String(file).split(/[\\\\/]/).pop() || "";
      return f.replace(/\\.(t|j)sx?$|\\.svelte$|\\.vue$/, "");
    };

    const fromReact = (el) => {
      const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
      if (!key) return null;
      let fiber = el[key];
      let src = null;
      let component = "";
      let guard = 0;
      while (fiber && guard++ < 60) {
        if (!src && fiber._debugSource) src = fiber._debugSource;
        const t = fiber.type;
        if (!component && t && (typeof t === "function" || typeof t === "object")) {
          const name = t.displayName || t.name || (t.type && (t.type.displayName || t.type.name));
          if (name && name !== "Unknown") component = name;
        }
        if (component && src) break;
        fiber = fiber._debugOwner || fiber.return;
      }
      if (!component && !src) return null;
      return {
        framework: "react",
        component: component || baseName(src && src.fileName) || "Component",
        file: src ? src.fileName : undefined,
        line: src ? src.lineNumber : undefined,
        column: src ? src.columnNumber : undefined
      };
    };

    const fromSvelte = (el) => {
      const meta = el.__svelte_meta;
      if (!meta || !meta.loc) return null;
      return { framework: "svelte", component: baseName(meta.loc.file) || "Component",
        file: meta.loc.file, line: meta.loc.line, column: meta.loc.column };
    };

    const fromVue = (el) => {
      const vc = el.__vueParentComponent;
      const type = vc && vc.type;
      if (!type) return null;
      const file = type.__file;
      const component = type.__name || type.name || baseName(file);
      if (!component && !file) return null;
      return { framework: "vue", component: component || "Component", file: file || undefined };
    };

    const all = Array.prototype.slice.call(document.querySelectorAll("body *"), 0, ${cap});
    for (const el of all) {
      let info = null;
      try { info = fromReact(el) || fromSvelte(el) || fromVue(el); } catch (_) {}
      if (info && info.component) out.push(Object.assign({ selector: selectorFor(el) }, info));
    }

    return { url: location.href, sampledElements: all.length, elements: out };
  })()`;
}
