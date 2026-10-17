import * as http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AgentActivityEntry, RoutineSpec } from "../../shared/src/index.js";
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

const START = "https://news.example.com/updates";
const SENTINEL = "ZEBRA-PAGE-TEXT-4471";
const PAGE = {
  url: START,
  title: "Updates",
  page: { title: "Updates", url: START },
  structured: [
    { title: `${SENTINEL} one`, url: "https://news.example.com/a/1", date: "2026-01-05" },
    { title: "Two", url: "https://news.example.com/a/2", date: "2026-01-06" }
  ],
  blocks: []
};

/** A backend whose tabs answer the page script with PAGE, so the real core and engine run end to end. */
class PageBackend extends FakeBackend {
  override async createTab(url: string, opts?: { parentTabId?: string }) {
    const tab = (await super.createTab(url, opts as never)) as FakeTab;
    tab.cdp.handlers.set("Runtime.evaluate", () => ({ result: { value: PAGE } }));
    return tab;
  }
}

const SPEC: RoutineSpec = {
  version: 1,
  title: "Watch updates",
  intent: "Watch the updates page.",
  scope: { start: [START], follow: { same_site: true, max_depth: 1 }, max_pages_per_run: 5 },
  trigger: { kind: "manual" },
  state: { seen: "set", notes: "log" },
  steps: [
    { do: "open", id: "start", url: "$scope.start[0]" },
    { do: "locate", id: "updates", target: "updates", strategies: ["structured_data"], min_confidence: 0.6, on_low: "skip" },
    { do: "diff", id: "fresh", items: "$updates", against: "state.seen", key: ["url"] },
    { do: "for_each", items: "$fresh", limit: 10, steps: [{ do: "note", tag: "update" }, { do: "mark_seen" }] }
  ]
};

let dataDir: string;
let core: HelmstackCore;
let server: AgentServer;
let port: number;
let id: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "helmstack-routine-runs-"));
  core = new HelmstackCore(new PageBackend(), {
    dataDir,
    routineStore: { log: () => {} },
    routineEngine: { autoStart: false, sleep: async () => {}, navTimeoutMs: 5000 }
  });
  server = createAgentServer({ api: core, backend: "daemon", port: 0, authToken: null });
  await server.start();
  port = server.boundPort!;
  const proposed = await request(port, "POST", "/api/routines", { spec: SPEC });
  expect(proposed.status).toBe(201);
  id = proposed.json.routine.id;
  core.approveRoutine(id);
});
afterAll(async () => {
  await server.stop();
  core.dispose();
  rmSync(dataDir, { recursive: true, force: true });
});

const finished = (runId: string) => vi.waitFor(() => expect(core.listRoutineRuns(id).find((r) => r.id === runId)?.status).toBe("completed"), { timeout: 5000 });

