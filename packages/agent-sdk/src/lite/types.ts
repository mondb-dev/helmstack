import type {
  A11yAuditReport,
  BrowserCommandResult,
  BrowserOutputCommand,
  BrowserPerceptionPacket,
  FieldType,
  HealthReport,
  LayoutIssuesReport,
  ObservedAction,
  ObservedAlert,
  ObservedForm,
  PageScreenshot,
  PerformanceReport,
  SeoAuditReport,
  TabSummary
} from "../../../shared/src/index.js";

/** Default character cap for one page view (~600 tokens). */
export const DEFAULT_VIEW_CHARS = 2400;
/** Default number of audit items listed in a digest. */
export const DEFAULT_DIGEST_ITEMS = 5;

/** The slice of PageGraph / PageObservation the page view is built from. */
export type LitePageSource = {
  url: string;
  title: string;
  headings: string[];
  forms: ObservedForm[];
  alerts: string[];
  alertDetails?: ObservedAlert[];
  /** PageGraph.actions */
  actions?: ObservedAction[];
  /** PageObservation.primaryActions (used when `actions` is absent) */
  primaryActions?: ObservedAction[];
  /**
   * Visible body text (e.g. `document.body.innerText`). Perception carries
   * only structure, so the session fetches this separately. Optional.
   */
  text?: string;
};

/** One numbered, actionable element of a view. Held server-side per tab. */
export type LiteElement = {
  n: number;
  kind: "field" | "action";
  /** Display role: textbox, checkbox, combobox, radio, button, link. */
  role: string;
  label: string;
  /** Perception id of the field / action (used to build the DOM tool call). */
  id: string;
  selectorHint: string;
  fieldType?: FieldType;
  formId?: string;
  /** Checkbox/radio state, or whether a text field holds anything. */
  filled?: boolean;
  /** Set on submit buttons: the form this button submits. */
  submitsFormId?: string;
  href?: string;
};

export type LitePageView = {
  text: string;
  elements: LiteElement[];
  /** Elements that existed but were not listed because of the cap. */
  omitted: number;
  /** Text without the `· view N` counter, for change detection. */
  fingerprint: string;
};

export type LiteSeverity = "error" | "warning" | "note";

export type LiteDigestItem = {
  n: number;
  severity: LiteSeverity;
  summary: string;
  /** Longer text returned by `details n`. */
  detail: string;
};

export type LiteAuditKind = "accessibility" | "seo" | "layout" | "performance" | "health";
export const LITE_AUDIT_KINDS: readonly LiteAuditKind[] = ["accessibility", "seo", "layout", "performance", "health"];

export type LiteDigest = {
  kind: LiteAuditKind;
  text: string;
  /** Every item (also those not printed), numbered from 1. */
  items: LiteDigestItem[];
};

export type LiteAuditReports = {
  accessibility: A11yAuditReport;
  seo: SeoAuditReport;
  layout: LayoutIssuesReport;
  performance: PerformanceReport;
  health: HealthReport;
};

/** The subset of BrowserClient the lite session needs (also easy to fake in tests). */
export interface LiteBrowser {
  listTabs(): Promise<TabSummary[]>;
  openTab(url?: string): Promise<TabSummary[]>;
  navigate(tabId: string, url: string): Promise<TabSummary[]>;
  reload(tabId: string): Promise<TabSummary[]>;
  goBack(tabId: string): Promise<TabSummary[]>;
  goForward(tabId: string): Promise<TabSummary[]>;
  setViewport(tabId: string, width: number, height: number, mobile?: boolean): Promise<unknown>;
  getPerception(tabId: string): Promise<BrowserPerceptionPacket>;
  getScreenshot(tabId: string): Promise<PageScreenshot>;
  execute(tabId: string, command: BrowserOutputCommand): Promise<BrowserCommandResult>;
  evaluate<T = unknown>(tabId: string, expression: string): Promise<T>;
  auditAccessibility(tabId: string): Promise<A11yAuditReport>;
  seoAudit(tabId: string): Promise<SeoAuditReport>;
  detectLayoutIssues(tabId: string): Promise<LayoutIssuesReport>;
  getPerformanceMetrics(tabId: string): Promise<PerformanceReport>;
  getHealthReport(tabId: string): Promise<HealthReport>;
  /** Optional: lets the session report approvals that were rejected / expired. */
  stream?(handlers: {
    onApprovalResolved?: (r: { requestId: string; outcome: "approved" | "rejected" | "cancelled" | "expired"; reason?: string }) => void;
  }): { close(): void };
}
