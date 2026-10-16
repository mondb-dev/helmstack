import * as http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ReportSummary, TabId } from "../../shared/src/index.js";
import { HelmstackCore } from "../src/core/helmstack-core.js";
import { ACTIVITY_ROUTES, matchActivityRoute } from "../src/http/activity.js";
import { REPORT_BODY_LIMIT_BYTES, createAgentServer, type AgentServer } from "../src/http/agent-server.js";
import { FakeBackend } from "./core/fakes.js";

type Res = { status: number; headers: http.IncomingHttpHeaders; text: string; json: any };

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
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
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
let tabId: TabId;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "helmstack-report-http-"));
  const backend = new FakeBackend();
  const tab = backend.addTab("https://example.com/");
  tabId = tab.id;
  core = new HelmstackCore(backend, { dataDir, reportCollectorTimeoutMs: 100, helmstackVersion: "9.9.9" });
  const session = (core as unknown as { sessions: Map<TabId, Record<string, unknown>> }).sessions.get(tab.id)!;
  session.auditAccessibility = async () => ({ tabId: tab.id, url: "u", capturedAt: 1, score: 88, violations: [], violationCounts: { critical: 0, serious: 0, moderate: 0, minor: 0 }, byPrinciple: {}, violatedRules: [], recommendations: [], passes: 1, nodeCount: 1 });
  session.captureScreenshot = async () => { throw new Error("headless"); };
  server = createAgentServer({ api: core, backend: "daemon", port: 0, authToken: null });
  await server.start();
  port = server.boundPort!;
});

afterAll(async () => {
  await server.stop();
  core.dispose();
  rmSync(dataDir, { recursive: true, force: true });
});

const body = { summary: "Fine.", findings: [{ title: "Low contrast", severity: "high", recommendation: "Darken" }], recommendations: ["Fix it"], include: ["accessibility"] };

describe("report routes", () => {
  it("creates a report, lists it, and downloads both formats as attachments", async () => {
    const created = await request(port, "POST", `/api/tabs/${tabId}/report`, body, { "X-Agent-ID": "tester" });
    expect(created.status).toBe(200);
    const report = created.json.report as ReportSummary;
    expect(report.author).toBe("tester");
    expect(report.evidence).toEqual(["accessibility"]);
    expect(created.json.path).toMatch(/\.html$/);

    const list = await request(port, "GET", "/api/reports");
    expect(list.json.map((r: ReportSummary) => r.id)).toContain(report.id);

    const html = await request(port, "GET", `/api/reports/${report.id}`);
    expect(html.status).toBe(200);
    expect(html.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(html.headers["content-disposition"]).toBe(`attachment; filename="helmstack-report-${report.id}.html"`);
    expect(html.headers["x-content-type-options"]).toBe("nosniff");
    expect(html.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(html.text).toContain("Written by tester; not verified by HelmStack");
    expect(html.text).toContain("HelmStack 9.9.9");

    const md = await request(port, "GET", `/api/reports/${report.id}?format=md`);
    expect(md.status).toBe(200);
    expect(md.headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(md.headers["content-disposition"]).toContain(".md");
    expect(md.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("answers 400 for limit violations with a message naming the field", async () => {
    for (const [input, fragment] of [
      [{ title: "x".repeat(500) }, "title"],
      [{ findings: [{ title: "t", severity: "nope", recommendation: "r" }] }, "findings[0].severity"],
      [{ include: ["cookies"] }, "include"],
      [{ extra: 1 }, "unknown field"]
    ] as const) {
      const res = await request(port, "POST", `/api/tabs/${tabId}/report`, input);
      expect(res.status).toBe(400);
      expect(res.json.error).toContain(fragment);
    }
    expect((await request(port, "POST", `/api/tabs/${tabId}/report`, "{ nope")).status).toBe(400);
  });

  it("rejects an oversized body with 413", async () => {
    const huge = JSON.stringify({ summary: "x".repeat(REPORT_BODY_LIMIT_BYTES + 10) });
    const res = await request(port, "POST", `/api/tabs/${tabId}/report`, huge).catch(() => ({ status: 413 }));
    expect(res.status).toBe(413);
  });

  it("rejects bad ids and formats, and unknown ids are 404", async () => {
    expect((await request(port, "GET", "/api/reports/..%2f..%2fetc%2fpasswd")).status).toBe(400);
    expect((await request(port, "GET", "/api/reports/not-an-id")).status).toBe(400);
    expect((await request(port, "GET", "/api/reports/20990101-000000-00000000")).status).toBe(404);
    expect((await request(port, "GET", "/api/reports/20990101-000000-00000000?format=pdf")).status).toBe(400);
  });

  it("has no agent route that deletes a report", async () => {
    const [{ id }] = (await request(port, "GET", "/api/reports")).json as ReportSummary[];
    for (const method of ["DELETE", "PUT", "PATCH", "POST"]) {
      const res = await request(port, method, `/api/reports/${id}`);
      expect(res.status, method).toBe(404);
    }
    expect((await request(port, "DELETE", "/api/reports")).status).toBe(404);
    expect(core.listReports().some((r) => r.id === id)).toBe(true);
  });

  it("broadcasts report_created over SSE", async () => {
    const events: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/stream" }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          events.push(chunk);
          if (chunk.includes(": connected")) {
            void request(port, "POST", `/api/tabs/${tabId}/report`, { include: [] });
          }
          if (events.join("").includes("event: report_created")) {
            req.destroy();
            resolve();
          }
        });
      });
      req.on("error", (e) => { if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e); });
    });
    const frame = events.join("").split("\n\n").find((f) => f.includes("event: report_created"))!;
    const data = JSON.parse(frame.split("data: ")[1]!) as ReportSummary;
    expect(data.tabId).toBe(tabId);
    expect(data.formats).toEqual(["html", "md"]);
  });
});

describe("report activity labels", () => {
  it("labels every report route in sentence case and summarises with counts only", () => {
    const create = matchActivityRoute("POST", `/api/tabs/${tabId}/report`);
    expect(create.label).toBe("Create report");
    expect(create.tabId).toBe(tabId);
    expect(matchActivityRoute("GET", "/api/reports").label).toBe("List reports");
    expect(matchActivityRoute("GET", "/api/reports/20261016-103000-abcdef01").label).toBe("Download report");
    expect(matchActivityRoute("GET", "/api/reports/20261016-103000-abcdef01").route).toBe("/api/reports/:id");
    const summarize = ACTIVITY_ROUTES.find((r) => r.pattern === "/api/tabs/:id/report")!.summarize!;
    expect(summarize({ report: { findingCount: 3, evidence: ["a", "b", "c", "d", "e"], title: "SECRET" }, path: "/secret" })).toBe("3 findings · 5 measurements");
  });
});
