/**
 * Agent-server surfaces for the desktop shell: human-only approvals, the
 * activity feed (labels, redaction, ring buffer) and the connection status.
 */
import * as http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentActivityEntry, AgentConnectionStatus } from "../../shared/src/index.js";
import type { AgentApi } from "../src/api.js";
import {
  ACTIVITY_ROUTES,
  ActivityLog,
  UNMATCHED_ROUTE,
  isActivityExcluded,
  matchActivityRoute,
  summarizeResponse
} from "../src/http/activity.js";
import { type AgentServer, createAgentServer, REQUIRES_HUMAN } from "../src/http/agent-server.js";

const pending = [{ requestId: "req-1", tabId: "tab-1", command: { type: "submit" }, effects: [], summary: "Submit form", createdAt: 1 }];

function stubApi(calls: string[] = []): AgentApi {
  const api: Record<string, unknown> = {
    onTabsChanged() {},
    onPageObserved() {},
    onApprovalQueued() {},
    onHandoffRequested() {},
    onAssertionTransition() {},
    listTabs: () => [{ id: "tab-1", title: "Example", url: "https://example.com", isActive: true, status: "idle" }],
    listPendingApprovals: () => pending,
    approveCommand: async (id: string) => {
      calls.push(`approve:${id}`);
      return { status: "completed", command: { type: "submit" } };
    },
    rejectCommand: (id: string) => {
      calls.push(`reject:${id}`);
      return { status: "blocked", command: { type: "submit" }, reason: "rejected" };
    },
    auditAccessibility: async () => ({ violations: [{ id: "a" }, { id: "b" }, { id: "c" }], score: 80 }),
    enableNetworkMock: async () => {},
    evaluateAssertion: async (_tabId: string, assertion: string) => ({ pass: false, assertion, explanation: "nope" }),
    insertText: async () => {}
  };
  return api as unknown as AgentApi;
}

type Res = { status: number; json: any };

function request(
  port: number,
  method: string,
  urlPath: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {}
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: urlPath,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } : {}),
          ...opts.headers
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null });
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Open an SSE stream; resolves once connected, with a closer. */
function openStream(port: number, headers: Record<string, string> = {}): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path: "/api/stream", headers }, (res) => {
      res.once("data", () => resolve(() => req.destroy()));
    });
    req.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err);
    });
    req.end();
  });
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

let servers: AgentServer[] = [];

async function startServer(opts: Partial<Parameters<typeof createAgentServer>[0]> = {}, api = stubApi()): Promise<[AgentServer, number]> {
  const server = createAgentServer({ api, backend: "desktop", port: 0, authToken: null, ...opts });
  servers.push(server);
  await server.start();
  return [server, server.boundPort!];
}

afterEach(async () => {
  await Promise.all(servers.map((s) => s.stop().catch(() => {})));
  servers = [];
});

describe("approvals mode", () => {
  it('defaults to "agent": an agent may approve', async () => {
    const calls: string[] = [];
    const [, port] = await startServer({}, stubApi(calls));
    const res = await request(port, "POST", "/api/approvals/req-1/approve");
    expect(res.status).toBe(200);
    expect(calls).toEqual(["approve:req-1"]);
  });

  it('"human": approve is 403 requires_human and never reaches the core', async () => {
    const calls: string[] = [];
    const [, port] = await startServer({ approvals: "human" }, stubApi(calls));
    const res = await request(port, "POST", "/api/approvals/req-1/approve");
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: REQUIRES_HUMAN });
    expect(typeof res.json.error).toBe("string");
    expect(calls).toEqual([]);
  });

  it('"human": an agent may still reject (withdraw) its request', async () => {
    const calls: string[] = [];
    const [, port] = await startServer({ approvals: "human" }, stubApi(calls));
    const res = await request(port, "POST", "/api/approvals/req-1/reject");
    expect(res.status).toBe(200);
    expect(calls).toEqual(["reject:req-1"]);
  });
});

