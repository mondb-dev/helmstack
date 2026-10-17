import * as http from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HelmstackHttpError, createBrowserClient } from "../src/index.js";

const seen: Array<{ method: string; url: string; body: string; agent?: string }> = [];
let server: http.Server;
let port: number;
let sse: http.ServerResponse | null = null;
const ID = "rt-20261017-093000-abcdef01";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      seen.push({ method: req.method ?? "", url, body: Buffer.concat(chunks).toString(), agent: req.headers["x-agent-id"] as string | undefined });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url === "/api/stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(": connected\n\n");
        sse = res;
        return;
      }
      if (req.method === "GET" && url === "/api/routines/schema") return send(200, { schema: { type: "object" }, example: {}, limits: { maxSteps: 60 } });
      if (req.method === "POST" && url === "/api/routines") {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { spec: { title?: string } };
        if (!body.spec.title) return send(400, { error: "bad", errors: [{ path: "title", message: "is required" }] });
        return send(201, { routine: { id: ID, state: "proposed" }, preview: { headline: "h", lines: [], risks: [] }, warnings: [], stepCount: 1, message: "m" });
      }
      if (req.method === "GET" && url === "/api/routines") return send(200, [{ id: ID }]);
      if (req.method === "GET" && url === `/api/routines/${ID}`) return send(200, { id: ID, specJson: "{}" });
      if (req.method === "POST" && url === `/api/routines/${ID}/withdraw`) return send(200, { id: ID, state: "rejected" });
      if (req.method === "POST" && url === `/api/routines/${ID}/library`) return send(201, { document: { id: "doc-abc123-0123abcd", status: "proposed" }, message: "m" });
      if (req.method === "GET" && url === `/api/routines/${ID}/library`) return send(200, [{ id: "doc-abc123-0123abcd", status: "proposed" }]);
      return send(404, { error: "Not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => new Promise<void>((resolve) => { sse?.end(); server.close(() => resolve()); }));

describe("SDK routines", () => {
  it("proposes and lists reference documents; there is no approve or delete method", async () => {
    const client = createBrowserClient({ port, agentId: "sdk-library" });
    const out = await client.addRoutineReference(ID, { title: "Rules", text: "Never drop X.", source: "notes" });
    expect(out.document.status).toBe("proposed");
    const post = seen.find((c) => c.method === "POST" && c.url === `/api/routines/${ID}/library`)!;
    expect(JSON.parse(post.body)).toEqual({ title: "Rules", text: "Never drop X.", source: "notes" });
    expect(post.agent).toBe("sdk-library");
    expect((await client.listRoutineReferences(ID))[0]!.status).toBe("proposed");
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(client)).filter((n) => /reference|Doc|library/i.test(n));
    expect(methods.sort()).toEqual(["addRoutineReference", "listRoutineReferences"]);
  });

  it("reads the schema, proposes, lists, reads and withdraws", async () => {
    const client = createBrowserClient({ port, agentId: "sdk-routines" });
    expect((await client.getRoutineSchema()).limits.maxSteps).toBe(60);
    const out = await client.proposeRoutine({ title: "t" }, { replaces: ID });
    expect(out.routine.id).toBe(ID);
    const post = seen.find((c) => c.method === "POST" && c.url === "/api/routines")!;
    expect(JSON.parse(post.body)).toEqual({ spec: { title: "t" }, replaces: ID });
    expect(post.agent).toBe("sdk-routines");
    expect((await client.listRoutines())[0]!.id).toBe(ID);
    expect((await client.getRoutine(ID)).id).toBe(ID);
    expect((await client.withdrawRoutine(ID)).state).toBe("rejected");
  });

  it("omits replaces when not given, and surfaces a 400 error list", async () => {
    const client = createBrowserClient({ port });
    await client.proposeRoutine({ title: "t" });
    const last = seen.filter((c) => c.url === "/api/routines" && c.method === "POST").at(-1)!;
    expect(JSON.parse(last.body)).toEqual({ spec: { title: "t" } });
    const err = await client.proposeRoutine({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HelmstackHttpError);
    expect((err as HelmstackHttpError).status).toBe(400);
    expect(JSON.parse((err as HelmstackHttpError).body).errors[0].path).toBe("title");
  });

  it("has no method that approves, stops or deletes a routine", () => {
    const client = createBrowserClient({ port }) as unknown as Record<string, unknown>;
    for (const name of ["approveRoutine", "rejectRoutine", "pauseRoutine", "resumeRoutine", "stopRoutine", "deleteRoutine"]) {
      expect(client[name], name).toBeUndefined();
    }
  });

  it("delivers routine stream events to handlers", async () => {
    const client = createBrowserClient({ port });
    const got: string[] = [];
    await new Promise<void>((resolve) => {
      const handle = client.stream({
        onRoutineProposed: (r) => got.push(`proposed:${r.id}`),
        onRoutineStateChanged: (r) => {
          got.push(`changed:${r.state}`);
          handle.close();
          resolve();
        }
      });
      const poll = setInterval(() => {
        if (!sse) return;
        clearInterval(poll);
        sse.write(`event: routine_proposed\ndata: ${JSON.stringify({ id: ID, state: "proposed" })}\n\n`);
        sse.write(`event: routine_state_changed\ndata: ${JSON.stringify({ id: ID, state: "approved" })}\n\n`);
      }, 10);
    });
    expect(got).toEqual([`proposed:${ID}`, "changed:approved"]);
  });
});
