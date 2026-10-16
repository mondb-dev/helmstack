/**
 * "Reports" tab of the right-hand panel: the page analysis reports an agent has
 * prepared. The shell never reads report contents; it lists summaries and asks
 * main to open, save, reveal or delete a file. Everything is rendered with
 * textContent, so agent-written titles and authors can never inject markup.
 */

import type { BrowserShellBridge, ReportFormat, ReportSeverity, ReportSummary } from "../../../../../packages/shared/src/index.js";
import { plural, relativeTime, truncateMiddle } from "../ui/format.js";
import { toast } from "../ui/toast.js";

export type ReportsBridge = Pick<
  BrowserShellBridge,
  "listReports" | "saveReportAs" | "openReport" | "revealReport" | "deleteReport" | "onReportsChanged"
>;

/** True when the preload bridge exposes every report method. */
export function reportsSupported(bridge: Partial<ReportsBridge>): bridge is ReportsBridge {
  return (
    typeof bridge.listReports === "function" &&
    typeof bridge.saveReportAs === "function" &&
    typeof bridge.openReport === "function" &&
    typeof bridge.revealReport === "function" &&
    typeof bridge.deleteReport === "function" &&
    typeof bridge.onReportsChanged === "function"
  );
}

export const REPORT_ROW_CAP = 100;
const SEVERITIES: Array<Exclude<ReportSeverity, "info">> = ["critical", "high", "medium", "low"];
const FORMAT_LABEL: Record<ReportFormat, string> = { html: "HTML", md: "Markdown" };
const TIME_REFRESH_MS = 30_000;

/** `/Users/me/Downloads` → `~/Downloads`; other paths are returned unchanged. */
export function shortenHome(path: string): string {
  return path.replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:[\\/]Users[\\/][^\\/]+)(?=[\\/]|$)/, "~");
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function dirName(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : "";
}

function pageLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return truncateMiddle(`${parsed.host}${path}`, 48);
  } catch {
    return truncateMiddle(url, 48);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ReportsOptions {
  bridge: ReportsBridge;
  root?: ParentNode;
  /** Whether the Reports tab is currently on screen (suppresses the unread count). */
  isVisible?: () => boolean;
  /** Called whenever the unread count changes. */
  onUnreadChange?: (count: number) => void;
  now?: () => number;
}

export interface ReportsController {
  refresh(): Promise<void>;
  handleChanged(reports: ReportSummary[], created?: ReportSummary): void;
  /** The tab was shown: clear unread and re-sync. */
  show(): void;
  unread(): number;
  destroy(): void;
}

export function mountReports(options: ReportsOptions): ReportsController {
  const { bridge } = options;
  const root = options.root ?? document;
  const found = root.querySelector<HTMLElement>("#reports-body");
  if (!found) throw new Error("Reports markup missing");
  const host: HTMLElement = found;
  const now = options.now ?? Date.now;

  let reports: ReportSummary[] = [];
  let unread = new Set<string>();
  const notified = new Set<string>();
  let confirming: string | null = null;

  const setUnread = (next: Set<string>): void => {
    const changed = next.size !== unread.size;
    unread = next;
    if (changed) options.onUnreadChange?.(unread.size);
  };

  const sorted = (): ReportSummary[] => [...reports].sort((a, b) => b.createdAt - a.createdAt);

  const save = async (report: ReportSummary, format: ReportFormat): Promise<void> => {
    try {
      const path = await bridge.saveReportAs(report.id, format);
      if (path === null || path === undefined) return;
      const dir = dirName(path);
      toast(`Saved ${baseName(path)}${dir ? ` to ${shortenHome(dir)}` : ""}`, "success");
    } catch (error) {
      toast(`Couldn't save the report — ${errorText(error)}`, "error");
    }
  };

  const run = async (action: () => Promise<void>, failure: string): Promise<void> => {
    try {
      await action();
    } catch (error) {
      toast(`${failure} — ${errorText(error)}`, "error");
    }
  };

  const focusAfterDelete = (index: number): void => {
    const rows = Array.from(host.querySelectorAll<HTMLElement>(".report-row"));
    const target = rows[Math.min(index, rows.length - 1)]?.querySelector<HTMLElement>("button");
    (target ?? host.querySelector<HTMLElement>(".reports__heading"))?.focus();
  };

  const remove = async (report: ReportSummary, index: number): Promise<void> => {
    confirming = null;
    try {
      await bridge.deleteReport(report.id);
    } catch (error) {
      toast(`Couldn't delete the report — ${errorText(error)}`, "error");
      render();
      return;
    }
    reports = reports.filter((candidate) => candidate.id !== report.id);
    if (unread.delete(report.id)) options.onUnreadChange?.(unread.size);
    render();
    focusAfterDelete(index);
  };

  const buildRow = (report: ReportSummary, index: number): HTMLLIElement => {
    const row = el("li", "report-row");
    row.dataset.reportId = report.id;
    row.append(el("h3", "report-row__title", report.title));

    const meta = el("p", "report-row__meta");
    meta.append(`${pageLabel(report.url)} · `);
    const time = el("time", undefined, relativeTime(report.createdAt, now()));
    time.dataset.at = String(report.createdAt);
    meta.append(time);
    row.append(meta);
    row.append(el("p", "report-row__meta", `Written by ${report.author?.trim() || "an agent"}`));

    const sev = el("ul", "report-row__sev");
    sev.setAttribute("aria-label", "Findings by severity");
    const shown = SEVERITIES.filter((level) => (report.severityCounts?.[level] ?? 0) > 0);
    if (shown.length === 0) {
      const none = el("li", "report-row__meta", report.findingCount > 0 ? plural(report.findingCount, "finding") : "No findings");
      sev.append(none);
    }
    for (const level of shown) {
      sev.append(el("li", `report-sev report-sev--${level}`, `${report.severityCounts[level]} ${level}`));
    }
    row.append(sev);

    const included = report.evidence.length > 0 ? report.evidence.join(", ") : "none";
    let evidence = `Measurements: ${included}`;
    if (report.skipped.length > 0) evidence += ` · not collected: ${report.skipped.map((item) => item.kind).join(", ")}`;
    row.append(el("p", "report-row__meta", evidence));

    const actions = el("div", "report-row__actions");
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", `Actions for ${report.title}`);

    if (confirming === report.id) {
      actions.append(el("p", "report-row__confirm", "Delete this report? This can't be undone."));
      const confirm = el("button", "btn btn--sm btn--danger", "Delete");
      confirm.type = "button";
      confirm.setAttribute("aria-label", `Confirm delete: ${report.title}`);
      confirm.addEventListener("click", () => void remove(report, index));
      const cancel = el("button", "btn btn--sm btn--quiet report-row__cancel", "Cancel");
      cancel.type = "button";
      cancel.addEventListener("click", () => {
        confirming = null;
        render();
        host.querySelector<HTMLElement>(`[data-report-id="${CSS.escape(report.id)}"] .report-row__delete`)?.focus();
      });
      actions.append(confirm, cancel);
      row.append(actions);
      return row;
    }

    const open = el("button", "btn btn--sm btn--primary", "Open");
    open.type = "button";
    open.setAttribute("aria-label", `Open report: ${report.title}`);
    open.addEventListener("click", () => void run(() => bridge.openReport(report.id), "Couldn't open the report"));

    const formats = report.formats.length > 0 ? report.formats : (["html"] as ReportFormat[]);
    const select = el("select", "report-row__format");
    select.setAttribute("aria-label", `Save format for ${report.title}`);
    for (const format of formats) {
      const option = el("option", undefined, FORMAT_LABEL[format]);
      option.value = format;
      select.append(option);
    }
    const saveButton = el("button", "btn btn--sm btn--ghost", "Save as…");
    saveButton.type = "button";
    saveButton.setAttribute("aria-label", `Save report as…: ${report.title}`);
    saveButton.addEventListener("click", () => void save(report, select.value as ReportFormat));

    const reveal = el("button", "btn btn--sm btn--quiet", "Show in folder");
    reveal.type = "button";
    reveal.setAttribute("aria-label", `Show in folder: ${report.title}`);
    reveal.addEventListener("click", () => void run(() => bridge.revealReport(report.id), "Couldn't show the report"));

    const del = el("button", "btn btn--sm btn--quiet report-row__delete", "Delete");
    del.type = "button";
    del.setAttribute("aria-label", `Delete report: ${report.title}`);
    del.addEventListener("click", () => {
      confirming = report.id;
      render();
      host.querySelector<HTMLElement>(`[data-report-id="${CSS.escape(report.id)}"] .report-row__cancel`)?.focus();
    });

    actions.append(open, select, saveButton, reveal, del);
    row.append(actions);
    return row;
  };

  function render(): void {
    const list = sorted();
    const children: HTMLElement[] = [];
    const heading = el("h3", "sr-only reports__heading", "Page analysis reports");
    heading.tabIndex = -1;
    children.push(heading);

    if (list.length === 0) {
      const empty = el("div", "reports__empty");
      empty.append(
        el("h3", "reports__empty-title", "No reports yet"),
        el(
          "p",
          undefined,
          "A report is a self-contained document with HelmStack's measurements of a page plus your agent's findings and recommendations."
        ),
        el("p", undefined, 'Ask your agent: "analyze this page and prepare a report". You can type that in the Chat tab or use any connected agent.')
      );
      children.push(empty);
    } else {
      children.push(
        el("p", "reports__intro", "Findings are written by an agent and are not verified by HelmStack.")
      );
      const ol = el("ol", "reports__list");
      ol.setAttribute("aria-label", "Reports, newest first");
      list.slice(0, REPORT_ROW_CAP).forEach((report, index) => ol.append(buildRow(report, index)));
      children.push(ol);
      if (list.length > REPORT_ROW_CAP) {
        children.push(
          el("p", "reports__footer", `Showing the newest ${REPORT_ROW_CAP} of ${list.length} reports.`)
        );
      }
    }
    host.replaceChildren(...children);
  }

  const handleChanged = (next: ReportSummary[], created?: ReportSummary): void => {
    reports = Array.isArray(next) ? next : [];
    const known = new Set(reports.map((report) => report.id));
    if (confirming && !known.has(confirming)) confirming = null;
    const kept = new Set([...unread].filter((id) => known.has(id)));
    if (created && !notified.has(created.id)) {
      notified.add(created.id);
      if (!(options.isVisible?.() ?? false)) kept.add(created.id);
      toast(`Report ready: ${created.title}`, "success", {
        actions: [
          { label: "Open", onClick: () => void run(() => bridge.openReport(created.id), "Couldn't open the report") },
          { label: "Save as…", onClick: () => void save(created, created.formats.includes("html") || created.formats.length === 0 ? "html" : created.formats[0]) },
        ],
      });
    }
    setUnread(kept);
    render();
  };

  const refresh = async (): Promise<void> => {
    try {
      reports = await bridge.listReports();
      if (!Array.isArray(reports)) reports = [];
    } catch {
      reports = [];
    }
    render();
  };

  const timer = setInterval(() => {
    host.querySelectorAll<HTMLElement>("time[data-at]").forEach((node) => {
      node.textContent = relativeTime(Number(node.dataset.at), now());
    });
  }, TIME_REFRESH_MS);

  const unsubscribe = bridge.onReportsChanged(handleChanged);
  render();
  void refresh();

  return {
    refresh,
    handleChanged,
    show() {
      setUnread(new Set());
      void refresh();
    },
    unread: () => unread.size,
    destroy() {
      clearInterval(timer);
      unsubscribe?.();
    },
  };
}
