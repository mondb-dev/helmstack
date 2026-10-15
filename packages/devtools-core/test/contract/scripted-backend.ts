/**
 * A scripted, in-memory `BrowserBackend` for the contract suite's fast,
 * always-on factory. Each tab's `CdpTarget` answers the CDP calls the
 * browser-independent routes make (perception pull, screenshots, viewport,
 * Fetch for mocks) and replays the CDP Network events a real page load emits,
 * so logs/HAR are exercised end to end through `cdp-events`. Routes whose
 * results come from in-page collector scripts (a11y, styles, coverage, …) are
 * not scripted; the suite runs those only against a real browser.
 */
import { PNG } from "pngjs";

import type { CdpTarget, PageObservation, TabId, TabSummary } from "../../../shared/src/index.js";
import type { BackendTab, BrowserBackend, TabLifecycleEvent } from "../../src/backend.js";

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

/**
 * What the SEO collector would read from the fixture SEO pages (see
 * fixture-server.ts): `seo-bad` has deliberate problems, anything else is clean.
 */
function seoSignalsFor(url: string): Record<string, unknown> {
  const origin = new URL(url).origin;
  const good = {
    url, origin,
    titles: ["Clean SEO fixture page for contract tests"],
    descriptions: ["A deliberately clean fixture page whose metadata, headings and structured data are all valid."],
    canonicals: [{ href: url, resolved: url }],
    lang: "en", viewport: "width=device-width, initial-scale=1",
    charset: { meta: "utf-8", httpEquiv: null, document: "UTF-8" },
    hreflang: [], robotsMeta: [],
    headings: [{ level: 1, text: "Clean SEO fixture", selector: "h1", empty: false }, { level: 2, text: "Details", selector: "h2", empty: false }],
    images: { total: 1, missingAlt: 0, missingAltSelectors: [] },
    links: [{ href: "/blank.html", abs: `${origin}/blank.html`, text: "Blank fixture page", rel: "", selector: "a" }],
    linkTotal: 1, wordCount: 320,
    openGraph: { "og:title": "t", "og:description": "d", "og:image": `${origin}/og.png`, "og:url": url, "og:type": "website" },
    twitter: { "twitter:card": "summary_large_image" },
    jsonLd: [JSON.stringify({ "@context": "https://schema.org", "@type": "Organization", name: "Fixture Co", url: origin, logo: `${origin}/logo.png` })],
    microdataItems: 0, rdfaItems: 0,
    navigation: { responseStatus: 200, redirectCount: 0 }
  };
  if (!url.includes("seo-bad")) return good;
  return {
    ...good,
    titles: [], descriptions: [], canonicals: [], lang: null, viewport: null,
    charset: { meta: "utf-8", httpEquiv: null, document: "UTF-8" },
    robotsMeta: [{ name: "robots", content: "noindex, nofollow" }],
    headings: [
      { level: 1, text: "First", selector: "h1", empty: false },
      { level: 1, text: "Second", selector: "h1", empty: false },
      { level: 4, text: "Skipped", selector: "h4", empty: false }
    ],
    images: { total: 1, missingAlt: 1, missingAltSelectors: ["img"] },
    links: [
      { href: "/blank.html", abs: `${origin}/blank.html`, text: "Read more", rel: "", selector: "a.one" },
      { href: "/seo-good.html", abs: `${origin}/seo-good.html`, text: "Read more", rel: "", selector: "a.two" },
      { href: "/missing.html", abs: `${origin}/missing.html`, text: "Gone page", rel: "", selector: "a.three" }
    ],
    linkTotal: 3, wordCount: 5, openGraph: {}, twitter: {},
    jsonLd: ['{ "@type": "Product", ']
  };
}

/** /robots.txt as `fixture-server.ts` serves it. */
function robotsFor(url: string): Record<string, unknown> {
  const origin = new URL(url).origin;
  return {
    ok: true, status: 200, url: `${origin}/robots.txt`, contentType: "text/plain",
    text: `User-agent: *\nDisallow: /private/\nSitemap: ${origin}/sitemap.xml\n`
  };
}
const PERCEPTION_CONTEXT_ID = 4242;