describe("activity feed", () => {
  it("records route patterns, labels, tab and agent ids, status and summaries", async () => {
    const [server, port] = await startServer({ approvals: "human" });
    const seen: AgentActivityEntry[] = [];
    server.onActivity((entry) => seen.push(entry));

    await request(port, "GET", "/api/tabs/tab-1/a11y?selector=%23secret-form", { headers: { "X-Agent-ID": "claude" } });
    await request(port, "POST", "/api/tabs/tab-1/assert", { body: { assertion: "the password is hunter2" } });
    await request(port, "POST", "/api/tabs/tab-1/mock", { body: { rules: [{ urlPattern: "*", body: "x" }, { urlPattern: "/api/*", body: "y" }] } });
    await request(port, "POST", "/api/tabs/tab-1/insert-text", { body: { text: "s3cr3t-typed-value" } });
    await request(port, "POST", "/api/approvals/req-1/approve");
    await tick();

    expect(seen).toHaveLength(5);
    expect(server.listActivity()).toEqual(seen);
    expect(seen[0]).toMatchObject({
      method: "GET", route: "/api/tabs/:id/a11y", label: "Accessibility audit",
      tabId: "tab-1", agentId: "claude", status: 200, ok: true, summary: "3 issues"
    });
    expect(seen[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(seen[1]).toMatchObject({ route: "/api/tabs/:id/assert", label: "Assertion", summary: "Failed" });
    expect(seen[2]).toMatchObject({ route: "/api/tabs/:id/mock", label: "Set network mocks", summary: "2 rules" });
    expect(seen[3]).toMatchObject({ route: "/api/tabs/:id/insert-text", label: "Type text" });
    expect(seen[3].summary).toBeUndefined();
    expect(seen[4]).toMatchObject({ route: "/api/approvals/:requestId/approve", label: "Approve action", status: 403, ok: false });
    expect(seen[4].tabId).toBeUndefined();

    // Redaction: no query strings, selectors, bodies, typed values or raw ids.
    const dump = JSON.stringify(seen);
    for (const secret of ["secret-form", "selector", "hunter2", "password", "s3cr3t", "req-1", "/api/*"]) {
      expect(dump).not.toContain(secret);
    }
  });

  it("never records the raw path of unknown routes", async () => {
    const [server, port] = await startServer();
    await request(port, "GET", "/api/unknown/https%3A%2F%2Fprivate.example%2Fpath?token=abc");
    await tick();
    const [entry] = server.listActivity();
    expect(entry).toMatchObject({ route: UNMATCHED_ROUTE, label: "Unknown request", status: 404, ok: false });
    expect(JSON.stringify(entry)).not.toMatch(/private|token|abc/);
  });

  it("skips health polling, the SSE stream, agent log lines and unauthorized requests", async () => {
    const [server, port] = await startServer({ authToken: "tok" });
    const auth = { Authorization: "Bearer tok" };
    await request(port, "GET", "/api/health", { headers: auth });
    await request(port, "POST", "/api/log", { body: { message: "hi" }, headers: auth });
    const close = await openStream(port, auth);
    await request(port, "GET", "/api/tabs", { headers: { ...auth, "X-Agent-ID": "spoof-free" } });
    await request(port, "GET", "/api/tabs", { headers: { "X-Agent-ID": "no-token" } });
    close();
    await tick();
    expect(server.listActivity().map((e) => e.route)).toEqual(["/api/tabs"]);
    expect(server.listActivity()[0].summary).toBe("1 tab");
    expect(server.getConnectionStatus().agentIds).toEqual(["spoof-free"]);
  });

  it("truncates very long agent ids", async () => {
    const [server, port] = await startServer();
    await request(port, "GET", "/api/tabs", { headers: { "X-Agent-ID": "a".repeat(500) } });
    await tick();
    expect(server.listActivity()[0].agentId!.length).toBeLessThanOrEqual(65);
  });

  it("keeps a bounded ring buffer, oldest first", async () => {
    const [server, port] = await startServer({ activityCapacity: 3 });
    for (let i = 0; i < 5; i++) await request(port, "GET", "/api/tabs");
    await tick();
    const ids = server.listActivity().map((e) => e.id);
    expect(ids).toEqual(["act-3", "act-4", "act-5"]);
  });
});

describe("activity table", () => {
  it("has a sentence-case label and a unique method+pattern per route", () => {
    const keys = new Set<string>();
    for (const route of ACTIVITY_ROUTES) {
      expect(route.label).toMatch(/^[A-Z0-9]/);
      // Sentence case: later words are lower case unless they are acronyms.
      for (const word of route.label.split(" ").slice(1)) {
        expect(["HAR", "CSS", "JS", "TOTP"].includes(word) || word === word.toLowerCase(), route.label).toBe(true);
      }
      const key = `${route.method} ${route.pattern}`;
      expect(keys.has(key)).toBe(false);
      keys.add(key);
    }
  });

  it("covers every route documented in agent-server.ts", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(here, "../src/http/agent-server.ts"), "utf8");
    const documented = [...source.matchAll(/^ \* (GET|POST|PUT|PATCH|DELETE)\s+(\/api\/[^\s?]+)/gm)];
    expect(documented.length).toBeGreaterThan(60);
    for (const [, method, pattern] of documented) {
      const concrete = pattern
        .replace(/:id\b/, "tab-1")
        .replace(/:area\b/, "local")
        .replace(/:[a-z]+/gi, "x-1");
      if (isActivityExcluded(method!, concrete)) continue;
      const match = matchActivityRoute(method!, concrete);
      expect.soft(match.route, `${method} ${pattern}`).not.toBe(UNMATCHED_ROUTE);
    }
  });

  it("only extracts the tab id from /api/tabs/:id routes", () => {
    expect(matchActivityRoute("DELETE", "/api/tabs/tab%201/cookies/session_id")).toMatchObject({
      route: "/api/tabs/:id/cookies/:name", tabId: "tab 1"
    });
    expect(matchActivityRoute("DELETE", "/api/screenshots/home-page").tabId).toBeUndefined();
  });

  it("summaries never throw and ignore malformed data", () => {
    const a11y = matchActivityRoute("GET", "/api/tabs/t/a11y").summarize;
    expect(summarizeResponse(a11y, { violations: "nope" })).toBeUndefined();
    expect(summarizeResponse(a11y, null)).toBeUndefined();
    const seo = matchActivityRoute("GET", "/api/tabs/t/seo");
    expect(seo.label).toBe("SEO audit");
    expect(summarizeResponse(seo.summarize, { counts: { error: 3, warning: 5, info: 9 } })).toBe("3 errors · 5 warnings");
    expect(summarizeResponse(seo.summarize, { counts: { error: 1, warning: 1 } })).toBe("1 error · 1 warning");
    expect(summarizeResponse(seo.summarize, { counts: "nope" })).toBeUndefined();
    const perception = matchActivityRoute("GET", "/api/tabs/t/perception").summarize;
    expect(summarizeResponse(perception, { result: { graph: { forms: [1], actions: [1, 2] } } })).toBe("1 form, 2 actions");
    const diff = matchActivityRoute("POST", "/api/screenshots/diff").summarize;
    expect(summarizeResponse(diff, { diffPixelCount: 42 })).toBe("42 pixels differ");
    const command = matchActivityRoute("POST", "/api/tabs/t/command").summarize;
    expect(summarizeResponse(command, { status: "awaiting_approval", command: { value: "secret" } })).toBe("awaiting approval");
    expect(summarizeResponse(command, { status: "<script>" })).toBeUndefined();
  });

  it("ActivityLog drops the oldest entries beyond capacity", () => {
    const log = new ActivityLog(2);
    for (let i = 1; i <= 3; i++) {
      log.push({ id: `e${i}`, at: i, durationMs: 0, method: "GET", route: "/api/tabs", label: "List tabs", status: 200, ok: true });
    }
    expect(log.list().map((e) => e.id)).toEqual(["e2", "e3"]);
  });
});

