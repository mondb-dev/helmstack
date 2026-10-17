import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  RoutineEngineStatus,
  RoutineMemory,
  RoutineNote,
  RoutineRunDetail,
  RoutineRunSummary,
  RoutineSummary,
} from "../../../packages/shared/src/index.js";
import { LOG_CAP, NOTE_CAP, mountRoutines, untilText } from "../src/renderer/panels/routines.js";
import { createFakeBridge, flush, loadShellDom } from "./helpers/shell-fixtures.js";

let seq = 0;
function routine(partial: Partial<RoutineSummary> = {}): RoutineSummary {
  seq += 1;
  return {
    id: `rr${seq}`,
    title: `Routine ${seq}`,
    intent: "Watch pricing",
    state: "approved",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    trigger: "every 6 hours",
    hosts: ["example.com"],
    specVersion: 1,
    preview: { headline: "h", lines: [], risks: [] },
    ...partial,
  };
}

function run(r: RoutineSummary, partial: Partial<RoutineRunSummary> = {}): RoutineRunSummary {
  seq += 1;
  return {
    id: `run${seq}`,
    routineId: r.id,
    trigger: "manual",
    startedAt: Date.now() - 60_000,
    endedAt: Date.now() - 30_000,
    status: "completed",
    pagesVisited: 3,
    notesAdded: 2,
    summary: "Looked at 3 pages.",
    ...partial,
  };
}

const ON: RoutineEngineStatus = { enabled: true, running: [] };
const EVIL = "<img src=x onerror=alert(1)>";

type Impl = Record<string, (...args: never[]) => unknown>;

function setup(list: RoutineSummary[], overrides: Impl = {}, status: RoutineEngineStatus = ON) {
  const fake = createFakeBridge({ listRoutines: () => list, getRoutineEngineStatus: () => status, ...overrides });
  const unsubChanged = vi.fn();
  const unsubRuns = vi.fn();
  const bridge = new Proxy(fake.bridge, {
    get(target, prop: string) {
      if (prop === "onRoutinesChanged") return vi.fn(() => unsubChanged);
      if (prop === "onRoutineRunUpdated") {
        return vi.fn((cb: (r: RoutineRunSummary) => void) => {
          (fake as unknown as { cb: typeof cb }).cb = cb;
          return unsubRuns;
        });
      }
      return (target as never)[prop];
    },
  });
  const ctrl = mountRoutines({ bridge });
  const push = (r: RoutineRunSummary): void => (fake as unknown as { cb: (r: RoutineRunSummary) => void }).cb(r);
  return { fake, ctrl, push, unsubChanged, unsubRuns };
}

const body = (): HTMLElement => document.getElementById("routines-body")!;
const row = (): HTMLElement => document.querySelector<HTMLElement>(".routine-row")!;
const btn = (scope: ParentNode, label: string): HTMLButtonElement =>
  Array.from(scope.querySelectorAll("button")).find((b) => b.textContent === label)!;

