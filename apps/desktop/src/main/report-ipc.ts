/**
 * Shell-side report actions (save as, open, reveal, delete, list).
 *
 * The renderer only ever sends a report id and a format. Both are validated
 * here, the file is resolved from the core's index (never from a renderer
 * path), and the sender must be the shell window. Electron APIs are injected so
 * the logic is unit-testable.
 */
import { copyFile } from "node:fs/promises";

import type { ReportFormat, ReportSummary } from "../../../../packages/shared/src/index.js";
import { isValidReportId } from "../../../../packages/devtools-core/src/core/stores/report-store.js";

export type ReportIpcDeps = {
  core: {
    listReports(): ReportSummary[];
    resolveReportPath(id: string, format: ReportFormat): string | null;
    deleteReport(id: string): boolean;
  };
  /** True when the IPC sender is the shell window's own renderer. */
  isShellSender(sender: unknown): boolean;
  showSaveDialog(options: { defaultPath: string; filters: Array<{ name: string; extensions: string[] }> }): Promise<{ canceled: boolean; filePath?: string }>;
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
  /** Directory the save dialog starts in (e.g. the user's Downloads). */
  defaultDirectory(): string;
  copy?: (from: string, to: string) => Promise<void>;
  joinPath(dir: string, name: string): string;
};

/** Lower-case ASCII slug for a default file name; never empty. */
export function slugForFileName(text: string, max = 60): string {
  const slug = text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "report";
}

export function defaultReportFileName(summary: Pick<ReportSummary, "title" | "createdAt">, format: ReportFormat): string {
  const date = new Date(Number.isFinite(summary.createdAt) ? summary.createdAt : 0).toISOString().slice(0, 10);
  return `${slugForFileName(summary.title)}-${date}.${format}`;
}

export function parseReportId(value: unknown): string {
  if (!isValidReportId(value)) throw new Error("Invalid report id.");
  return value;
}

export function parseReportFormat(value: unknown): ReportFormat {
  if (value !== "html" && value !== "md") throw new Error("Invalid report format.");
  return value;
}

export function createReportIpc(deps: ReportIpcDeps) {
  const copy = deps.copy ?? ((from: string, to: string) => copyFile(from, to));
  const guard = (sender: unknown): void => {
    if (!deps.isShellSender(sender)) throw new Error("Reports are only available from the HelmStack window.");
  };
  const stored = (id: string, format: ReportFormat): string => {
    const file = deps.core.resolveReportPath(id, format);
    if (!file) throw new Error("That report no longer exists.");
    return file;
  };
  const summaryOf = (id: string): ReportSummary => {
    const found = deps.core.listReports().find((r) => r.id === id);
    if (!found) throw new Error("That report no longer exists.");
    return found;
  };

  return {
    list(sender: unknown): ReportSummary[] {
      guard(sender);
      return deps.core.listReports();
    },

    async saveAs(sender: unknown, rawId: unknown, rawFormat: unknown): Promise<string | null> {
      guard(sender);
      const id = parseReportId(rawId);
      const format = parseReportFormat(rawFormat);
      const source = stored(id, format);
      const summary = summaryOf(id);
      const result = await deps.showSaveDialog({
        defaultPath: deps.joinPath(deps.defaultDirectory(), defaultReportFileName(summary, format)),
        filters: [
          format === "html"
            ? { name: "HTML report", extensions: ["html"] }
            : { name: "Markdown report", extensions: ["md"] }
        ]
      });
      if (result.canceled || !result.filePath) return null;
      await copy(source, result.filePath);
      return result.filePath;
    },

    async open(sender: unknown, rawId: unknown): Promise<void> {
      guard(sender);
      const file = stored(parseReportId(rawId), "html");
      const error = await deps.openPath(file);
      if (error) throw new Error("Could not open the report.");
    },

    reveal(sender: unknown, rawId: unknown): void {
      guard(sender);
      deps.showItemInFolder(stored(parseReportId(rawId), "html"));
    },

    delete(sender: unknown, rawId: unknown): void {
      guard(sender);
      deps.core.deleteReport(parseReportId(rawId));
    }
  };
}
