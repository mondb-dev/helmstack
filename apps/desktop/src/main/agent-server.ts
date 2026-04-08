import http from "node:http";

import type {
  AccountInput,
  AccountUpdate,
  AgentLogEntry,
  BrowserOutputCommand,
  HumanHandoffRecord,
  TabId,
  VaultSecretInput,
} from "../../../../packages/shared/src/index.js";
import type { TabManager } from "./tab-manager.js";
import type { ExtensionManager } from "./extension-manager.js";

type SseClient = http.ServerResponse;

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
 * DELETE /api/tabs/:id/logs               clears buffered logs * GET  /api/tabs/:id/mock                 → { rules }
 * POST /api/tabs/:id/mock                 { rules: NetworkInterceptRule[] }
 * DELETE /api/tabs/:id/mock              disables interception
 * POST /api/tabs/:id/screenshot/named    { snapshotId } → PageScreenshot
 * POST /api/screenshots/diff             { beforeId, afterId } → ScreenshotDiff
 * POST /api/tabs/:id/viewport-suite      { presets?, includeDiffs? } → ViewportSuiteReport
 * GET  /api/tabs/:id/performance         → PerformanceReport
 * GET  /api/tabs/:id/a11y               → A11yAuditReport
 * GET  /api/tabs/:id/component-tree     → ComponentTreeReport
 *
 * SSE stream
 * ----------
 * GET  /api/stream
 * Events: tabs_changed | page_observed | approval_queued | human_handoff_requested | human_handoff_resolved | intent_changed | agent_log
 */
export class AgentServer {
  private readonly server: http.Server;
  private readonly clients = new Set<SseClient>();
  private intent = "";
  private logListeners: Array<(entry: AgentLogEntry) => void> = [];