beforeEach(() => {
  loadShellDom();
  document.getElementById("toast-region")?.remove();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("routines phase 2: engine banner and kill switch", () => {
  it("shows the engine's reason when not enabled and offers no kill switch", async () => {
    setup([routine()], {}, { enabled: false, reason: "Not on this backend." });
    await flush();
    expect(body().querySelector(".routines__notice")!.textContent).toBe("Not on this backend.");
    expect(btn(body(), "Stop all routines")).toBeUndefined();
  });

  it("stops all routines with one action and shows a clear off state, then allows again", async () => {
    const { fake } = setup([routine()], {
      setRoutineKillSwitch: ((on: boolean) => ({ enabled: true, killed: on, running: [] })) as never,
    });
    await flush();
    expect(body().querySelector(".routines__notice")).toBeNull();
    btn(body(), "Stop all routines").focus();
    btn(body(), "Stop all routines").click();
    await flush();
    expect(fake.fn("setRoutineKillSwitch")).toHaveBeenCalledWith(true);
    const off = body().querySelector(".routines__notice--off")!;
    expect(off.textContent).toContain("Routines are switched off");
    expect(row().textContent).toContain("Switched off");
    expect(document.activeElement?.textContent).toBe("Allow routines again");
    btn(body(), "Allow routines again").click();
    await flush();
    expect(fake.fn("setRoutineKillSwitch")).toHaveBeenLastCalledWith(false);
    expect(body().querySelector(".routines__notice--off")).toBeNull();
  });

  it("shows a bridge failure inline in plain language", async () => {
    setup([routine()], {
      setRoutineKillSwitch: (() => {
        throw new Error("denied");
      }) as never,
    });
    await flush();
    btn(body(), "Stop all routines").click();
    await flush();
    expect(body().querySelector('[role="alert"]')!.textContent).toBe("Couldn't switch routines off — denied");
  });
});

describe("routines phase 2: run now and cancel", () => {
  it("disables Run now when killed, not approved, engine off, or already running", async () => {
    const live = routine({ title: "Live" });
    const held = routine({ title: "Held", state: "paused" });
    const busy = routine({ title: "Busy" });
    const { ctrl } = setup([live, held, busy], {}, { enabled: true, running: [busy.id] });
    await flush();
    const by = (t: string): HTMLElement => Array.from(document.querySelectorAll<HTMLElement>(".routine-row")).find((r) => r.querySelector("h4")!.textContent === t)!;
    expect(btn(by("Live"), "Run now").disabled).toBe(false);
    expect(btn(by("Held"), "Run now").disabled).toBe(true);
    expect(btn(by("Busy"), "Run now").disabled).toBe(true);
    expect(by("Busy").textContent).toContain("Running");
    expect(btn(by("Busy"), "Cancel run")).toBeTruthy();
    expect(btn(by("Live"), "Cancel run")).toBeUndefined();
    void ctrl;
    loadShellDom();
    setup([routine()], {}, { enabled: true, killed: true });
    await flush();
    expect(btn(row(), "Run now").disabled).toBe(true);
    loadShellDom();
    setup([routine()], {}, { enabled: false });
    await flush();
    expect(btn(row(), "Run now").disabled).toBe(true);
  });

  it("starts a run, shows the running chip with Cancel, and settles on a run update", async () => {
    const r = routine();
    const started = run(r, { status: "running", endedAt: undefined });
    const { fake, push } = setup([r], {
      runRoutineNow: (() => started) as never,
      cancelRoutineRun: (() => undefined) as never,
    });
    await flush();
    btn(row(), "Run now").click();
    await flush();
    expect(fake.fn("runRoutineNow")).toHaveBeenCalledWith(r.id);
    expect(row().querySelector(".routine-status--running")!.textContent).toBe("Running");
    expect(btn(row(), "Run now").disabled).toBe(true);
    btn(row(), "Cancel run").click();
    await flush();
    expect(fake.fn("cancelRoutineRun")).toHaveBeenCalledWith(r.id);
    expect(row().textContent).toContain("Cancelling…");
    push({ ...started, status: "cancelled", endedAt: Date.now() });
    expect(row().textContent).toContain("Last run: Cancelled");
    expect(btn(row(), "Cancel run")).toBeUndefined();
    expect(btn(row(), "Run now").disabled).toBe(false);
  });

  it("shows a refused start inline", async () => {
    setup([routine()], {
      runRoutineNow: (() => {
        throw new Error("already running");
      }) as never,
    });
    await flush();
    btn(row(), "Run now").click();
    await flush();
    expect(row().querySelector('[role="alert"]')!.textContent).toBe("Couldn't start the routine — already running");
    expect(btn(row(), "Run now").disabled).toBe(false);
  });

  it("shows when the next run is and counts down on the tick", async () => {
    vi.useFakeTimers();
    const r = routine();
    const memory: RoutineMemory = { routineId: r.id, sets: {}, values: {}, nextRunAt: Date.now() + 5 * 60_000 };
    setup([r], { getRoutineMemory: (() => memory) as never });
    body().hidden = false;
    await vi.advanceTimersByTimeAsync(10);
    expect(row().querySelector(".routine-status--next")!.textContent).toBe("Next run in 5m");
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(row().querySelector(".routine-status--next")!.textContent).toBe("Next run in 2m");
    expect(untilText(1000, 0)).toBe("in a moment");
  });
});

describe("routines phase 2: details", () => {
  async function openWith(r: RoutineSummary, overrides: Impl) {
    const ctx = setup([r], overrides);
    await flush();
    btn(row(), "Details").click();
    await flush();
    return ctx;
  }

  it("lists runs and opens a log that renders page text as text only", async () => {
    const r = routine();
    const one = run(r, { summary: EVIL });
    const detail: RoutineRunDetail = {
      ...one,
      log: [
        { at: 1, level: "info", message: EVIL },
        { at: 2, level: "warn", step: "open", message: "slow" },
        { at: 3, level: "error", message: "<script>x</script>" },
      ],
    };
    const { fake } = await openWith(r, { listRoutineRuns: (() => [one]) as never, getRoutineRun: (() => detail) as never });
    expect(row().querySelector(".routine-run__summary")!.textContent).toBe(EVIL);
    expect(row().querySelector(".routine-run__counts")!.textContent).toBe("3 pages · 2 notes");
    btn(row(), "Details"); // toggled label now reads Hide details
    row().querySelector<HTMLButtonElement>('[data-action="open-run"]')!.click();
    await flush();
    expect(fake.fn("getRoutineRun")).toHaveBeenCalledWith(r.id, one.id);
    const lines = Array.from(row().querySelectorAll(".routine-log__line"));
    expect(lines.map((l) => l.className)).toEqual([
      "routine-log__line routine-log__line--info",
      "routine-log__line routine-log__line--warn",
      "routine-log__line routine-log__line--error",
    ]);
    expect(lines[0].textContent).toContain(EVIL);
    expect(lines[1].textContent).toBe("Warningopen: slow");
    expect(row().querySelector("img")).toBeNull();
    expect(row().querySelector("script")).toBeNull();
    expect(row().querySelector('[data-action="open-run"]')!.getAttribute("aria-expanded")).toBe("true");
  });

  it("caps log lines and shows a log failure inline", async () => {
    const r = routine();
    const one = run(r);
    let fail = false;
    await openWith(r, {
      listRoutineRuns: (() => [one]) as never,
      getRoutineRun: (() => {
        if (fail) throw new Error("gone");
        return { ...one, log: Array.from({ length: LOG_CAP + 10 }, (_, i) => ({ at: i, level: "info", message: `l${i}` })) };
      }) as never,
    });
    row().querySelector<HTMLButtonElement>('[data-action="open-run"]')!.click();
    await flush();
    expect(row().querySelectorAll(".routine-log__line")).toHaveLength(LOG_CAP);
    fail = true;
    row().querySelector<HTMLButtonElement>('[data-action="open-run"]')!.click(); // close
    row().querySelector<HTMLButtonElement>('[data-action="open-run"]')!.click(); // reopen
    await flush();
    expect(row().textContent).toContain("Couldn't load the log — gone");
  });

  it("renders notes as text, marks uncertain ones, caps them and opens only web pages", async () => {
    const r = routine();
    const mk = (i: number, partial: Partial<RoutineNote> = {}): RoutineNote => ({
      id: `n${i}`, routineId: r.id, runId: "x", at: Date.now() - i * 1000, url: "https://example.com/a", fields: { title: `T${i}` }, ...partial,
    });
    const notes = [
      mk(0, { url: "javascript:alert(1)", fields: { price: EVIL, [EVIL]: "k" }, maybe: true }),
      mk(1, { url: `https://example.com/${"x".repeat(200)}` }),
      ...Array.from({ length: NOTE_CAP + 5 }, (_, i) => mk(i + 2)),
    ];
    const openTab = vi.fn(async () => []);
    const { fake } = await openWith(r, { listRoutineNotes: (() => notes) as never, openTab: openTab as never });
    expect(fake.fn("listRoutineNotes")).toHaveBeenCalled();
    const items = Array.from(row().querySelectorAll(".routine-note"));
    expect(items).toHaveLength(NOTE_CAP);
    expect(items[0].textContent).toContain("uncertain");
    expect(items[0].textContent).toContain(`price: ${EVIL}`);
    expect(items[0].querySelector("img")).toBeNull();
    expect(items[0].querySelector("button")).toBeNull(); // javascript: gets no Open
    const long = items[1].querySelector<HTMLElement>(".routine-note__url-text")!;
    expect(long.textContent!.length).toBeLessThan(100);
    expect(long.title).toContain("xxxx");
    items[1].querySelector<HTMLButtonElement>('[data-action="open-note-url"]')!.click();
    expect(openTab).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/example\.com\/x+/));
  });

  it("shows memory and forgets only after confirmation", async () => {
    const r = routine();
    const memory: RoutineMemory = { routineId: r.id, sets: { seen: 41 }, values: { last: EVIL } };
    const { fake } = await openWith(r, { getRoutineMemory: (() => memory) as never, clearRoutineMemory: (() => undefined) as never });
    const facts = row().querySelector(".routine-detail__facts")!.textContent!;
    expect(facts).toContain("seen: 41 items remembered");
    expect(facts).toContain(`last: ${EVIL}`);
    expect(row().querySelector(".routine-detail__facts img")).toBeNull();
    btn(row(), "Forget what it has seen").click();
    expect(fake.fn("clearRoutineMemory")).not.toHaveBeenCalled();
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(row().textContent).toContain("Forget everything this routine has seen?");
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(row().textContent).not.toContain("Forget everything");
    expect(document.activeElement?.textContent).toBe("Forget what it has seen");
    btn(row(), "Forget what it has seen").click();
    btn(row(), "Forget").click();
    await flush();
    expect(fake.fn("clearRoutineMemory")).toHaveBeenCalledWith(r.id);
    expect(row().textContent).not.toContain("Forget everything");
  });

  it("shows section errors inline", async () => {
    const r = routine();
    await openWith(r, {
      listRoutineRuns: (() => {
        throw new Error("a");
      }) as never,
      listRoutineNotes: (() => {
        throw new Error("b");
      }) as never,
      getRoutineMemory: (() => {
        throw new Error("c");
      }) as never,
    });
    const t = row().textContent!;
    expect(t).toContain("Couldn't load runs — a");
    expect(t).toContain("Couldn't load notes — b");
    expect(t).toContain("Couldn't load memory — c");
  });

  it("adds a live run to an open Runs list", async () => {
    const r = routine();
    const { push } = await openWith(r, { listRoutineRuns: (() => []) as never });
    expect(row().textContent).toContain("No runs yet.");
    push(run(r, { summary: "fresh" }));
    expect(row().querySelector(".routine-run__summary")!.textContent).toBe("fresh");
  });
});

describe("routines phase 2: unmount", () => {
  it("unsubscribes both listeners, clears the timer and ignores late results", async () => {
    vi.useFakeTimers();
    let resolve!: (v: RoutineRunSummary[]) => void;
    const r = routine();
    const { ctrl, unsubChanged, unsubRuns } = setup([r], { listRoutineRuns: (() => new Promise((res) => (resolve = res))) as never });
    await vi.advanceTimersByTimeAsync(10);
    btn(row(), "Details").click();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    ctrl.destroy();
    expect(unsubChanged).toHaveBeenCalledTimes(1);
    expect(unsubRuns).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    resolve([run(r)]);
    await vi.advanceTimersByTimeAsync(10);
    expect(row().querySelector(".routine-run")).toBeNull();
  });
});
