/**
 * Agent activity feed: what the agent server records about each handled API
 * call so the desktop shell can show the human what an agent did.
 *
 * REDACTION — an entry carries only:
 *  - the route *pattern* from {@link ACTIVITY_ROUTES} (never the raw path, so
 *    no ids, URLs, cookie names or query strings; unknown paths are recorded as
 *    {@link UNMATCHED_ROUTE});
 *  - a fixed label from the same table;
 *  - the tab id (`:id` of `/api/tabs/:id/…` only) and the agent id header
 *    (truncated);
 *  - status, timing, and a summary built **only from numbers, booleans and
 *    fixed enums** of the JSON response (counts, pass/fail, statuses) — the
 *    one exception is a picked element's tag name, validated by {@link pickTag}.
 * Request bodies, headers other than `X-Agent-ID`, tokens, typed text,
 * selectors, assertion text, URLs and response strings are never read into
 * an entry.
 */
import type { AgentActivityEntry } from "../../../shared/src/index.js";

type Summarizer = (data: Record<string, unknown>) => string | undefined;

export type ActivityRoute = {
  method: string;
  /** Route pattern; `:name` segments match one path segment. */
  pattern: string;
  /** Sentence-case label shown in the shell's activity feed. */
  label: string;
  /** Optional one-line summary from the JSON response (numbers/enums only). */
  summarize?: Summarizer;
};

/** Route recorded when no table entry matches (the raw path is never kept). */
export const UNMATCHED_ROUTE = "(unmatched)";

/** Paths deliberately not recorded; see {@link isActivityExcluded}. */
const EXCLUDED: ReadonlyArray<{ method: string; path: string }> = [
  // Liveness polling — would drown the feed; connection status covers it.
  { method: "GET", path: "/api/health" },
  // The long-lived SSE stream — reflected in connection status (`sseClients`).
  { method: "GET", path: "/api/stream" },
  // Agent log lines already reach the shell through the AgentLog channel.
  { method: "POST", path: "/api/log" }
];

const count = (n: unknown, one: string, many = `${one}s`): string | undefined =>
  typeof n === "number" ? `${n} ${n === 1 ? one : many}` : undefined;
const len = (v: unknown): number | undefined => (Array.isArray(v) ? v.length : undefined);
const passFail = (d: Record<string, unknown>): string | undefined =>
  typeof d.pass === "boolean" ? (d.pass ? "Passed" : "Failed") : undefined;
const arrayCount = (one: string, many?: string): Summarizer => (d) => count(len(d.__array), one, many);

const COMMAND_STATUSES = new Set(["completed", "awaiting_approval", "blocked", "failed", "awaiting_human"]);
const commandStatus: Summarizer = (d) => {
  if (typeof d.status !== "string" || !COMMAND_STATUSES.has(d.status)) return undefined;
  return d.status.replace(/_/g, " ");
};

/** Tag name of a recorded human pick (`{ pick: { tagName } }`); never its text or selector. */
const tagSummary: Summarizer = (d) => pickTag((d.pick as { tagName?: unknown } | undefined)?.tagName);

/** A lower-case tag name when it looks like one, else undefined (keeps page strings out of the feed). */
export function pickTag(tagName: unknown): string | undefined {
  if (typeof tagName !== "string") return undefined;
  const tag = tagName.toLowerCase();
  return /^[a-z][a-z0-9-]{0,63}$/.test(tag) ? tag : undefined;
}

/**
 * Activity entry for a pick the human made with "Select for agent" in the
 * shell. Not an HTTP route: `method`/`route` are fixed markers so the feed
 * can show it alongside agent calls. The summary is the tag name only.
 */
export const SHELL_PICK_ACTIVITY = {
  method: "SHELL",
  route: "shell:select-for-agent",
  label: "You selected an element"
} as const;

/**
 * Every agent API route, its label and optional summary. Keep in sync with the
 * router in `agent-server.ts` (a test asserts each documented route matches).
 */
