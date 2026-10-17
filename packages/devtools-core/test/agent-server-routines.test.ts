import * as http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AgentActivityEntry, RoutineSummary } from "../../shared/src/index.js";
import { HelmstackCore } from "../src/core/helmstack-core.js";
import { ACTIVITY_ROUTES, matchActivityRoute, summarizeResponse } from "../src/http/activity.js";
import { ROUTINE_BODY_LIMIT_BYTES, createAgentServer, type AgentServer } from "../src/http/agent-server.js";
import { FakeBackend } from "./core/fakes.js";
import { canonical, minimal } from "./routines/fixtures.js";
import { schemaAccepts } from "./routines/jsonschema-lite.js";

type Res = { status: number; text: string; json: any };

function request(port: number, method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, method, path: urlPath, headers: { ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}), ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
          resolve({ status: res.statusCode ?? 0, text, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let dataDir: string;
let core: HelmstackCore;
let server: AgentServer;
let port: number;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "helmstack-routine-http-"));
  core = new HelmstackCore(new FakeBackend(), { dataDir, routineStore: { log: () => {} } });
  server = createAgentServer({ api: core, backend: "daemon", port: 0, authToken: null });
  await server.start();
  port = server.boundPort!;
});
afterAll(async () => {
  await server.stop();
  core.dispose();
  rmSync(dataDir, { recursive: true, force: true });
});

const as = (agent: string) => ({ "X-Agent-ID": agent });
const propose = (spec: unknown, agent = "agent-a", extra: Record<string, unknown> = {}) =>
  request(port, "POST", "/api/routines", { spec, ...extra }, as(agent));

