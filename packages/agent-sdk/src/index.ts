/**
 * @helmstack/agent-sdk
 *
 * Typed client for the HelmStack agent server (127.0.0.1:7070).
 * Zero external dependencies — built on Node.js built-in http module.
 *
 * Quick start:
 *
 *   import { createBrowserClient } from "@helmstack/agent-sdk";
 *
 *   const browser = createBrowserClient();
 *   const tabs    = await browser.listTabs();
 *   const tab     = tabs.find(t => t.isActive)!;
 *   const page    = await browser.getPerception(tab.id);
 *   const shot    = await browser.getScreenshot(tab.id);  // base64 PNG
 *
 *   const result = await browser.execute(tab.id, {
 *     type: "invoke_site_tool",
 *     provider: "dom",
 *     toolName: "dom.read_page_state",
 *     args: {}
 *   });
 *
 *   const stream = browser.stream({
 *     onPageObserved: obs => console.log("page changed:", obs.tabId)
 *   });
 *   // later: stream.close();
 */

import http from "node:http";

// ── Re-export shared types agents need ────────────────────────────────────────
export type {
  AccountInput,
  AccountSummary,
  AccountUpdate,
  BrowserCommandResult,
  BrowserOutputCommand,
  BrowserPerceptionPacket,
  ConsoleLogEntry,
  HumanHandoffRecord,
  NetworkInterceptRule,
  NetworkRequestEntry,
  PageGraph,
  PageObservation,
  PageScreenshot,
  ScreenshotDiff,
  SiteCapabilityManifest,
  TabId,
  TabLogSnapshot,
  TabSummary,
  TotpResult
} from "../../shared/src/index.js";

import type {
  AccountInput,
  AccountSummary,
  AccountUpdate,
  BrowserCommandResult,
  BrowserOutputCommand,
  BrowserPerceptionPacket,
  HumanHandoffRecord,
  NetworkInterceptRule,
  PageScreenshot,
  ScreenshotDiff,
  SiteCapabilityManifest,
  TabId,
  TabLogSnapshot,
  TabSummary,
  TotpResult
} from "../../shared/src/index.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type BrowserClientOptions = {
  /** Default: 7070 */
  port?: number;
  /** Default: "127.0.0.1" */
  host?: string;
  /** Request timeout in ms. Default: 30_000 */
  timeout?: number;
};

export type StreamHandlers = {
  onTabsChanged?: (tabs: TabSummary[]) => void;
  onPageObserved?: (observation: unknown) => void;
  onApprovalQueued?: (approval: unknown) => void;
  onHandoffRequested?: (handoff: HumanHandoffRecord) => void;
  onHandoffResolved?: (data: { requestId: string; cancelled?: boolean }) => void;
  onIntentChanged?: (data: { intent: string }) => void;
  onAgentLog?: (data: { level: string; message: string; timestamp: number }) => void;
  onError?: (err: Error) => void;
};

export type StreamHandle = {
  close(): void;
};

// ── Client ────────────────────────────────────────────────────────────────────

export class BrowserClient {
  private readonly host: string;
  private readonly port: number;
  private readonly timeout: number;

  constructor(opts: BrowserClientOptions = {}) {
    this.host    = opts.host    ?? "127.0.0.1";
    this.port    = opts.port    ?? 7070;
    this.timeout = opts.timeout ?? 30_000;
  }

  // ── Health ──────────────────────────────────────────────────────────────

  async health(): Promise<{ status: string; tabs: number }> {
    return this.get("/api/health");
  }

  // ── Tabs ────────────────────────────────────────────────────────────────

  async listTabs(): Promise<TabSummary[]> {
    return this.get("/api/tabs");
  }

  async openTab(url?: string): Promise<TabSummary[]> {
    return this.post("/api/tabs", url ? { url } : {});
  }

  async navigate(tabId: TabId, url: string): Promise<TabSummary[]> {
    return this.post(`/api/tabs/${tabId}/navigate`, { url });
  }

  async setViewport(tabId: TabId, width: number, height: number, mobile = false): Promise<{ ok: boolean; width: number; height: number; mobile: boolean }> {
    return this.post(`/api/tabs/${tabId}/viewport`, { width, height, mobile });
  }

  // ── Perception ──────────────────────────────────────────────────────────

  async getPerception(tabId: TabId): Promise<BrowserPerceptionPacket> {
    return this.get(`/api/tabs/${tabId}/perception`);
  }

  async listManifests(tabId: TabId): Promise<SiteCapabilityManifest[]> {
    return this.get(`/api/tabs/${tabId}/manifests`);
  }

