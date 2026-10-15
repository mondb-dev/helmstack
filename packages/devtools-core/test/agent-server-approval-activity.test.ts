/**
 * The activity row of a command queued for approval is updated in place when
 * the approval resolves (approved / rejected / cancelled / expired).
 */
import * as http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentActivityEntry, ApprovalResolution } from "../../shared/src/index.js";
import type { AgentApi } from "../src/api.js";
import { type AgentServer, createAgentServer } from "../src/http/agent-server.js";

let resolvers: Array<(r: ApprovalResolution) => void> = [];
let queued = 0;

function stubApi(): AgentApi {
  const api: Record<string, unknown> = {
    onTabsChanged() {},
    onPageObserved() {},
    onApprovalQueued() {},
    onApprovalResolved(fn: (r: ApprovalResolution) => void) {
      resolvers.push(fn);
      return () => {};
    },
    onHandoffRequested() {},
    onAssertionTransition() {},
    listTabs: () => [],
    listPendingApprovals: () => [{ requestId: "req-x", tabId: "tab-1", command: {}, effects: [], summary: "s", createdAt: 1 }],
    executeCommand: async () => ({
      status: "awaiting_approval",
      requestId: `req-${++queued}`,
      command: { type: "submit" },
      effects: []
    }),
    approveCommand: async () => ({ status: "completed", command: { type: "submit" } })
  };
  return api as unknown as AgentApi;
}

function post(port: number, urlPath: string, body: unknown = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: urlPath, headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
let servers: AgentServer[] = [];

async function start(opts: Partial<Parameters<typeof createAgentServer>[0]> = {}): Promise<[AgentServer, number]> {
  const server = createAgentServer({ api: stubApi(), backend: "desktop", port: 0, authToken: null, ...opts });
  servers.push(server);
  await server.start();
  return [server, server.boundPort!];
}

const resolve = (r: Partial<ApprovalResolution> & { requestId: string }) =>
  resolvers.forEach((fn) => fn({ tabId: "tab-1", outcome: "approved", resolvedAt: 1, ...r } as ApprovalResolution));

const queue = (port: number) =>
  post(port, "/api/tabs/tab-1/command", { command: { type: "submit", secretArg: "hunter2" } });

afterEach(async () => {
  await Promise.all(servers.map((s) => s.stop().catch(() => {})));
  servers = [];
  resolvers = [];
  queued = 0;
});

describe("approval activity row", () => {
  it("records requestId and approval:pending for a queued command", async () => {
    const [server, port] = await start();
    await queue(port);
    await tick();
    const [entry] = server.listActivity();
    expect(entry).toMatchObject({ label: "Run page command", summary: "awaiting approval", ok: true, requestId: "req-1", approval: "pending" });
  });

  it.each([
    ["approved", "approved", true],
    ["rejected", "rejected", true],
    ["cancelled", "cancelled", true],
    ["expired", "expired", true]
  ] as const)("%s updates the same entry in place and notifies listeners", async (outcome, summary, ok) => {
    const [server, port] = await start();
    const seen: AgentActivityEntry[] = [];
    server.onActivity((e) => seen.push(e));
    await queue(port);
    await tick();
    const id = server.listActivity()[0].id;
    resolve({ requestId: "req-1", outcome, reason: "page text: https://secret.test/?token=abc" });
    const list = server.listActivity();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, approval: outcome, summary, ok, requestId: "req-1" });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(list[0]);
    const dump = JSON.stringify(list[0]);
    for (const leaked of ["secret", "token", "hunter2", "page text"]) expect(dump).not.toContain(leaked);
  });

  it("an approved command that then failed is flagged not ok", async () => {
    const [server, port] = await start();
    await queue(port);
    await tick();
    resolve({ requestId: "req-1", outcome: "approved", status: "failed" });
    expect(server.listActivity()[0]).toMatchObject({ approval: "approved", ok: false, summary: "approved: failed" });
  });

  it("an evicted entry is simply not updated", async () => {
    const [server, port] = await start({ activityCapacity: 2 });
    await queue(port);
    await queue(port);
    await queue(port);
    await tick();
    expect(server.listActivity().map((e) => e.requestId)).toEqual(["req-2", "req-3"]);
    const seen: AgentActivityEntry[] = [];
    server.onActivity((e) => seen.push(e));
    expect(() => resolve({ requestId: "req-1", outcome: "rejected" })).not.toThrow();
    expect(seen).toEqual([]);
    expect(server.listActivity()).toHaveLength(2);
  });

  it("a refused (403 requires_human) approve leaves the row pending", async () => {
    const [server, port] = await start({ approvals: "human" });
    await queue(port);
    const res = await post(port, "/api/approvals/req-1/approve");
    expect(res.status).toBe(403);
    await tick();
    const entry = server.listActivity().find((e) => e.requestId === "req-1")!;
    expect(entry).toMatchObject({ approval: "pending", summary: "awaiting approval" });
  });

  it("only the first resolution counts", async () => {
    const [server, port] = await start();
    await queue(port);
    await tick();
    resolve({ requestId: "req-1", outcome: "approved" });
    resolve({ requestId: "req-1", outcome: "expired" });
    expect(server.listActivity()[0].approval).toBe("approved");
  });
});