type Listener = (method: string, params: Record<string, unknown>) => void;

/** Deterministic solid-colour PNG, so two captures of the same page are pixel-identical. */
function solidPng(width: number, height: number): string {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 0xf4;
    png.data[i + 1] = 0xef;
    png.data[i + 2] = 0xe6;
    png.data[i + 3] = 0xff;
  }
  return PNG.sync.write(png).toString("base64");
}

/** What the perception script would report for the fixture pages. */
function observationFor(url: string, title: string): Omit<PageObservation, "tabId"> {
  const base = { url, title, timestamp: Date.now(), pageKind: "generic" as PageObservation["pageKind"], alerts: [], media: [] };
  if (!url.includes("contact-form")) {
    return { ...base, headings: [title], forms: [], primaryActions: [] };
  }
  const submit = { id: "action-submit", label: "Send message", kind: "submit" as const, selectorHint: "#contact-form button[type=submit]", disabled: false };
  return {
    ...base,
    pageKind: "form" as PageObservation["pageKind"],
    headings: ["Contact HelmStack", "Send us a message"],
    primaryActions: [submit],
    forms: [
      {
        id: "form-contact",
        purpose: "generic",
        selectorHint: "#contact-form",
        fields: [
          { id: "field-name", label: "Full name", name: "name", fieldType: "text", required: true, selectorHint: "#name" },
          { id: "field-email", label: "Work email", name: "email", fieldType: "email", required: true, selectorHint: "#email" },
          { id: "field-message", label: "Message", name: "message", fieldType: "textarea", required: true, selectorHint: "#message" }
        ],
        submitActions: [submit]
      }
    ]
  };
}

class ScriptedCdpTarget implements CdpTarget {
  private readonly listeners = new Set<Listener>();
  private metrics = { ...DEFAULT_VIEWPORT };
  private requestSeq = 0;

  constructor(private readonly tab: ScriptedTab) {}

  async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.answer(method, params) as T;
  }

  private answer(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case "DOMSnapshot.captureSnapshot":
        return { documents: [], strings: [] };
      case "Accessibility.getFullAXTree":
        return { nodes: [] };
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: "main", url: this.tab.url } } };
      case "Page.createIsolatedWorld":
        return { executionContextId: PERCEPTION_CONTEXT_ID };
      case "Runtime.evaluate":
        if (params.contextId === PERCEPTION_CONTEXT_ID) {
          return { result: { type: "string", value: JSON.stringify(observationFor(this.tab.url, this.tab.title())) } };
        }
        if (typeof params.expression === "string" && params.expression.includes("application/ld+json")) {
          return { result: { type: "object", value: seoSignalsFor(this.tab.url) } };
        }
        if (typeof params.expression === "string" && params.expression.includes('fetch("/robots.txt"')) {
          return { result: { type: "object", value: robotsFor(this.tab.url) } };
        }
        return { result: { type: "undefined" } };
      case "Emulation.setDeviceMetricsOverride":
        this.metrics = { width: Number(params.width), height: Number(params.height) };
        return {};
      case "Emulation.clearDeviceMetricsOverride":
        this.metrics = { ...DEFAULT_VIEWPORT };
        return {};
      case "Page.getLayoutMetrics":
        return {
          cssLayoutViewport: { clientWidth: this.metrics.width, clientHeight: this.metrics.height },
          cssContentSize: { width: this.metrics.width, height: this.metrics.height }
        };
      case "Page.captureScreenshot":
        return { data: solidPng(this.metrics.width, this.metrics.height) };
      default:
        return {};
    }
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Page-world probes (e.g. WebMCP detection) see an empty page. */
  async evaluate<T = unknown>(): Promise<T> {
    return {} as T;
  }

  url(): string {
    return this.tab.url;
  }

  isLoading(): boolean {
    return false;
  }

  async waitForLoadStop(): Promise<void> {}

  /** Replays the CDP events of a successful document load (monotonic `timestamp`, epoch `wallTime`). */
  emitDocumentLoad(url: string): void {
    const requestId = `req-${++this.requestSeq}`;
    const monotonic = performance.now() / 1000;
    this.emit("Network.requestWillBeSent", {
      requestId,
      type: "Document",
      request: { url, method: "GET", headers: { accept: "text/html" } },
      timestamp: monotonic,
      wallTime: Date.now() / 1000
    });
    this.emit("Network.responseReceived", {
      requestId,
      type: "Document",
      timestamp: monotonic + 0.01,
      response: { url, status: 200, statusText: "OK", mimeType: "text/html", headers: {
          "content-type": "text/html",
          "set-cookie": "contract-secret=1",
          ...(url.includes("seo-header") ? { "x-robots-tag": "noindex" } : {})
        }
      }
    });
    this.emit("Network.loadingFinished", { requestId, timestamp: monotonic + 0.02, encodedDataLength: 512 });
  }

  private emit(method: string, params: Record<string, unknown>): void {
    for (const listener of [...this.listeners]) listener(method, params);
  }
}

