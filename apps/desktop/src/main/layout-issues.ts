import type { LayoutIssue, LayoutIssuesReport, TabId } from "../../../../packages/shared/src/index.js";

/** Raw layout-issue payload returned by the in-page detector script. */
export type LayoutIssuesRaw = {
  url: string;
  viewport: { width: number; height: number };
  hasHorizontalOverflow: boolean;
  documentScrollWidth: number;
  issues: LayoutIssue[];
};

const KIND_PRIORITY: Record<LayoutIssue["kind"], number> = {
  page_overflow: 0,
  viewport_overflow: 1,
  container_escape: 2,
  clipped_content: 3
};

/**
 * Assemble a LayoutIssuesReport from raw detector output: order issues by
 * severity (page-level first, then by how far each overflows) and cap the list.
 * Pure — unit-testable without a DOM.
 */
export function buildLayoutIssuesReport(
  raw: LayoutIssuesRaw,
  tabId: TabId,
  capturedAt: number,
  limit = 50
): LayoutIssuesReport {
  const issues = [...raw.issues]
    .sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || (b.overflowPx ?? 0) - (a.overflowPx ?? 0))
    .slice(0, limit);

  return {
    tabId,
    url: raw.url,
    capturedAt,
    viewport: raw.viewport,
    hasHorizontalOverflow: raw.hasHorizontalOverflow,
    documentScrollWidth: raw.documentScrollWidth,
    issues
  };
}

/**
 * In-page detector. Returns a string evaluating to a `LayoutIssuesRaw`. Finds
 * horizontal page overflow and the elements responsible, children escaping a
 * constrained parent, and elements clipping their own content. Tolerances of a
 * few px avoid sub-pixel false positives.
 */
export function layoutIssueDetectorScript(cap = 4000): string {
  return `(() => {
    const root = document.documentElement;
    const vw = root.clientWidth;
    const vh = root.clientHeight;
    const TOL = 2;

    const selectorFor = (el) => {
      const tag = el.tagName.toLowerCase();
      if (el.id) return tag + "#" + CSS.escape(el.id);
      const tid = el.getAttribute("data-testid");
      if (tid) return tag + "[data-testid=\\"" + tid + "\\"]";
      const cls = (el.getAttribute("class") || "").trim().split(/\\s+/).filter(Boolean)[0];
      if (cls) return tag + "." + CSS.escape(cls);
      return tag;
    };

    const isVisible = (el, r) => {
      if (r.width <= 0 || r.height <= 0) return false;
      const s = getComputedStyle(el);
      return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
    };

    const issues = [];
    const pushIssue = (kind, el, detail, overflowPx, r) => {
      issues.push({
        kind,
        selector: selectorFor(el),
        detail,
        bounds: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
        ...(overflowPx != null ? { overflowPx: Math.round(overflowPx) } : {})
      });
    };

    const all = Array.prototype.slice.call(document.querySelectorAll("body *"), 0, ${cap});
    const overflowing = new Set();

    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (!isVisible(el, r)) continue;
      const s = getComputedStyle(el);
      if (s.position === "fixed" || s.position === "sticky") continue;

      // Element extends past the right edge of the viewport.
      if (r.right > vw + TOL) {
        overflowing.add(el);
        const parent = el.parentElement;
        const pr = parent ? parent.getBoundingClientRect() : null;
        // Only flag the boundary where overflow begins (parent stays within the viewport).
        if (!pr || pr.right <= vw + TOL) {
          pushIssue("viewport_overflow", el, "Extends " + Math.round(r.right - vw) + "px past the right edge of the " + vw + "px viewport.", r.right - vw, r);
        }
      }

      // Child escaping a constrained parent horizontally.
      const parent = el.parentElement;
      if (parent && parent !== document.body) {
        const ps = getComputedStyle(parent);
        if (ps.overflowX === "visible") {
          const pr = parent.getBoundingClientRect();
          if (pr.width > 0 && pr.width < vw - TOL && (r.right > pr.right + TOL || r.left < pr.left - TOL)) {
            const escape = Math.max(r.right - pr.right, pr.left - r.left);
            pushIssue("container_escape", el, "Escapes its parent " + selectorFor(parent) + " by " + Math.round(escape) + "px.", escape, r);
          }
        }
      }

      // Element clipping its own content.
      if ((s.overflowX === "hidden" || s.overflowX === "clip" || s.overflow === "hidden" || s.overflow === "clip")) {
        if (el.scrollWidth > el.clientWidth + TOL) {
          pushIssue("clipped_content", el, "Content is " + (el.scrollWidth - el.clientWidth) + "px wider than its clipped box.", el.scrollWidth - el.clientWidth, r);
        }
      }
    }

    const hasHorizontalOverflow = root.scrollWidth > vw + TOL;
    if (hasHorizontalOverflow) {
      issues.unshift({
        kind: "page_overflow",
        selector: "html",
        detail: "Document scrolls horizontally: scrollWidth " + root.scrollWidth + "px vs viewport " + vw + "px.",
        bounds: { x: 0, y: 0, width: root.scrollWidth, height: vh },
        overflowPx: root.scrollWidth - vw
      });
    }

    return { url: location.href, viewport: { width: vw, height: vh }, hasHorizontalOverflow, documentScrollWidth: root.scrollWidth, issues };
  })()`;
}