export const ACTIVITY_ROUTES: readonly ActivityRoute[] = [
  // Tabs
  { method: "GET", pattern: "/api/tabs", label: "List tabs", summarize: arrayCount("tab") },
  { method: "POST", pattern: "/api/tabs", label: "Open tab" },
  { method: "DELETE", pattern: "/api/tabs/:id", label: "Close tab" },
  { method: "POST", pattern: "/api/tabs/:id/navigate", label: "Navigate" },
  { method: "POST", pattern: "/api/tabs/:id/reload", label: "Reload page" },
  { method: "POST", pattern: "/api/tabs/:id/back", label: "Go back" },
  { method: "POST", pattern: "/api/tabs/:id/forward", label: "Go forward" },
  // Perception / commands
  {
    method: "GET", pattern: "/api/tabs/:id/perception", label: "Read page",
    summarize: (d) => {
      const graph = (d.result as { graph?: { forms?: unknown; actions?: unknown } } | undefined)?.graph;
      const forms = len(graph?.forms);
      const actions = len(graph?.actions);
      return forms === undefined || actions === undefined ? undefined : `${count(forms, "form")}, ${count(actions, "action")}`;
    }
  },
  { method: "GET", pattern: "/api/tabs/:id/manifests", label: "List site capabilities", summarize: arrayCount("capability", "capabilities") },
  { method: "POST", pattern: "/api/tabs/:id/command", label: "Run page command", summarize: commandStatus },
  { method: "POST", pattern: "/api/tabs/:id/perception/named", label: "Save perception snapshot" },
  { method: "POST", pattern: "/api/perception/diff", label: "Compare perception snapshots" },
  { method: "GET", pattern: "/api/perception", label: "List perception snapshots" },
  { method: "DELETE", pattern: "/api/perception/:snapshotId", label: "Delete perception snapshot" },
  // Approvals / handoffs
  { method: "GET", pattern: "/api/approvals", label: "List approvals", summarize: arrayCount("pending", "pending") },
  { method: "POST", pattern: "/api/approvals/:requestId/approve", label: "Approve action", summarize: commandStatus },
  { method: "POST", pattern: "/api/approvals/:requestId/reject", label: "Reject action" },
  { method: "GET", pattern: "/api/handoffs", label: "List handoffs" },
  { method: "POST", pattern: "/api/handoffs/:requestId/resolve", label: "Resolve handoff" },
  { method: "POST", pattern: "/api/handoffs/:requestId/cancel", label: "Cancel handoff" },
  // Intent
  { method: "GET", pattern: "/api/intent", label: "Read intent" },
  { method: "PUT", pattern: "/api/intent", label: "Set intent" },
  // Screenshots / visual diff / viewport
  {
    method: "GET", pattern: "/api/tabs/:id/screenshot", label: "Screenshot",
    summarize: (d) => (typeof d.width === "number" && typeof d.height === "number" ? `${d.width}×${d.height}` : undefined)
  },
  { method: "POST", pattern: "/api/tabs/:id/screenshot/named", label: "Named screenshot" },
  {
    method: "POST", pattern: "/api/screenshots/diff", label: "Compare screenshots",
    summarize: (d) => (typeof d.diffPixelCount === "number" ? `${count(d.diffPixelCount, "pixel")} differ` : undefined)
  },
  { method: "POST", pattern: "/api/tabs/:id/changed-elements", label: "Map changed elements", summarize: arrayCount("element") },
  { method: "GET", pattern: "/api/screenshots", label: "List screenshots" },
  { method: "DELETE", pattern: "/api/screenshots/:snapshotId", label: "Delete screenshot" },
  {
    method: "POST", pattern: "/api/tabs/:id/viewport", label: "Set viewport",
    summarize: (d) => (typeof d.width === "number" && typeof d.height === "number"
      ? `${d.width}×${d.height}${d.mobile === true ? " mobile" : ""}`
      : undefined)
  },
  { method: "POST", pattern: "/api/tabs/:id/viewport-suite", label: "Viewport suite", summarize: (d) => count(len(d.captures), "breakpoint") },
  // Inspection
  { method: "GET", pattern: "/api/tabs/:id/performance", label: "Performance metrics" },
  {
    method: "GET", pattern: "/api/tabs/:id/health", label: "Health report",
    summarize: (d) => (typeof d.overallScore === "number" ? `Score ${Math.round(d.overallScore)}` : undefined)
  },
  { method: "GET", pattern: "/api/tabs/:id/a11y", label: "Accessibility audit", summarize: (d) => count(len(d.violations), "issue") },
  {
    method: "GET", pattern: "/api/tabs/:id/seo", label: "SEO audit",
    summarize: (d) => {
      const c = d.counts as Record<string, unknown> | undefined;
      if (!c || typeof c.error !== "number" || typeof c.warning !== "number") return undefined;
      return `${count(c.error, "error")} · ${count(c.warning, "warning")}`;
    }
  },
  { method: "GET", pattern: "/api/tabs/:id/focus-order", label: "Focus order audit" },
  { method: "POST", pattern: "/api/tabs/:id/styles/inspect", label: "Inspect element styles", summarize: (d) => count(d.matchedCount, "element") },
  { method: "POST", pattern: "/api/tabs/:id/styles/assert", label: "Assert element styles", summarize: passFail },
  { method: "GET", pattern: "/api/tabs/:id/component-tree", label: "Component tree" },
  { method: "GET", pattern: "/api/tabs/:id/design-tokens", label: "Design tokens" },
  { method: "GET", pattern: "/api/tabs/:id/css-coverage", label: "CSS coverage" },
  { method: "GET", pattern: "/api/tabs/:id/js-coverage", label: "JS coverage" },
  { method: "GET", pattern: "/api/tabs/:id/trace", label: "Performance trace" },
  { method: "GET", pattern: "/api/tabs/:id/framework", label: "Detect framework" },
  { method: "GET", pattern: "/api/tabs/:id/component-sources", label: "Component sources" },
  { method: "GET", pattern: "/api/tabs/:id/layout-issues", label: "Layout issues", summarize: (d) => count(len(d.issues), "issue") },
  { method: "GET", pattern: "/api/tabs/:id/media-state", label: "Media state" },
  { method: "GET", pattern: "/api/tabs/:id/mutations", label: "Mutation timeline" },
  { method: "GET", pattern: "/api/tabs/:id/threejs-scene", label: "Three.js scene" },
  { method: "GET", pattern: "/api/tabs/:id/pick", label: "Pick element" },
  { method: "GET", pattern: "/api/tabs/:id/picks/latest", label: "Read selected element", summarize: tagSummary },
  { method: "GET", pattern: "/api/picks", label: "List selected elements", summarize: arrayCount("element") },
  // Reports
  {
    method: "POST", pattern: "/api/tabs/:id/report", label: "Create report",
    summarize: (d) => {
      const r = d.report as { findingCount?: unknown; evidence?: unknown } | undefined;
      const findings = count(r?.findingCount, "finding");
      const measurements = count(len(r?.evidence), "measurement");
      return findings && measurements ? `${findings} · ${measurements}` : findings ?? measurements;
    }
  },
  { method: "GET", pattern: "/api/reports", label: "List reports", summarize: arrayCount("report") },
  { method: "GET", pattern: "/api/reports/:id", label: "Download report" },
  // Routines. Never the intent or the spec: only counts and fixed words.
  { method: "GET", pattern: "/api/routines/schema", label: "Read routine schema" },
  {
    method: "POST", pattern: "/api/routines", label: "Propose routine",
    summarize: (d) => {
      const steps = count(d.stepCount, "step");
      return steps ? `proposed · ${steps}` : "proposed";
    }
  },
  { method: "GET", pattern: "/api/routines", label: "List routines", summarize: arrayCount("routine") },
  { method: "GET", pattern: "/api/routines/:id", label: "Read routine" },
  { method: "POST", pattern: "/api/routines/:id/withdraw", label: "Withdraw routine", summarize: () => "withdrawn" },
  { method: "GET", pattern: "/api/routines/:id/runs", label: "Read routine runs", summarize: arrayCount("run") },
  { method: "GET", pattern: "/api/routines/:id/notes", label: "Read routine notes", summarize: arrayCount("note") },
  // Input
  { method: "POST", pattern: "/api/tabs/:id/evaluate", label: "Evaluate script" },
  { method: "POST", pattern: "/api/tabs/:id/insert-text", label: "Type text" },
  { method: "POST", pattern: "/api/tabs/:id/key", label: "Press key" },
  { method: "POST", pattern: "/api/tabs/:id/click", label: "Click" },
  { method: "POST", pattern: "/api/tabs/:id/file-input", label: "Set file input" },
  // Assertions / watches
  { method: "POST", pattern: "/api/tabs/:id/assert", label: "Assertion", summarize: passFail },
  { method: "GET", pattern: "/api/tabs/:id/watches", label: "List assertion watches", summarize: arrayCount("watch", "watches") },
  { method: "POST", pattern: "/api/tabs/:id/watches", label: "Add assertion watch" },
  { method: "DELETE", pattern: "/api/tabs/:id/watches/:watchId", label: "Remove assertion watch" },
  // Recording
  { method: "GET", pattern: "/api/tabs/:id/recording", label: "Read recording" },
  { method: "POST", pattern: "/api/tabs/:id/recording/start", label: "Start recording" },
  { method: "POST", pattern: "/api/tabs/:id/recording/stop", label: "Stop recording", summarize: (d) => count(len(d.commands), "step") },
  // Logs / HAR / downloads / mocks
  { method: "GET", pattern: "/api/tabs/:id/logs", label: "Read logs" },
  { method: "DELETE", pattern: "/api/tabs/:id/logs", label: "Clear logs" },
  { method: "GET", pattern: "/api/tabs/:id/har", label: "Export HAR" },
  { method: "GET", pattern: "/api/tabs/:id/downloads", label: "List downloads" },
  { method: "DELETE", pattern: "/api/tabs/:id/downloads", label: "Clear downloads" },
  { method: "GET", pattern: "/api/tabs/:id/mock", label: "Read network mocks" },
  { method: "POST", pattern: "/api/tabs/:id/mock", label: "Set network mocks", summarize: (d) => count(d.rulesCount, "rule") },
  { method: "DELETE", pattern: "/api/tabs/:id/mock", label: "Clear network mocks" },
  // Site patterns
  { method: "GET", pattern: "/api/tabs/:id/site-patterns", label: "Read site patterns" },
  { method: "POST", pattern: "/api/tabs/:id/site-patterns", label: "Set site patterns" },
  { method: "DELETE", pattern: "/api/tabs/:id/site-patterns", label: "Clear site patterns" },
  // Overrides
  { method: "GET", pattern: "/api/tabs/:id/budget", label: "Read resource budget" },
  { method: "POST", pattern: "/api/tabs/:id/budget", label: "Set resource budget" },
  { method: "DELETE", pattern: "/api/tabs/:id/budget", label: "Clear resource budget" },
  { method: "GET", pattern: "/api/tabs/:id/location", label: "Read location override" },
  { method: "POST", pattern: "/api/tabs/:id/location", label: "Set location override" },
  { method: "DELETE", pattern: "/api/tabs/:id/location", label: "Clear location override" },
  { method: "GET", pattern: "/api/tabs/:id/media", label: "Read media emulation" },
  { method: "POST", pattern: "/api/tabs/:id/media", label: "Set media emulation" },
  { method: "DELETE", pattern: "/api/tabs/:id/media", label: "Clear media emulation" },
  // Storage / cookies
  { method: "GET", pattern: "/api/tabs/:id/storage", label: "Read storage" },
  { method: "GET", pattern: "/api/tabs/:id/storage/:area", label: "Read web storage" },
  { method: "POST", pattern: "/api/tabs/:id/storage/:area", label: "Set web storage" },
  { method: "DELETE", pattern: "/api/tabs/:id/storage/:area", label: "Clear web storage" },
  { method: "GET", pattern: "/api/tabs/:id/cookies", label: "Read cookies", summarize: arrayCount("cookie") },
  { method: "POST", pattern: "/api/tabs/:id/cookies", label: "Set cookie" },
  { method: "DELETE", pattern: "/api/tabs/:id/cookies", label: "Clear cookies" },
  { method: "DELETE", pattern: "/api/tabs/:id/cookies/:name", label: "Delete cookie" },
  // Accounts (optional slice)
  { method: "GET", pattern: "/api/accounts", label: "List accounts" },
  { method: "POST", pattern: "/api/accounts", label: "Save account" },
  { method: "GET", pattern: "/api/accounts/lookup/:origin", label: "Look up accounts", summarize: arrayCount("account") },
  { method: "PATCH", pattern: "/api/accounts/:accountId", label: "Update account" },
  { method: "DELETE", pattern: "/api/accounts/:accountId", label: "Delete account" },
  { method: "GET", pattern: "/api/accounts/:accountId/totp", label: "Generate TOTP code" },
  // Extensions (optional slice)
  { method: "GET", pattern: "/api/extensions", label: "List extensions" },
  { method: "POST", pattern: "/api/extensions", label: "Load extension" },
  { method: "DELETE", pattern: "/api/extensions/:extensionId", label: "Remove extension" }
];