  /** Returns a PageScreenshot with a base64 PNG in `.data`. */
  async getScreenshot(tabId: TabId): Promise<PageScreenshot> {
    return this.get(`/api/tabs/${tabId}/screenshot`);
  }

  /** Returns the raw PNG as a Buffer — ready for fs.writeFile or vision API. */
  async getScreenshotBuffer(tabId: TabId): Promise<Buffer> {
    const shot = await this.getScreenshot(tabId);
    return Buffer.from(shot.data, "base64");
  }

  // ── Execution ───────────────────────────────────────────────────────────

  async execute(tabId: TabId, command: BrowserOutputCommand): Promise<BrowserCommandResult> {
    return this.post(`/api/tabs/${tabId}/command`, { command });
  }

  // ── Approvals ───────────────────────────────────────────────────────────

  async listApprovals(): Promise<unknown[]> {
    return this.get("/api/approvals");
  }

  async approveCommand(requestId: string): Promise<BrowserCommandResult> {
    return this.post(`/api/approvals/${requestId}/approve`, {});
  }

  async rejectCommand(requestId: string): Promise<BrowserCommandResult> {
    return this.post(`/api/approvals/${requestId}/reject`, {});
  }

  // ── Human handoffs ──────────────────────────────────────────────────────

  async listHandoffs(): Promise<HumanHandoffRecord[]> {
    return this.get("/api/handoffs");
  }

  async resolveHandoff(requestId: string): Promise<BrowserCommandResult> {
    return this.post(`/api/handoffs/${requestId}/resolve`, {});
  }

  async cancelHandoff(requestId: string): Promise<BrowserCommandResult> {
    return this.post(`/api/handoffs/${requestId}/cancel`, {});
  }

