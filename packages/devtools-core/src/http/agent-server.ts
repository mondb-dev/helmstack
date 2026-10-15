import http from "node:http";

import type {
  AccountUpdate,
  AgentActivityEntry,
  AgentConnectionStatus,
  AgentLogEntry,
  BrowserOutputCommand,
  CookieEntry,
  DiffRegion,
  HumanElementPick,
  HumanHandoffRecord,
  LocationOverride,
  MediaEmulation,
  StorageArea,
  StyleAssertion,
  TabId,
  TabSummary,
  ViewportPresetName,
} from "../../../shared/src/index.js";
import type { AccountsApi, AgentApi, BackendKind, ExtensionsApi, OptionalCapability } from "../api.js";
import { resolveProfile } from "../core/runtime-config.js";
import {
  ActivityLog,
  clampAgentId,
  isActivityExcluded,
  matchActivityRoute,
  pickTag,
  SHELL_PICK_ACTIVITY,
  summarizeResponse
} from "./activity.js";
import { parseAccountInput, parseNetworkMockRules, parseResourceBudget, parseViewportBody } from "./request-validation.js";

type SseClient = { res: http.ServerResponse; agentId: string | null };

/** Default control-plane port shared by the desktop app and the daemon. */
export const DEFAULT_AGENT_PORT = 7070;

/** `code` of the 501 body returned when an optional slice is missing. */
export const UNSUPPORTED_ON_BACKEND = "unsupported_on_backend";

/** `code` of the 403 body when an agent tries to approve in `approvals: "human"` mode. */
export const REQUIRES_HUMAN = "requires_human";

/** `code` of the 404 body from `GET /api/tabs/:id/picks/latest` when the human has not picked. */
export const NO_PICK = "no_pick";

/** How long an agent id counts as "seen recently" in the connection status. */
export const RECENT_AGENT_WINDOW_MS = 5 * 60_000;
const RECENT_AGENT_PRUNE_MS = 30_000;

export interface AgentServerOptions {
  /** The browser the server drives. */
  api: AgentApi;
  /** Which runtime is serving. Falls back to `api.backend`; one of the two is required. */
  backend?: BackendKind;
  /** Optional credential accounts + TOTP slice. Absent → `/api/accounts*` answer 501. */
  accounts?: AccountsApi;
  /** Optional browser-extension slice. Absent → `/api/extensions*` answer 501. */
  extensions?: ExtensionsApi;
  /** TCP port (default 7070; 0 picks a free port, see `boundPort`). */
  port?: number;
  /**
   * Shared REST/SSE auth token. `null` disables auth; `undefined` falls back
   * to `HELMSTACK_AUTH_TOKEN` (or no auth when that is unset).
   */
  authToken?: string | null;
  /** Bind address. Loopback only — the control plane is never network-exposed. */
  host?: "127.0.0.1";
  /**
   * Who may approve queued actions over `POST /api/approvals/:id/approve`.
   * `"agent"` (default; daemon): any token holder. `"human"` (desktop): the
   * route answers `403 { code: "requires_human" }` and only the shell UI can
   * approve. Reject stays allowed in both modes (an agent may withdraw).
   */
  approvals?: "human" | "agent";
  /** Where local agents read the auth token from; reported in the connection status. */
  tokenPath?: string | null;
  /** Activity ring-buffer size (default 500). */
  activityCapacity?: number;
}

/** Thrown by {@link AgentServer.start} when the port is already bound. */
export class AgentServerPortInUseError extends Error {
  readonly code = "EADDRINUSE";

  constructor(readonly host: string, readonly port: number, cause?: unknown) {
    super(
      `HelmStack agent server cannot listen on ${host}:${port}: the port is already in use. ` +
      "Another HelmStack instance (desktop app or daemon) is probably running — stop it, " +
      "or pick a different port (the daemon honours HELMSTACK_PORT / --port).",
      { cause }
    );
    this.name = "AgentServerPortInUseError";
  }
}

/** Create (but do not start) the agent HTTP+SSE server. Call `start()` to bind. */
export function createAgentServer(opts: AgentServerOptions): AgentServer {
  return new AgentServer(opts);
}

/** Loopback host names that are safe for a localhost-only control plane. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** Extract the bare hostname from a `Host`/`Origin` authority, handling IPv6 brackets. */
export function parseHostname(authority: string | undefined): string | null {
  if (!authority) return null;
  const trimmed = authority.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end > 1 ? trimmed.slice(1, end).toLowerCase() : null;
  }
  return trimmed.split(":")[0]!.toLowerCase();
}

/**
 * DNS-rebinding guard: the `Host` header must resolve to a loopback name.
 * A malicious page that rebinds a domain to 127.0.0.1 still sends its own
 * domain in `Host`, so rejecting non-loopback hosts blocks the attack.
 */
export function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  const host = parseHostname(hostHeader);
  return host !== null && LOOPBACK_HOSTS.has(host);
}

/**
 * Cross-origin guard. Non-browser clients (Node, curl, the SDK) send no
 * `Origin` header and are allowed. Browsers always attach `Origin` on
 * cross-origin requests, so any web page hitting the control plane is
 * rejected unless it is itself served from loopback.
 */