class ScriptedTab implements BackendTab {
  readonly cdp: ScriptedCdpTarget;
  isActive = false;

  constructor(readonly id: TabId, public url: string, private readonly backend: ScriptedBackend, readonly parentTabId?: TabId) {
    this.cdp = new ScriptedCdpTarget(this);
  }

  summary(): TabSummary {
    return { id: this.id, title: this.title(), url: this.url, isActive: this.isActive, status: "idle" };
  }

  title(): string {
    if (this.url.includes("contact-form")) return "HelmStack Contact Form Fixture";
    return new URL(this.url).pathname.replace(/^\//, "") || "about:blank";
  }

  async navigate(url: string): Promise<void> {
    this.url = url;
    this.backend.load(this);
  }
}

export class ScriptedBackend implements BrowserBackend {
  readonly kind = "daemon" as const;
  private readonly tabs = new Map<TabId, ScriptedTab>();
  private readonly lifecycle = new Set<(event: TabLifecycleEvent) => void>();
  private nextId = 1;

  defaultViewport() {
    return { ...DEFAULT_VIEWPORT };
  }

  listTabs(): BackendTab[] {
    return [...this.tabs.values()];
  }

  getTab(id: TabId): BackendTab | undefined {
    return this.tabs.get(id);
  }

  async createTab(url: string, opts?: { parentTabId?: TabId }): Promise<BackendTab> {
    const tab = new ScriptedTab(`tab-${this.nextId++}` as TabId, url, this, opts?.parentTabId);
    for (const other of this.tabs.values()) other.isActive = false;
    tab.isActive = true;
    this.tabs.set(tab.id, tab);
    this.emit({ type: "created", tab });
    this.load(tab);
    return tab;
  }

  async closeTab(id: TabId): Promise<void> {
    if (!this.tabs.delete(id)) throw new Error(`Tab ${id} not found`);
    this.emit({ type: "closed", tabId: id });
  }

  onLifecycle(listener: (event: TabLifecycleEvent) => void): () => void {
    this.lifecycle.add(listener);
    return () => this.lifecycle.delete(listener);
  }

  onObservation(): () => void {
    return () => {};
  }

  /** A main-frame navigation as the real backends report it. */
  load(tab: ScriptedTab): void {
    this.emit({ type: "main-frame-navigation", tabId: tab.id, url: tab.url });
    tab.cdp.emitDocumentLoad(tab.url);
    this.emit({ type: "load-finished", tabId: tab.id });
    this.emit({ type: "summary-changed" });
  }

  private emit(event: TabLifecycleEvent): void {
    for (const listener of [...this.lifecycle]) listener(event);
  }
}
