/**
 * "Select for agent" hand-off over the agent API: the latest/recent pick
 * routes, the `element_picked` SSE event, the shell-pick activity entry
 * (tag name only) and the agent-sdk methods.
 */
import { mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BrowserClient } from "../../agent-sdk/src/index.js";
import type { ElementPickResult, HumanElementPick, TabId } from "../../shared/src/index.js";
import type { AgentApi } from "../src/api.js";
import { HelmstackCore } from "../src/core/helmstack-core.js";
import { matchActivityRoute, SHELL_PICK_ACTIVITY, summarizeResponse } from "../src/http/activity.js";
import { type AgentServer, createAgentServer, NO_PICK } from "../src/http/agent-server.js";
import { FakeBackend } from "./core/fakes.js";

const SECRET_TEXT = "Account 4111-secret balance";

function pickResult(tabId: TabId, overrides: Partial<ElementPickResult> = {}): ElementPickResult {
  return {
    tabId, url: "https://a.test/private?q=1", capturedAt: 1, picked: true,
    selector: "#checkout > button.cta", tagName: "BUTTON", text: SECRET_TEXT, id: "pay",
    ...overrides
  };
}

function get(port: number, urlPath: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: urlPath }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    }).on("error", reject);
  });
}

const tick = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await tick(10);
  }
}

let dataDir: string;
let core: HelmstackCore;
let server: AgentServer;
let port: number;
let tabId: TabId;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "helmstack-server-picks-"));
  core = new HelmstackCore(new FakeBackend(), { dataDir });
  tabId = (await core.createTab("https://a.test/")).at(-1)!.id;
  server = createAgentServer({ api: core, backend: "desktop", port: 0, authToken: null });
  await server.start();
  port = server.boundPort!;
});

afterEach(async () => {
  await server.stop();
  core.dispose();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("pick routes", () => {
  it("GET /api/tabs/:id/picks/latest is 404 no_pick until the human picks", async () => {
    const res = await get(port, `/api/tabs/${tabId}/picks/latest`);
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ code: NO_PICK });
    expect((await get(port, "/api/picks")).json).toEqual([]);
  });

  it("returns the latest pick per tab and the recent list newest first", async () => {
    core.recordHumanPick(tabId, pickResult(tabId, { selector: "#first" }));
    core.recordHumanPick(tabId, pickResult(tabId, { selector: "#second" }));
    const latest = await get(port, `/api/tabs/${tabId}/picks/latest`);
    expect(latest.status).toBe(200);
    expect(latest.json).toMatchObject({ tabId, pick: { selector: "#second", tagName: "BUTTON", text: SECRET_TEXT } });
    expect(typeof latest.json.pickedAt).toBe("number");
    const list = await get(port, "/api/picks");
    expect(list.json.map((p: HumanElementPick) => p.pick.selector)).toEqual(["#second", "#first"]);
  });
});

describe("element_picked event and activity", () => {
  it("streams element_picked and records a redacted 'You selected an element' entry", async () => {
    const client = new BrowserClient({ port });
    const events: HumanElementPick[] = [];
    const stream = client.stream({ onElementPicked: (p) => events.push(p) });
    try {
      await until(() => server.getConnectionStatus().sseClients === 1);
      core.recordHumanPick(tabId, pickResult(tabId));
      await until(() => events.length === 1);
      expect(events[0]).toMatchObject({ tabId, pick: { selector: "#checkout > button.cta" } });
    } finally {
      stream.close();
    }

    const entry = server.listActivity().find((e) => e.route === SHELL_PICK_ACTIVITY.route)!;
    expect(entry).toMatchObject({
      method: "SHELL", label: "You selected an element", tabId, ok: true, summary: "button"
    });
    expect(entry.agentId).toBeUndefined();
    const dump = JSON.stringify(entry);
    for (const leaked of ["4111", "secret", "checkout", "cta", "private", "pay"]) expect(dump).not.toContain(leaked);
  });

  it("labels the read routes and summarizes only the tag name", async () => {
    core.recordHumanPick(tabId, pickResult(tabId));
    await get(port, `/api/tabs/${tabId}/picks/latest`);
    await get(port, "/api/picks");
    await tick();
    const reads = server.listActivity().filter((e) => e.method === "GET");
    expect(reads.map((e) => [e.route, e.label, e.summary])).toEqual([
      ["/api/tabs/:id/picks/latest", "Read selected element", "button"],
      ["/api/picks", "List selected elements", "1 element"]
    ]);
    expect(JSON.stringify(reads)).not.toMatch(/4111|secret|checkout/);

    const summarize = matchActivityRoute("GET", "/api/tabs/t/picks/latest").summarize;
    expect(summarizeResponse(summarize, { pick: { tagName: "<img onerror=x>" } })).toBeUndefined();
    expect(summarizeResponse(summarize, { pick: { tagName: "my-widget" } })).toBe("my-widget");
  });
});

describe("agent-sdk", () => {
  it("getLatestPick returns null when none, then the pick; listPicks lists them", async () => {
    const client = new BrowserClient({ port });
    expect(await client.getLatestPick(tabId)).toBeNull();
    expect(await client.listPicks()).toEqual([]);
    core.recordHumanPick(tabId, pickResult(tabId));
    expect(await client.getLatestPick(tabId)).toMatchObject({ tabId, pick: { tagName: "BUTTON" } });
    expect(await client.listPicks()).toHaveLength(1);
  });

  it("getLatestPick still throws on other errors", async () => {
    const client = new BrowserClient({ port, agentId: "other" });
    // A tab owned by another agent → 403, not swallowed.
    const owner = new BrowserClient({ port, agentId: "owner" });
    const owned = (await owner.openTab()).find((t) => t.id !== tabId)!.id;
    await expect(client.getLatestPick(owned)).rejects.toThrow(/HTTP 403/);
  });
});

describe("backend without the picker (daemon parity)", () => {
  it("reports no picks rather than 501, and no pick capability", async () => {
    const api = {
      onTabsChanged() {}, onPageObserved() {}, onApprovalQueued() {}, onHandoffRequested() {}, onAssertionTransition() {},
      listTabs: () => []
    } as unknown as AgentApi;
    const bare = createAgentServer({ api, backend: "daemon", port: 0, authToken: null });
    await bare.start();
    try {
      const p = bare.boundPort!;
      expect((await get(p, "/api/tabs/tab-1/picks/latest"))).toMatchObject({ status: 404, json: { code: NO_PICK } });
      expect((await get(p, "/api/picks")).json).toEqual([]);
      expect((await get(p, "/api/health")).json.capabilities).not.toContain("pick");
    } finally {
      await bare.stop();
    }
  });
});