type CompiledRoute = ActivityRoute & { regex: RegExp; params: string[] };

const COMPILED: CompiledRoute[] = ACTIVITY_ROUTES.map((route) => {
  const params: string[] = [];
  const source = route.pattern
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
      params.push(segment.slice(1));
      return "([^/]+)";
    })
    .join("/");
  return { ...route, regex: new RegExp(`^${source}$`), params };
});

export type MatchedActivityRoute = {
  route: string;
  label: string;
  tabId?: string;
  summarize?: Summarizer;
};

/** True for requests the feed deliberately skips (health polling, SSE, log lines, preflight). */
export function isActivityExcluded(method: string, pathname: string): boolean {
  if (method === "OPTIONS") return true;
  return EXCLUDED.some((e) => e.method === method && e.path === pathname);
}

/** Match a request to its table entry. Unknown routes get {@link UNMATCHED_ROUTE}, never the raw path. */
export function matchActivityRoute(method: string, pathname: string): MatchedActivityRoute {
  for (const route of COMPILED) {
    if (route.method !== method) continue;
    const m = route.regex.exec(pathname);
    if (!m) continue;
    const idIndex = route.pattern.startsWith("/api/tabs/:id") ? route.params.indexOf("id") : -1;
    const tabId = idIndex >= 0 ? safeDecode(m[idIndex + 1]!) : undefined;
    return { route: route.pattern, label: route.label, ...(tabId ? { tabId } : {}), ...(route.summarize ? { summarize: route.summarize } : {}) };
  }
  return { route: UNMATCHED_ROUTE, label: "Unknown request" };
}