describe("routine runs over HTTP", () => {
  it("broadcasts routine_run with ids, status and a fixed-wording summary only", async () => {
    const frames: string[] = [];
    let runId = "";
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/stream" }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          frames.push(chunk);
          if (chunk.includes(": connected")) runId = core.runRoutineNow(id).id;
          if (frames.join("").includes('"status":"completed"')) {
            req.destroy();
            resolve();
          }
        });
      });
      req.on("error", (e) => { if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e); });
    });
    const events = frames.join("").split("\n\n").filter((f) => f.includes("event: routine_run")).map((f) => JSON.parse(f.split("data: ")[1]!));
    expect(events.length).toBeGreaterThanOrEqual(2); // started, finished
    for (const e of events) {
      expect(Object.keys(e).sort()).toEqual(["routineId", "runId", "status", "summary"]);
      expect(e).toMatchObject({ routineId: id, runId });
    }
    expect(events[0].status).toBe("running");
    expect(events.at(-1)).toMatchObject({ status: "completed", summary: "Completed: 1 page, 2 notes." });
    expect(frames.join("")).not.toContain(SENTINEL);
  });

  it("lets an agent read runs and notes, and marks neither as instructions", async () => {
    await finished(core.listRoutineRuns(id)[0]!.id);
    const runs = await request(port, "GET", `/api/routines/${id}/runs`);
    expect(runs.status).toBe(200);
    expect(runs.json[0]).toMatchObject({ routineId: id, status: "completed", pagesVisited: 1, notesAdded: 2, trigger: "manual" });
    expect(runs.json[0].log).toBeUndefined(); // summaries only

    const notes = await request(port, "GET", `/api/routines/${id}/notes`);
    expect(notes.status).toBe(200);
    expect(notes.json).toHaveLength(2);
    expect(JSON.stringify(notes.json)).toContain(SENTINEL); // page text is data, available to read
    const one = await request(port, "GET", `/api/routines/${id}/notes?limit=1`);
    expect(one.json).toHaveLength(1);
    expect((await request(port, "GET", `/api/routines/${id}/notes?limit=junk`)).json).toHaveLength(2);
    expect((await request(port, "GET", `/api/routines/${id}/notes?limit=100000`)).status).toBe(200);
  });

  it("rejects bad ids and unknown routines", async () => {
    for (const kind of ["runs", "notes"]) {
      expect((await request(port, "GET", `/api/routines/nope/${kind}`)).status).toBe(400);
      expect((await request(port, "GET", `/api/routines/rt-20990101-000000-00000000/${kind}`)).status).toBe(404);
    }
  });

  it("has no route that runs, cancels, clears memory, reads memory or toggles the kill switch", async () => {
    const attempts: Array<[string, string]> = [];
    for (const action of ["run", "run-now", "runs", "cancel", "memory", "clear-memory", "kill", "kill-switch", "start", "notes"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) attempts.push([method, `/api/routines/${id}/${action}`]);
    }
    for (const action of ["memory", "run", "cancel", "start", `runs/${core.listRoutineRuns(id)[0]!.id}`]) attempts.push(["GET", `/api/routines/${id}/${action}`]);
    for (const url of ["/api/routines/kill-switch", "/api/routines/killswitch", "/api/routines/engine", "/api/routines/run", "/api/routine-engine"]) {
      for (const method of ["GET", "POST", "PUT", "DELETE"]) attempts.push([method, url]);
    }
    for (const [method, url] of attempts) {
      const res = await request(port, method, url, method === "GET" ? undefined : {});
      // 404 (no route), or 400 where the path is read as a malformed routine id; never a success.
      expect([400, 404], `${method} ${url} -> ${res.status}`).toContain(res.status);
    }
    expect(core.getRoutineEngineStatus().killed).toBe(false);
    expect(core.listRoutineRuns(id).every((r) => r.status === "completed")).toBe(true);
    const src = await import("node:fs").then((fs) => fs.readFileSync(path.resolve(__dirname, "../src/http/agent-server.ts"), "utf8"));
    expect(src).not.toMatch(/runRoutineNow|cancelRoutineRun|clearRoutineMemory|setRoutineKillSwitch|getRoutineMemory/);
  });

  it("labels the read routes and records only counts in the activity feed", async () => {
    expect(matchActivityRoute("GET", `/api/routines/${id}/runs`)).toMatchObject({ label: "Read routine runs", route: "/api/routines/:id/runs" });
    expect(matchActivityRoute("GET", `/api/routines/${id}/notes`)).toMatchObject({ label: "Read routine notes", route: "/api/routines/:id/notes" });
    const entries = server.listActivity().filter((e: AgentActivityEntry) => e.route.startsWith("/api/routines"));
    expect(entries.map((e) => e.label)).toEqual(expect.arrayContaining(["Read routine runs", "Read routine notes"]));
    expect(entries.find((e) => e.label === "Read routine notes")?.summary).toMatch(/^\d+ notes?$/);
    expect(JSON.stringify(entries)).not.toContain(SENTINEL);
    expect(JSON.stringify(entries)).not.toContain("Watch the updates page");
  });
});
