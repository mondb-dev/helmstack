import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CreateReportInput, ReportSummary, TabId } from "../../../shared/src/index.js";
import { HelmstackCore } from "../../src/core/helmstack-core.js";
import { ReportInputError, parseCreateReportInput } from "../../src/core/reports/report-input.js";
import { ReportStore, REPORT_ID_PATTERN, isValidReportId, newReportId } from "../../src/core/stores/report-store.js";
import { FakeBackend } from "./fakes.js";

let dataDir: string;
let backend: FakeBackend;
let core: HelmstackCore;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "helmstack-reports-"));
  backend = new FakeBackend();
});

afterEach(() => {
  core?.dispose();
  vi.useRealTimers();
  rmSync(dataDir, { recursive: true, force: true });
});

const A11Y = {
  tabId: "tab-1", url: "u", capturedAt: 1, score: 90, violations: [],
  violationCounts: { critical: 0, serious: 0, moderate: 0, minor: 0 },
  byPrinciple: { perceivable: 0, operable: 0, understandable: 0, robust: 0 },
  violatedRules: [], recommendations: [], passes: 10, nodeCount: 20
};

function setup(options: ConstructorParameters<typeof HelmstackCore>[1] extends infer O ? Partial<O> : never = {}) {
  const tab = backend.addTab("https://example.com/page?secret=1");
  core = new HelmstackCore(backend, { dataDir, reportCollectorTimeoutMs: 80, ...options });
  const session = (core as unknown as { sessions: Map<TabId, Record<string, unknown>> }).sessions.get(tab.id)!;
  // Deterministic collectors; individual tests override them.
  session.auditAccessibility = async () => A11Y;
  session.captureSeoAudit = async () => ({ score: 100, pass: true, issues: [], counts: { error: 0, warning: 0, info: 0 }, skipped: [] });
  session.detectLayoutIssues = async () => ({ tabId: tab.id, url: "u", capturedAt: 1, viewport: { width: 1280, height: 800 }, hasHorizontalOverflow: false, documentScrollWidth: 1280, issues: [] });
  session.capturePerformanceMetrics = async () => ({ tabId: tab.id, url: "u", capturedAt: 1, navigation: null, vitals: { lcp: 1000, fcp: 500, cls: 0, inp: null, ttfb: 100 }, slowResources: [], cdpMetrics: {} });
  session.captureScreenshot = async () => ({ tabId: tab.id, capturedAt: 1, data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]).toString("base64"), mimeType: "image/png", width: 1, height: 1 });
  return { tab, session };
}

const INPUT: CreateReportInput = {
  summary: "Looks fine.",
  findings: [{ title: "Low contrast", severity: "high", evidence: "ratio 2.1", recommendation: "Darken text" }],
  recommendations: ["Fix contrast"]
};

