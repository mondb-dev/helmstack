import type { WebContents } from "electron";

import type {
  ElementStyleAssertionReport,
  ElementStyleInspection,
  ElementStyleInspectionReport,
  StyleAssertion,
  StyleAssertionCheck,
  TabId
} from "../../../../packages/shared/src/index.js";
import { clampInt } from "./util.js";

/**
 * Element style inspector — computed-style/box/contrast inspection and CSS
 * assertions over CDP. Extracted from `TabManager`. Assumes the CDP debugger is
 * already attached.
 */
export async function inspectStyles(webContents: WebContents, tabId: TabId, selector: string, options: { limit?: number } = {}): Promise<ElementStyleInspectionReport> {
  const limit = clampInt(options.limit ?? 20, 1, 100);

  const result = await webContents.debugger.sendCommand("Runtime.evaluate", {
    expression: `(${buildElementStyleInspectorScript()})(${JSON.stringify({ selector, limit })})`,
    returnByValue: true,
    awaitPromise: true
  }) as { result: { value?: Omit<ElementStyleInspectionReport, "tabId" | "capturedAt"> } };

  const value = result.result.value;
  if (!value) {
    return { tabId, url: webContents.getURL(), capturedAt: Date.now(), selector, matchedCount: 0, inspectedCount: 0, elements: [], warnings: ["Style inspection did not return a value."] };
  }
  return { ...value, tabId, capturedAt: Date.now() };
}

export async function assertStyles(webContents: WebContents, tabId: TabId, selector: string, assertions: StyleAssertion[], options: { limit?: number } = {}): Promise<ElementStyleAssertionReport> {
  const inspection = await inspectStyles(webContents, tabId, selector, options);
  const checks: StyleAssertionCheck[] = [];
  for (const element of inspection.elements) {
    for (const assertion of assertions) {
      checks.push(evaluateStyleAssertion(element, assertion));
    }
  }
  const issues = inspection.elements.flatMap((element) => element.issues);
  const pass = inspection.matchedCount > 0 && checks.length > 0 && checks.every((check) => check.pass);
  return { tabId, url: inspection.url, capturedAt: Date.now(), selector, pass, matchedCount: inspection.matchedCount, checks, inspected: inspection.elements, issues };
}

// ── Helpers (moved verbatim from TabManager) ───────────────────────────────

export function evaluateStyleAssertion(element: ElementStyleInspection, assertion: StyleAssertion): StyleAssertionCheck {
  const property = toKebabCase(assertion.property);
  const actual = element.computed[property] ?? element.computed[assertion.property];
  const expected = describeStyleExpectation(assertion);

  if (actual === undefined) {
    return {
      elementIndex: element.index,
      selectorHint: element.selectorHint,
      property,
      actual,
      expected,
      pass: false,
      message: `Property "${property}" was not captured for ${element.selectorHint}.`
    };
  }

  const checks: Array<{ pass: boolean; message: string }> = [];
  const tolerance = assertion.tolerance ?? 0;

  if (assertion.equals !== undefined) {
    const expectedValue = String(assertion.equals);
    const numericExpected = typeof assertion.equals === "number" ? assertion.equals : parseCssNumber(expectedValue);
    const numericActual = parseCssNumber(actual);
    const pass =
      numericExpected !== null && numericActual !== null
        ? Math.abs(numericActual - numericExpected) <= tolerance
        : canonicalCssValue(actual) === canonicalCssValue(expectedValue);
    checks.push({
      pass,
      message: pass ? `${property} equals ${expectedValue}.` : `${property} expected ${expectedValue}, got ${actual}.`
    });
  }

  if (assertion.not !== undefined) {
    const disallowed = String(assertion.not);
    const pass = canonicalCssValue(actual) !== canonicalCssValue(disallowed);
    checks.push({
      pass,
      message: pass ? `${property} is not ${disallowed}.` : `${property} should not be ${disallowed}.`
    });
  }

  if (assertion.contains !== undefined) {
    const pass = actual.toLowerCase().includes(assertion.contains.toLowerCase());
    checks.push({
      pass,
      message: pass ? `${property} contains ${assertion.contains}.` : `${property} does not contain ${assertion.contains}; got ${actual}.`
    });
  }

  if (assertion.matches !== undefined) {
    let pass = false;
    try {
      pass = new RegExp(assertion.matches).test(actual);
    } catch {
      // invalid regex → pass stays false
    }
    checks.push({
      pass,
      message: pass ? `${property} matches /${assertion.matches}/.` : `${property} does not match /${assertion.matches}/; got ${actual}.`
    });
  }

  if (assertion.min !== undefined) {
    const numericActual = parseCssNumber(actual);
    const pass = numericActual !== null && numericActual >= assertion.min;
    checks.push({
      pass,
      message: pass ? `${property} is at least ${assertion.min}.` : `${property} expected >= ${assertion.min}, got ${actual}.`
    });
  }

  if (assertion.max !== undefined) {
    const numericActual = parseCssNumber(actual);
    const pass = numericActual !== null && numericActual <= assertion.max;
    checks.push({
      pass,
      message: pass ? `${property} is at most ${assertion.max}.` : `${property} expected <= ${assertion.max}, got ${actual}.`
    });
  }

  if (checks.length === 0) {
    return {
      elementIndex: element.index,
      selectorHint: element.selectorHint,
      property,
      actual,
      expected,
      pass: false,
      message: `No assertion operator was supplied for "${property}".`
    };
  }

  const failed = checks.find((check) => !check.pass);
  return {
    elementIndex: element.index,
    selectorHint: element.selectorHint,
    property,
    actual,
    expected,
    pass: failed === undefined,
    message: failed?.message ?? checks.map((check) => check.message).join(" ")
  };
}