describe("connection status", () => {
  it("reports listening, port, SSE clients, intent listeners, agents, token path and profile", async () => {
    const prev = process.env.HELMSTACK_PROFILE;
    process.env.HELMSTACK_PROFILE = "agent-substrate";
    try {
      const server = createAgentServer({ api: stubApi(), backend: "desktop", port: 0, authToken: null, tokenPath: "/data/helmstack-agent-token" });
      servers.push(server);
      const events: AgentConnectionStatus[] = [];
      server.onConnectionStatusChanged((s) => events.push(s));
      expect(server.getConnectionStatus()).toMatchObject({ listening: false, port: null, sseClients: 0 });

      await server.start();
      const port = server.boundPort!;
      expect(events.at(-1)).toMatchObject({
        listening: true, port, sseClients: 0, intentListeners: 0, agentIds: [],
        tokenPath: "/data/helmstack-agent-token", profile: "agent-substrate"
      });

      const close = await openStream(port, { "X-Agent-ID": "cursor" });
      await tick();
      expect(events.at(-1)).toMatchObject({ sseClients: 1, intentListeners: 1, agentIds: ["cursor"] });

      await request(port, "GET", "/api/tabs", { headers: { "X-Agent-ID": "claude" } });
      expect(events.at(-1)!.agentIds).toEqual(["claude", "cursor"]);

      const before = events.length;
      await request(port, "GET", "/api/tabs", { headers: { "X-Agent-ID": "claude" } });
      expect(events.length).toBe(before); // unchanged status → no event

      close();
      await tick();
      expect(events.at(-1)).toMatchObject({ sseClients: 0, intentListeners: 0 });

      await server.stop();
      expect(events.at(-1)).toMatchObject({ listening: false });
    } finally {
      if (prev === undefined) delete process.env.HELMSTACK_PROFILE;
      else process.env.HELMSTACK_PROFILE = prev;
    }
  });

  it("reports a port-in-use error", async () => {
    const [, port] = await startServer();
    const second = createAgentServer({ api: stubApi(), backend: "desktop", port, authToken: null });
    const events: AgentConnectionStatus[] = [];
    second.onConnectionStatusChanged((s) => events.push(s));
    await expect(second.start()).rejects.toThrow(/already in use/);
    expect(second.getConnectionStatus()).toMatchObject({ listening: false, port: null });
    expect(second.getConnectionStatus().error).toMatch(/already in use/);
    expect(events.at(-1)?.error).toMatch(/already in use/);
    expect(second.getConnectionStatus().profile).toMatch(/fe-dev|agent-substrate|full/);
  });
});