describe("createReport", () => {
  it("writes html + md + index, returns a summary, and emits a reports-changed event", async () => {
    const { tab } = setup();
    const events: Array<[number, ReportSummary | undefined]> = [];
    core.onReportsChanged((list, created) => events.push([list.length, created]));

    const result = await core.createReport(tab.id, INPUT, { agentId: "agent-9" });

    expect(REPORT_ID_PATTERN.test(result.report.id)).toBe(true);
    expect(result.report.author).toBe("agent-9");
    expect(result.report.findingCount).toBe(1);
    expect(result.report.evidence.sort()).toEqual(["accessibility", "health", "layout", "performance", "seo"]);
    expect(result.report.skipped).toEqual([]);
    expect(result.report.screenshot).toBe(true);
    expect(result.report.url).toBe("https://example.com/page");
    expect(result.path).toBe(path.join(dataDir, "reports", `${result.report.id}.html`));
    expect(readFileSync(result.path, "utf8")).toContain("Measured by HelmStack");
    expect(existsSync(path.join(dataDir, "reports", `${result.report.id}.md`))).toBe(true);
    expect(readdirSync(path.join(dataDir, "reports")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(core.listReports().map((r) => r.id)).toEqual([result.report.id]);
    expect(events).toEqual([[1, expect.objectContaining({ id: result.report.id })]]);
    expect(result.preview).toContain("Findings written by agent-9 (not verified by HelmStack)");
  });

  it("persists across a restart", async () => {
    const { tab } = setup();
    const { report } = await core.createReport(tab.id, INPUT);
    core.dispose();
    core = new HelmstackCore(new FakeBackend(), { dataDir });
    expect(core.listReports().map((r) => r.id)).toEqual([report.id]);
    expect(core.getReportFile(report.id, "md")?.bytes.toString("utf8")).toContain("Findings");
  });

  it("isolates a collector that throws or hangs and still writes the report", async () => {
    const { tab, session } = setup();
    session.auditAccessibility = async () => { throw new Error("CDP session closed\n    at secret/stack.js:1"); };
    session.captureSeoAudit = () => new Promise(() => {}); // never settles
    const started = Date.now();
    const { report, path: file } = await core.createReport(tab.id, INPUT);
    expect(Date.now() - started).toBeLessThan(2_000);

    const skipped = Object.fromEntries(report.skipped.map((s) => [s.kind, s.reason]));
    expect(skipped.accessibility).toBe("CDP session closed");
    expect(skipped.seo).toMatch(/timed out/);
    expect(report.evidence).toContain("layout");
    expect(report.evidence).toContain("performance");
    expect(report.evidence).not.toContain("accessibility");
    // health needed accessibility, so it falls back to its own collector; that one also ends up skipped here.
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("Not measured");
  });

  it("derives health from the other collectors instead of re-running them", async () => {
    const { tab, session } = setup();
    const spy = vi.spyOn(core, "captureHealthReport");
    const a11y = vi.fn(async () => A11Y);
    session.auditAccessibility = a11y;
    const { report } = await core.createReport(tab.id, { ...INPUT, include: ["health"], screenshot: false });
    expect(report.evidence).toEqual(["health"]);
    expect(report.screenshot).toBe(false);
    expect(a11y).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("survives a screenshot failure", async () => {
    const { tab, session } = setup();
    session.captureScreenshot = async () => { throw new Error("no surface"); };
    const { report } = await core.createReport(tab.id, { ...INPUT, include: ["accessibility"] });
    expect(report.screenshot).toBe(false);
    expect(report.evidence).toEqual(["accessibility"]);
  });

  it("rejects over-limit and malformed input instead of mangling it", async () => {
    const { tab } = setup();
    const bad: unknown[] = [
      { title: "x".repeat(121) },
      { summary: "x".repeat(4_001) },
      { findings: Array.from({ length: 51 }, () => ({ title: "t", severity: "low", recommendation: "r" })) },
      { findings: [{ title: "t", severity: "bogus", recommendation: "r" }] },
      { findings: [{ title: "t", severity: "low" }] },
      { findings: [{ title: "x".repeat(161), severity: "low", recommendation: "r" }] },
      { recommendations: Array.from({ length: 31 }, () => "r") },
      { recommendations: ["x".repeat(601)] },
      { include: ["cookies"] },
      { screenshot: "yes" },
      { author: "x".repeat(81) },
      { surprise: true },
      []
    ];
    for (const input of bad) {
      await expect(core.createReport(tab.id, input as CreateReportInput)).rejects.toBeInstanceOf(ReportInputError);
    }
    expect(core.listReports()).toEqual([]);
    const error = parseCreateReportInput({ findings: [{ title: "t", severity: "bogus", recommendation: "r" }] });
    expect(error).toEqual({ ok: false, error: expect.stringContaining("findings[0].severity") });
  });

  it("rejects an unknown tab", async () => {
    setup();
    await expect(core.createReport("nope" as TabId, INPUT)).rejects.toThrow(/Unknown tab/);
  });
});

describe("report files and ids", () => {
  it("serves files by validated id only and refuses path-like ids", async () => {
    const { tab } = setup();
    const { report } = await core.createReport(tab.id, INPUT);
    expect(core.getReportFile(report.id, "html")?.bytes.length).toBeGreaterThan(100);
    expect(core.getReportFile("20990101-000000-00000000", "html")).toBeNull();
    for (const bad of ["../x", "..%2fx", "..\\x", "/etc/passwd", `${report.id}/../index`, `${report.id}.html`, "", "index", `${report.id}\0`]) {
      expect(isValidReportId(bad), bad).toBe(false);
      expect(() => core.getReportFile(bad, "html"), bad).toThrow(ReportInputError);
      expect(() => core.deleteReport(bad), bad).toThrow(ReportInputError);
      expect(() => core.resolveReportPath(bad, "html"), bad).toThrow(ReportInputError);
    }
    expect(() => core.getReportFile(report.id, "../../x" as never)).toThrow(ReportInputError);
  });

  it("does not serve a well-formed id that is not in the index, even if a file exists", async () => {
    const { tab } = setup();
    await core.createReport(tab.id, INPUT);
    const stray = "20200101-000000-deadbeef";
    writeFileSync(path.join(dataDir, "reports", `${stray}.html`), "<html>stray</html>");
    expect(core.getReportFile(stray, "html")).toBeNull();
  });

  it("deletes a report (files, index) and emits an event without `created`", async () => {
    const { tab } = setup();
    const { report, path: file } = await core.createReport(tab.id, INPUT);
    const events: Array<ReportSummary | undefined> = [];
    core.onReportsChanged((_l, created) => events.push(created));
    expect(core.deleteReport(report.id)).toBe(true);
    expect(core.deleteReport(report.id)).toBe(false);
    expect(existsSync(file)).toBe(false);
    expect(core.listReports()).toEqual([]);
    expect(events).toEqual([undefined]);
  });
});

describe("ReportStore", () => {
  const summary = (n: number, sizeBytes = 10): ReportSummary => ({
    id: newReportId(Date.UTC(2026, 0, 1, 0, 0, n), () => String(n).padStart(8, "0").replace(/\d/g, (d) => "abcdef0123"[Number(d)]!)),
    title: `r${n}`, createdAt: Date.UTC(2026, 0, 1, 0, 0, n), tabId: "t", url: "https://e.com/", pageTitle: "p",
    findingCount: 0, severityCounts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    evidence: [], skipped: [], screenshot: false, formats: ["html", "md"], sizeBytes
  });

  it("generates filesystem-safe, sortable ids", () => {
    const id = newReportId(Date.UTC(2026, 9, 16, 10, 30, 5));
    expect(id).toMatch(REPORT_ID_PATTERN);
    expect(id.startsWith("20261016-103005-")).toBe(true);
  });

  it("keeps only the newest N reports and logs what it removed", () => {
    const log = vi.fn();
    const store = new ReportStore(dataDir, { maxReports: 2, log });
    for (let n = 1; n <= 4; n++) store.add(summary(n), { html: `h${n}`, md: `m${n}` });
    expect(store.list().map((r) => r.title)).toEqual(["r4", "r3"]);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]![0]).toMatch(/removed 1 oldest report/);
    const files = readdirSync(path.join(dataDir, "reports")).sort();
    expect(files).toHaveLength(5); // 2 reports x 2 files + index.json
    expect(files.filter((f) => f.endsWith(".html"))).toHaveLength(2);
  });

  it("caps total size but always keeps the newest report", () => {
    const store = new ReportStore(dataDir, { maxBytes: 100, log: () => {} });
    store.add(summary(1, 60), { html: "a", md: "a" });
    store.add(summary(2, 60), { html: "b", md: "b" });
    expect(store.list().map((r) => r.title)).toEqual(["r2"]);
    store.add(summary(3, 500), { html: "c", md: "c" });
    expect(store.list().map((r) => r.title)).toEqual(["r3"]);
  });

  it("recovers from a corrupt index and sweeps leftover temp files", () => {
    const first = new ReportStore(dataDir, { log: () => {} });
    first.add(summary(1), { html: "h", md: "m" });
    const dir = path.join(dataDir, "reports");
    writeFileSync(path.join(dir, "index.json"), "{ not json");
    writeFileSync(path.join(dir, "20260101-000009-aaaaaaaa.html.1234.tmp"), "partial");
    const second = new ReportStore(dataDir, { log: () => {} });
    expect(second.list()).toEqual([]);
    expect(readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("drops index entries whose file is gone", () => {
    const first = new ReportStore(dataDir, { log: () => {} });
    const s = summary(1);
    first.add(s, { html: "h", md: "m" });
    rmSync(path.join(dataDir, "reports", `${s.id}.html`));
    expect(new ReportStore(dataDir, { log: () => {} }).list()).toEqual([]);
  });

  it("refuses to store an invalid id", () => {
    const store = new ReportStore(dataDir, { log: () => {} });
    expect(() => store.add({ ...summary(1), id: "../evil" }, { html: "", md: "" })).toThrow();
  });
});