  /**
   * Wait until the given handoff is resolved (by the user in the UI) and
   * return. Polls the SSE stream internally. Rejects if `timeoutMs` elapses.
   */
  waitForHandoffResolved(requestId: string, timeoutMs = 120_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        handle.close();
        reject(new Error(`Handoff ${requestId} was not resolved within ${timeoutMs}ms`));
      }, timeoutMs);

      const handle = this.stream({
        onHandoffResolved: (data) => {
          if (data.requestId === requestId) {
            clearTimeout(timer);
            handle.close();
            resolve();
          }
        },
        onError: (err) => {
          clearTimeout(timer);
          handle.close();
          reject(err);
        }
      });
    });
  }

  // ── Accounts ────────────────────────────────────────────────────────────

  async listAccounts(): Promise<AccountSummary[]> {
    return this.get("/api/accounts");
  }

  async saveAccount(input: AccountInput): Promise<AccountSummary> {
    return this.post("/api/accounts", input);
  }

  async updateAccount(id: string, update: AccountUpdate): Promise<AccountSummary> {
    return this.request("PATCH", `/api/accounts/${id}`, update);
  }

  async deleteAccount(id: string): Promise<{ deleted: string }> {
    return this.request("DELETE", `/api/accounts/${id}`);
  }

  async lookupAccounts(origin: string): Promise<AccountSummary[]> {
    return this.get(`/api/accounts/lookup/${encodeURIComponent(origin)}`);
  }

  async generateTotp(accountId: string): Promise<TotpResult> {
    return this.get(`/api/accounts/${accountId}/totp`);
  }

  // ── Intent ─────────────────────────────────────────────────────────────

  async getIntent(): Promise<{ intent: string }> {
    return this.get("/api/intent");
  }

  async setIntent(intent: string): Promise<{ intent: string }> {
    return this.request("PUT", "/api/intent", { intent });
  }

  // ── Logging ────────────────────────────────────────────────────────────

  async log(message: string, level: "system" | "agent" | "ai" | "error" | "nav" = "agent"): Promise<void> {
    await this.post("/api/log", { level, message });
  }

  // ── Dev tools ──────────────────────────────────────────────────────────

  /** Return all buffered console logs, network requests, and JS errors for the tab. */
  async getLogs(tabId: TabId): Promise<TabLogSnapshot> {
    return this.get(`/api/tabs/${tabId}/logs`);
  }

  /** Clear all buffered logs for the tab. */
  async clearLogs(tabId: TabId): Promise<{ ok: boolean }> {
    return this.request("DELETE", `/api/tabs/${tabId}/logs`);
  }

  /**
   * Enable network request interception for the tab.
   * Requests matching a rule are fulfilled with the mocked response.
   * Non-matching requests pass through transparently.
   */
  async enableNetworkMock(tabId: TabId, rules: NetworkInterceptRule[]): Promise<{ ok: boolean; rulesCount: number }> {
    return this.post(`/api/tabs/${tabId}/mock`, { rules });
  }

  /** Disable network interception and restore normal request handling. */
  async disableNetworkMock(tabId: TabId): Promise<{ ok: boolean }> {
    return this.request("DELETE", `/api/tabs/${tabId}/mock`);
  }

  /** Return the currently active mock rules for the tab (null if disabled). */
  async getNetworkMockRules(tabId: TabId): Promise<{ rules: NetworkInterceptRule[] | null }> {
    return this.get(`/api/tabs/${tabId}/mock`);
  }

  /**
   * Capture a screenshot and store it in the server-side cache under `snapshotId`.
   * Use `diffScreenshots` to compare two named captures.
   */
  async captureNamedScreenshot(tabId: TabId, snapshotId: string): Promise<PageScreenshot> {
    return this.post(`/api/tabs/${tabId}/screenshot/named`, { snapshotId });
  }

  /**
   * Compare two previously captured named screenshots pixel-by-pixel.
   * Returns a diff percentage and a base64 PNG with changed pixels highlighted in red.
   */
  async diffScreenshots(beforeId: string, afterId: string): Promise<ScreenshotDiff> {
    return this.post("/api/screenshots/diff", { beforeId, afterId });
  }

  // ── SSE stream ──────────────────────────────────────────────────────────

  /**
   * Subscribe to the real-time event stream.
   * Returns a handle with a `close()` method to disconnect.
   * Automatically reconnects on drop.
   */
  stream(handlers: StreamHandlers): StreamHandle {
    let alive = true;
    let currentReq: http.ClientRequest | null = null;

    const connect = () => {
      if (!alive) return;

      const req = http.get(
        { host: this.host, port: this.port, path: "/api/stream" },
        (res) => {
          let buf = "";
          let eventType = "message";

          res.on("data", (chunk: Buffer) => {
            buf += chunk.toString();
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";

            for (const line of lines) {
              if (line.startsWith("event: ")) {
                eventType = line.slice(7).trim();
              } else if (line.startsWith("data: ")) {
                try {
                  const data = JSON.parse(line.slice(6)) as unknown;
                  dispatch(eventType, data, handlers);
                } catch {
                  // malformed JSON — skip
                }
                eventType = "message";
              }
            }
          });

          res.on("end", () => {
            if (alive) setTimeout(connect, 2000);
          });
          res.on("error", () => {
            if (alive) setTimeout(connect, 2000);
          });
        }
      );

      req.on("error", () => {
        if (alive) setTimeout(connect, 2000);
      });

      currentReq = req;
    };

    connect();

    return {
      close() {
        alive = false;
        currentReq?.destroy();
        currentReq = null;
      }
    };
  }

  // ── HTTP helpers ────────────────────────────────────────────────────────

  private get<T>(path: string): Promise<T> {
    return this.request("GET", path);
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request("POST", path, body);
  }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
      const headers: Record<string, string | number> = {
        "Accept": "application/json",
        "Content-Type": "application/json"
      };
      if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr);

      const req = http.request(
        {
          host: this.host,
          port: this.port,
          path,
          method,
          headers,
          timeout: this.timeout
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if ((res.statusCode ?? 0) >= 400) {
              return reject(new Error(`HTTP ${res.statusCode} ${method} ${path}: ${text}`));
            }
            try {
              resolve(JSON.parse(text) as T);
            } catch {
              reject(new Error(`Non-JSON response from ${method} ${path}: ${text}`));
            }
          });
          res.on("error", reject);
        }
      );

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Request timed out: ${method} ${path}`));
      });

      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }
}

// ── SSE dispatcher ────────────────────────────────────────────────────────────

function dispatch(eventType: string, data: unknown, handlers: StreamHandlers) {
  switch (eventType) {
    case "tabs_changed":
      handlers.onTabsChanged?.(data as TabSummary[]);
      break;
    case "page_observed":
      handlers.onPageObserved?.(data);
      break;
    case "approval_queued":
      handlers.onApprovalQueued?.(data);
      break;
    case "human_handoff_requested":
      handlers.onHandoffRequested?.(data as HumanHandoffRecord);
      break;
    case "human_handoff_resolved":
      handlers.onHandoffResolved?.(data as { requestId: string; cancelled?: boolean });
      break;
    case "intent_changed":
      handlers.onIntentChanged?.(data as { intent: string });
      break;
    case "agent_log":
      handlers.onAgentLog?.(data as { level: string; message: string; timestamp: number });
      break;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createBrowserClient(opts?: BrowserClientOptions): BrowserClient {
  return new BrowserClient(opts);
}
