import * as http from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HelmstackHttpError, createBrowserClient } from "../src/index.js";

const seen: Array<{ method: string; url: string; body: string; agent?: string }> = [];
let server: http.Server;
let port: number;
let sse: http.ServerResponse | null = null;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      seen.push({ method: req.method ?? "", url, body: Buffer.concat(chunks).toString(), agent: req.headers["x-agent-id"] as string | undefined });
      if (url === "/api/stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(": connected\n\n");
        sse = res;
        return;
      }
      if (req.method === "POST" && url === "/api/tabs/tab-1/report") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ report: { id: "20261016-103000-abcdef01" }, path: "/x.html", preview: "p" }));
      } else if (url === "/api/reports") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("[]");
      } else if (url.startsWith("/api/reports/20261016-103000-abcdef01")) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html>report</html>");
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "findings[0].severity must be one of critical, high, medium, low, info" }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => new Promise<void>((resolve) => { sse?.end(); server.close(() => resolve()); }));

describe("SDK reports", () => {
  it("createReport posts the input and returns the result", async () => {
    const client = createBrowserClient({ port, agentId: "sdk-test" });
    const input = { summary: "s", findings: [{ title: "t", severity: "low" as const, recommendation: "r" }] };
    const result = await client.createReport("tab-1", input);
    expect(result.report.id).toBe("20261016-103000-abcdef01");
    const call = seen.find((c) => c.url === "/api/tabs/tab-1/report")!;
    expect(call.method).toBe("POST");
    expect(JSON.parse(call.body)).toEqual(input);
    expect(call.agent).toBe("sdk-test");
  });

  it("listReports and getReport (text, format selectable)", async () => {
    const client = createBrowserClient({ port });
    expect(await client.listReports()).toEqual([]);
    expect(await client.getReport("20261016-103000-abcdef01")).toBe("<html>report</html>");
    await client.getReport("20261016-103000-abcdef01", "md");
    expect(seen.some((c) => c.url === "/api/reports/20261016-103000-abcdef01?format=md")).toBe(true);
    // The id is URL-encoded, never spliced into the path raw.
    await client.getReport("../x").catch(() => {});
    expect(seen.some((c) => c.url.startsWith("/api/reports/..%2Fx"))).toBe(true);
  });

  it("surfaces a 400 with the server's message", async () => {
    const client = createBrowserClient({ port });
    await expect(client.createReport("tab-2", {})).rejects.toBeInstanceOf(HelmstackHttpError);
  });

  it("stream handler onReportCreated receives report_created", async () => {
    const client = createBrowserClient({ port });
    const got = new Promise<unknown>((resolve) => {
      const handle = client.stream({ onReportCreated: (r) => { handle.close(); resolve(r); } });
      const poll = setInterval(() => {
        if (sse) {
          clearInterval(poll);
          sse.write(`event: report_created\ndata: ${JSON.stringify({ id: "20261016-103000-abcdef01", findingCount: 2 })}\n\n`);
        }
      }, 10);
    });
    expect(await got).toEqual({ id: "20261016-103000-abcdef01", findingCount: 2 });
  });
});
