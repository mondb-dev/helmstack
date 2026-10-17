import * as http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ROUTINE_LIBRARY_LIMITS, type AgentActivityEntry, type RoutineSpec } from "../../shared/src/index.js";
import { HelmstackCore } from "../src/core/helmstack-core.js";
import { LIBRARY_PROPOSALS_PER_MINUTE, createAgentServer, type AgentServer } from "../src/http/agent-server.js";
import { matchActivityRoute } from "../src/http/activity.js";
import { FakeBackend } from "./core/fakes.js";

type Res = { status: number; json: any };

function request(port: number, method: string, urlPath: string, body?: unknown, agent?: string, raw?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const headers: Record<string, string | number> = {};
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    if (agent) headers["X-Agent-ID"] = agent;
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const TITLE = "Secret-Title-9931";
const BODY = "Never drop protected players. SECRET-DOC-TEXT-4417 is the code word.";
const SPEC: RoutineSpec = {
  version: 1,
  title: "Library test",
  intent: "Judge with my rules",
  scope: { start: ["https://example.com/"], follow: { max_depth: 0 }, max_pages_per_run: 3 },
  trigger: { kind: "manual" },
  steps: [{ do: "open", url: "$scope.start[0]" }]
};

let dataDir: string;
let core: HelmstackCore;
let server: AgentServer;
let port: number;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "helmstack-routine-library-"));
  core = new HelmstackCore(new FakeBackend(), { dataDir, routineStore: { log: () => {}, maxRoutines: 50 }, routineEngine: { autoStart: false } });
  server = createAgentServer({ api: core, backend: "daemon", port: 0, authToken: null });
  await server.start();
  port = server.boundPort!;
});
afterAll(async () => {
  await server.stop();
  core.dispose();
  rmSync(dataDir, { recursive: true, force: true });
});

const newRoutine = () => core.proposeRoutine(SPEC).routine.id;
const lib = (id: string) => `/api/routines/${id}/library`;

