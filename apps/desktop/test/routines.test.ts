import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RoutineRisk, RoutineState, RoutineSummary } from "../../../packages/shared/src/index.js";
import { ROUTINE_ROW_CAP, mountRoutines, routinesSupported } from "../src/renderer/panels/routines.js";
import { SIDE_TAB_STORAGE_KEY, mountSideTabs } from "../src/renderer/panels/side-tabs.js";
import { createFakeBridge, flush, loadShellDom } from "./helpers/shell-fixtures.js";

let seq = 0;
function routine(partial: Partial<RoutineSummary> & { risks?: RoutineRisk[]; lines?: string[] } = {}): RoutineSummary {
  seq += 1;
  const { risks, lines, ...rest } = partial;
  return {
    id: `rt${seq}`,
    title: `Routine ${seq}`,
    intent: "Watch this page for updates on pricing",
    state: "proposed",
    createdAt: 1_700_000_000_000 + seq * 1000,
    updatedAt: 1_700_000_000_000 + seq * 1000,
    proposedBy: "claude-code",
    trigger: "every 6 hours",
    hosts: ["example.com"],
    specVersion: 1,
    preview: {
      headline: `Check example.com every 6 hours (${seq})`,
      lines: lines ?? ["Every 6 hours", "On example.com"],
      risks: risks ?? [],
    },
    ...rest,
  };
}

const ENGINE_OFF = { enabled: false, reason: "Routines can be reviewed and approved, but running them isn't available yet." };

function setup(initial: RoutineSummary[] = [], overrides: Record<string, (...args: never[]) => unknown> = {}) {
  const fake = createFakeBridge({ listRoutines: () => initial, getRoutineEngineStatus: () => ENGINE_OFF, ...overrides });
  const needs = vi.fn();
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const onReveal = vi.fn();
  const ctrl = mountRoutines({ bridge: fake.bridge, onNeedsReviewChange: needs, onDialogOpen: onOpen, onDialogClose: onClose, onReveal });
  return { fake, ctrl, needs, onOpen, onClose, onReveal };
}

const body = (): HTMLElement => document.getElementById("routines-body")!;
const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".routine-row"));
const rowTitles = (): string[] => rows().map((r) => r.querySelector("h4")!.textContent!);
const btn = (scope: ParentNode, label: string): HTMLButtonElement =>
  Array.from(scope.querySelectorAll("button")).find((b) => b.textContent === label)!;
const modal = (): HTMLElement => document.getElementById("routine-review-modal")!;
const approve = (): HTMLButtonElement => document.getElementById("routine-review-approve") as HTMLButtonElement;
const reject = (): HTMLButtonElement => document.getElementById("routine-review-reject") as HTMLButtonElement;
const withState = (state: RoutineState, title: string): RoutineSummary => routine({ state, title });

function openReviewFor(row: HTMLElement): HTMLButtonElement {
  const open = btn(row, "Review…");
  open.focus();
  open.click();
  return open;
}

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

describe("routines: side tab", () => {
  it("feature-detects the bridge", () => {
    expect(routinesSupported({})).toBe(false);
    expect(routinesSupported(createFakeBridge().bridge)).toBe(true);
  });

  it("hides the tab when unsupported and ignores a stored selection", () => {
    localStorage.setItem(SIDE_TAB_STORAGE_KEY, "routines");
    const tabs = mountSideTabs({ reports: true });
    expect(document.getElementById("side-tab-routines")!.hidden).toBe(true);
    expect(tabs.selected()).toBe("activity");
  });

  it("is the fourth tab, remembers its selection and restores it", () => {
    mountSideTabs({ reports: true, routines: true });
    const ids = Array.from(document.querySelectorAll("#side-tabs [role=tab]")).map((t) => t.id);
    expect(ids).toEqual(["side-tab-activity", "side-tab-chat", "side-tab-reports", "side-tab-routines"]);
    document.getElementById("side-tab-routines")!.click();
    expect(document.getElementById("routines-body")!.hidden).toBe(false);
    expect(document.getElementById("reports-body")!.hidden).toBe(true);
    expect(localStorage.getItem(SIDE_TAB_STORAGE_KEY)).toBe("routines");
    loadShellDom();
    expect(mountSideTabs({ reports: true, routines: true }).selected()).toBe("routines");
  });

  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const tabs = mountSideTabs({ routines: true });
    expect(() => tabs.select("routines")).not.toThrow();
    expect(tabs.selected()).toBe("routines");
  });

  it("shows a badge with a 'need review' screen reader label, and End reaches it", () => {
    const tabs = mountSideTabs({ routines: true });
    tabs.setBadge("routines", 2, "need review");
    const tab = document.getElementById("side-tab-routines")!;
    expect(tab.textContent).toContain("(2 need review)");
    expect(tab.querySelector<HTMLElement>(".side-tabs__badge")!.hidden).toBe(false);
    tabs.setBadge("routines", 0, "need review");
    expect(tab.querySelector<HTMLElement>(".side-tabs__badge")!.hidden).toBe(true);
    const first = document.getElementById("side-tab-activity")!;
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement?.id).toBe("side-tab-routines");
  });
});

