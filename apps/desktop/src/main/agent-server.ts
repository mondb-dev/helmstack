import http from "node:http";

import type {
  AccountUpdate,
  AgentLogEntry,
  BrowserOutputCommand,
  CookieEntry,
  DiffRegion,
  HumanHandoffRecord,
  LocationOverride,
  MediaEmulation,
  StorageArea,
  StyleAssertion,
  TabId,
  TabSummary,
  ViewportPresetName,
} from "../../../../packages/shared/src/index.js";
import type { TabManager } from "./tab-manager.js";
import type { ExtensionManager } from "./extension-manager.js";
import { parseAccountInput, parseNetworkMockRules, parseResourceBudget, parseViewportBody } from "./request-validation.js";

type SseClient = { res: http.ServerResponse; agentId: string | null };

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
 * REST endpoints
 * --------------
 * GET  /api/health
 * GET  /api/tabs
 * POST /api/tabs                          { url?: string }
 * POST /api/tabs/:id/navigate             { url: string }
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
 * GET  /api/tabs/:id/health               → HealthReport (aggregated scorecard)
 * GET  /api/tabs/:id/a11y               → A11yAuditReport (?selector= scopes to a subtree)
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
 * Events: tabs_changed | page_observed | approval_queued | human_handoff_requested | human_handoff_resolved | intent_changed | agent_log | assertion_changed
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

  constructor(
    private readonly tabs: TabManager,
    private readonly extensions: ExtensionManager,
    readonly port: number = 7070,
    private readonly authToken: string | null = process.env.HELMSTACK_AUTH_TOKEN || null
  ) {
    this.server = http.createServer(this.handle.bind(this));

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
    tabs.onHandoffRequested((h: HumanHandoffRecord) => this.broadcastTabEvent("human_handoff_requested", h, h.tabId));
  }

  /** The actual TCP port the server is bound to (useful when constructed with port 0). */
  get boundPort(): number | null {
    const addr = this.server.address();
    return addr && typeof addr === "object" ? addr.port : null;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.on("error", reject);
      this.server.listen(this.port, "127.0.0.1", () => {
        console.log(`[AgentServer] listening on http://127.0.0.1:${this.port}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const client of this.clients) {
        client.res.end();
      }
      this.server.close(() => resolve());
    });
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
      });
      return;
    }

    // ── Health ───────────────────────────────────────────────────────────────
    if (method === "GET" && p === "/api/health") {
      return json(res, { status: "ok", connectedAgents: this.clients.size, tabs: this.tabs.listTabs().length });
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

    const navMatch = p.match(/^\/api\/tabs\/([^/]+)\/navigate$/);
    if (method === "POST" && navMatch) {
      const body = await readBody(req);
      if (typeof body.url !== "string") return error(res, 400, "url is required");
      return json(res, await this.tabs.navigate(navMatch[1] as TabId, body.url));
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

    // ── Approvals ────────────────────────────────────────────────────────────
    if (method === "GET" && p === "/api/approvals") {
      const agentId = this.agentIdOf(req);
      const all = this.tabs.listPendingApprovals();
      return json(res, agentId === null ? all : all.filter(a => this.isTabAccessible(a.tabId, agentId)));
    }

    const approveMatch = p.match(/^\/api\/approvals\/([^/]+)\/approve$/);
    if (method === "POST" && approveMatch) {
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

    // ── Accounts ─────────────────────────────────────────────────────────────
    if (method === "GET" && p === "/api/accounts") {
      return json(res, this.tabs.listAccounts());
    }

    if (method === "POST" && p === "/api/accounts") {
      const parsed = parseAccountInput(await readBody(req));
      if (!parsed.ok) return error(res, 400, parsed.error);
      return json(res, this.tabs.saveAccount(parsed.value));
    }

    const accountLookupMatch = p.match(/^\/api\/accounts\/lookup\/(.+)$/);
    if (method === "GET" && accountLookupMatch) {
      return json(res, this.tabs.lookupAccounts(decodeURIComponent(accountLookupMatch[1])));
    }

    const accountMatch = p.match(/^\/api\/accounts\/([^/]+)$/);
    if (accountMatch) {
      if (method === "PATCH") {
        const body = await readBody(req);
        return json(res, this.tabs.updateAccount(accountMatch[1], body as AccountUpdate));
      }
      if (method === "DELETE") {
        this.tabs.deleteAccount(accountMatch[1]);
        return json(res, { deleted: accountMatch[1] });
      }
    }

    const totpMatch = p.match(/^\/api\/accounts\/([^/]+)\/totp$/);
    if (method === "GET" && totpMatch) {
      return json(res, this.tabs.generateTotp(totpMatch[1]));
    }

    // ── Extensions ───────────────────────────────────────────────────────────
    if (method === "GET" && p === "/api/extensions") {
      return json(res, await this.extensions.listExtensions());
    }

    if (method === "POST" && p === "/api/extensions") {
      const body = await readBody(req);
      if (typeof body.path !== "string") return error(res, 400, "path is required");
      return json(res, await this.extensions.loadExtension(body.path));
    }

    const extDeleteMatch = p.match(/^\/api\/extensions\/([^/]+)$/);
    if (method === "DELETE" && extDeleteMatch) {
      await this.extensions.removeExtension(extDeleteMatch[1]);
      return json(res, { removed: extDeleteMatch[1] });
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
      return json(res, await this.tabs.captureHealthReport(healthMatch[1] as TabId));
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

    // ── Visual element picker (human inspect → agent) ───────────────────────────
    const pickMatch = p.match(/^\/api\/tabs\/([^/]+)\/pick$/);
    if (method === "GET" && pickMatch) {
      return json(res, await this.tabs.pickElement(pickMatch[1] as TabId));
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

function json(res: http.ServerResponse, data: unknown) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, code: number, message: string) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
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