describe("routine routes", () => {
  it("serves the schema, the limits and an example that validates against it", async () => {
    const res = await request(port, "GET", "/api/routines/schema");
    expect(res.status).toBe(200);
    expect(res.json.schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(res.json.limits).toMatchObject({ maxSteps: 60, maxNesting: 4, specBytes: 65536 });
    expect(schemaAccepts(res.json.schema, res.json.example)).toBe(true);
    const proposed = await propose(res.json.example);
    expect(proposed.status).toBe(201);
  });

  it("proposes: 201 with summary, preview, warnings and a clear next step", async () => {
    const spec = canonical() as any;  
    delete spec.stop;
    const res = await propose(spec);
    expect(res.status).toBe(201);
    const routine = res.json.routine as RoutineSummary;
    expect(routine).toMatchObject({ state: "proposed", proposedBy: "agent-a", trigger: "every 6 hours" });
    expect(res.json.preview.headline).toContain("news.example.com");
    expect(res.json.warnings[0]).toContain("no stop condition");
    expect(res.json.stepCount).toBe(13);
    expect(res.json.message).toMatch(/approve this routine in the HelmStack window/);
    // The routine is listed and readable.
    const list = await request(port, "GET", "/api/routines");
    expect(list.json.map((r: RoutineSummary) => r.id)).toContain(routine.id);
    const detail = await request(port, "GET", `/api/routines/${routine.id}`);
    expect(detail.status).toBe(200);
    expect(JSON.parse(detail.json.specJson).title).toBe(spec.title);
    expect(detail.json.state).toBe("proposed");
  });

  it("answers 400 with the error list for an invalid spec", async () => {
    const bad = canonical() as any;  
    bad.related.needs = "auto";
    bad.steps[3].steps[1].reject_below = 0.95;
    const res = await propose(bad);
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("invalid_routine_spec");
    // Deterministic traversal order: steps are checked before related.
    expect(res.json.errors).toEqual([
      { path: "steps[3].steps[1].reject_below", message: expect.stringContaining("accept_at") },
      { path: "related.needs", message: expect.stringContaining("human") }
    ]);
  });

  it("rejects malformed bodies", async () => {
    expect((await request(port, "POST", "/api/routines", "{ nope")).status).toBe(400);
    expect((await request(port, "POST", "/api/routines", {})).json.error).toMatch(/spec must be an object/);
    expect((await request(port, "POST", "/api/routines", { spec: [] })).status).toBe(400);
    expect((await request(port, "POST", "/api/routines", { spec: minimal(), extra: 1 })).json.error).toMatch(/unknown field "extra"/);
    expect((await request(port, "POST", "/api/routines", { spec: minimal(), replaces: 5 })).status).toBe(400);
    expect((await request(port, "POST", "/api/routines", { spec: minimal(), replaces: "rt-20990101-000000-00000000" })).status).toBe(404);
    expect((await request(port, "POST", "/api/routines", { spec: minimal(), replaces: "../x" })).status).toBe(400);
  });

  it("rejects an oversized body with 413", async () => {
    const huge = JSON.stringify({ spec: { intent: "x".repeat(ROUTINE_BODY_LIMIT_BYTES + 10) } });
    const res = await request(port, "POST", "/api/routines", huge).catch(() => ({ status: 413 }));
    expect(res.status).toBe(413);
  });

  it("rejects bad ids and unknown routines", async () => {
    expect((await request(port, "GET", "/api/routines/not-an-id")).status).toBe(400);
    expect((await request(port, "GET", "/api/routines/..%2f..%2fetc%2fpasswd")).status).toBe(400);
    expect((await request(port, "GET", "/api/routines/rt-20990101-000000-00000000")).status).toBe(404);
    expect((await request(port, "POST", "/api/routines/not-an-id/withdraw")).status).toBe(400);
    expect((await request(port, "POST", "/api/routines/rt-20990101-000000-00000000/withdraw")).status).toBe(404);
  });

  it("lets an agent withdraw only its own proposal, only while it is still proposed", async () => {
    const mine = (await propose(minimal(), "agent-w")).json.routine as RoutineSummary;
    const other = await request(port, "POST", `/api/routines/${mine.id}/withdraw`, undefined, as("agent-x"));
    expect(other.status).toBe(403);
    expect(core.getRoutine(mine.id)!.state).toBe("proposed");
    const ok = await request(port, "POST", `/api/routines/${mine.id}/withdraw`, undefined, as("agent-w"));
    expect(ok.status).toBe(200);
    expect(ok.json.state).toBe("rejected");
    const again = await request(port, "POST", `/api/routines/${mine.id}/withdraw`, undefined, as("agent-w"));
    expect(again.status).toBe(409);
    expect(again.json.error).toMatch(/Can't withdraw a routine that is rejected/);

    const approved = (await propose(minimal(), "agent-w")).json.routine as RoutineSummary;
    core.approveRoutine(approved.id); // the human, in the shell
    expect((await request(port, "POST", `/api/routines/${approved.id}/withdraw`, undefined, as("agent-w"))).status).toBe(409);
    expect(core.getRoutine(approved.id)!.state).toBe("approved");
  });

  it("has no HTTP route that approves, rejects, pauses, resumes, stops or deletes a routine", async () => {
    const { id } = (await propose(minimal())).json.routine as RoutineSummary;
    const attempts: Array<[string, string]> = [];
    for (const action of ["approve", "reject", "pause", "resume", "stop", "delete", "state", "withdraw/force"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "GET"]) attempts.push([method, `/api/routines/${id}/${action}`]);
    }
    for (const method of ["DELETE", "PUT", "PATCH"]) attempts.push([method, `/api/routines/${id}`], [method, "/api/routines"]);
    attempts.push(["POST", `/api/routines/${id}`], ["GET", "/api/routines/schema/x"], ["POST", "/api/routines/schema"]);
    for (const [method, url] of attempts) {
      const res = await request(port, method, url, method === "GET" ? undefined : {});
      expect(res.status, `${method} ${url}`).toBe(404);
    }
    // Still proposed: nothing above changed it.
    expect(core.getRoutine(id)!.state).toBe("proposed");
    // The agent server's types do not even include the human methods.
    const src = await import("node:fs").then((fs) => fs.readFileSync(path.resolve(__dirname, "../src/http/agent-server.ts"), "utf8"));
    expect(src).not.toMatch(/approveRoutine|rejectRoutine|pauseRoutine|resumeRoutine|stopRoutine|deleteRoutine/);
  });

  it("answers 501 when the backend has no routine slice", async () => {
    const bare = createAgentServer({
      api: { onTabsChanged() {}, onPageObserved() {}, onApprovalQueued() {}, onHandoffRequested() {}, onAssertionTransition() {}, listTabs: () => [] } as never,
      backend: "daemon",
      port: 0,
      authToken: null
    });
    await bare.start();
    try {
      for (const [method, url] of [["GET", "/api/routines"], ["GET", "/api/routines/schema"], ["POST", "/api/routines"]] as const) {
        const res = await request(bare.boundPort!, method, url, method === "POST" ? { spec: minimal() } : undefined);
        expect(res.status, url).toBe(501);
        expect(res.json.feature).toBe("routines");
      }
    } finally {
      await bare.stop();
    }
  });

  it("broadcasts routine_proposed and routine_state_changed with the summary only", async () => {
    const frames: string[] = [];
    let proposedId = "";
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/stream" }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          frames.push(chunk);
          if (chunk.includes(": connected")) {
            void propose(minimal(), "agent-s").then((r) => {
              proposedId = r.json.routine.id;
              core.approveRoutine(proposedId);
            });
          }
          const all = frames.join("");
          if (all.includes("event: routine_proposed") && all.includes("event: routine_state_changed")) {
            req.destroy();
            resolve();
          }
        });
      });
      req.on("error", (e) => { if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e); });
    });
    const events = frames.join("").split("\n\n").filter((f) => f.includes("event: routine_"));
    const [proposed, changed] = events.map((f) => ({ name: /event: (\S+)/.exec(f)![1], data: JSON.parse(f.split("data: ")[1]!) }));
    expect(proposed).toMatchObject({ name: "routine_proposed", data: { id: proposedId, state: "proposed" } });
    expect(changed).toMatchObject({ name: "routine_state_changed", data: { id: proposedId, state: "approved" } });
    expect(JSON.stringify(proposed!.data)).not.toContain("specJson");
    expect(proposed!.data.steps).toBeUndefined();
  });
});

