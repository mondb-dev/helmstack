import * as http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { RoutineSpec } from "../../shared/src/index.js";
import { HelmstackCore } from "../src/core/helmstack-core.js";
import { createAgentServer, type AgentServer } from "../src/http/agent-server.js";
import { matchActivityRoute } from "../src/http/activity.js";
import { FakeBackend, type FakeTab } from "./core/fakes.js";

type Res = { status: number; json: any };

function request(port: number, method: string, urlPath: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, method, path: urlPath, headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
          resolve({ status: res.statusCode ?? 0, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const HOST = "league.example.com";
const START = `https://${HOST}/free-agents`;
const SENTINEL = "ZEBRA-PAGE-TEXT-7781";

/**
 * A backend whose tab answers the CDP calls the real core makes while acting: an accessibility tree with
 * three Add buttons, the row text around each, a page text that changes once a button is clicked.
 */
class RosterBackend extends FakeBackend {
  clicks: number[] = [];
  added = false;
  override async createTab(url: string, opts?: { parentTabId?: string }) {
    const tab = (await super.createTab(url, opts as never)) as FakeTab;
    tab.cdp.currentUrl = START;
    const page = { url: START, title: "Free agents", page: { title: "Free agents", url: START }, structured: [{ title: "Jalen Smith", url: `https://${HOST}/p/1` }], blocks: [] };
    tab.cdp.handlers.set("Runtime.evaluate", (p) => {
      const expr = String(p?.expression ?? "");
      if (expr.includes("selectedOptions")) return { result: { value: `Jalen Smith ${SENTINEL}\n${this.added ? "added to your team" : ""}` } };
      return { result: { value: page } };
    });
    tab.cdp.handlers.set("DOMSnapshot.captureSnapshot", () => ({ documents: [], strings: [] }));
    tab.cdp.handlers.set("Accessibility.getFullAXTree", () => ({
      nodes: [
        { nodeId: "1", role: { value: "button" }, name: { value: "Add" }, backendDOMNodeId: 11 },
        { nodeId: "2", role: { value: "button" }, name: { value: "Add" }, backendDOMNodeId: 12 }
      ]
    }));
    tab.cdp.handlers.set("DOM.resolveNode", (p) => ({ object: { objectId: `o${p?.backendNodeId}` } }));
    tab.cdp.handlers.set("Runtime.callFunctionOn", (p) => {
      const id = String(p?.objectId);
      const decl = String(p?.functionDeclaration ?? "");
      if (decl.includes("parentElement")) return { result: { value: id === "o11" ? `Jalen Smith Guard ${SENTINEL}` : "Mo Lee Forward" } };
      this.clicks.push(Number(id.slice(1)));
      this.added = true;
      return { result: { value: undefined } };
    });
    return tab;
  }
}

const SPEC: RoutineSpec = {
  version: 1,
  title: "Add a free agent",
  intent: "Pick up the first free agent.",
  scope: { start: [START], follow: { allow_hosts: [HOST], max_depth: 0 }, max_pages_per_run: 3 },
  trigger: { kind: "manual" },
  steps: [
    { do: "open", url: "$scope.start[0]" },
    { do: "locate", id: "list", target: "players", strategies: ["structured_data"], min_confidence: 0.5, on_low: "fail" },
    {
      do: "for_each",
      items: "$list",
      limit: 1,
      steps: [
        { do: "extract", id: "p", fields: { name: "text<=80" }, strategies: ["structured_data"], from: "$item" },
        { do: "act", action: "click", effect: "add_item", target: "the Add button in this player's row", strategies: ["repeating_blocks"], min_confidence: 0.8, on_low: "fail", subject: "$p", verify: { present: ["added to your team"] } }
      ]
    }
  ],
  actions: { request: { add_item: { mode: "auto", per_run: 1 } }, protect: ["Star Player"] }
};

let dataDir: string;
let backend: RosterBackend;
let core: HelmstackCore;
let server: AgentServer;
let port: number;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "helmstack-routine-actions-"));
  backend = new RosterBackend();
  core = new HelmstackCore(backend, {
    dataDir,
    routineStore: { log: () => {} },
    routineEngine: { autoStart: false, sleep: async () => {}, navTimeoutMs: 5000 }
  });
  server = createAgentServer({ api: core, backend: "daemon", port: 0, authToken: null });
  await server.start();
  port = server.boundPort!;
});
afterAll(async () => {
  await server.stop();
  core.dispose();
  rmSync(dataDir, { recursive: true, force: true });
});

async function propose(): Promise<string> {
  const res = await request(port, "POST", "/api/routines", { spec: SPEC });
  expect(res.status).toBe(201);
  expect(res.json.routine.preview.risks.map((r: { code: string }) => r.code)).toEqual(expect.arrayContaining(["acts_on_account", "requests_auto"]));
  return res.json.routine.id;
}
const finished = (id: string, status: string) =>
  vi.waitFor(() => expect(core.listRoutineRuns(id)[0]?.status).toBe(status), { timeout: 5000 });