describe("routines: list", () => {
  it("shows the empty state with what a routine is and how to get one", async () => {
    setup([]);
    await flush();
    const text = body().textContent!;
    expect(text).toContain("No routines yet");
    expect(text).toContain("A routine is");
    expect(text).toContain('Ask your agent: "watch this page for updates on X and note anything new"');
  });

  it("orders sections and collapses stopped / rejected with a count", async () => {
    setup([
      withState("rejected", "Rej"),
      withState("paused", "Pau"),
      withState("approved", "App"),
      withState("proposed", "Pro"),
      withState("stopped", "Sto"),
    ]);
    await flush();
    const headings = Array.from(body().querySelectorAll(".routines__section-title")).map((h) => h.textContent);
    expect(headings).toEqual(["Needs review (1)", "Approved (1)", "Paused (1)", "Stopped / rejected (2)"]);
    expect(rowTitles()).toEqual(["Pro", "App", "Pau"]);
    const toggle = body().querySelector<HTMLButtonElement>(".routines__toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.focus();
    toggle.click();
    expect(rowTitles().slice(0, 3)).toEqual(["Pro", "App", "Pau"]);
    expect(rowTitles().slice(3).sort()).toEqual(["Rej", "Sto"]);
    expect(body().querySelector<HTMLButtonElement>(".routines__toggle")!.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement?.classList.contains("routines__toggle")).toBe(true);
  });

  it("renders request, trigger, hosts, risk summary, proposer and replaces", async () => {
    const old = routine({ state: "approved", title: "Old watch" });
    const fresh = routine({
      title: "New watch",
      replaces: old.id,
      hosts: ["a.com", "b.com"],
      risks: [
        { level: "info", code: "x", message: "m1" },
        { level: "high", code: "y", message: "m2" },
      ],
    });
    setup([old, fresh]);
    await flush();
    const row = rows().find((r) => r.querySelector("h4")!.textContent === "New watch")!;
    const text = row.textContent!;
    expect(text).toContain("“Watch this page for updates on pricing”");
    expect(text).toContain("Trigger: every 6 hours");
    expect(Array.from(row.querySelectorAll(".routine-chip")).map((c) => c.textContent)).toEqual(["a.com", "b.com"]);
    expect(text).toContain("2 risks · highest: High");
    expect(row.querySelector(".routine-row__risk svg")).not.toBeNull();
    expect(text).toContain("Proposed by claude-code");
    expect(text).toContain("Replaces “Old watch”");
  });

  it("flags routines that may visit any site", async () => {
    setup([routine({ hosts: [] })]);
    await flush();
    const chip = rows()[0].querySelector(".routine-chip--warn")!;
    expect(chip.textContent).toBe("Any site");
    expect(chip.querySelector("svg")).not.toBeNull();
  });

  it("truncates a long request and expands it", async () => {
    const long = "x".repeat(300);
    setup([routine({ intent: long })]);
    await flush();
    expect(rows()[0].querySelector("blockquote")!.textContent!.length).toBeLessThan(200);
    const expand = btn(rows()[0], "Show full request");
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expand.focus();
    expand.click();
    expect(rows()[0].querySelector("blockquote")!.textContent).toBe(`“${long}”`);
    expect(document.activeElement?.textContent).toBe("Show less");
  });

  it("caps rendered rows", async () => {
    setup(Array.from({ length: ROUTINE_ROW_CAP + 5 }, () => routine()));
    await flush();
    expect(rows()).toHaveLength(ROUTINE_ROW_CAP);
    expect(body().querySelector(".routines__footer")!.textContent).toContain("5 more routines");
  });

  it("shows the engine notice and never calls an approved routine active", async () => {
    const { ctrl } = setup([routine({ state: "approved", title: "A" })]);
    await flush();
    const notice = body().querySelector(".routines__notice")!;
    expect(notice.textContent).toBe(ENGINE_OFF.reason);
    expect(rows()[0].textContent).toContain("Approved — waiting for the engine");
    expect(rows()[0].textContent).not.toContain("Active");
    expect(ctrl.needsReview()).toBe(0);
  });

  it("uses a fallback notice when the engine status is unavailable, and says Active once enabled", async () => {
    setup([routine({ state: "approved" })], {
      getRoutineEngineStatus: () => {
        throw new Error("boom");
      },
    });
    await flush();
    expect(body().querySelector(".routines__notice")!.textContent).toContain("isn't available yet");
    expect(rows()[0].textContent).not.toContain("Active");
    loadShellDom();
    setup([routine({ state: "approved" })], { getRoutineEngineStatus: () => ({ enabled: true }) });
    await flush();
    expect(body().querySelector(".routines__notice")).toBeNull();
    expect(rows()[0].textContent).toContain("Active");
  });

  it("computes the badge from proposed routines and clears it as they are reviewed", async () => {
    const a = routine({ title: "A" });
    const b = routine({ title: "B" });
    const { ctrl, needs, fake } = setup([a, b, withState("approved", "C")]);
    await flush();
    expect(ctrl.needsReview()).toBe(2);
    expect(needs).toHaveBeenLastCalledWith(2);
    fake.emit("onRoutinesChanged", [{ ...a, state: "approved" }, b]);
    expect(needs).toHaveBeenLastCalledWith(1);
    ctrl.handleChanged([{ ...a, state: "approved" }, { ...b, state: "rejected" }]);
    expect(needs).toHaveBeenLastCalledWith(0);
  });
});

describe("routines: actions", () => {
  it("pauses and resumes, moves the routine between sections and keeps focus on it", async () => {
    const r = routine({ state: "approved", title: "A" });
    const { fake } = setup([r], {
      pauseRoutine: () => ({ ...r, state: "paused" }),
      resumeRoutine: () => ({ ...r, state: "approved" }),
    });
    await flush();
    btn(rows()[0], "Pause").click();
    await flush();
    expect(fake.fn("pauseRoutine")).toHaveBeenCalledWith(r.id);
    expect(body().querySelector(".routines__section-title")!.textContent).toBe("Paused (1)");
    expect(rows()[0].textContent).toContain("Paused");
    expect(rows()[0].contains(document.activeElement)).toBe(true);
    btn(rows()[0], "Resume").click();
    await flush();
    expect(fake.fn("resumeRoutine")).toHaveBeenCalledWith(r.id);
    expect(body().querySelector(".routines__section-title")!.textContent).toBe("Approved (1)");
  });

  it("confirms Stop inline, can cancel with Escape, and stops once confirmed", async () => {
    const r = routine({ state: "approved", title: "A" });
    const { fake } = setup([r], { stopRoutine: () => ({ ...r, state: "stopped" }) });
    await flush();
    btn(rows()[0], "Stop").click();
    expect(fake.fn("stopRoutine")).not.toHaveBeenCalled();
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(rows()[0].textContent).toContain("Stop this routine?");
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(rows()[0].textContent).not.toContain("Stop this routine?");
    expect(document.activeElement?.textContent).toBe("Stop");
    btn(rows()[0], "Stop").click();
    btn(rows()[0], "Stop").click(); // the confirm button
    await flush();
    expect(fake.fn("stopRoutine")).toHaveBeenCalledWith(r.id);
    expect(rows()).toHaveLength(0); // moved to the collapsed section
    expect(body().querySelector(".routines__toggle")!.textContent).toContain("Stopped / rejected (1)");
  });

  it("offers Delete only for stopped or rejected, confirms inline and focuses a neighbour", async () => {
    const a = routine({ state: "stopped", title: "A", updatedAt: 3 });
    const b = routine({ state: "rejected", title: "B", updatedAt: 2 });
    const c = routine({ state: "stopped", title: "C", updatedAt: 1 });
    const live = routine({ state: "approved", title: "Live" });
    const { fake } = setup([a, b, c, live]);
    await flush();
    expect(btn(rows()[0], "Pause")).toBeTruthy();
    expect(Array.from(rows()[0].querySelectorAll("button")).some((x) => x.textContent === "Delete")).toBe(false);
    body().querySelector<HTMLButtonElement>(".routines__toggle")!.click();
    expect(rowTitles()).toEqual(["Live", "A", "B", "C"]);
    btn(rows()[2], "Delete").click();
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(rows()[2].textContent).toContain("can't be undone");
    btn(rows()[2], "Delete").click();
    await flush();
    expect(fake.fn("deleteRoutine")).toHaveBeenCalledWith(b.id);
    expect(rowTitles()).toEqual(["Live", "A", "C"]);
    expect(rows()[2].contains(document.activeElement)).toBe(true); // the next row, C
  });

  it("toasts and keeps the row when an action fails", async () => {
    const r = routine({ state: "approved" });
    setup([r], {
      pauseRoutine: () => {
        throw new Error("nope");
      },
    });
    await flush();
    btn(rows()[0], "Pause").click();
    await flush();
    expect(document.querySelector(".toast--error")!.textContent).toContain("Couldn't pause the routine — nope");
    expect(rows()).toHaveLength(1);
    expect(btn(rows()[0], "Pause").disabled).toBe(false);
  });
});

describe("routines: review dialog", () => {
  const spec = '{\n  "steps": []\n}';

  it("shows the headline, lines, risks highest first and the request, then returns focus on Cancel", async () => {
    const r = routine({
      title: "T",
      lines: ["When: every 6 hours", "Where: example.com"],
      risks: [
        { level: "info", code: "i", message: "Info msg" },
        { level: "warning", code: "w", message: "Warn msg" },
        { level: "high", code: "h", message: "High msg" },
      ],
    });
    const { onOpen, onClose } = setup([r]);
    await flush();
    const opener = openReviewFor(rows()[0]);
    expect(modal().hidden).toBe(false);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(document.getElementById("routine-review-title")!.textContent).toBe(r.preview.headline);
    expect(Array.from(modal().querySelectorAll(".routine-review__lines li")).map((l) => l.textContent)).toEqual(r.preview.lines);
    const risks = Array.from(modal().querySelectorAll(".routine-review__risk")).map((x) => x.textContent);
    expect(risks).toEqual(["HighHigh msg", "WarningWarn msg", "InfoInfo msg"]);
    expect(modal().querySelector(".routine-review__risk svg")).not.toBeNull();
    expect(modal().textContent).toContain("“Watch this page for updates on pricing”");
    btn(modal(), "Cancel").click();
    expect(modal().hidden).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });

  it("closes on Escape and returns focus to the Review button", async () => {
    setup([routine()]);
    await flush();
    const opener = openReviewFor(rows()[0]);
    expect(modal().contains(document.activeElement)).toBe(true);
    modal().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(modal().hidden).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it("returns focus to the row's button when the list re-rendered under the dialog", async () => {
    const a = routine({ title: "A" });
    const b = routine({ title: "B" });
    const { ctrl } = setup([a, b]);
    await flush();
    openReviewFor(rows().find((r) => r.querySelector("h4")!.textContent === "A")!);
    ctrl.handleChanged([a, b, withState("approved", "C")]); // re-render; the opener is replaced
    modal().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const row = rows().find((r) => r.querySelector("h4")!.textContent === "A")!;
    expect(row.contains(document.activeElement)).toBe(true);
  });

  it("fetches the spec lazily on first expand, with textContent, once", async () => {
    const r = routine();
    const { fake } = setup([r], { getRoutine: () => ({ ...r, specJson: spec }) });
    await flush();
    openReviewFor(rows()[0]);
    expect(fake.fn("getRoutine")).not.toHaveBeenCalled();
    const toggle = modal().querySelector<HTMLButtonElement>(".routine-review__disclosure")!;
    expect(toggle.textContent).toBe("Show the technical spec");
    toggle.click();
    await flush();
    expect(fake.fn("getRoutine")).toHaveBeenCalledWith(r.id);
    const pre = modal().querySelector("pre")!;
    expect(pre.textContent).toBe(spec);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    toggle.click();
    toggle.click();
    await flush();
    expect(fake.fn("getRoutine")).toHaveBeenCalledTimes(1);
  });

  it("handles a null spec and a failing fetch, and retries after a failure", async () => {
    const r = routine();
    let mode: "null" | "throw" | "ok" = "null";
    setup([r], {
      getRoutine: () => {
        if (mode === "throw") throw new Error("offline");
        return mode === "null" ? null : { ...r, specJson: spec };
      },
    });
    await flush();
    openReviewFor(rows()[0]);
    const toggle = modal().querySelector<HTMLButtonElement>(".routine-review__disclosure")!;
    toggle.click();
    await flush();
    expect(modal().querySelector(".routine-review__spec")!.textContent).toContain("isn't available");
    expect(modal().querySelector("pre")!.hidden).toBe(true);
    mode = "throw";
    toggle.click();
    toggle.click();
    await flush();
    expect(modal().querySelector(".routine-review__spec")!.textContent).toContain("Couldn't load the spec — offline");
    mode = "ok";
    toggle.click();
    toggle.click();
    await flush();
    expect(modal().querySelector("pre")!.textContent).toBe(spec);
  });

  it("enables Approve straight away without high risks, then approves, toasts and updates the list", async () => {
    const r = routine({ title: "Watch", risks: [{ level: "warning", code: "w", message: "w" }] });
    const other = routine({ title: "Other" });
    const { fake, needs, onClose } = setup([r, other], { approveRoutine: () => ({ ...r, state: "approved" }) });
    await flush();
    openReviewFor(rows().find((x) => x.querySelector("h4")!.textContent === "Watch")!);
    expect(approve().disabled).toBe(false);
    expect(modal().querySelector("#routine-review-ack")).toBeNull();
    approve().click();
    await flush();
    expect(fake.fn("approveRoutine")).toHaveBeenCalledWith(r.id);
    expect(modal().hidden).toBe(true);
    expect(onClose).toHaveBeenCalled();
    expect(document.querySelector(".toast--success")!.textContent).toBe("Approved “Watch” — it will wait for the engine");
    expect(needs).toHaveBeenLastCalledWith(1);
    expect(body().querySelectorAll(".routines__section-title")[1].textContent).toBe("Approved (1)");
    expect(document.activeElement?.closest(".routine-row")).not.toBeNull(); // focus did not fall to the body
  });

  it("requires ticking 'I've read the risks' when any risk is high", async () => {
    const r = routine({ risks: [{ level: "high", code: "any_site", message: "It can visit any site." }] });
    const { fake } = setup([r], { approveRoutine: () => ({ ...r, state: "approved" }) });
    await flush();
    openReviewFor(rows()[0]);
    const gate = document.getElementById("routine-review-gate")!;
    expect(approve().disabled).toBe(true);
    expect(gate.hidden).toBe(false);
    expect(gate.textContent).toContain("I've read the risks");
    expect(approve().getAttribute("aria-describedby")).toBe("routine-review-gate");
    approve().click();
    expect(fake.fn("approveRoutine")).not.toHaveBeenCalled();
    const ack = modal().querySelector<HTMLInputElement>("#routine-review-ack")!;
    expect(ack.closest("label")!.textContent).toBe("I've read the risks");
    ack.checked = true;
    ack.dispatchEvent(new Event("change", { bubbles: true }));
    expect(approve().disabled).toBe(false);
    expect(gate.hidden).toBe(true);
    ack.checked = false;
    ack.dispatchEvent(new Event("change", { bubbles: true }));
    expect(approve().disabled).toBe(true);
    // Reject is never gated.
    expect(reject().disabled).toBe(false);
  });

  it("rejects, toasts and moves focus to a neighbour", async () => {
    const a = routine({ title: "A", updatedAt: 9 });
    const b = routine({ title: "B", updatedAt: 8 });
    const { fake } = setup([a, b], { rejectRoutine: () => ({ ...a, state: "rejected" }) });
    await flush();
    openReviewFor(rows()[0]);
    reject().click();
    await flush();
    expect(fake.fn("rejectRoutine")).toHaveBeenCalledWith(a.id);
    expect(document.querySelector(".toast--success")!.textContent).toBe("Rejected “A”");
    expect(rowTitles()).toEqual(["B"]);
    expect(rows()[0].contains(document.activeElement)).toBe(true);
  });

  it("keeps the dialog open and re-enables the buttons when approving fails", async () => {
    const r = routine();
    setup([r], {
      approveRoutine: () => {
        throw new Error("not proposed");
      },
    });
    await flush();
    openReviewFor(rows()[0]);
    approve().click();
    await flush();
    expect(modal().hidden).toBe(false);
    expect(approve().disabled).toBe(false);
    expect(document.querySelector(".toast--error")!.textContent).toContain("not proposed");
  });

  it("says what a replacing proposal will stop", async () => {
    const old = routine({ state: "approved", title: "Old watch" });
    const next = routine({ replaces: old.id });
    setup([old, next]);
    await flush();
    openReviewFor(rows().find((r) => btn(r, "Review…"))!);
    expect(modal().querySelector(".routine-review__replaces")!.textContent).toBe("Approving this will stop Old watch.");
  });

  it("closes if the proposal changes or is handled elsewhere while open", async () => {
    const r = routine();
    const { ctrl } = setup([r]);
    await flush();
    openReviewFor(rows()[0]);
    ctrl.handleChanged([{ ...r, updatedAt: r.updatedAt + 5, specVersion: 2 }]);
    expect(modal().hidden).toBe(true);
    expect(document.querySelector(".toast")!.textContent).toContain("changed while you were reviewing");
    openReviewFor(rows()[0]);
    ctrl.handleChanged([{ ...r, updatedAt: r.updatedAt + 5, specVersion: 2, state: "approved" }]);
    expect(modal().hidden).toBe(true);
  });

  it("traps Tab inside the dialog", async () => {
    setup([routine()]);
    await flush();
    openReviewFor(rows()[0]);
    approve().focus();
    modal().dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(modal().contains(document.activeElement)).toBe(true);
  });
});

describe("routines: new-proposal notification", () => {
  it("toasts once per id with a Review action, without stealing focus, and updates the badge", async () => {
    const { fake, ctrl, needs, onReveal } = setup([]);
    await flush();
    const before = document.activeElement;
    const p = routine({ title: "Fresh" });
    fake.emit("onRoutinesChanged", [p]);
    ctrl.handleChanged([p], p);
    ctrl.handleChanged([p], p);
    ctrl.handleChanged([p], p);
    expect(document.querySelectorAll(".toast")).toHaveLength(1);
    const node = document.querySelector(".toast")!;
    expect(node.querySelector(".toast__message")!.textContent).toBe("Routine proposed: Fresh");
    expect(document.activeElement).toBe(before);
    expect(needs).toHaveBeenLastCalledWith(1);
    expect(document.getElementById("toast-region")!.getAttribute("aria-live")).toBe("polite");
    const action = node.querySelector<HTMLButtonElement>(".toast__action")!;
    expect(action.textContent).toBe("Review…");
    action.click();
    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(modal().hidden).toBe(false);
    expect(document.getElementById("routine-review-title")!.textContent).toBe(p.preview.headline);
    modal().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(rows()[0].contains(document.activeElement)).toBe(true);
  });
});

describe("routines: text safety", () => {
  it("never injects HTML from model-written strings", async () => {
    const evil = "<img src=x onerror=alert(1)><script>alert(2)</script>";
    const r = routine({
      title: evil,
      intent: evil,
      hosts: [evil],
      proposedBy: evil,
      lines: [evil],
      risks: [{ level: "high", code: "x", message: evil }],
    });
    const { fake, ctrl } = setup([r], { getRoutine: () => ({ ...r, specJson: evil }) });
    await flush();
    openReviewFor(rows()[0]);
    modal().querySelector<HTMLButtonElement>(".routine-review__disclosure")!.click();
    await flush();
    for (const scope of [body(), modal()]) {
      expect(scope.querySelector("img")).toBeNull();
      expect(scope.querySelector("script")).toBeNull();
    }
    expect(modal().querySelector("pre")!.textContent).toBe(evil);
    expect(rows()[0].textContent).toContain(evil);
    expect(fake.fn("getRoutine")).toHaveBeenCalled();
    const second = { ...r, id: "other" };
    ctrl.handleChanged([r, second], second);
    expect(document.querySelector(".toast__message")!.textContent).toContain("<img");
    expect(document.querySelector(".toast img")).toBeNull();
  });
});

describe("routines: keyboard", () => {
  it("every action is a real button reachable with Tab and activated with the keyboard", async () => {
    setup([routine({ title: "A" }), withState("approved", "B")]);
    await flush();
    const buttons = Array.from(body().querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    for (const b of buttons) {
      expect(b.type).toBe("button");
      expect(b.tabIndex).toBeGreaterThanOrEqual(0);
      expect(b.getAttribute("aria-label") ?? b.textContent).toBeTruthy();
    }
    const review = btn(rows()[0], "Review…");
    expect(review.getAttribute("aria-label")).toBe("Review proposal: A");
    expect(rows()[0].querySelector('[role="group"]')!.getAttribute("aria-label")).toBe("Actions for A");
  });
});