describe("routine activity entries", () => {
  it("labels every routine route in sentence case, summarising with counts and fixed words only", () => {
    const route = (m: string, p: string) => matchActivityRoute(m, p);
    expect(route("GET", "/api/routines/schema")).toMatchObject({ label: "Read routine schema", route: "/api/routines/schema" });
    expect(route("POST", "/api/routines")).toMatchObject({ label: "Propose routine" });
    expect(route("GET", "/api/routines").label).toBe("List routines");
    expect(route("GET", "/api/routines/rt-20261017-093000-abcdef01")).toMatchObject({ label: "Read routine", route: "/api/routines/:id" });
    expect(route("POST", "/api/routines/rt-20261017-093000-abcdef01/withdraw")).toMatchObject({ label: "Withdraw routine", route: "/api/routines/:id/withdraw" });
    const find = (m: string, pattern: string) => ACTIVITY_ROUTES.find((r) => r.method === m && r.pattern === pattern)!;
    const response = { routine: { intent: "SECRET INTENT", title: "SECRET TITLE", preview: { headline: "SECRET" } }, stepCount: 12, warnings: ["SECRET"], message: "SECRET" };
    expect(summarizeResponse(find("POST", "/api/routines").summarize, response)).toBe("proposed · 12 steps");
    expect(summarizeResponse(find("POST", "/api/routines").summarize, { stepCount: 1 })).toBe("proposed · 1 step");
    expect(summarizeResponse(find("GET", "/api/routines").summarize, [{}, {}, {}])).toBe("3 routines");
    expect(summarizeResponse(find("POST", "/api/routines/:id/withdraw").summarize, { intent: "SECRET" })).toBe("withdrawn");
    for (const r of ACTIVITY_ROUTES.filter((x) => x.pattern.startsWith("/api/routines"))) {
      expect(r.label).toMatch(/^[A-Z][a-z]/);
      expect(r.label).not.toMatch(/[A-Z].*[A-Z]/);
    }
  });

  it("never records the intent, the title or the spec in the activity feed", async () => {
    const marker = "ZEBRA-MARKER-9137";
    const spec = minimal();
    spec.intent = `please watch ${marker}`;
    spec.title = `Title ${marker}`;
    const res = await propose(spec, "agent-act");
    expect(res.status).toBe(201);
    await request(port, "GET", `/api/routines/${res.json.routine.id}`);
    await request(port, "GET", "/api/routines");
    await request(port, "POST", `/api/routines/${res.json.routine.id}/withdraw`, undefined, as("agent-act"));
    const entries = server.listActivity().filter((e: AgentActivityEntry) => e.route.startsWith("/api/routines"));
    expect(entries.map((e: AgentActivityEntry) => e.label)).toEqual(expect.arrayContaining(["Propose routine", "Read routine", "List routines", "Withdraw routine"]));
    expect(JSON.stringify(entries)).not.toContain(marker);
    expect(entries.filter((e: AgentActivityEntry) => e.label === "Propose routine").at(-1)?.summary).toBe("proposed · 1 step");
    expect(entries.every((e: AgentActivityEntry) => !e.route.includes("rt-"))).toBe(true);
  });
});
