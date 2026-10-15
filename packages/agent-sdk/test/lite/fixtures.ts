import type { LiteBrowser, LitePageSource } from "../../src/lite/index.js";

export const SECRET = "jane.doe@example.com";

export function contactSource(overrides: Partial<LitePageSource> = {}): LitePageSource {
  return {
    url: "http://127.0.0.1:4177/contact-form.html",
    title: "Contact HelmStack",
    headings: ["Contact HelmStack", "Send us a message", "Contact HelmStack"],
    alerts: ["Please enter a valid email address."],
    alertDetails: [{ text: "Please enter a valid email address.", tone: "error", signals: ["role-alert"] }],
    forms: [
      {
        id: "form-1",
        purpose: "generic",
        selectorHint: "#contact-form",
        fields: [
          { id: "field-name", label: "Full name", fieldType: "text", required: true, selectorHint: "#name", filled: false },
          { id: "field-email", label: "Work email", fieldType: "email", required: true, selectorHint: "#email", filled: true, invalid: true },
          { id: "field-topic", label: "Topic", fieldType: "select", required: false, selectorHint: "#topic", filled: true },
          { id: "field-consent", label: "I agree to be contacted", fieldType: "checkbox", required: true, selectorHint: "#consent", filled: false }
        ],
        submitActions: [{ id: "act-send", label: "Send message", kind: "submit", selectorHint: "button[type=submit]", disabled: false }]
      }
    ],
    actions: [
      { id: "act-send", label: "Send message", kind: "submit", selectorHint: "button[type=submit]", disabled: false },
      { id: "act-docs", label: "Docs", kind: "link", href: "/docs", selectorHint: "a.docs", disabled: false },
      { id: "act-help", label: "Help", kind: "button", selectorHint: "button.help", disabled: false }
    ],
    ...overrides
  };
}

export function manyLinks(count: number): LitePageSource {
  const base = contactSource();
  return {
    ...base,
    actions: [
      ...(base.actions ?? []),
      ...Array.from({ length: count }, (_, i) => ({
        id: `act-link-${i}`,
        label: `Reference article number ${i + 1} about browsers`,
        kind: "link" as const,
        href: `/ref/${i}`,
        selectorHint: `a.ref-${i}`,
        disabled: false
      }))
    ]
  };
}

export type FakeCall = { method: string; args: unknown[] };

/** A scripted LiteBrowser; `perception` is a function so tests can mutate the page. */
export function fakeBrowser(state: { source: LitePageSource; pageText?: string; tabs?: Array<{ id: string; title: string; url: string; isActive: boolean; status: "idle" }> }) {
  const calls: FakeCall[] = [];
  let executeResult: unknown = { status: "completed", command: { type: "request_perception_refresh", tabId: "tab-1" } };
  let executeThrows: Error | null = null;
  let streamHandlers: { onApprovalResolved?: (r: { requestId: string; outcome: "approved" | "rejected" | "cancelled" | "expired" }) => void } | null = null;
  const tabs = state.tabs ?? [{ id: "tab-1", title: state.source.title, url: state.source.url, isActive: true, status: "idle" as const }];
  const rec = (method: string, ...args: unknown[]) => calls.push({ method, args });
  const browser = {
    async listTabs() { rec("listTabs"); return tabs.map((t) => ({ ...t })); },
    async openTab(url?: string) { rec("openTab", url); return tabs; },
    async navigate(id: string, url: string) { rec("navigate", id, url); state.source = { ...state.source, url }; return tabs.map((t) => ({ ...t, url })); },
    async reload(id: string) { rec("reload", id); return tabs; },
    async goBack(id: string) { rec("goBack", id); return tabs; },
    async goForward(id: string) { rec("goForward", id); return tabs; },
    async setViewport(id: string, w: number, h: number, m?: boolean) { rec("setViewport", id, w, h, m); return { ok: true }; },
    async getPerception(id: string) {
      rec("getPerception", id);
      return { tabId: id, emittedAt: 0, observation: null, result: { snapshot: {}, observation: null, graph: state.source }, siteCapabilities: [] };
    },
    async getScreenshot() { rec("getScreenshot"); return { tabId: "tab-1", capturedAt: 0, data: Buffer.from("PNG").toString("base64"), mimeType: "image/png", width: 800, height: 600 }; },
    async execute(id: string, command: unknown) {
      rec("execute", id, command);
      if (executeThrows) throw executeThrows;
      return executeResult;
    },
    async evaluate(id: string, expr: string) {
      rec("evaluate", id, expr);
      if (expr.includes("innerText")) return state.pageText ?? null;
      if (expr.includes("innerWidth")) return { w: 1280, h: 800 };
      if (expr.includes("scrollBy")) return { moved: true, pct: 80 };
      return null;
    },
    async auditAccessibility() { rec("auditAccessibility"); return {} as never; },
    async seoAudit() { rec("seoAudit"); return {} as never; },
    async detectLayoutIssues() { rec("detectLayoutIssues"); return {} as never; },
    async getPerformanceMetrics() { rec("getPerformanceMetrics"); return {} as never; },
    async getHealthReport() { rec("getHealthReport"); return {} as never; },
    stream(handlers: typeof streamHandlers) { streamHandlers = handlers; return { close() { streamHandlers = null; } }; }
  };
  return {
    browser: browser as unknown as LiteBrowser,
    calls,
    setExecuteResult(value: unknown) { executeResult = value; },
    setExecuteThrows(error: Error | null) { executeThrows = error; },
    emitApproval(r: { requestId: string; outcome: "approved" | "rejected" | "cancelled" | "expired" }) { streamHandlers?.onApprovalResolved?.(r); },
    get streaming() { return streamHandlers !== null; }
  };
}