describe("reference library over HTTP", () => {
  it("an agent can only propose: the document is stored as proposed and is not in use", async () => {
    const id = newRoutine();
    const res = await request(port, "POST", lib(id), { title: TITLE, text: BODY, source: "https://notes.example.com/a" }, "agent-a");
    expect(res.status).toBe(201);
    expect(res.json.document).toMatchObject({ routineId: id, title: TITLE, origin: "agent", status: "proposed", source: "https://notes.example.com/a" });
    expect(res.json.message).toMatch(/PROPOSES/);
    expect(res.json.message).toMatch(/approve it in the Routines tab/);
    expect(res.json.message).toMatch(/untrusted/);
    expect(core.getRoutineMemory(id).docs).toBe(0); // nothing active
    const docs = await request(port, "GET", lib(id));
    expect(docs.status).toBe(200);
    expect(docs.json).toHaveLength(1);
    expect(docs.json[0].excerpt).toContain("SECRET-DOC-TEXT-4417"); // an excerpt, as data
    expect(docs.json[0].text).toBeUndefined(); // never the full text
    core.approveRoutineDoc(id, docs.json[0].id);
    expect(core.getRoutineMemory(id).docs).toBe(1);
    expect(core.getRoutineDoc(id, docs.json[0].id)!.text).toBe(BODY);
  });

  it("agents cannot approve, activate, delete or read a document in full: those routes do not exist", async () => {
    const id = newRoutine();
    const doc = (await request(port, "POST", lib(id), { title: "A", text: "b" }, "agent-b")).json.document;
    const base = `${lib(id)}/${doc.id}`;
    for (const [method, p] of [
      ["GET", base],
      ["DELETE", base],
      ["PUT", base],
      ["PATCH", base],
      ["POST", `${base}/approve`],
      ["POST", `${lib(id)}/approve`],
      ["POST", `${base}/activate`],
      ["DELETE", lib(id)],
      ["PUT", lib(id)]
    ] as const) {
      const res = await request(port, method, p, method === "GET" || method === "DELETE" ? undefined : {}, "agent-b");
      expect([404, 405], `${method} ${p}`).toContain(res.status);
    }
    expect(core.listRoutineDocs(id)[0]).toMatchObject({ id: doc.id, status: "proposed" });
    const src = readFileSync(path.resolve(__dirname, "../src/http/agent-server.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(src).not.toMatch(/approveRoutineDoc|deleteRoutineDoc|addRoutineDoc|getRoutineDoc\b|listRoutineDocs/);
  });

  it("rejects bad ids, unknown routines, bad bodies and finished routines", async () => {
    const id = newRoutine();
    expect((await request(port, "POST", "/api/routines/nope/library", { title: "a", text: "b" })).status).toBe(400);
    expect((await request(port, "GET", "/api/routines/nope/library")).status).toBe(400);
    expect((await request(port, "POST", lib("rt-20200101-000000-deadbeef"), { title: "a", text: "b" })).status).toBe(404);
    expect((await request(port, "GET", lib("rt-20200101-000000-deadbeef"))).status).toBe(404);
    expect((await request(port, "POST", lib(id), undefined, "agent-c", "{not json")).status).toBe(400);
    expect((await request(port, "POST", lib(id), { title: "a" }, "agent-c")).status).toBe(400);
    expect((await request(port, "POST", lib(id), { title: 1, text: "b" }, "agent-c")).status).toBe(400);
    expect((await request(port, "POST", lib(id), { title: "a", text: "b", source: 3 }, "agent-c")).status).toBe(400);
    expect((await request(port, "POST", lib(id), { title: "a", text: "b", status: "active" }, "agent-c2")).status).toBe(400);
    expect((await request(port, "POST", lib(id), { title: "a", text: "b", origin: "human" }, "agent-c2")).status).toBe(400);
    expect((await request(port, "POST", lib(id), { title: "", text: "b" }, "agent-c2")).status).toBe(400);
    expect(core.listRoutineDocs(id)).toEqual([]);
    core.rejectRoutine(id);
    const res = await request(port, "POST", lib(id), { title: "a", text: "b" }, "agent-c3");
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/rejected routine/);
  });

  it("allows a proposal while the routine is approved or paused", async () => {
    const id = newRoutine();
    core.approveRoutine(id);
    expect((await request(port, "POST", lib(id), { title: "a1", text: "b1" }, "agent-d")).status).toBe(201);
    core.pauseRoutine(id);
    expect((await request(port, "POST", lib(id), { title: "a2", text: "b2" }, "agent-d")).status).toBe(201);
    core.stopRoutine(id);
    expect((await request(port, "POST", lib(id), { title: "a3", text: "b3" }, "agent-d")).status).toBe(409);
  });

  it("caps the body size, the document size and the proposals waiting for review", async () => {
    const id = newRoutine();
    // The server refuses an oversized body and closes the connection; on Windows the client can see a reset instead of the 413.
    const big = await request(port, "POST", lib(id), { title: "a", text: "x".repeat(200 * 1024) }, "agent-e").catch(() => ({ status: 413 }));
    expect(big.status).toBe(413);
    const long = await request(port, "POST", lib(id), { title: "a", text: "x".repeat(ROUTINE_LIBRARY_LIMITS.docChars + 1) }, "agent-e");
    expect(long.status).toBe(409);
    expect(long.json.error).toMatch(/limit/);
    expect(core.listRoutineDocs(id)).toEqual([]);
    // Fill the pending slots with several agents (each agent has its own rate allowance).
    for (let i = 0; i < ROUTINE_LIBRARY_LIMITS.pendingPerRoutine; i++) {
      const res = await request(port, "POST", lib(id), { title: `p${i}`, text: `text ${i}` }, `filler-${Math.floor(i / 3)}`);
      expect(res.status, `proposal ${i}`).toBe(201);
    }
    const over = await request(port, "POST", lib(id), { title: "one too many", text: "x" }, "filler-9");
    expect(over.status).toBe(409);
    expect(over.json.error).toMatch(/waiting for the user's review/);
    // The human can still add one, and deleting a proposal frees a slot.
    expect(() => core.addRoutineDoc(id, { title: "mine", text: "mine" })).not.toThrow();
    core.deleteRoutineDoc(id, core.listRoutineDocs(id).find((d) => d.title === "p0")!.id);
    expect((await request(port, "POST", lib(id), { title: "fits now", text: "x" }, "filler-9")).status).toBe(201);
  });

  it("rate limits each agent", async () => {
    const id = newRoutine();
    for (let i = 0; i < LIBRARY_PROPOSALS_PER_MINUTE; i++) {
      expect((await request(port, "POST", lib(id), { title: `r${i}`, text: `t${i}` }, "chatty")).status).toBe(201);
    }
    const limited = await request(port, "POST", lib(id), { title: "r-over", text: "t" }, "chatty");
    expect(limited.status).toBe(429);
    expect((await request(port, "POST", lib(id), { title: "other agent", text: "t" }, "quiet")).status).toBe(201);
  });

  it("broadcasts routine_library with ids and a status only, and the activity feed never holds a title or text", async () => {
    const id = newRoutine();
    const frames: string[] = [];
    let docId = "";
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/stream" }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          frames.push(chunk);
          if (chunk.includes(": connected")) {
            void request(port, "POST", lib(id), { title: TITLE, text: BODY }, "agent-f").then((r) => {
              docId = r.json.document.id;
              core.approveRoutineDoc(id, docId);
              core.deleteRoutineDoc(id, docId);
            });
          }
          if (frames.join("").includes('"status":"removed"')) {
            req.destroy();
            resolve();
          }
        });
      });
      req.on("error", (e) => { if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e); });
    });
    const all = frames.join("");
    const events = all.split("\n\n").filter((f) => f.includes("event: routine_library")).map((f) => JSON.parse(f.split("data: ")[1]!));
    expect(events.map((e) => e.status)).toEqual(["proposed", "active", "removed"]);
    for (const e of events) {
      expect(Object.keys(e).sort()).toEqual(["docId", "routineId", "status"]);
      expect(e).toMatchObject({ routineId: id, docId });
    }
    expect(all).not.toContain(TITLE);
    expect(all).not.toContain("SECRET-DOC-TEXT-4417");

    expect(matchActivityRoute("POST", lib(id))).toMatchObject({ label: "Propose routine reference", route: "/api/routines/:id/library" });
    expect(matchActivityRoute("GET", lib(id))).toMatchObject({ label: "List routine references" });
    await request(port, "GET", lib(id));
    const entries = server.listActivity().filter((e: AgentActivityEntry) => e.route.startsWith("/api/routines/:id/library"));
    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).not.toContain(TITLE);
    expect(JSON.stringify(entries)).not.toContain("SECRET-DOC-TEXT-4417");
    expect(JSON.stringify(entries)).not.toContain("Never drop");
    expect(entries.find((e) => e.label === "Propose routine reference")?.summary).toBe("proposed");
  });

  it("serves the library example next to the others", async () => {
    const res = await request(port, "GET", "/api/routines/schema");
    expect(res.json.libraryExample.steps.some((s: { do: string }) => s.do === "for_each")).toBe(true);
    const ok = await request(port, "POST", "/api/routines", { spec: res.json.libraryExample });
    expect(ok.status).toBe(201);
    expect(ok.json.routine.preview.risks.map((r: { code: string }) => r.code)).toContain("uses_library");
    expect(res.json.limits.recallTopK).toBe(5);
    expect(res.json.limits.rememberChars).toBe(2000);
  });
});