  constructor(
    private readonly tabs: TabManager,
    private readonly extensions: ExtensionManager,
    readonly port: number = 7070
  ) {
    this.server = http.createServer(this.handle.bind(this));

    tabs.onTabsChanged((t) => this.broadcast("tabs_changed", t));
    tabs.onPageObserved((o) => this.broadcast("page_observed", o));
    tabs.onApprovalQueued((a) => this.broadcast("approval_queued", a));
    tabs.onHandoffRequested((h: HumanHandoffRecord) => this.broadcast("human_handoff_requested", h));
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
        client.end();
      }
      this.server.close(() => resolve());
    });
  }

  setIntent(value: string): void {
    this.intent = value;
    this.broadcast("intent_changed", { intent: value });
  }

  getIntent(): string {
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
        client.write(frame);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
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
      this.clients.add(res);
      req.on("close", () => this.clients.delete(res));
      return;
    }

    // ── Health ───────────────────────────────────────────────────────────────
    if (method === "GET" && p === "/api/health") {
      return json(res, { status: "ok", connectedAgents: this.clients.size, tabs: this.tabs.listTabs().length });
    }

    // ── Intent ────────────────────────────────────────────────────────────────
    if (method === "GET" && p === "/api/intent") {
      return json(res, { intent: this.intent });
    }

    if (method === "PUT" && p === "/api/intent") {
      const body = await readBody(req);
      if (typeof body.intent !== "string") return error(res, 400, "intent string is required");
      this.setIntent(body.intent);
      return json(res, { intent: this.intent });
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
      return json(res, this.tabs.listTabs());
    }

    if (method === "POST" && p === "/api/tabs") {
      const body = await readBody(req);
      const url = typeof body.url === "string" ? body.url : undefined;
      return json(res, await this.tabs.createTab(url));
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
      return json(res, { ...packet, intent: this.intent });
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
      const shot = await this.tabs.captureScreenshot(screenshotMatch[1] as TabId);
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
      const body = await readBody(req);
      const { width, height, mobile } = body as { width: number; height: number; mobile?: boolean };
      if (typeof width !== "number" || typeof height !== "number") return error(res, 400, "width and height are required numbers");
      await this.tabs.setEmulatedViewport(viewportMatch[1] as TabId, width, height, mobile ?? false);
      return json(res, { ok: true, width, height, mobile: mobile ?? false });
    }

    // ── Approvals ────────────────────────────────────────────────────────────
    if (method === "GET" && p === "/api/approvals") {
      return json(res, this.tabs.listPendingApprovals());
    }

    const approveMatch = p.match(/^\/api\/approvals\/([^/]+)\/approve$/);
    if (method === "POST" && approveMatch) {
      return json(res, await this.tabs.approveCommand(approveMatch[1]));
    }

    const rejectMatch = p.match(/^\/api\/approvals\/([^/]+)\/reject$/);
    if (method === "POST" && rejectMatch) {
      return json(res, this.tabs.rejectCommand(rejectMatch[1]));
    }

    // ── Handoffs ─────────────────────────────────────────────────────────────
    if (method === "GET" && p === "/api/handoffs") {
      return json(res, this.tabs.listHandoffs());
    }

    const handoffResolveMatch = p.match(/^\/api\/handoffs\/([^/]+)\/resolve$/);
    if (method === "POST" && handoffResolveMatch) {
      const result = this.tabs.resolveHandoff(handoffResolveMatch[1]);
      this.broadcast("human_handoff_resolved", { requestId: handoffResolveMatch[1] });
      return json(res, result);
    }

    const handoffCancelMatch = p.match(/^\/api\/handoffs\/([^/]+)\/cancel$/);
    if (method === "POST" && handoffCancelMatch) {
      const result = this.tabs.cancelHandoff(handoffCancelMatch[1]);
      this.broadcast("human_handoff_resolved", { requestId: handoffCancelMatch[1], cancelled: true });
      return json(res, result);
    }

    // ── Accounts ─────────────────────────────────────────────────────────────
    if (method === "GET" && p === "/api/accounts") {
      return json(res, this.tabs.listAccounts());
    }

    if (method === "POST" && p === "/api/accounts") {
      const body = await readBody(req);
      if (typeof body.label !== "string") return error(res, 400, "label is required");
      if (!Array.isArray(body.origins)) return error(res, 400, "origins array is required");
      if (typeof body.username !== "string") return error(res, 400, "username is required");
      if (typeof body.password !== "string") return error(res, 400, "password is required");
      return json(res, this.tabs.saveAccount(body as unknown as AccountInput));
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

    // ── Network mock / intercept ──────────────────────────────────────────────
    const mockMatch = p.match(/^\/api\/tabs\/([^/]+)\/mock$/);
    if (mockMatch) {
      if (method === "GET") {
        return json(res, { rules: this.tabs.getNetworkMockRules(mockMatch[1] as TabId) });
      }
      if (method === "POST") {
        const body = await readBody(req);
        if (!Array.isArray(body.rules)) return error(res, 400, "rules array is required");
        await this.tabs.enableNetworkMock(mockMatch[1] as TabId, body.rules as import("../../../../packages/shared/src/index.js").NetworkInterceptRule[]);
        return json(res, { ok: true, rulesCount: (body.rules as unknown[]).length });
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
      return json(res, await this.tabs.captureNamedScreenshot(namedShotMatch[1] as TabId, body.snapshotId));
    }

    if (method === "POST" && p === "/api/screenshots/diff") {
      const body = await readBody(req);
      if (typeof body.beforeId !== "string" || typeof body.afterId !== "string") {
        return error(res, 400, "beforeId and afterId strings are required");
      }
      return json(res, this.tabs.diffScreenshots(body.beforeId, body.afterId));
    }

    // ── Responsive multi-viewport suite ──────────────────────────────────────
    const viewportSuiteMatch = p.match(/^\/api\/tabs\/([^/]+)\/viewport-suite$/);
    if (method === "POST" && viewportSuiteMatch) {
      const body = await readBody(req);
      const presets = Array.isArray(body.presets) ? body.presets as import("../../../../packages/shared/src/index.js").ViewportPresetName[] : undefined;
      const includeDiffs = body.includeDiffs === true;
      return json(res, await this.tabs.captureViewportSuite(viewportSuiteMatch[1] as import("../../../../packages/shared/src/index.js").TabId, presets, includeDiffs));
    }

    // ── Performance metrics ───────────────────────────────────────────────────
    const perfMatch = p.match(/^\/api\/tabs\/([^/]+)\/performance$/);
    if (method === "GET" && perfMatch) {
      return json(res, await this.tabs.capturePerformanceMetrics(perfMatch[1] as import("../../../../packages/shared/src/index.js").TabId));
    }

    // ── Accessibility audit ───────────────────────────────────────────────────
    const a11yMatch = p.match(/^\/api\/tabs\/([^/]+)\/a11y$/);
    if (method === "GET" && a11yMatch) {
      return json(res, await this.tabs.auditAccessibility(a11yMatch[1] as import("../../../../packages/shared/src/index.js").TabId));
    }

    // ── Component tree ────────────────────────────────────────────────────────
    const ctreeMatch = p.match(/^\/api\/tabs\/([^/]+)\/component-tree$/);
    if (method === "GET" && ctreeMatch) {
      return json(res, await this.tabs.captureComponentTree(ctreeMatch[1] as import("../../../../packages/shared/src/index.js").TabId));
    }

    // ── 404 ──────────────────────────────────────────────────────────────────
    return error(res, 404, "Not found");
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
