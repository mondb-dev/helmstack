import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReportSummary } from "../../../packages/shared/src/index.js";
import { REPORT_ROW_CAP, baseName, mountReports, reportsSupported, shortenHome } from "../src/renderer/panels/reports.js";
import { SIDE_TAB_STORAGE_KEY, mountSideTabs } from "../src/renderer/panels/side-tabs.js";
import { humanizeToolName } from "../src/renderer/ui/chat-tools.js";
import { createFakeBridge, flush, loadShellDom } from "./helpers/shell-fixtures.js";

let seq = 0;
function report(partial: Partial<ReportSummary> = {}): ReportSummary {
  seq += 1;
  return {
    id: `r${seq}`,
    title: `Report ${seq}`,
    createdAt: 1_700_000_000_000 + seq * 1000,
    tabId: "tab-1",
    url: "https://example.com/pricing/plans",
    pageTitle: "Pricing",
    author: "Claude Code",
    findingCount: 3,
    severityCounts: { critical: 1, high: 0, medium: 2, low: 0, info: 0 },
    evidence: ["accessibility", "seo"],
    skipped: [],
    screenshot: true,
    formats: ["html", "md"],
    sizeBytes: 1000,
    ...partial,
  };
}

function setup(initial: ReportSummary[] = [], overrides: Record<string, (...args: never[]) => unknown> = {}) {
  const fake = createFakeBridge({ listReports: () => initial, ...overrides });
  const unread = vi.fn();
  const isVisible = vi.fn(() => false);
  const ctrl = mountReports({ bridge: fake.bridge, onUnreadChange: unread, isVisible });
  return { fake, ctrl, unread, isVisible };
}

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".report-row"));
const button = (row: HTMLElement, label: string): HTMLButtonElement =>
  Array.from(row.querySelectorAll("button")).find((b) => b.textContent === label)!;

describe("reports panel", () => {
  beforeEach(() => {
    loadShellDom();
    document.getElementById("toast-region")?.remove();
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it("shortens home directories", () => {
    expect(shortenHome("/Users/mon/Downloads")).toBe("~/Downloads");
    expect(shortenHome("/home/mon/x")).toBe("~/x");
    expect(shortenHome("C:\\Users\\Mon\\Documents")).toBe("~\\Documents");
    expect(shortenHome("/var/tmp")).toBe("/var/tmp");
    expect(baseName("C:\\Users\\Mon\\r.html")).toBe("r.html");
  });

  it("feature-detects the bridge", () => {
    expect(reportsSupported({})).toBe(false);
    expect(reportsSupported(createFakeBridge().bridge)).toBe(true);
  });

  it("renders newest first with counts, author, measurements and accessible actions", async () => {
    const old = report({ title: "Old" });
    const fresh = report({ title: "Fresh" });
    setup([old, fresh]);
    await flush();
    const list = rows();
    expect(list.map((r) => r.querySelector("h3")!.textContent)).toEqual(["Fresh", "Old"]);
    const text = list[0].textContent!;
    expect(text).toContain("example.com/pricing/plans");
    expect(text).toContain("Written by Claude Code");
    expect(text).toContain("1 critical");
    expect(text).toContain("2 medium");
    expect(text).not.toContain("0 high");
    expect(text).toContain("accessibility, seo");
    expect(button(list[0], "Open").getAttribute("aria-label")).toContain("Fresh");
  });

  it("shows an empty state that explains how to get a report", async () => {
    setup([]);
    await flush();
    const text = document.getElementById("reports-body")!.textContent!;
    expect(text).toContain("analyze this page and prepare a report");
    expect(text).toContain("Chat tab");
  });

  it("caps rendered rows", async () => {
    const many = Array.from({ length: REPORT_ROW_CAP + 5 }, () => report());
    setup(many);
    await flush();
    expect(rows()).toHaveLength(REPORT_ROW_CAP);
    expect(document.querySelector(".reports__footer")!.textContent).toContain(String(REPORT_ROW_CAP + 5));
  });

  it("never injects HTML from titles or authors", async () => {
    setup([report({ title: "<img src=x onerror=alert(1)>", author: "<b>evil</b>" })]);
    await flush();
    expect(document.querySelector("#reports-body img")).toBeNull();
    expect(document.querySelector("#reports-body b")).toBeNull();
    expect(rows()[0].textContent).toContain("<img src=x");
  });

  it("wires open and show in folder", async () => {
    const r = report();
    const { fake } = setup([r]);
    await flush();
    button(rows()[0], "Open").click();
    button(rows()[0], "Show in folder").click();
    expect(fake.fn("openReport")).toHaveBeenCalledWith(r.id);
    expect(fake.fn("revealReport")).toHaveBeenCalledWith(r.id);
  });

  it("saves as HTML by default, Markdown on choice, and toasts a ~-shortened location", async () => {
    const r = report();
    const { fake } = setup([r], { saveReportAs: () => "/Users/mon/Downloads/report.md" });
    await flush();
    button(rows()[0], "Save as…").click();
    expect(fake.fn("saveReportAs")).toHaveBeenLastCalledWith(r.id, "html");
    await flush();
    const msg = document.querySelector(".toast--success .toast__message")!.textContent!;
    expect(msg).toBe("Saved report.md to ~/Downloads");
    expect(msg).not.toContain("/Users/mon");
    const select = rows()[0].querySelector("select")!;
    select.value = "md";
    button(rows()[0], "Save as…").click();
    expect(fake.fn("saveReportAs")).toHaveBeenLastCalledWith(r.id, "md");
  });

  it("shows nothing when the save dialog is cancelled", async () => {
    const { fake } = setup([report()], { saveReportAs: () => null });
    await flush();
    button(rows()[0], "Save as…").click();
    await flush();
    expect(fake.fn("saveReportAs")).toHaveBeenCalled();
    expect(document.querySelector(".toast")).toBeNull();
  });

  it("confirms deletes inline, can cancel back to the delete button, and moves focus after deleting", async () => {
    const a = report({ title: "A" });
    const b = report({ title: "B" });
    const { fake } = setup([a, b]);
    await flush();
    // Newest first: B then A.
    button(rows()[0], "Delete").click();
    expect(fake.fn("deleteReport")).not.toHaveBeenCalled();
    expect(document.activeElement?.textContent).toBe("Cancel");
    (document.activeElement as HTMLElement).click();
    expect(document.activeElement?.classList.contains("report-row__delete")).toBe(true);

    button(rows()[0], "Delete").click();
    const confirm = Array.from(rows()[0].querySelectorAll("button")).find((x) => x.textContent === "Delete")!;
    confirm.click();
    await flush();
    expect(fake.fn("deleteReport")).toHaveBeenCalledWith(b.id);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].contains(document.activeElement)).toBe(true);
  });

  it("raises a toast with actions once and tracks unread until the tab is shown", async () => {
    const { fake, ctrl, unread } = setup([]);
    await flush();
    const created = report({ title: "Fresh one" });
    fake.emit("onReportsChanged", [created]);
    fake.emit("onReportsChanged", [created]); // not created=… again
    // handleChanged with created twice must not double-toast
    ctrl.handleChanged([created], created);
    ctrl.handleChanged([created], created);
    expect(document.querySelectorAll(".toast")).toHaveLength(1);
    const toastNode = document.querySelector(".toast")!;
    expect(toastNode.querySelector(".toast__message")!.textContent).toBe("Report ready: Fresh one");
    expect(toastNode.contains(document.activeElement)).toBe(false);
    expect(ctrl.unread()).toBe(1);
    expect(unread).toHaveBeenLastCalledWith(1);
    (toastNode.querySelectorAll(".toast__action")[0] as HTMLButtonElement).click();
    expect(fake.fn("openReport")).toHaveBeenCalledWith(created.id);
    ctrl.show();
    expect(ctrl.unread()).toBe(0);
    expect(unread).toHaveBeenLastCalledWith(0);
  });

  it("does not count unread when the tab is already visible", async () => {
    const { ctrl, isVisible } = setup([]);
    isVisible.mockReturnValue(true);
    const created = report();
    ctrl.handleChanged([created], created);
    expect(ctrl.unread()).toBe(0);
  });
});