function describeStyleExpectation(assertion: StyleAssertion): string {
  const parts: string[] = [];
  if (assertion.equals !== undefined) parts.push(`equals ${assertion.equals}`);
  if (assertion.not !== undefined) parts.push(`not ${assertion.not}`);
  if (assertion.contains !== undefined) parts.push(`contains ${assertion.contains}`);
  if (assertion.matches !== undefined) parts.push(`matches /${assertion.matches}/`);
  if (assertion.min !== undefined) parts.push(`min ${assertion.min}`);
  if (assertion.max !== undefined) parts.push(`max ${assertion.max}`);
  return parts.join("; ") || "unspecified";
}

function toKebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`).replace(/^-/, "");
}

function parseCssNumber(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalCssValue(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const hex = trimmed.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const raw = hex[1];
    const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
    const r = Number.parseInt(full.slice(0, 2), 16);
    const g = Number.parseInt(full.slice(2, 4), 16);
    const b = Number.parseInt(full.slice(4, 6), 16);
    return `rgb(${r},${g},${b})`;
  }

  return trimmed.replace(/\s+/g, " ").replace(/\s*,\s*/g, ",");
}

function buildElementStyleInspectorScript() {
  const fn = (payload: { selector: string; limit: number }) => {
    const selector = String(payload.selector || "");
    const limit = Math.max(1, Math.min(100, Number(payload.limit) || 20));
    const warnings: string[] = [];
    const properties = [
      "display", "visibility", "opacity", "pointer-events", "position", "z-index",
      "top", "right", "bottom", "left", "overflow", "overflow-x", "overflow-y",
      "box-sizing", "width", "height", "min-width", "min-height", "max-width", "max-height",
      "margin-top", "margin-right", "margin-bottom", "margin-left",
      "padding-top", "padding-right", "padding-bottom", "padding-left",
      "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
      "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
      "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
      "border-radius", "color", "background-color", "font-family", "font-size", "font-weight",
      "line-height", "letter-spacing", "text-align", "text-decoration-line", "white-space",
      "text-overflow", "box-shadow", "filter", "transform", "transition-duration",
      "animation-name", "animation-duration", "flex-direction", "align-items", "justify-content",
      "gap", "row-gap", "column-gap", "grid-template-columns", "grid-template-rows"
    ];

    const roots = collectRoots();
    const matches: Element[] = [];
    for (const root of roots) {
      try {
        matches.push(...Array.from(root.querySelectorAll(selector)));
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : "Invalid selector.");
        break;
      }
    }

    const seen = new Set<Element>();
    const elements = matches
      .filter((element) => {
        if (seen.has(element)) return false;
        seen.add(element);
        return true;
      })
      .slice(0, limit)
      .map((element, index) => inspectElement(element, index));

    if (matches.length > limit) {
      warnings.push(`Matched ${matches.length} elements; inspected first ${limit}.`);
    }

    return {
      url: window.location.href,
      selector,
      matchedCount: matches.length,
      inspectedCount: elements.length,
      elements,
      warnings
    };

    function collectRoots(): ParentNode[] {
      const collected: ParentNode[] = [document];
      const queue: ParentNode[] = [document];
      const seenRoots = new Set<ParentNode>([document]);

      while (queue.length > 0) {
        const current = queue.shift();
        if (!current) break;
        for (const element of Array.from(current.querySelectorAll("*"))) {
          const maybeShadow = (element as HTMLElement).shadowRoot;
          if (maybeShadow && !seenRoots.has(maybeShadow)) {
            seenRoots.add(maybeShadow);
            collected.push(maybeShadow);
            queue.push(maybeShadow);
          }

          if (element.tagName.toLowerCase() === "iframe") {
            try {
              const doc = (element as HTMLIFrameElement).contentDocument;
              if (doc && !seenRoots.has(doc)) {
                seenRoots.add(doc);
                collected.push(doc);
                queue.push(doc);
              }
            } catch {
              // Cross-origin iframe; skip.
            }
          }
        }
      }

      return collected;
    }

    function inspectElement(element: Element, index: number) {
      const view = element.ownerDocument.defaultView || window;
      const style = view.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const computed: Record<string, string> = {};
      for (const property of properties) {
        computed[property] = style.getPropertyValue(property);
      }

      const margin = edges(style, "margin", "");
      const border = edges(style, "border", "-width");
      const padding = edges(style, "padding", "");
      const isVisible =
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || "1") > 0 &&
        rect.width > 0 &&
        rect.height > 0;
      const inViewport =
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < view.innerHeight &&
        rect.left < view.innerWidth;

      const contrast = getContrast(element, style);
      const issues = collectIssues(element, style, rect, isVisible, inViewport, contrast);
      const className = element.getAttribute("class") || undefined;
      const text = normalizeText(element.textContent || "");

      return {
        index,
        selectorHint: selectorHint(element),
        tagName: element.tagName.toLowerCase(),
        ...(element.id ? { id: element.id } : {}),
        ...(className ? { className } : {}),
        ...(element.getAttribute("role") ? { role: element.getAttribute("role") || undefined } : {}),
        ...(element.getAttribute("aria-label") ? { ariaLabel: element.getAttribute("aria-label") || undefined } : {}),
        ...(text ? { text: text.slice(0, 160) } : {}),
        isVisible,
        inViewport,
        bounds: roundRect(rect),
        box: {
          margin,
          border,
          padding,
          content: {
            width: round(Math.max(0, rect.width - border.left - border.right - padding.left - padding.right)),
            height: round(Math.max(0, rect.height - border.top - border.bottom - padding.top - padding.bottom))
          }
        },
        computed,
        ...(contrast ? { contrast } : {}),
        issues
      };
    }

    function collectIssues(
      element: Element,
      style: CSSStyleDeclaration,
      rect: DOMRect,
      isVisible: boolean,
      inViewport: boolean,
      contrast: ReturnType<typeof getContrast>
    ) {
      const issues: Array<{ kind: string; severity: string; message: string; property?: string; value?: string | number | boolean }> = [];
      if (!isVisible) {
        issues.push({ kind: "not_visible", severity: "warning", message: "Element is not visible.", property: "display/visibility/opacity" });
      }
      if (rect.width === 0 || rect.height === 0) {
        issues.push({ kind: "zero_size", severity: "error", message: "Element has a zero-width or zero-height bounding box." });
      }
      if (isVisible && !inViewport) {
        issues.push({ kind: "offscreen", severity: "warning", message: "Element is rendered outside the current viewport." });
      }
      if (style.pointerEvents === "none") {
        issues.push({ kind: "pointer_events_none", severity: isInteractive(element) ? "error" : "info", message: "Element ignores pointer events.", property: "pointer-events", value: "none" });
      }
      if (contrast && !contrast.passesAA) {
        issues.push({ kind: "low_contrast", severity: "error", message: `Text contrast ratio ${contrast.ratio}:1 is below WCAG AA.`, property: "color/background-color", value: contrast.ratio });
      }
      if (isInteractive(element) && isVisible && (rect.width < 44 || rect.height < 44)) {
        issues.push({ kind: "small_tap_target", severity: "warning", message: "Interactive target is smaller than 44x44 CSS px.", value: `${round(rect.width)}x${round(rect.height)}` });
      }
      if (hasClippedContent(element, style)) {
        issues.push({ kind: "clipped_content", severity: "warning", message: "Element content appears clipped by overflow settings.", property: "overflow", value: style.overflow });
      }
      const z = Number.parseInt(style.zIndex || "0", 10);
      if (Number.isFinite(z) && z >= 1000) {
        issues.push({ kind: "high_z_index", severity: "info", message: "Element uses a high z-index.", property: "z-index", value: z });
      }
      if (style.position === "fixed" || style.position === "sticky") {
        issues.push({ kind: "fixed_or_sticky", severity: "info", message: `Element is ${style.position} positioned.`, property: "position", value: style.position });
      }
      return issues;
    }

    function edges(style: CSSStyleDeclaration, prefix: string, suffix: string) {
      return {
        top: round(cssNumber(style.getPropertyValue(prefix + "-top" + suffix))),
        right: round(cssNumber(style.getPropertyValue(prefix + "-right" + suffix))),
        bottom: round(cssNumber(style.getPropertyValue(prefix + "-bottom" + suffix))),
        left: round(cssNumber(style.getPropertyValue(prefix + "-left" + suffix)))
      };
    }

    function getContrast(element: Element, style: CSSStyleDeclaration) {
      const text = normalizeText(element.textContent || "");
      if (!text) return null;
      const fg = parseColor(style.color);
      const bg = findEffectiveBackground(element);
      if (!fg || !bg || fg.a === 0) return null;
      const ratio = contrastRatio(fg, bg);
      const fontSizePx = cssNumber(style.fontSize);
      const fontWeight = style.fontWeight;
      const large = fontSizePx >= 24 || (fontSizePx >= 18.66 && Number.parseInt(fontWeight, 10) >= 600);
      return {
        foreground: colorString(fg),
        background: colorString(bg),
        ratio: round(ratio),
        fontSizePx: round(fontSizePx),
        fontWeight,
        passesAA: ratio >= (large ? 3 : 4.5),
        passesLargeTextAA: ratio >= 3
      };
    }

    function findEffectiveBackground(element: Element) {
      let current: Element | null = element;
      while (current) {
        const view = current.ownerDocument.defaultView || window;
        const bg = parseColor(view.getComputedStyle(current).backgroundColor);
        if (bg && bg.a > 0) return bg;
        current = current.parentElement;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    }

    function parseColor(value: string) {
      const match = value.match(/rgba?\(([^)]+)\)/i);
      if (!match) return null;
      const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
      if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) return null;
      return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
    }

    function contrastRatio(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) {
      const l1 = luminance(a);
      const l2 = luminance(b);
      const high = Math.max(l1, l2);
      const low = Math.min(l1, l2);
      return (high + 0.05) / (low + 0.05);
    }

    function luminance(c: { r: number; g: number; b: number }) {
      const channel = (value: number) => {
        const normalized = value / 255;
        return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
    }

    function colorString(c: { r: number; g: number; b: number; a: number }) {
      return c.a === 1 ? `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})` : `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${round(c.a)})`;
    }

    function hasClippedContent(element: Element, style: CSSStyleDeclaration) {
      const html = element as HTMLElement;
      const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`;
      if (!/(hidden|clip|scroll)/.test(overflow)) return false;
      return html.scrollWidth > html.clientWidth + 1 || html.scrollHeight > html.clientHeight + 1;
    }

    function isInteractive(element: Element) {
      const tag = element.tagName.toLowerCase();
      const role = element.getAttribute("role") || "";
      return ["a", "button", "input", "select", "textarea", "summary"].includes(tag) || ["button", "link", "checkbox", "radio", "tab", "menuitem", "switch"].includes(role);
    }

    function selectorHint(element: Element) {
      const tag = element.tagName.toLowerCase();
      if (element.id) return `${tag}#${cssEscape(element.id)}`;
      const classList = Array.from(element.classList).slice(0, 3);
      if (classList.length) return `${tag}.${classList.map(cssEscape).join(".")}`;
      const parent = element.parentElement;
      if (!parent) return tag;
      const siblings = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
      const index = siblings.indexOf(element) + 1;
      return siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag;
    }

    function cssEscape(value: string) {
      if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
      return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    }

    function roundRect(rect: DOMRect) {
      return {
        x: round(rect.x),
        y: round(rect.y),
        top: round(rect.top),
        right: round(rect.right),
        bottom: round(rect.bottom),
        left: round(rect.left),
        width: round(rect.width),
        height: round(rect.height)
      };
    }

    function cssNumber(value: string) {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    function round(value: number) {
      return Math.round(value * 100) / 100;
    }

    function normalizeText(value: string) {
      return value.replace(/\s+/g, " ").trim();
    }
  };

  return fn.toString();
}