export function isAllowedOrigin(originHeader: string | undefined): boolean {
  if (!originHeader) return true;
  if (originHeader === "null") return false; // opaque origin (sandboxed iframe, data: URL)
  try {
    // URL.hostname keeps IPv6 brackets ("[::1]"); strip them before matching.
    const hostname = new URL(originHeader).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return LOOPBACK_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

/**
 * HTTP + Server-Sent Events server that exposes the browser substrate to
 * external agents (OpenClaw, LangGraph, custom runtimes, etc.).
 *
 * Binds to 127.0.0.1 only — never exposed to the network.
 *
 * Typed against {@link AgentApi} only (ADR 0001 §4.4), so the Electron desktop
 * and the headless daemon serve the identical API.
 *
 * Optional slices (accounts, extensions, pick) answer
 * `501 { error, code: "unsupported_on_backend", feature, backend }` when the
 * backend does not provide them.
 *
 * REST endpoints
 * --------------
 * GET  /api/health                         → { status, connectedAgents, tabs, backend, capabilities }
 * GET  /api/tabs
 * POST /api/tabs                          { url?: string }
 * POST /api/tabs/:id/navigate             { url: string }
 * POST /api/tabs/:id/reload               { ignoreCache?: boolean }   (waits for the load)
 * POST /api/tabs/:id/back                 (waits for the load; unchanged when there is no earlier entry)
 * POST /api/tabs/:id/forward              (likewise)
 * GET  /api/tabs/:id/perception
 * GET  /api/tabs/:id/manifests
 * POST /api/tabs/:id/command              { command: BrowserOutputCommand }
 * GET  /api/approvals
 * POST /api/approvals/:id/approve
 * POST /api/approvals/:id/reject
 * GET  /api/tabs/:id/screenshot
 * POST /api/tabs/:id/viewport              { width: number, height: number, mobile?: boolean }
 * GET  /api/handoffs
 * POST /api/handoffs/:id/resolve
 * POST /api/handoffs/:id/cancel
 * GET  /api/extensions
 * POST /api/extensions                    { path: string }
 * DELETE /api/extensions/:id
 * GET  /api/intent
 * PUT  /api/intent                          { intent: string }
 * POST /api/log                             { level?, message }
 * GET  /api/tabs/:id/logs                  → TabLogSnapshot
 * GET  /api/tabs/:id/har                   → HarArchive (HAR 1.2)
 * DELETE /api/tabs/:id/logs               clears buffered logs * GET  /api/tabs/:id/mock                 → { rules }
 * POST /api/tabs/:id/mock                 { rules: NetworkInterceptRule[] }
 * DELETE /api/tabs/:id/mock              disables interception
 * POST /api/tabs/:id/screenshot/named    { snapshotId } → PageScreenshot
 * POST /api/screenshots/diff             { beforeId, afterId, ignoreRegions?, perceptual?, threshold? } → ScreenshotDiff
 * POST /api/tabs/:id/changed-elements     { regions: DiffRegion[] } → ChangedElement[]
 * POST /api/tabs/:id/viewport-suite      { presets?, includeDiffs?, includeLayoutIssues? } → ViewportSuiteReport
 * GET  /api/tabs/:id/performance         → PerformanceReport
 * GET  /api/tabs/:id/health               → HealthReport (aggregated scorecard; ?seo=false omits the SEO category)
 * GET  /api/tabs/:id/a11y               → A11yAuditReport (?selector= scopes to a subtree)
 * GET  /api/tabs/:id/seo                → SeoAuditReport (?checkLinks=true&maxLinks=25 opts into a bounded link check)
 * GET  /api/tabs/:id/focus-order        → FocusOrderReport
 * POST /api/tabs/:id/styles/inspect     { selector, limit? } → ElementStyleInspectionReport
 * POST /api/tabs/:id/styles/assert      { selector, assertions, limit? } → ElementStyleAssertionReport
 * GET  /api/tabs/:id/component-tree     → ComponentTreeReport
 * GET  /api/tabs/:id/design-tokens      → DesignTokensReport
 * GET  /api/tabs/:id/css-coverage       → CssCoverageReport (unused-CSS, reloads tab)
 * GET  /api/tabs/:id/js-coverage        → JsCoverageReport (dead-JS, reloads tab)
 * GET  /api/tabs/:id/trace              → TraceReport (?durationMs=, long tasks + categories)
 * GET  /api/tabs/:id/framework          → FrameworkReport (framework + dev server + HMR)
 * GET  /api/tabs/:id/pick                → ElementPickResult (human inspect-and-click; blocks)
 * GET  /api/tabs/:id/picks/latest        → HumanElementPick (from "Select for agent"; 404 { code: "no_pick" })
 * GET  /api/picks                        → HumanElementPick[] (recent human picks, newest first)
 * GET  /api/tabs/:id/component-sources  → ComponentSourceReport (click-to-component)
 * GET  /api/tabs/:id/layout-issues      → LayoutIssuesReport
 * GET  /api/tabs/:id/media-state        → MediaStateReport
 * GET  /api/tabs/:id/mutations          → MutationTimelineReport (?durationMs=)
 * GET  /api/tabs/:id/threejs-scene      → ThreeSceneReport
 * POST /api/tabs/:id/assert            { assertion: string } → AssertionResult
 * GET  /api/tabs/:id/watches           → AssertionWatch[]
 * POST /api/tabs/:id/watches           { assertion: string } → AssertionWatch
 * DELETE /api/tabs/:id/watches/:wid    → { removed: boolean }
 * GET  /api/tabs/:id/recording          → RecordingSession | null
 * POST /api/tabs/:id/recording/start    → RecordingSession
 * POST /api/tabs/:id/recording/stop     → RecordingStopResult
 * GET  /api/tabs/:id/site-patterns      → { patterns: string[] }
 * POST /api/tabs/:id/site-patterns      { patterns: string[], mode?: "set" | "add" }
 * DELETE /api/tabs/:id/site-patterns    clears persisted origin patterns
 * POST /api/tabs/:id/file-input         { selector, files } → { ok: true }
 * GET  /api/tabs/:id/downloads          → DownloadEntry[]
 * DELETE /api/tabs/:id/downloads        clears tracked downloads
 * GET  /api/tabs/:id/budget             → ResourceBudget | null
 * POST /api/tabs/:id/budget             → ResourceBudget
 * DELETE /api/tabs/:id/budget           clears resource budget
 * GET  /api/tabs/:id/location           → LocationOverride | null
 * POST /api/tabs/:id/location           → LocationOverride
 * DELETE /api/tabs/:id/location         clears geolocation/timezone override
 * GET  /api/tabs/:id/media              → MediaEmulation | null
 * POST /api/tabs/:id/media              → MediaEmulation (colorScheme/reducedMotion/forcedColors/media)
 * DELETE /api/tabs/:id/media            clears CSS media emulation
 * GET  /api/tabs/:id/storage            → StorageReport (all areas)
 * GET  /api/tabs/:id/storage/:area      area=local|session → StorageEntry[]  (optional ?key=X)
 * POST /api/tabs/:id/storage/:area      { entries: Record<string,string> } → { ok: true }
 * DELETE /api/tabs/:id/storage/:area    body? { keys: string[] } — omit to clear all
 * POST /api/tabs/:id/insert-text        { text } → { ok: true } — CDP Input.insertText into the focused element
 * POST /api/tabs/:id/key                 { key, modifiers?, code?, keyCode?, text? } → { ok: true } — CDP key press (chords via modifiers bitmask: Alt=1 Ctrl=2 Meta=4 Shift=8)
 * POST /api/tabs/:id/click               { x, y } → { ok: true } — CDP left mouse click at viewport CSS coords (reaches cross-origin iframes)
 * DELETE /api/tabs/:id                    → TabSummary[] — close a tab
 * GET  /api/tabs/:id/cookies            → CookieEntry[]
 * POST /api/tabs/:id/cookies            { name, value, domain?, path?, httpOnly?, secure?, sameSite?, expires? }
 * DELETE /api/tabs/:id/cookies/:name    ?url=… (optional)
 * DELETE /api/tabs/:id/cookies          clear all cookies for the tab's origin
 * GET  /api/screenshots                 → {id,tabId,url,width,height,capturedAt}[]
 * DELETE /api/screenshots/:id           removes snapshot from cache
 * POST /api/tabs/:id/perception/named   { snapshotId } → PerceptionSnapshotEntry
 * POST /api/perception/diff             { beforeId, afterId } → PerceptionDiff
 * GET  /api/perception                  → PerceptionSnapshotEntry[]
 * DELETE /api/perception/:id            removes perception snapshot from cache
 *
 * SSE stream
 * ----------
 * GET  /api/stream
 * Events: tabs_changed | page_observed | approval_queued | approval_resolved | human_handoff_requested | human_handoff_resolved | intent_changed | agent_log | assertion_changed | element_picked
 *
 * `approval_resolved` carries an `ApprovalResolution` `{ requestId, tabId, outcome,
 * reason?, status?, url?, origin?, resolvedAt }`; `outcome` is approved | rejected |
 * cancelled (the tab navigated or closed before a decision) | expired.
 *
 * `element_picked` carries `{ tabId, pickedAt, pick }` when the human selects
 * an element with "Select for agent". Reading picks is never unsupported: a
 * backend without the `pick` capability (the daemon) simply has none.
 */
export class AgentServer {
  private readonly server: http.Server;
  private readonly clients = new Set<SseClient>();
  private intent = "";
  private logListeners: Array<(entry: AgentLogEntry) => void> = [];
  /** agentId → tabId: tracks which agent created which tab */
  private readonly tabOwners = new Map<TabId, string>();
  /** agentId → intent string: per-agent intent, falls back to global */
  private readonly perAgentIntents = new Map<string, string>();

  private readonly tabs: AgentApi;
  private readonly accounts: AccountsApi | undefined;
  private readonly extensions: ExtensionsApi | undefined;
  private readonly authToken: string | null;
  private readonly approvalsMode: "human" | "agent";
  private readonly tokenPath: string | null;
  private readonly activity: ActivityLog;
  private readonly activityListeners = new Set<(entry: AgentActivityEntry) => void>();
  private readonly statusListeners = new Set<(status: AgentConnectionStatus) => void>();
  /** agentId → last time it was seen on an authorized request. */
  private readonly recentAgents = new Map<string, number>();
  private activitySeq = 0;
  private listening = false;
  private startError: string | undefined;
  private lastStatusKey = "";
  private pruneTimer: NodeJS.Timeout | null = null;
  readonly port: number;
  readonly host: "127.0.0.1";
  readonly backend: BackendKind;

  constructor(opts: AgentServerOptions) {
    const backend = opts.backend ?? opts.api.backend;
    if (!backend) throw new Error("createAgentServer: `backend` is required (pass it as an option or set api.backend)");
    this.tabs = opts.api;
    this.accounts = opts.accounts;
    this.extensions = opts.extensions;
    this.port = opts.port ?? DEFAULT_AGENT_PORT;
    this.host = opts.host ?? "127.0.0.1";
    this.backend = backend;
    this.authToken = opts.authToken === undefined ? (process.env.HELMSTACK_AUTH_TOKEN || null) : opts.authToken;
    this.approvalsMode = opts.approvals ?? "agent";
    this.tokenPath = opts.tokenPath ?? null;
    this.activity = new ActivityLog(opts.activityCapacity ?? 500);
    this.server = http.createServer(this.handle.bind(this));
    const tabs = this.tabs;

    tabs.onTabsChanged((allTabs) => {
      // Prune owners for tabs that have been closed
      const alive = new Set(allTabs.map(t => t.id));
      for (const tabId of this.tabOwners.keys()) {
        if (!alive.has(tabId)) this.tabOwners.delete(tabId);
      }
      // Send each SSE client a view filtered to only their tabs
      for (const client of this.clients) {
        const filtered = this.filterTabsForAgent(allTabs, client.agentId);
        const frame = `event: tabs_changed\ndata: ${JSON.stringify(filtered)}\n\n`;
        try { client.res.write(frame); } catch { this.clients.delete(client); }
      }
    });
    tabs.onPageObserved((o) => this.broadcastTabEvent("page_observed", o, o.tabId));
    tabs.onAssertionTransition((t) => this.broadcastTabEvent("assertion_changed", t, t.tabId));
    tabs.onApprovalQueued((a) => this.broadcastTabEvent("approval_queued", a, a.tabId));
    tabs.onApprovalResolved?.((r) => this.broadcastTabEvent("approval_resolved", r, r.tabId));
    tabs.onHandoffRequested((h: HumanHandoffRecord) => this.broadcastTabEvent("human_handoff_requested", h, h.tabId));
    tabs.onElementPicked?.((pick) => this.handleHumanPick(pick));
  }

  /** A shell "Select for agent" pick: tell listening agents and note it in the feed. */
  private handleHumanPick(pick: HumanElementPick): void {
    this.broadcastTabEvent("element_picked", pick, pick.tabId);
    const tag = pickTag(pick.pick.tagName);
    this.pushActivity({
      id: `act-${++this.activitySeq}`,
      at: pick.pickedAt,
      durationMs: 0,
      method: SHELL_PICK_ACTIVITY.method,
      route: SHELL_PICK_ACTIVITY.route,
      label: SHELL_PICK_ACTIVITY.label,
      tabId: pick.tabId,
      status: 200,
      ok: true,
      ...(tag ? { summary: tag } : {})
    });
  }

  /** The actual TCP port the server is bound to (useful when constructed with port 0). */
  get boundPort(): number | null {
    const addr = this.server.address();
    return addr && typeof addr === "object" ? addr.port : null;
  }

  /** Optional features this backend provides (reported by `GET /api/health`). */
  get capabilities(): OptionalCapability[] {
    const caps: OptionalCapability[] = [];
    if (this.accounts) caps.push("accounts");
    if (this.extensions) caps.push("extensions");
    if (typeof this.tabs.pickElement === "function") caps.push("pick");
    return caps;
  }

  /**
   * Bind the server. Rejects with {@link AgentServerPortInUseError} when the
   * port is taken (e.g. desktop and daemon both on 7070) instead of a bare
   * `EADDRINUSE`, so callers can fail fast with an actionable message.
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        this.server.off("listening", onListening);
        const failure = err.code === "EADDRINUSE" ? new AgentServerPortInUseError(this.host, this.port, err) : err;
        this.listening = false;
        this.startError = failure.message;
        this.emitStatus();
        reject(failure);
      };
      const onListening = () => {
        this.server.off("error", onError);
        console.log(`[AgentServer] listening on http://${this.host}:${this.boundPort ?? this.port} (backend: ${this.backend})`);
        this.listening = true;
        this.startError = undefined;
        this.startPruneTimer();
        this.emitStatus();
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.port, this.host);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const client of this.clients) {
        client.res.end();
      }
      if (this.pruneTimer) clearInterval(this.pruneTimer);
      this.pruneTimer = null;
      this.server.close(() => {
        this.listening = false;
        this.emitStatus();
        resolve();
      });
    });
  }

  // ── Activity feed / connection status (desktop shell) ────────────────────

  /** Recorded agent API calls, oldest first (bounded ring buffer). */
  listActivity(): AgentActivityEntry[] {
    return this.activity.list();
  }

  /** Fires once per recorded call, after its response finished. Returns an unsubscribe function. */
  onActivity(fn: (entry: AgentActivityEntry) => void): () => void {
    this.activityListeners.add(fn);
    return () => this.activityListeners.delete(fn);
  }

  getConnectionStatus(): AgentConnectionStatus {
    this.pruneRecentAgents();
    const agentIds = new Set(this.recentAgents.keys());
    for (const client of this.clients) {
      const id = clampAgentId(client.agentId);
      if (id) agentIds.add(id);
    }
    return {
      listening: this.listening,
      port: this.boundPort ?? (this.listening ? this.port : null),
      ...(this.startError ? { error: this.startError } : {}),
      sseClients: this.clients.size,
      agentIds: [...agentIds].sort(),
      tokenPath: this.tokenPath,
      // SSE clients cannot filter events: every client receives `intent_changed`.
      intentListeners: this.clients.size,
      profile: resolveProfile()
    };
  }

  /** Fires with the full status whenever any field changes. Returns an unsubscribe function. */
  onConnectionStatusChanged(fn: (status: AgentConnectionStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private emitStatus(): void {
    const status = this.getConnectionStatus();
    const key = JSON.stringify(status);
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    for (const fn of this.statusListeners) fn(status);
  }

  private noteAgent(agentId: string | null): void {
    const id = clampAgentId(agentId);
    if (!id) return;
    const isNew = !this.recentAgents.has(id);
    this.recentAgents.set(id, Date.now());
    if (isNew) this.emitStatus();
  }

  private pruneRecentAgents(): void {
    const cutoff = Date.now() - RECENT_AGENT_WINDOW_MS;
    for (const [id, seenAt] of this.recentAgents) {
      if (seenAt < cutoff) this.recentAgents.delete(id);
    }
  }

  private startPruneTimer(): void {
    if (this.pruneTimer) return;
    // emitStatus prunes and only fires when an agent actually aged out.
    this.pruneTimer = setInterval(() => this.emitStatus(), RECENT_AGENT_PRUNE_MS);
    this.pruneTimer.unref?.();
  }

  /** Record a finished request (see `activity.ts` for what is and isn't kept). */
  private recordActivity(req: http.IncomingMessage, res: http.ServerResponse, method: string, pathname: string, at: number): void {
    const match = matchActivityRoute(method, pathname);
    const agentId = clampAgentId(this.agentIdOf(req));
    const summary = res.statusCode < 400 ? summarizeResponse(match.summarize, responseData.get(res)) : undefined;
    responseData.delete(res);
    const entry: AgentActivityEntry = {
      id: `act-${++this.activitySeq}`,
      at,
      durationMs: Date.now() - at,
      method,
      route: match.route,
      label: match.label,
      ...(match.tabId ? { tabId: match.tabId as TabId } : {}),
      ...(agentId ? { agentId } : {}),
      status: res.statusCode,
      ok: res.statusCode < 400,
      ...(summary ? { summary } : {})
    };
    this.pushActivity(entry);
  }

  private pushActivity(entry: AgentActivityEntry): void {
    this.activity.push(entry);
    for (const fn of this.activityListeners) {
      try { fn(entry); } catch { /* a listener must not break the server */ }
    }
  }

  setIntent(value: string, agentId: string | null = null): void {
    if (agentId !== null) {
      this.perAgentIntents.set(agentId, value);
      this.broadcastToAgent("intent_changed", { intent: value }, agentId);
    } else {
      this.intent = value;
      this.broadcast("intent_changed", { intent: value });
    }
  }

  getIntent(agentId: string | null = null): string {
    if (agentId !== null) return this.perAgentIntents.get(agentId) ?? this.intent;
    return this.intent;
  }

  pushLog(entry: AgentLogEntry): void {
    this.broadcast("agent_log", entry);
    for (const fn of this.logListeners) fn(entry);
  }

  onAgentLog(fn: (entry: AgentLogEntry) => void): void {
    this.logListeners.push(fn);
  }

  private broadcast(event: string, data: unknown) {
    if (this.clients.size === 0) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      try {
        client.res.write(frame);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  /** Broadcast only to the agent that owns the given tab (+ unauthenticated clients). */
  private broadcastTabEvent(event: string, data: unknown, tabId: TabId) {
    if (this.clients.size === 0) return;
    const owner = this.tabOwners.get(tabId);
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      if (client.agentId === null || owner === undefined || owner === client.agentId) {
        try { client.res.write(frame); } catch { this.clients.delete(client); }
      }
    }
  }

  /** Broadcast only to clients identified as the given agent (+ unauthenticated clients). */
  private broadcastToAgent(event: string, data: unknown, agentId: string) {
    if (this.clients.size === 0) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      if (client.agentId === null || client.agentId === agentId) {
        try { client.res.write(frame); } catch { this.clients.delete(client); }
      }
    }
  }

  /**
   * Extract the agent ID from the X-Agent-ID request header, or null if absent.
   *
   * SECURITY — this value is **client-supplied and unauthenticated**. There is a
   * single shared auth token, so identity is not bound to the caller: any holder
   * of the token can present any X-Agent-ID. Per-agent ownership built on this
   * (see {@link isTabAccessible}) is a *cooperative partition* to prevent
   * accidental cross-agent interference — it is **NOT a security boundary**. Run
   * mutually-distrusting agents in separate HelmStack instances. See
   * docs/security-model.md → "agent isolation is advisory".
   */
  private agentIdOf(req: http.IncomingMessage): string | null {
    const h = req.headers["x-agent-id"];
    if (typeof h === "string" && h.trim()) return h.trim();
    return null;
  }

  /**
   * Returns true if the requesting agent may access this tab.
   *
   * SECURITY: advisory only — `agentId` comes from a spoofable header (see
   * {@link agentIdOf}). This stops honest agents from stepping on each other,
   * not a malicious token-holder.
   */
  private isTabAccessible(tabId: TabId, agentId: string | null): boolean {
    if (agentId === null) return true; // unauthenticated: full backward compat
    const owner = this.tabOwners.get(tabId);
    return owner === undefined || owner === agentId;
  }

  /** Filter a tab list to only the tabs visible to this agent. */
  private filterTabsForAgent(tabs: TabSummary[], agentId: string | null): TabSummary[] {
    if (agentId === null) return tabs;
    return tabs.filter(t => this.isTabAccessible(t.id, agentId));
  }

  /** The active REST auth token, or null when auth is disabled. */
  getAuthToken(): string | null {
    return this.authToken;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const origin = headerValue(req.headers.origin);

    // Echo CORS headers only for loopback origins — never a wildcard. A non
    // loopback origin gets no Access-Control-Allow-Origin, so even if the
    // request slips through, a browser cannot read the response.
    if (origin && isAllowedOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Agent-ID, X-HelmStack-Token");
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // DNS-rebinding guard: reject any request whose Host is not loopback.
    if (!isLoopbackHostHeader(headerValue(req.headers.host))) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden: non-loopback Host header" }));
      return;
    }

    // Cross-origin guard: reject browser-originated cross-site requests.
    if (!isAllowedOrigin(origin)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden: cross-origin request rejected" }));
      return;
    }

    if (!this.isAuthorized(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    // Only authorized requests reach the feed / agent list: requests rejected
    // above come from parties without the token (e.g. a web page) and would
    // let anyone spam the shell.
    this.noteAgent(this.agentIdOf(req));
    const method = req.method?.toUpperCase() ?? "GET";
    const pathname = safePathname(req.url);
    if (!isActivityExcluded(method, pathname)) {
      const at = Date.now();
      res.once("finish", () => this.recordActivity(req, res, method, pathname, at));
    }

    this.route(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse) {
    const method = req.method?.toUpperCase() ?? "GET";
    const raw = req.url ?? "/";
    const url = new URL(raw, `http://localhost:${this.port}`);
    const p = url.pathname;

    // ── SSE stream ──────────────────────────────────────────────────────────
    if (method === "GET" && p === "/api/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      res.write(": connected\n\n");
      const agentId = this.agentIdOf(req);
      const client: SseClient = { res, agentId };
      this.clients.add(client);
      this.emitStatus();

      // Heartbeat: a comment frame every 25s keeps idle connections alive
      // through proxies/load balancers and lets us detect dead sockets.
      const heartbeat = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          clearInterval(heartbeat);
          this.clients.delete(client);
        }
      }, 25_000);
      heartbeat.unref?.();

      req.on("close", () => {
        clearInterval(heartbeat);
        this.clients.delete(client);
        this.emitStatus();
      });
      return;
    }

    // ── Health ───────────────────────────────────────────────────────────────
    if (method === "GET" && p === "/api/health") {
      return json(res, {
        status: "ok",
        connectedAgents: this.clients.size,
        tabs: this.tabs.listTabs().length,
        backend: this.backend,
        capabilities: this.capabilities
      });
    }

    // ── Intent ────────────────────────────────────────────────────────────────
    if (method === "GET" && p === "/api/intent") {
      const agentId = this.agentIdOf(req);
      return json(res, { intent: this.getIntent(agentId) });
    }

    if (method === "PUT" && p === "/api/intent") {
      const agentId = this.agentIdOf(req);
      const body = await readBody(req);
      if (typeof body.intent !== "string") return error(res, 400, "intent string is required");
      this.setIntent(body.intent, agentId);
      return json(res, { intent: this.getIntent(agentId) });
    }

    // ── Agent log ─────────────────────────────────────────────────────────────
    if (method === "POST" && p === "/api/log") {
      const body = await readBody(req);
      if (typeof body.message !== "string") return error(res, 400, "message string is required");
      const level = (typeof body.level === "string" && ["system", "agent", "ai", "error", "nav"].includes(body.level))
        ? body.level as AgentLogEntry["level"]
        : "agent";
      const entry: AgentLogEntry = { level, message: body.message, timestamp: Date.now() };
      this.pushLog(entry);
      return json(res, { ok: true });
    }

    // ── Tabs ─────────────────────────────────────────────────────────────────
    if (method === "GET" && p === "/api/tabs") {
      const agentId = this.agentIdOf(req);
      return json(res, this.filterTabsForAgent(this.tabs.listTabs(), agentId));
    }

    if (method === "POST" && p === "/api/tabs") {
      const agentId = this.agentIdOf(req);
      const body = await readBody(req);
      const url = typeof body.url === "string" ? body.url : undefined;
      const existingIds = new Set(this.tabs.listTabs().map(t => t.id));
      const tabs = await this.tabs.createTab(url);
      if (agentId !== null) {
        const newTab = tabs.find(t => !existingIds.has(t.id));
        if (newTab) this.tabOwners.set(newTab.id, agentId);
      }
      return json(res, this.filterTabsForAgent(tabs, agentId));
    }

    // ── Tab-scope ownership guard ────────────────────────────────────────────
    const tabScopeMatch = p.match(/^\/api\/tabs\/([^/]+)/);
    if (tabScopeMatch) {
      const agentId = this.agentIdOf(req);
      if (!this.isTabAccessible(tabScopeMatch[1] as TabId, agentId)) {
        return error(res, 403, "tab is owned by another agent");
      }
    }

    // Close a tab (tab hygiene; frees a tab an agent wedged/finished with).
    const tabCloseMatch = p.match(/^\/api\/tabs\/([^/]+)$/);
    if (method === "DELETE" && tabCloseMatch) {
      const remaining = await this.tabs.closeTab(tabCloseMatch[1] as TabId);
      this.tabOwners.delete(tabCloseMatch[1] as TabId);
      return json(res, this.filterTabsForAgent(remaining, this.agentIdOf(req)));
    }

    const navMatch = p.match(/^\/api\/tabs\/([^/]+)\/navigate$/);
    if (method === "POST" && navMatch) {
      const body = await readBody(req);
      if (typeof body.url !== "string") return error(res, 400, "url is required");
      return json(res, await this.tabs.navigate(navMatch[1] as TabId, body.url));
    }

    const historyMatch = p.match(/^\/api\/tabs\/([^/]+)\/(reload|back|forward)$/);
    if (method === "POST" && historyMatch) {
      const tabId = historyMatch[1] as TabId;
      if (historyMatch[2] === "reload") {
        const body = await readBody(req);
        if (body.ignoreCache !== undefined && typeof body.ignoreCache !== "boolean") {
          return error(res, 400, "ignoreCache must be a boolean");
        }
        return json(res, await this.tabs.reload(tabId, { ignoreCache: body.ignoreCache === true }));
      }
      return json(res, historyMatch[2] === "back" ? await this.tabs.goBack(tabId) : await this.tabs.goForward(tabId));
    }

    const perceptionMatch = p.match(/^\/api\/tabs\/([^/]+)\/perception$/);
    if (method === "GET" && perceptionMatch) {
      const packet = await this.tabs.getPerceptionPacket(perceptionMatch[1] as TabId);
      return json(res, { ...packet, intent: this.getIntent(this.agentIdOf(req)) });
    }

    const manifestsMatch = p.match(/^\/api\/tabs\/([^/]+)\/manifests$/);
    if (method === "GET" && manifestsMatch) {
      return json(res, await this.tabs.listCapabilityManifests(manifestsMatch[1] as TabId));
    }

    const commandMatch = p.match(/^\/api\/tabs\/([^/]+)\/command$/);
    if (method === "POST" && commandMatch) {
      const body = await readBody(req);
      if (!body.command || typeof body.command !== "object") return error(res, 400, "command object is required");
      return json(res, await this.tabs.executeCommand(commandMatch[1] as TabId, body.command as BrowserOutputCommand));
    }

    const screenshotMatch = p.match(/^\/api\/tabs\/([^/]+)\/screenshot$/);
    if (method === "GET" && screenshotMatch) {
      const shot = await this.tabs.captureScreenshot(screenshotMatch[1] as TabId, {
        fullPage: url.searchParams.get("fullPage") === "true",
        ...(url.searchParams.get("selector") ? { selector: url.searchParams.get("selector")! } : {})
      });
      // Optionally serve raw PNG for easier consumption
      const accept = req.headers["accept"] ?? "";
      if (accept.includes("image/png")) {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(Buffer.from(shot.data, "base64"));
        return;
      }
      return json(res, shot);
    }

    const viewportMatch = p.match(/^\/api\/tabs\/([^/]+)\/viewport$/);
    if (method === "POST" && viewportMatch) {
      const parsed = parseViewportBody(await readBody(req));
      if (!parsed.ok) return error(res, 400, parsed.error);
      const { width, height, mobile } = parsed.value;
      await this.tabs.setEmulatedViewport(viewportMatch[1] as TabId, width, height, mobile);
      return json(res, { ok: true, width, height, mobile });
    }

    if (method === "GET" && p === "/api/picks") {
      const agentId = this.agentIdOf(req);
      const all = this.tabs.listPicks?.() ?? [];
      return json(res, agentId === null ? all : all.filter(pick => this.isTabAccessible(pick.tabId, agentId)));
    }

    // ── Approvals ────────────────────────────────────────────────────────────
    if (method === "GET" && p === "/api/approvals") {
      const agentId = this.agentIdOf(req);
      const all = this.tabs.listPendingApprovals();
      return json(res, agentId === null ? all : all.filter(a => this.isTabAccessible(a.tabId, agentId)));
    }

    const approveMatch = p.match(/^\/api\/approvals\/([^/]+)\/approve$/);
    if (method === "POST" && approveMatch) {
      if (this.approvalsMode === "human") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "Approvals on this instance are decided by the human in the HelmStack window. " +
            "The agent may reject (withdraw) its request, but not approve it.",
          code: REQUIRES_HUMAN
        }));
        return;
      }
      const agentId = this.agentIdOf(req);
      const pending = this.tabs.listPendingApprovals();
      const approval = pending.find(a => a.requestId === approveMatch[1]);
      if (approval && !this.isTabAccessible(approval.tabId, agentId)) return error(res, 403, "approval belongs to another agent");
      return json(res, await this.tabs.approveCommand(approveMatch[1]));
    }

    const rejectMatch = p.match(/^\/api\/approvals\/([^/]+)\/reject$/);
    if (method === "POST" && rejectMatch) {
      const agentId = this.agentIdOf(req);
      const pending = this.tabs.listPendingApprovals();
      const approval = pending.find(a => a.requestId === rejectMatch[1]);
      if (approval && !this.isTabAccessible(approval.tabId, agentId)) return error(res, 403, "approval belongs to another agent");
      return json(res, this.tabs.rejectCommand(rejectMatch[1]));
    }

    // ── Handoffs ─────────────────────────────────────────────────────────────
    if (method === "GET" && p === "/api/handoffs") {
      const agentId = this.agentIdOf(req);
      const all = this.tabs.listHandoffs();
      return json(res, agentId === null ? all : all.filter(h => this.isTabAccessible(h.tabId, agentId)));
    }

    const handoffResolveMatch = p.match(/^\/api\/handoffs\/([^/]+)\/resolve$/);
    if (method === "POST" && handoffResolveMatch) {
      const agentId = this.agentIdOf(req);
      const handoffs = this.tabs.listHandoffs();
      const handoff = handoffs.find(h => h.requestId === handoffResolveMatch[1]);
      if (handoff && !this.isTabAccessible(handoff.tabId, agentId)) return error(res, 403, "handoff belongs to another agent");
      const result = this.tabs.resolveHandoff(handoffResolveMatch[1]);
      if (handoff) {
        this.broadcastTabEvent("human_handoff_resolved", { requestId: handoffResolveMatch[1] }, handoff.tabId);
      } else {
        this.broadcast("human_handoff_resolved", { requestId: handoffResolveMatch[1] });
      }
      return json(res, result);
    }

    const handoffCancelMatch = p.match(/^\/api\/handoffs\/([^/]+)\/cancel$/);
    if (method === "POST" && handoffCancelMatch) {
      const agentId = this.agentIdOf(req);
      const handoffs = this.tabs.listHandoffs();
      const handoff = handoffs.find(h => h.requestId === handoffCancelMatch[1]);
      if (handoff && !this.isTabAccessible(handoff.tabId, agentId)) return error(res, 403, "handoff belongs to another agent");
      const result = this.tabs.cancelHandoff(handoffCancelMatch[1]);
      if (handoff) {
        this.broadcastTabEvent("human_handoff_resolved", { requestId: handoffCancelMatch[1], cancelled: true }, handoff.tabId);
      } else {
        this.broadcast("human_handoff_resolved", { requestId: handoffCancelMatch[1], cancelled: true });
      }
      return json(res, result);
    }

    // ── Accounts (optional slice) ────────────────────────────────────────────
    if (p === "/api/accounts" || p.startsWith("/api/accounts/")) {
      if (!this.accounts) return unsupported(res, "accounts", this.backend);
      return this.routeAccounts(req, res, method, p, this.accounts);
    }

    // ── Extensions (optional slice) ──────────────────────────────────────────
    if (p === "/api/extensions" || p.startsWith("/api/extensions/")) {
      if (!this.extensions) return unsupported(res, "extensions", this.backend);
      return this.routeExtensions(req, res, method, p, this.extensions);
    }

    // ── Console / network logs ────────────────────────────────────────────────
    const tabLogsMatch = p.match(/^\/api\/tabs\/([^/]+)\/logs$/);
    if (tabLogsMatch) {
      if (method === "GET") {
        return json(res, this.tabs.getTabLogs(tabLogsMatch[1] as TabId));
      }
      if (method === "DELETE") {
        this.tabs.clearTabLogs(tabLogsMatch[1] as TabId);
        return json(res, { ok: true });
      }
    }

    // ── HAR export ─────────────────────────────────────────────────────────────
    const harMatch = p.match(/^\/api\/tabs\/([^/]+)\/har$/);
    if (method === "GET" && harMatch) {
      return json(res, this.tabs.exportHar(harMatch[1] as TabId));
    }

    // ── Network mock / intercept ──────────────────────────────────────────────
    const mockMatch = p.match(/^\/api\/tabs\/([^/]+)\/mock$/);
    if (mockMatch) {
      if (method === "GET") {
        return json(res, { rules: this.tabs.getNetworkMockRules(mockMatch[1] as TabId) });
      }
      if (method === "POST") {
        const parsed = parseNetworkMockRules(await readBody(req));
        if (!parsed.ok) return error(res, 400, parsed.error);
        await this.tabs.enableNetworkMock(mockMatch[1] as TabId, parsed.value);
        return json(res, { ok: true, rulesCount: parsed.value.length });
      }
      if (method === "DELETE") {
        await this.tabs.disableNetworkMock(mockMatch[1] as TabId);
        return json(res, { ok: true });
      }
    }

    // ── Named screenshot + visual diff ────────────────────────────────────────
    const namedShotMatch = p.match(/^\/api\/tabs\/([^/]+)\/screenshot\/named$/);
    if (method === "POST" && namedShotMatch) {
      const body = await readBody(req);
      if (typeof body.snapshotId !== "string") return error(res, 400, "snapshotId string is required");
      return json(res, await this.tabs.captureNamedScreenshot(namedShotMatch[1] as TabId, body.snapshotId, {
        fullPage: body.fullPage === true,
        ...(typeof body.selector === "string" ? { selector: body.selector } : {})
      }));
    }

    if (method === "POST" && p === "/api/screenshots/diff") {
      const body = await readBody(req);
      if (typeof body.beforeId !== "string" || typeof body.afterId !== "string") {
        return error(res, 400, "beforeId and afterId strings are required");
      }
      const ignoreRegions = Array.isArray(body.ignoreRegions) ? body.ignoreRegions as DiffRegion[] : undefined;
      const perceptual = body.perceptual === true;
      const threshold = typeof body.threshold === "number" ? body.threshold : undefined;
      return json(res, this.tabs.diffScreenshots(body.beforeId, body.afterId, { ignoreRegions, perceptual, threshold }));
    }

    // ── Map diff regions → changed DOM elements ───────────────────────────────
    const changedElementsMatch = p.match(/^\/api\/tabs\/([^/]+)\/changed-elements$/);
    if (method === "POST" && changedElementsMatch) {
      const body = await readBody(req);
      if (!Array.isArray(body.regions)) return error(res, 400, "regions array is required");
      return json(res, await this.tabs.mapRegionsToElements(changedElementsMatch[1] as TabId, body.regions as DiffRegion[]));
    }

    // List all named screenshots in cache
    if (method === "GET" && p === "/api/screenshots") {
      return json(res, this.tabs.listScreenshots());
    }

    // Delete a named screenshot from cache
    const deleteScreenshotMatch = p.match(/^\/api\/screenshots\/([^/]+)$/);
    if (method === "DELETE" && deleteScreenshotMatch) {
      const deleted = this.tabs.deleteScreenshot(decodeURIComponent(deleteScreenshotMatch[1]));
      if (!deleted) return error(res, 404, "Screenshot not found");
      return json(res, { ok: true });
    }

    // ── Responsive multi-viewport suite ──────────────────────────────────────
    const viewportSuiteMatch = p.match(/^\/api\/tabs\/([^/]+)\/viewport-suite$/);
    if (method === "POST" && viewportSuiteMatch) {
      const body = await readBody(req);
      const presets = Array.isArray(body.presets) ? body.presets as ViewportPresetName[] : undefined;
      const includeDiffs = body.includeDiffs === true;
      const includeLayoutIssues = body.includeLayoutIssues === true;
      return json(res, await this.tabs.captureViewportSuite(viewportSuiteMatch[1] as TabId, presets, includeDiffs, includeLayoutIssues));
    }

    // ── Performance metrics ───────────────────────────────────────────────────
    const perfMatch = p.match(/^\/api\/tabs\/([^/]+)\/performance$/);
    if (method === "GET" && perfMatch) {
      return json(res, await this.tabs.capturePerformanceMetrics(perfMatch[1] as TabId));
    }

    // ── Aggregated page-health scorecard ──────────────────────────────────────
    const healthMatch = p.match(/^\/api\/tabs\/([^/]+)\/health$/);
    if (method === "GET" && healthMatch) {
      const includeSeo = url.searchParams.get("seo") !== "false";
      return json(res, await this.tabs.captureHealthReport(healthMatch[1] as TabId, { includeSeo }));
    }

    // ── SEO audit ─────────────────────────────────────────────────────────────
    const seoMatch = p.match(/^\/api\/tabs\/([^/]+)\/seo$/);
    if (method === "GET" && seoMatch) {
      const checkLinks = url.searchParams.get("checkLinks") === "true";
      const rawMax = url.searchParams.get("maxLinks");
      let maxLinks: number | undefined;
      if (rawMax !== null) {
        maxLinks = Number(rawMax);
        if (!Number.isInteger(maxLinks) || maxLinks < 1 || maxLinks > 100) {
          return error(res, 400, "maxLinks must be an integer between 1 and 100");
        }
      }
      return json(res, await this.tabs.seoAudit(seoMatch[1] as TabId, { checkLinks, ...(maxLinks !== undefined ? { maxLinks } : {}) }));
    }

    // ── Accessibility audit ───────────────────────────────────────────────────
    const a11yMatch = p.match(/^\/api\/tabs\/([^/]+)\/a11y$/);
    if (method === "GET" && a11yMatch) {
      const selector = url.searchParams.get("selector") ?? undefined;
      return json(res, await this.tabs.auditAccessibility(a11yMatch[1] as TabId, selector));
    }

    // ── Keyboard / focus-order audit ──────────────────────────────────────────
    const focusOrderMatch = p.match(/^\/api\/tabs\/([^/]+)\/focus-order$/);
    if (method === "GET" && focusOrderMatch) {
      return json(res, await this.tabs.auditFocusOrder(focusOrderMatch[1] as TabId));
    }

    // ── Element style inspector ───────────────────────────────────────────────
    const styleInspectMatch = p.match(/^\/api\/tabs\/([^/]+)\/styles\/inspect$/);
    if (method === "POST" && styleInspectMatch) {
      const body = await readBody(req);
      if (typeof body.selector !== "string" || !body.selector.trim()) {
        return error(res, 400, "selector string is required");
      }
      const limit = typeof body.limit === "number" ? body.limit : undefined;
      return json(res, await this.tabs.inspectElementStyles(
        styleInspectMatch[1] as TabId,
        body.selector,
        { limit }
      ));
    }

    const styleAssertMatch = p.match(/^\/api\/tabs\/([^/]+)\/styles\/assert$/);
    if (method === "POST" && styleAssertMatch) {
      const body = await readBody(req);
      if (typeof body.selector !== "string" || !body.selector.trim()) {
        return error(res, 400, "selector string is required");
      }
      if (!Array.isArray(body.assertions)) {
        return error(res, 400, "assertions array is required");
      }
      const limit = typeof body.limit === "number" ? body.limit : undefined;
      return json(res, await this.tabs.assertElementStyles(
        styleAssertMatch[1] as TabId,
        body.selector,
        body.assertions as StyleAssertion[],
        { limit }
      ));
    }

    // ── Component tree ────────────────────────────────────────────────────────
    const ctreeMatch = p.match(/^\/api\/tabs\/([^/]+)\/component-tree$/);
    if (method === "GET" && ctreeMatch) {
      return json(res, await this.tabs.captureComponentTree(ctreeMatch[1] as TabId));
    }

    // ── Design tokens ─────────────────────────────────────────────────────────
    const designTokensMatch = p.match(/^\/api\/tabs\/([^/]+)\/design-tokens$/);
    if (method === "GET" && designTokensMatch) {
      return json(res, await this.tabs.extractDesignTokens(designTokensMatch[1] as TabId));
    }

    // ── CSS coverage (unused-CSS) ───────────────────────────────────────────────
    const cssCoverageMatch = p.match(/^\/api\/tabs\/([^/]+)\/css-coverage$/);
    if (method === "GET" && cssCoverageMatch) {
      return json(res, await this.tabs.captureCssCoverage(cssCoverageMatch[1] as TabId));
    }

    // ── JS coverage (dead-JS) ───────────────────────────────────────────────────
    const jsCoverageMatch = p.match(/^\/api\/tabs\/([^/]+)\/js-coverage$/);
    if (method === "GET" && jsCoverageMatch) {
      return json(res, await this.tabs.captureJsCoverage(jsCoverageMatch[1] as TabId));
    }

    // ── Performance trace / timeline ────────────────────────────────────────────
    const traceMatch = p.match(/^\/api\/tabs\/([^/]+)\/trace$/);
    if (method === "GET" && traceMatch) {
      const durationMs = Number(url.searchParams.get("durationMs")) || undefined;
      return json(res, await this.tabs.captureTrace(traceMatch[1] as TabId, durationMs));
    }

    // ── Framework / dev-server detection ────────────────────────────────────────
    const frameworkMatch = p.match(/^\/api\/tabs\/([^/]+)\/framework$/);
    if (method === "GET" && frameworkMatch) {
      return json(res, await this.tabs.detectFramework(frameworkMatch[1] as TabId));
    }

    // ── Evaluate a JS expression in the page ────────────────────────────────────
    const evalMatch = p.match(/^\/api\/tabs\/([^/]+)\/evaluate$/);
    if (method === "POST" && evalMatch) {
      const body = await readBody(req);
      if (typeof body.expression !== "string") return error(res, 400, "expression string is required");
      return json(res, await this.tabs.evaluateExpression(evalMatch[1] as TabId, body.expression));
    }

    // ── Insert text into the focused element (browser-level input events) ───────
    const insertTextMatch = p.match(/^\/api\/tabs\/([^/]+)\/insert-text$/);
    if (method === "POST" && insertTextMatch) {
      const body = await readBody(req);
      if (typeof body.text !== "string") return error(res, 400, "text string is required");
      await this.tabs.insertText(insertTextMatch[1] as TabId, body.text);
      return json(res, { ok: true });
    }

    // ── Press a key (with optional modifier chord) on the focused element ───────
    const keyMatch = p.match(/^\/api\/tabs\/([^/]+)\/key$/);
    if (method === "POST" && keyMatch) {
      const body = await readBody(req);
      if (typeof body.key !== "string") return error(res, 400, "key string is required");
      await this.tabs.pressKey(keyMatch[1] as TabId, {
        key: body.key,
        code: typeof body.code === "string" ? body.code : undefined,
        keyCode: typeof body.keyCode === "number" ? body.keyCode : undefined,
        modifiers: typeof body.modifiers === "number" ? body.modifiers : undefined,
        text: typeof body.text === "string" ? body.text : undefined
      });
      return json(res, { ok: true });
    }

    // ── Left mouse click at viewport coordinates (reaches cross-origin frames) ──
    const clickMatch = p.match(/^\/api\/tabs\/([^/]+)\/click$/);
    if (method === "POST" && clickMatch) {
      const body = await readBody(req);
      if (typeof body.x !== "number" || typeof body.y !== "number") return error(res, 400, "x and y numbers are required");
      await this.tabs.clickAt(clickMatch[1] as TabId, body.x, body.y);
      return json(res, { ok: true });
    }

    // ── Visual element picker (human inspect → agent) ───────────────────────────
    const pickMatch = p.match(/^\/api\/tabs\/([^/]+)\/pick$/);
    if (method === "GET" && pickMatch) {
      if (typeof this.tabs.pickElement !== "function") return unsupported(res, "pick", this.backend);
      return json(res, await this.tabs.pickElement(pickMatch[1] as TabId));
    }

    // ── Human picks from the shell's "Select for agent" (read-only) ─────────────
    const latestPickMatch = p.match(/^\/api\/tabs\/([^/]+)\/picks\/latest$/);
    if (method === "GET" && latestPickMatch) {
      const latest = this.tabs.getLatestPick?.(latestPickMatch[1] as TabId) ?? null;
      if (!latest) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "The user has not selected an element in this tab", code: NO_PICK }));
        return;
      }
      return json(res, latest);
    }

    // ── Element → source mapping (click-to-component) ──────────────────────────
    const componentSourcesMatch = p.match(/^\/api\/tabs\/([^/]+)\/component-sources$/);
    if (method === "GET" && componentSourcesMatch) {
      return json(res, await this.tabs.captureComponentSources(componentSourcesMatch[1] as TabId));
    }

    // ── Layout / responsive issues ────────────────────────────────────────────
    const layoutIssuesMatch = p.match(/^\/api\/tabs\/([^/]+)\/layout-issues$/);
    if (method === "GET" && layoutIssuesMatch) {
      return json(res, await this.tabs.detectLayoutIssues(layoutIssuesMatch[1] as TabId));
    }

    // ── Media state (currently-matching media queries) ─────────────────────────
    const mediaStateMatch = p.match(/^\/api\/tabs\/([^/]+)\/media-state$/);
    if (method === "GET" && mediaStateMatch) {
      return json(res, await this.tabs.getMediaState(mediaStateMatch[1] as TabId));
    }

    // ── Mutation / re-render timeline ──────────────────────────────────────────
    const mutationsMatch = p.match(/^\/api\/tabs\/([^/]+)\/mutations$/);
    if (method === "GET" && mutationsMatch) {
      const durationMs = Number(url.searchParams.get("durationMs")) || undefined;
      return json(res, await this.tabs.captureMutationTimeline(mutationsMatch[1] as TabId, durationMs));
    }

    // ── Three.js Scene Inspector ──────────────────────────────────────────────
    const threejsMatch = p.match(/^\/api\/tabs\/([^/]+)\/threejs-scene$/);
    if (method === "GET" && threejsMatch) {
      return json(res, await this.tabs.captureThreeJsScene(threejsMatch[1] as TabId));
    }

    // ── Natural Language Assertions ───────────────────────────────────────────
    const assertMatch = p.match(/^\/api\/tabs\/([^/]+)\/assert$/);
    if (method === "POST" && assertMatch) {
      const body = await readBody(req);
      if (typeof body.assertion !== "string" || !body.assertion.trim()) {
        return error(res, 400, "assertion string is required");
      }
      const result = await this.tabs.evaluateAssertion(
        assertMatch[1] as TabId,
        body.assertion
      );
      return json(res, result);
    }

    // ── Standing assertion watches (emit `assertion_changed` over SSE) ─────────
    const watchesMatch = p.match(/^\/api\/tabs\/([^/]+)\/watches$/);
    if (watchesMatch) {
      const tid = watchesMatch[1] as TabId;
      if (method === "GET") {
        return json(res, this.tabs.listAssertionWatches(tid));
      }
      if (method === "POST") {
        const body = await readBody(req);
        if (typeof body.assertion !== "string" || !body.assertion.trim()) {
          return error(res, 400, "assertion string is required");
        }
        return json(res, this.tabs.addAssertionWatch(tid, body.assertion));
      }
    }
    const watchDeleteMatch = p.match(/^\/api\/tabs\/[^/]+\/watches\/([^/]+)$/);
    if (method === "DELETE" && watchDeleteMatch) {
      return json(res, { removed: this.tabs.removeAssertionWatch(watchDeleteMatch[1]) });
    }

    const recordingMatch = p.match(/^\/api\/tabs\/([^/]+)\/recording$/);
    if (recordingMatch && method === "GET") {
      return json(res, this.tabs.getRecording(recordingMatch[1] as TabId));
    }

    const recordingStartMatch = p.match(/^\/api\/tabs\/([^/]+)\/recording\/start$/);
    if (recordingStartMatch && method === "POST") {
      return json(res, this.tabs.startRecording(recordingStartMatch[1] as TabId));
    }

    const recordingStopMatch = p.match(/^\/api\/tabs\/([^/]+)\/recording\/stop$/);
    if (recordingStopMatch && method === "POST") {
      return json(res, this.tabs.stopRecording(recordingStopMatch[1] as TabId));
    }

    const sitePatternsMatch = p.match(/^\/api\/tabs\/([^/]+)\/site-patterns$/);
    if (sitePatternsMatch) {
      const tid = sitePatternsMatch[1] as TabId;
      if (method === "GET") {
        return json(res, { patterns: this.tabs.getSitePatterns(tid) });
      }
      if (method === "POST") {
        const body = await readBody(req);
        if (!Array.isArray(body.patterns)) return error(res, 400, "patterns array is required");
        const mode = body.mode === "set" ? "set" : "add";
        const patterns = mode === "set"
          ? this.tabs.setSitePatterns(tid, body.patterns.map(String))
          : this.tabs.addSitePatterns(tid, body.patterns.map(String));
        return json(res, { patterns });
      }
      if (method === "DELETE") {
        this.tabs.clearSitePatterns(tid);
        return json(res, { ok: true });
      }
    }

    const fileInputMatch = p.match(/^\/api\/tabs\/([^/]+)\/file-input$/);
    if (fileInputMatch && method === "POST") {
      const body = await readBody(req);
      if (typeof body.selector !== "string" || !Array.isArray(body.files)) {
        return error(res, 400, "selector string and files array are required");
      }
      return json(res, await this.tabs.setFileInputFiles(fileInputMatch[1] as TabId, {
        selector: body.selector,
        files: body.files.map(String)
      }));
    }

    const downloadsMatch = p.match(/^\/api\/tabs\/([^/]+)\/downloads$/);
    if (downloadsMatch) {
      const tid = downloadsMatch[1] as TabId;
      if (method === "GET") {
        return json(res, this.tabs.listDownloads(tid));
      }
      if (method === "DELETE") {
        this.tabs.clearDownloads(tid);
        return json(res, { ok: true });
      }
    }

    const budgetMatch = p.match(/^\/api\/tabs\/([^/]+)\/budget$/);
    if (budgetMatch) {
      const tid = budgetMatch[1] as TabId;
      if (method === "GET") {
        return json(res, this.tabs.getResourceBudget(tid));
      }
      if (method === "POST") {
        const parsed = parseResourceBudget(await readBody(req));
        if (!parsed.ok) return error(res, 400, parsed.error);
        return json(res, await this.tabs.setResourceBudget(tid, parsed.value));
      }
      if (method === "DELETE") {
        await this.tabs.clearResourceBudget(tid);
        return json(res, { ok: true });
      }
    }

    const locationMatch = p.match(/^\/api\/tabs\/([^/]+)\/location$/);
    if (locationMatch) {
      const tid = locationMatch[1] as TabId;
      if (method === "GET") {
        return json(res, this.tabs.getLocationOverride(tid));
      }
      if (method === "POST") {
        const body = await readBody(req);
        if (typeof body.latitude !== "number" || typeof body.longitude !== "number") {
          return error(res, 400, "latitude and longitude are required numbers");
        }
        return json(res, await this.tabs.setLocationOverride(tid, body as LocationOverride));
      }
      if (method === "DELETE") {
        await this.tabs.clearLocationOverride(tid);
        return json(res, { ok: true });
      }
    }

    // ── Media / appearance emulation ──────────────────────────────────────────
    const mediaMatch = p.match(/^\/api\/tabs\/([^/]+)\/media$/);
    if (mediaMatch) {
      const tid = mediaMatch[1] as TabId;
      if (method === "GET") {
        return json(res, this.tabs.getMediaEmulation(tid));
      }
      if (method === "POST") {
        const body = await readBody(req);
        return json(res, await this.tabs.setMediaEmulation(tid, body as MediaEmulation));
      }
      if (method === "DELETE") {
        await this.tabs.clearMediaEmulation(tid);
        return json(res, { ok: true });
      }
    }

    // ── Storage Inspector ─────────────────────────────────────────────────────
    type TabIdType = TabId;
    type StorageAreaType = StorageArea;

    // Full snapshot
    const storageAllMatch = p.match(/^\/api\/tabs\/([^/]+)\/storage$/);
    if (method === "GET" && storageAllMatch) {
      return json(res, await this.tabs.captureStorage(storageAllMatch[1] as TabIdType));
    }

    // Per-area GET + POST + DELETE
    const storageAreaMatch = p.match(/^\/api\/tabs\/([^/]+)\/storage\/(local|session)$/);
    if (storageAreaMatch) {
      const tid = storageAreaMatch[1] as TabIdType;
      const area = storageAreaMatch[2] as StorageAreaType;
      const u = new URL(req.url ?? "/", "http://x");
      if (method === "GET") {
        const key = u.searchParams.get("key") ?? undefined;
        return json(res, await this.tabs.getStorage(tid, area, key));
      }
      if (method === "POST") {
        const body = await readBody(req);
        if (!body.entries || typeof body.entries !== "object") return error(res, 400, "entries object is required");
        await this.tabs.setStorage(tid, area, body.entries as Record<string, string>);
        return json(res, { ok: true });
      }
      if (method === "DELETE") {
        const body: Record<string, unknown> =
          req.headers["content-length"] !== "0" ? await readBody(req).catch(() => ({})) : {};
        const keys = Array.isArray(body.keys) ? body.keys as string[] : undefined;
        await this.tabs.clearStorage(tid, area, keys);
        return json(res, { ok: true });
      }
    }

    // Cookies GET + POST + DELETE all
    const cookiesAllMatch = p.match(/^\/api\/tabs\/([^/]+)\/cookies$/);
    if (cookiesAllMatch) {
      const tid = cookiesAllMatch[1] as TabIdType;
      if (method === "GET") {
        const report = await this.tabs.captureStorage(tid);
        return json(res, report.cookies);
      }
      if (method === "POST") {
        const body = await readBody(req);
        if (typeof body.name !== "string" || typeof body.value !== "string") return error(res, 400, "name and value are required");
        await this.tabs.setCookie(tid, body as CookieEntry & { name: string; value: string });
        return json(res, { ok: true });
      }
      if (method === "DELETE") {
        await this.tabs.clearCookies(tid);
        return json(res, { ok: true });
      }
    }

    // Delete single cookie by name
    const cookieNameMatch = p.match(/^\/api\/tabs\/([^/]+)\/cookies\/([^/]+)$/);
    if (method === "DELETE" && cookieNameMatch) {
      const tid = cookieNameMatch[1] as TabIdType;
      const name = decodeURIComponent(cookieNameMatch[2]);
      const u = new URL(req.url ?? "/", "http://x");
      const url = u.searchParams.get("url") ?? undefined;
      await this.tabs.deleteCookie(tid, name, url);
      return json(res, { ok: true });
    }

    // ── "What Broke?" Perception snapshot + diff ──────────────────────────────
    const namedPerceptionMatch = p.match(/^\/api\/tabs\/([^/]+)\/perception\/named$/);
    if (method === "POST" && namedPerceptionMatch) {
      const body = await readBody(req);
      if (typeof body.snapshotId !== "string") return error(res, 400, "snapshotId string is required");
      return json(res, await this.tabs.saveNamedPerception(namedPerceptionMatch[1] as TabId, body.snapshotId));
    }

    if (method === "POST" && p === "/api/perception/diff") {
      const body = await readBody(req);
      if (typeof body.beforeId !== "string" || typeof body.afterId !== "string") {
        return error(res, 400, "beforeId and afterId strings are required");
      }
      return json(res, this.tabs.diffPerception(body.beforeId, body.afterId));
    }

    if (method === "GET" && p === "/api/perception") {
      return json(res, this.tabs.listPerceptionSnapshots());
    }

    const deletePerceptionMatch = p.match(/^\/api\/perception\/([^/]+)$/);
    if (method === "DELETE" && deletePerceptionMatch) {
      const deleted = this.tabs.deletePerceptionSnapshot(decodeURIComponent(deletePerceptionMatch[1]));
      if (!deleted) return error(res, 404, "Perception snapshot not found");
      return json(res, { ok: true });
    }

    // ── 404 ──────────────────────────────────────────────────────────────────
    return error(res, 404, "Not found");
  }

  private async routeAccounts(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    method: string,
    p: string,
    accounts: AccountsApi
  ): Promise<void> {
    if (method === "GET" && p === "/api/accounts") {
      return json(res, accounts.listAccounts());
    }

    if (method === "POST" && p === "/api/accounts") {
      const parsed = parseAccountInput(await readBody(req));
      if (!parsed.ok) return error(res, 400, parsed.error);
      return json(res, accounts.saveAccount(parsed.value));
    }

    const accountLookupMatch = p.match(/^\/api\/accounts\/lookup\/(.+)$/);
    if (method === "GET" && accountLookupMatch) {
      return json(res, accounts.lookupAccounts(decodeURIComponent(accountLookupMatch[1])));
    }

    const accountMatch = p.match(/^\/api\/accounts\/([^/]+)$/);
    if (accountMatch) {
      if (method === "PATCH") {
        const body = await readBody(req);
        return json(res, accounts.updateAccount(accountMatch[1], body as AccountUpdate));
      }
      if (method === "DELETE") {
        accounts.deleteAccount(accountMatch[1]);
        return json(res, { deleted: accountMatch[1] });
      }
    }

    const totpMatch = p.match(/^\/api\/accounts\/([^/]+)\/totp$/);
    if (method === "GET" && totpMatch) {
      return json(res, accounts.generateTotp(totpMatch[1]));
    }

    return error(res, 404, "Not found");
  }

  private async routeExtensions(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    method: string,
    p: string,
    extensions: ExtensionsApi
  ): Promise<void> {
    if (method === "GET" && p === "/api/extensions") {
      return json(res, await extensions.listExtensions());
    }

    if (method === "POST" && p === "/api/extensions") {
      const body = await readBody(req);
      if (typeof body.path !== "string") return error(res, 400, "path is required");
      return json(res, await extensions.loadExtension(body.path));
    }

    const extDeleteMatch = p.match(/^\/api\/extensions\/([^/]+)$/);
    if (method === "DELETE" && extDeleteMatch) {
      await extensions.removeExtension(extDeleteMatch[1]);
      return json(res, { removed: extDeleteMatch[1] });
    }

    return error(res, 404, "Not found");
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    if (!this.authToken) return true;

    const tokenHeader = req.headers["x-helmstack-token"];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    if (token === this.authToken) return true;

    const authHeader = req.headers.authorization;
    const auth = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    return auth === `Bearer ${this.authToken}`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Normalize a possibly-array HTTP header to a single string value. */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Last JSON payload per response, read once by the activity summarizer on finish. */
const responseData = new WeakMap<http.ServerResponse, unknown>();

function safePathname(raw: string | undefined): string {
  try {
    return new URL(raw ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

function json(res: http.ServerResponse, data: unknown) {
  responseData.set(res, data);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, code: number, message: string) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

/** 501 for a route whose optional API slice this backend does not provide. */
function unsupported(res: http.ServerResponse, feature: OptionalCapability, backend: BackendKind) {
  res.writeHead(501, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    error: `${feature} is not supported on the ${backend} backend`,
    code: UNSUPPORTED_ON_BACKEND,
    feature,
    backend
  }));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw.length ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}
