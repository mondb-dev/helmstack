import { describe, expect, it, vi } from "vitest";

import type { ReportSummary } from "../../../packages/shared/src/index.js";
import {
  createReportIpc,
  defaultReportFileName,
  parseReportFormat,
  parseReportId,
  slugForFileName,
  type ReportIpcDeps
} from "../src/main/report-ipc.js";

const SHELL = { shell: true };
const ID = "20261016-103000-abcdef01";
const SUMMARY = { id: ID, title: "Page analysis: Pricing / Plans!", createdAt: Date.UTC(2026, 9, 16, 10, 30) } as ReportSummary;

function setup(over: Partial<ReportIpcDeps> = {}) {
  const deps = {
    core: {
      listReports: vi.fn(() => [SUMMARY]),
      resolveReportPath: vi.fn((id: string, format: string) => (id === ID ? `/data/reports/${id}.${format}` : null)),
      deleteReport: vi.fn(() => true)
    },
    isShellSender: (s: unknown) => s === SHELL,
    showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: "/home/me/out.html" })),
    openPath: vi.fn(async () => ""),
    showItemInFolder: vi.fn(),
    defaultDirectory: () => "/home/me/Downloads",
    copy: vi.fn(async () => {}),
    joinPath: (d: string, n: string) => `${d}/${n}`,
    ...over
  } satisfies ReportIpcDeps;
  return { deps, ipc: createReportIpc(deps) };
}

describe("report IPC", () => {
  it("builds a slugged, dated default file name", () => {
    expect(defaultReportFileName(SUMMARY, "html")).toBe("page-analysis-pricing-plans-2026-10-16.html");
    expect(defaultReportFileName(SUMMARY, "md")).toBe("page-analysis-pricing-plans-2026-10-16.md");
    expect(slugForFileName("../../etc/passwd")).toBe("etc-passwd");
    expect(slugForFileName("日本語")).toBe("report");
    expect(slugForFileName("a".repeat(200)).length).toBe(60);
  });

  it("validates ids and formats", () => {
    expect(parseReportId(ID)).toBe(ID);
    for (const bad of ["../x", "", 5, null, `${ID}/..`, "/etc/passwd"]) expect(() => parseReportId(bad)).toThrow();
    expect(parseReportFormat("md")).toBe("md");
    for (const bad of ["pdf", "html ", undefined, "../html"]) expect(() => parseReportFormat(bad)).toThrow();
  });

  it("refuses every action from a sender that is not the shell window", async () => {
    const { ipc, deps } = setup();
    const other = { shell: false };
    expect(() => ipc.list(other)).toThrow(/HelmStack window/);
    await expect(ipc.saveAs(other, ID, "html")).rejects.toThrow();
    await expect(ipc.open(other, ID)).rejects.toThrow();
    expect(() => ipc.reveal(other, ID)).toThrow();
    expect(() => ipc.delete(other, ID)).toThrow();
    expect(deps.showSaveDialog).not.toHaveBeenCalled();
    expect(deps.core.deleteReport).not.toHaveBeenCalled();
  });

  it("save-as shows a dialog with a default name and copies the stored file", async () => {
    const { ipc, deps } = setup();
    await expect(ipc.saveAs(SHELL, ID, "html")).resolves.toBe("/home/me/out.html");
    expect(deps.showSaveDialog).toHaveBeenCalledWith({
      defaultPath: "/home/me/Downloads/page-analysis-pricing-plans-2026-10-16.html",
      filters: [{ name: "HTML report", extensions: ["html"] }]
    });
    expect(deps.copy).toHaveBeenCalledWith(`/data/reports/${ID}.html`, "/home/me/out.html");
  });

  it("save-as resolves null and copies nothing when cancelled", async () => {
    const { ipc, deps } = setup({ showSaveDialog: vi.fn(async () => ({ canceled: true })) });
    await expect(ipc.saveAs(SHELL, ID, "md")).resolves.toBeNull();
    expect(deps.copy).not.toHaveBeenCalled();
  });

  it("never accepts a path from the renderer", async () => {
    const { ipc, deps } = setup();
    await expect(ipc.saveAs(SHELL, "/etc/passwd", "html")).rejects.toThrow("Invalid report id.");
    await expect(ipc.open(SHELL, "../../secret")).rejects.toThrow("Invalid report id.");
    expect(() => ipc.reveal(SHELL, "C:\\Windows\\win.ini")).toThrow("Invalid report id.");
    expect(deps.openPath).not.toHaveBeenCalled();
    expect(deps.showItemInFolder).not.toHaveBeenCalled();
  });

  it("opens and reveals only stored files, and reports unknown ids", async () => {
    const { ipc, deps } = setup();
    await ipc.open(SHELL, ID);
    expect(deps.openPath).toHaveBeenCalledWith(`/data/reports/${ID}.html`);
    ipc.reveal(SHELL, ID);
    expect(deps.showItemInFolder).toHaveBeenCalledWith(`/data/reports/${ID}.html`);
    await expect(ipc.open(SHELL, "20990101-000000-00000000")).rejects.toThrow(/no longer exists/);
  });

  it("surfaces an openPath failure without leaking the path", async () => {
    const { ipc } = setup({ openPath: vi.fn(async () => "No application knows how to open /secret/x") });
    await expect(ipc.open(SHELL, ID)).rejects.toThrow("Could not open the report.");
  });

  it("deletes by id", () => {
    const { ipc, deps } = setup();
    ipc.delete(SHELL, ID);
    expect(deps.core.deleteReport).toHaveBeenCalledWith(ID);
    expect(() => ipc.delete(SHELL, "x")).toThrow();
  });
});