describe("routine actions over HTTP (real core, scripted page)", () => {
  it("a proposal's request is only shown: with no grant the action waits, an agent can read it, and a human tap performs it through the command pipeline", async () => {
    const id = await propose();
    core.approveRoutine(id);
    const detail = await request(port, "GET", `/api/routines/${id}`);
    expect(detail.json.requestedGrants).toEqual({ effects: { add_item: { mode: "auto", perRun: 1 } }, protect: ["Star Player"] });
    expect(detail.json.grants).toEqual({ effects: {}, protect: [] });

    const frames: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/stream" }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          frames.push(chunk);
          if (chunk.includes(": connected")) core.runRoutineNow(id);
          if (frames.join("").includes('"status":"pending"')) { req.destroy(); resolve(); }
        });
      });
      req.on("error", (e) => { if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e); });
    });
    await finished(id, "needs_human");
    expect(backend.clicks).toEqual([]);

    const listed = await request(port, "GET", `/api/routines/${id}/actions`);
    expect(listed.status).toBe(200);
    expect(listed.json).toHaveLength(1);
    expect(listed.json[0]).toMatchObject({ status: "pending", effect: "add_item", host: HOST });
    expect(listed.json[0].secret).toBeUndefined();

    const events = frames.join("").split("\n\n").filter((f) => f.includes("event: routine_action")).map((f) => JSON.parse(f.split("data: ")[1]!));
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(Object.keys(e).sort()).toEqual(["actionId", "effect", "routineId", "status"]);
    expect(frames.join("")).not.toContain(SENTINEL);

    const done = await core.approveRoutineAction(id, listed.json[0].id);
    expect(done).toMatchObject({ status: "done", allowedBy: "human" });
    expect(backend.clicks).toEqual([11]);
  });

  it("with the human's grant the same routine acts by itself", async () => {
    backend.clicks = [];
    backend.added = false;
    const id = await propose();
    core.approveRoutine(id, { effects: { add_item: { mode: "auto", perRun: 1, perDay: 3 } }, protect: [] });
    expect(core.getRoutine(id)!.grants!.effects.add_item).toEqual({ mode: "auto", perRun: 1, perDay: 3 });
    core.runRoutineNow(id);
    await finished(id, "completed");
    expect(backend.clicks).toEqual([11]);
    expect((await request(port, "GET", `/api/routines/${id}/actions`)).json[0]).toMatchObject({ status: "done", allowedBy: "grant" });
    expect(() => core.approveRoutine(id, { effects: {}, protect: [] })).toThrow();
  });

  it("an invalid grant is refused and nothing is approved", async () => {
    const id = await propose();
    expect(() => core.approveRoutine(id, { effects: { offer: { mode: "auto" } }, protect: [] } as never)).toThrow();
    expect(core.listRoutines().find((r) => r.id === id)!.state).toBe("proposed");
  });

  it("has no route that approves, declines or sets grants; only the read is open", async () => {
    const id = core.listRoutines()[0]!.id;
    const aid = "act-abc123-0123abcd";
    const attempts: Array<[string, string]> = [];
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const suffix of ["actions", `actions/${aid}`, `actions/${aid}/approve`, `actions/${aid}/decline`, "grants", "approve", "actions/approve"]) attempts.push([method, `/api/routines/${id}/${suffix}`]);
    }
    for (const suffix of [`actions/${aid}`, `actions/${aid}/approve`, "grants"]) attempts.push(["GET", `/api/routines/${id}/${suffix}`]);
    for (const [method, url] of attempts) {
      const res = await request(port, method, url, method === "GET" ? undefined : { effects: { add_item: { mode: "auto" } } });
      expect([400, 404], `${method} ${url} -> ${res.status}`).toContain(res.status);
    }
    expect(core.getRoutine(id)!.grants).toBeDefined();
    const src = await import("node:fs").then((fs) => fs.readFileSync(path.resolve(__dirname, "../src/http/agent-server.ts"), "utf8"));
    expect(src).not.toMatch(/approveRoutineAction|declineRoutineAction|setRoutineGrants/);
    expect((await request(port, "GET", "/api/routines/nope/actions")).status).toBe(400);
    expect((await request(port, "GET", "/api/routines/rt-20990101-000000-00000000/actions")).status).toBe(404);
  });

  it("labels the read in the activity feed with a count only", async () => {
    expect(matchActivityRoute("GET", "/api/routines/rt-20260101-000000-abcdef01/actions")).toMatchObject({ label: "Read routine actions" });
    const entries = server.listActivity().filter((e) => e.route === "/api/routines/:id/actions");
    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).not.toContain(SENTINEL);
  });

  it("serves an action example that validates", async () => {
    const res = await request(port, "GET", "/api/routines/schema");
    expect(res.json.actionExample.steps.some((s: { do: string }) => s.do === "for_each")).toBe(true);
    const ok = await request(port, "POST", "/api/routines", { spec: res.json.actionExample });
    expect(ok.status).toBe(201);
  });
});