/** Run a route's summarizer over its JSON response; never throws. */
export function summarizeResponse(summarize: Summarizer | undefined, data: unknown): string | undefined {
  if (!summarize || data === undefined || data === null) return undefined;
  try {
    const record = Array.isArray(data) ? { __array: data } : typeof data === "object" ? (data as Record<string, unknown>) : null;
    return record ? summarize(record) : undefined;
  } catch {
    return undefined;
  }
}

/** Longest agent id kept in an entry (the header is client-supplied). */
export const MAX_AGENT_ID_LENGTH = 64;

export function clampAgentId(agentId: string | null): string | undefined {
  if (!agentId) return undefined;
  return agentId.length > MAX_AGENT_ID_LENGTH ? `${agentId.slice(0, MAX_AGENT_ID_LENGTH)}…` : agentId;
}

/** Bounded FIFO of activity entries. */
export class ActivityLog {
  private readonly entries: AgentActivityEntry[] = [];

  constructor(readonly capacity = 500) {}

  push(entry: AgentActivityEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
  }

  /**
   * Resolve a pending approval entry in place. Returns the updated entry, or
   * undefined when it was evicted / never pending (nothing changes then).
   */
  resolveApproval(
    requestId: string,
    outcome: NonNullable<AgentActivityEntry["approval"]>,
    commandStatus?: string
  ): AgentActivityEntry | undefined {
    const entry = this.entries.find((e) => e.requestId === requestId && e.approval === "pending");
    if (!entry) return undefined;
    entry.approval = outcome;
    // The HTTP call itself succeeded; only an approved command that then
    // failed or was blocked is flagged !ok. Reject/cancel/expire are not errors.
    const failedRun = outcome === "approved" && (commandStatus === "failed" || commandStatus === "blocked");
    entry.ok = !failedRun;
    entry.summary = failedRun ? `approved: ${commandStatus}` : outcome;
    return { ...entry };
  }

  /** Oldest first. */
  list(): AgentActivityEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