describe("side tabs: reports", () => {
  beforeEach(() => {
    loadShellDom();
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it("hides the Reports tab when the bridge lacks reports and ignores a stored selection", () => {
    localStorage.setItem(SIDE_TAB_STORAGE_KEY, "reports");
    const tabs = mountSideTabs();
    expect(document.getElementById("side-tab-reports")!.hidden).toBe(true);
    expect(tabs.selected()).toBe("activity");
  });

  it("selects, remembers and restores Reports with a roving tablist", () => {
    mountSideTabs({ reports: true });
    const tab = document.getElementById("side-tab-reports")!;
    expect(tab.hidden).toBe(false);
    tab.click();
    expect(document.getElementById("reports-body")!.hidden).toBe(false);
    expect(document.getElementById("chat-body")!.hidden).toBe(true);
    expect(localStorage.getItem(SIDE_TAB_STORAGE_KEY)).toBe("reports");
    loadShellDom();
    const again = mountSideTabs({ reports: true });
    expect(again.selected()).toBe("reports");
  });

  it("shows an unread badge with a screen reader label", () => {
    const tabs = mountSideTabs({ reports: true });
    tabs.setBadge("reports", 2);
    const tab = document.getElementById("side-tab-reports")!;
    expect(tab.textContent).toContain("2 new");
    expect(tab.querySelector<HTMLElement>(".side-tabs__badge")!.hidden).toBe(false);
    tabs.setBadge("reports", 0);
    expect(tab.querySelector<HTMLElement>(".side-tabs__badge")!.hidden).toBe(true);
  });

  it("supports arrow keys across the three tabs", () => {
    mountSideTabs({ reports: true });
    const first = document.getElementById("side-tab-activity")!;
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement?.id).toBe("side-tab-reports");
  });
});

describe("tool labels", () => {
  it("humanizes report tools", () => {
    expect(humanizeToolName("mcp__helmstack__browser_create_report")).toBe("Prepare a report");
    expect(humanizeToolName("browser_list_reports")).toBe("List reports");
  });
});
