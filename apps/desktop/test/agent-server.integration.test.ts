import * as http from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AgentServer } from "../src/main/agent-server.js";
import type { ExtensionManager } from "../src/main/extension-manager.js";
import type { TabManager } from "../src/main/tab-manager.js";

const TOKEN = "test-token-123";

/** Minimal TabManager stub — only the members the server touches for these routes. */
function stubTabManager(): TabManager {
  return {
    onTabsChanged() {},
    onPageObserved() {},
    onApprovalQueued() {},
    onHandoffRequested() {},
    onAssertionTransition() {},
    listTabs() {
      return [{ id: "tab-1", title: "Example", url: "https://example.com", isActive: true, status: "idle", statusMessage: "" }];
    }
  } as unknown as TabManager;
}

const stubExtensions = {} as unknown as ExtensionManager;

let server: AgentServer;
let port: number;

beforeAll(async () => {
  server = new AgentServer(stubTabManager(), stubExtensions, 0, TOKEN);
  await server.start();
  port = server.boundPort!;
});

afterAll(async () => {
  await server.stop();
});

type Res = { status: number; body: string };

/** Raw HTTP request with full header control (fetch forbids overriding Host). */
function request(method: string, path: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

const auth = { "X-HelmStack-Token": TOKEN };

describe("AgentServer HTTP integration", () => {
  it("serves health with a valid token", async () => {
    const res = await request("GET", "/api/health", auth);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    expect(body.tabs).toBe(1);
  });

  it("rejects requests with no token", async () => {
    const res = await request("GET", "/api/health");
    expect(res.status).toBe(401);
  });

  it("rejects requests with a wrong token", async () => {
    const res = await request("GET", "/api/health", { "X-HelmStack-Token": "nope" });
    expect(res.status).toBe(401);
  });

  it("accepts a Bearer token too", async () => {
    const res = await request("GET", "/api/health", { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
  });

  it("rejects a cross-origin (non-loopback) Origin", async () => {
    const res = await request("GET", "/api/health", { ...auth, Origin: "https://evil.com" });
    expect(res.status).toBe(403);
  });

  it("allows a loopback Origin", async () => {
    const res = await request("GET", "/api/health", { ...auth, Origin: "http://localhost:3000" });
    expect(res.status).toBe(200);
  });

  it("rejects a non-loopback Host header (DNS-rebinding guard)", async () => {
    const res = await request("GET", "/api/health", { ...auth, Host: "evil.com" });
    expect(res.status).toBe(403);
  });

  it("lists tabs", async () => {
    const res = await request("GET", "/api/tabs", auth);
    expect(res.status).toBe(200);
    const tabs = JSON.parse(res.body);
    expect(Array.isArray(tabs)).toBe(true);
    expect(tabs[0].id).toBe("tab-1");
  });

  it("returns 404 for an unknown route", async () => {
    const res = await request("GET", "/api/does-not-exist", auth);
    expect(res.status).toBe(404);
  });

  it("answers CORS preflight without a token", async () => {
    const res = await request("OPTIONS", "/api/health", { Origin: "http://localhost:3000" });
    expect(res.status).toBe(204);
  });

  // Codifies the documented limitation (docs/security-model.md → "agent isolation
  // is advisory"): X-Agent-ID is a trusted, unauthenticated header. With one
  // shared token, any token-holder can present any agent id. This is intentional
  // (cooperative partition, not a security boundary) — these tests exist so that
  // can't silently change into a false guarantee.
  describe("agent isolation is advisory, not a security boundary", () => {
    it("accepts an arbitrary X-Agent-ID with a valid token (identity is not bound)", async () => {
      const a = await request("GET", "/api/tabs", { ...auth, "X-Agent-ID": "agent-a" });
      const impersonator = await request("GET", "/api/tabs", { ...auth, "X-Agent-ID": "totally-different-agent" });
      expect(a.status).toBe(200);
      expect(impersonator.status).toBe(200); // header trusted, not authenticated
    });

    it("still requires the shared token regardless of X-Agent-ID", async () => {
      const res = await request("GET", "/api/tabs", { "X-Agent-ID": "agent-a" });
      expect(res.status).toBe(401); // the token is the real gate; the agent id is not
    });
  });
});
