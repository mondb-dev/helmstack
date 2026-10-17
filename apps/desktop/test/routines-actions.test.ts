import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RoutineAction, RoutineGrants, RoutineSummary } from "../../../packages/shared/src/index.js";
import { clampLimit, parseProtect } from "../src/renderer/panels/routine-grants.js";
import { mountRoutines } from "../src/renderer/panels/routines.js";
import { createFakeBridge, flush, loadShellDom } from "./helpers/shell-fixtures.js";

const NOW = 1_700_000_000_000;
const EVIL = "<img src=x onerror=alert(1)>";
const ACCOUNT_RISK = { level: "warning" as const, code: "acts_on_account", message: "It can change things on your account." };

let seq = 0;
function routine(partial: Partial<RoutineSummary> = {}): RoutineSummary {
  seq += 1;
  return {
    id: `ra${seq}`,
    title: `Routine ${seq}`,
    intent: "Manage my lineup",
    state: "approved",
    createdAt: NOW - 100_000,
    updatedAt: NOW - 100_000,
    trigger: "every 6 hours",
    hosts: ["basketball.example.com"],
    specVersion: 1,
    preview: { headline: "h", lines: [], risks: [ACCOUNT_RISK] },
    ...partial,
  };
}

function action(partial: Partial<RoutineAction> = {}): RoutineAction {
  seq += 1;
  return {
    id: `act${seq}`,
    routineId: "x",
    runId: "run1",
    createdAt: NOW - 60_000,
    expiresAt: NOW + 3_600_000,
    effect: "add_item",
    action: "click",
    description: 'Click "Add" for Jalen Smith.',
    host: "basketball.example.com",
    url: "https://basketball.example.com/roster",
    subject: "Jalen Smith",
    status: "pending",
    ...partial,
  };
}

type Impl = Record<string, (...args: never[]) => unknown>;

function setup(list: RoutineSummary[], overrides: Impl = {}, hide: string[] = []) {
  const fake = createFakeBridge({ listRoutines: () => list, getRoutineEngineStatus: () => ({ enabled: true, running: [] }), ...overrides });
  const unsubChanged = vi.fn();
  const unsubActions = vi.fn();
  const bridge = new Proxy(fake.bridge, {
    get(target, prop: string) {
      if (hide.includes(prop)) return undefined;
      if (prop === "onRoutinesChanged") return vi.fn(() => unsubChanged);
      if (prop === "onRoutineActionsChanged" && !("onRoutineActionsChanged" in overrides)) {
        return vi.fn((cb: (id: string) => void) => {
          (fake as unknown as { cb: typeof cb }).cb = cb;
          return unsubActions;
        });
      }
      return (target as never)[prop];
    },
  });
  const onPending = vi.fn();
  const ctrl = mountRoutines({ bridge, now: () => NOW, onPendingActionsChange: onPending });
  const changed = (id: string): void => (fake as unknown as { cb: (id: string) => void }).cb(id);
  return { fake, ctrl, unsubChanged, unsubActions, onPending, changed };
}

const body = (): HTMLElement => document.getElementById("routines-body")!;
const approveBtn = (): HTMLButtonElement => document.getElementById("routine-review-approve") as HTMLButtonElement;
const modal = (): HTMLElement => document.getElementById("routine-review-body")!;
const btn = (scope: ParentNode, label: string): HTMLButtonElement =>
  Array.from(scope.querySelectorAll("button")).find((b) => b.textContent === label)!;
const radio = (scope: ParentNode, effect: string, value: string): HTMLInputElement =>
  scope.querySelector<HTMLInputElement>(`input[type="radio"][name$="-${effect}"][value="${value}"]`)!;

beforeEach(() => {
  loadShellDom();
  document.getElementById("toast-region")?.remove();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("grant helpers", () => {
  it("parses, trims, dedupes and caps the protect list", () => {
    expect(parseProtect("  Jalen  Smith \n\njalen smith\r\nAnna\n")).toEqual(["Jalen Smith", "Anna"]);
    const many = Array.from({ length: 80 }, (_, i) => `Player ${i}`).join("\n");
    expect(parseProtect(many)).toHaveLength(50);
    expect(parseProtect("x".repeat(200))[0]).toHaveLength(80);
  });
  it("clamps limits to 1-50", () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(500)).toBe(50);
    expect(clampLimit("abc")).toBe(3);
  });
});

describe("review dialog grant editor", () => {
  const proposed = (): RoutineSummary => routine({ state: "proposed" });

  it("defaults every effect to ask and locks offer/respond/other", async () => {
    const r = proposed();
    const { ctrl } = setup([r], { getRoutine: () => ({ ...r, specJson: "{}" }) });
    await flush();
    ctrl.openReview(r.id);
    await flush();
    const m = modal();
    for (const e of ["rearrange", "add_item", "remove_item"]) {
      expect(radio(m, e, "ask").checked).toBe(true);
      expect(radio(m, e, "auto").disabled).toBe(false);
    }
    for (const e of ["offer", "respond", "other"]) {
      expect(radio(m, e, "auto")).toBeNull();
      expect(radio(m, e, "ask").disabled).toBe(true);
    }
    expect(m.textContent).toContain("Always asks you");
    expect(m.textContent).toContain("HelmStack still asks you about purchases");
    expect(m.querySelectorAll("fieldset legend").length).toBe(6);
    expect(m.querySelectorAll<HTMLElement>(".routine-grants__limits").item(0).hidden).toBe(true);
  });

  it("shows what was requested without preselecting auto, and approves with exactly the chosen grants", async () => {
    const r = proposed();
    const requested: RoutineGrants = { effects: { add_item: { mode: "auto", perDay: 5, perRun: 2 }, offer: { mode: "auto" } }, protect: ["Star Player"] };
    const { fake, ctrl } = setup([r], {
      getRoutine: () => ({ ...r, specJson: "{}", requestedGrants: requested }),
      approveRoutine: () => ({ ...r, state: "approved" }),
    });
    await flush();
    ctrl.openReview(r.id);
    await flush();
    const m = modal();
    expect(m.querySelector(".routine-grants__requested")!.textContent).toContain("Add items (at most 5 per day, 2 per run)");
    expect(m.querySelector(".routine-grants__requested")!.textContent).not.toContain("Offer");
    expect(radio(m, "add_item", "ask").checked).toBe(true);
    expect((m.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Star Player");

    radio(m, "add_item", "auto").click();
    expect(m.querySelectorAll<HTMLElement>(".routine-grants__limits").item(1).hidden).toBe(false);
    const inputs = m.querySelectorAll<HTMLInputElement>('fieldset input[type="number"]');
    expect(inputs[2].value).toBe("3");
    inputs[2].value = "99";
    inputs[2].dispatchEvent(new Event("change"));
    expect(inputs[2].value).toBe("50");
    inputs[3].value = "2";
    const ta = m.querySelector("textarea") as HTMLTextAreaElement;
    ta.value = " Star Player \nstar player\nBench";
    ta.dispatchEvent(new Event("input"));
    approveBtn().click();
    await flush();
    expect(fake.fn("approveRoutine")).toHaveBeenCalledWith(r.id, {
      effects: {
        rearrange: { mode: "ask" },
        add_item: { mode: "auto", perDay: 50, perRun: 2 },
        remove_item: { mode: "ask" },
        offer: { mode: "ask" },
        respond: { mode: "ask" },
        other: { mode: "ask" },
      },
      protect: ["Star Player", "Bench"],
    });
  });

  it("shows no editor without the risk, and falls back to approveRoutine(id) without the bridge method", async () => {
    const plain = routine({ state: "proposed", preview: { headline: "h", lines: [], risks: [] } });
    const { fake, ctrl } = setup([plain], { approveRoutine: () => ({ ...plain, state: "approved" }) });
    await flush();
    ctrl.openReview(plain.id);
    expect(modal().querySelector(".routine-grants")).toBeNull();
    approveBtn().click();
    await flush();
    expect(fake.fn("approveRoutine")).toHaveBeenCalledWith(plain.id);

    document.body.innerHTML = "";
    loadShellDom();
    const r = routine({ state: "proposed" });
    const old = setup([r], { approveRoutine: () => ({ ...r, state: "approved" }) }, ["setRoutineGrants", "listRoutineActions", "approveRoutineAction", "declineRoutineAction", "onRoutineActionsChanged"]);
    await flush();
    old.ctrl.openReview(r.id);
    expect(modal().querySelector(".routine-grants")).toBeNull();
    approveBtn().click();
    await flush();
    expect(old.fake.fn("approveRoutine")).toHaveBeenCalledWith(r.id);
  });
});

describe("row grants and actions", () => {
  it("summarises grants and edits them with setRoutineGrants", async () => {
    const r = routine();
    const grants: RoutineGrants = { effects: { add_item: { mode: "auto", perDay: 4, perRun: 2 } }, protect: ["Star"] };
    const saved: RoutineGrants = { effects: { rearrange: { mode: "auto", perDay: 3, perRun: 3 } }, protect: [] };
    const { fake } = setup([r], {
      getRoutine: () => ({ ...r, specJson: "{}", grants }),
      listRoutineActions: () => [],
      setRoutineGrants: () => ({ ...r, specJson: "{}", grants: saved }),
    });
    await flush();
    const row = body().querySelector<HTMLElement>(".routine-row")!;
    expect(row.querySelector(".routine-row__grants")!.textContent).toContain("Add items (at most 4 per day, 2 per run)");
    expect(row.textContent).toContain("Star");
    btn(row, "Edit what it may do").click();
    expect(radio(body(), "add_item", "auto").checked).toBe(true);
    radio(body(), "rearrange", "auto").click();
    btn(body().querySelector(".routine-row__grant-edit")!, "Save").click();
    await flush();
    const sent = fake.fn("setRoutineGrants").mock.calls[0] as [string, RoutineGrants];
    expect(sent[0]).toBe(r.id);
    expect(sent[1].effects.rearrange).toEqual({ mode: "auto", perDay: 3, perRun: 3 });
    expect(sent[1].effects.add_item).toEqual({ mode: "auto", perDay: 4, perRun: 2 });
    expect(body().querySelector(".routine-grants")).toBeNull();
    expect(body().querySelector(".routine-row__grants")!.textContent).toContain("Rearrange");
  });

  it("shows a save failure inline", async () => {
    const r = routine();
    setup([r], {
      getRoutine: () => ({ ...r, specJson: "{}", grants: { effects: {}, protect: [] } }),
      listRoutineActions: () => [],
      setRoutineGrants: () => {
        throw new Error("nope");
      },
    });
    await flush();
    btn(body(), "Edit what it may do").click();
    btn(body().querySelector(".routine-row__grant-edit")!, "Save").click();
    await flush();
    expect(body().querySelector('[role="alert"]')!.textContent).toBe("Couldn't save — nope");
  });

  it("lists pending actions first, approves one with a disabled in-flight state, and updates the badge", async () => {
    const r = routine();
    const a1 = action({ routineId: r.id, description: EVIL, subject: EVIL, host: "h.example.com" });
    const done = action({ routineId: r.id, status: "done", allowedBy: "grant", decidedAt: NOW - 1000 });
    const failed = action({ routineId: r.id, status: "failed", allowedBy: "human", note: "The button was missing.", decidedAt: NOW - 500 });
    let list = [done, failed, a1];
    let release: (v: RoutineAction) => void = () => undefined;
    const approveRoutineAction = vi.fn(
      () =>
        new Promise<RoutineAction>((resolve) => {
          release = resolve;
        })
    );
    const { fake, onPending } = setup([{ ...r, state: "paused" }], {
      listRoutineActions: () => list,
      approveRoutineAction: approveRoutineAction as never,
    });
    await flush();
    expect(onPending).toHaveBeenLastCalledWith(1);
    const row = body().querySelector<HTMLElement>(".routine-row")!;
    expect(row.textContent).toContain("1 waiting for you");
    expect(row.querySelector(".routine-action__desc")!.textContent).toBe(EVIL);
    expect(row.querySelector("img")).toBeNull();
    expect(row.querySelector("[data-until]")!.textContent).toBe("Expires in 1h 0m");

    btn(row, "Details").click();
    await flush();
    const items = Array.from(body().querySelectorAll<HTMLElement>(".routine-action"));
    expect(items[0].dataset.actionId).toBe(a1.id);
    expect(items.length).toBe(3);
    expect(items[1].textContent).toContain("by you");
    expect(items[1].textContent).toContain("The button was missing.");
    expect(items[1].textContent).toContain("the routine was paused");
    expect(items[2].textContent).toContain("by your settings");

    list = [done, failed, { ...a1, status: "done", allowedBy: "human" }];
    btn(body(), "Approve").click();
    await flush();
    expect(approveRoutineAction).toHaveBeenCalledWith(r.id, a1.id);
    expect(btn(body(), "Working…").disabled).toBe(true);
    expect(btn(body(), "Decline").disabled).toBe(true);
    btn(body(), "Working…").click();
    expect(approveRoutineAction).toHaveBeenCalledTimes(1);
    release({ ...a1, status: "approved", allowedBy: "human" });
    await flush();
    expect(onPending).toHaveBeenLastCalledWith(0);
    expect(body().textContent).not.toContain("waiting for you");
    expect(fake.fn("declineRoutineAction")).not.toHaveBeenCalled();
  });

  it("declines, and shows failures inline; never approves automatically", async () => {
    const r = routine();
    const a = action({ routineId: r.id });
    const { fake } = setup([r], {
      listRoutineActions: () => [a],
      declineRoutineAction: () => {
        throw new Error("offline");
      },
    });
    await flush();
    expect(fake.fn("approveRoutineAction")).not.toHaveBeenCalled();
    btn(body(), "Decline").click();
    await flush();
    expect(fake.fn("declineRoutineAction")).toHaveBeenCalledWith(r.id, a.id);
    expect(body().querySelector('[role="alert"]')!.textContent).toBe("Couldn't decline this — offline");
    expect(btn(body(), "Decline").disabled).toBe(false);
  });

  it("renders an expired pending action without buttons and caps the list at 25", async () => {
    const r = routine();
    const expired = action({ routineId: r.id, expiresAt: NOW - 1000 });
    const many = Array.from({ length: 40 }, () => action({ routineId: r.id, status: "done", allowedBy: "grant" }));
    const { onPending } = setup([r], { listRoutineActions: () => [expired, ...many] });
    await flush();
    expect(onPending).not.toHaveBeenCalledWith(1);
    btn(body(), "Details").click();
    await flush();
    expect(body().querySelectorAll(".routine-action").length).toBe(25);
    expect(body().textContent).toContain("Showing 25 of 41 actions.");
    expect(body().querySelector(".routine-action--pending")!.textContent).toContain("Expired");
    expect(btn(body(), "Approve")).toBeUndefined();
  });

  it("reloads on onRoutineActionsChanged", async () => {
    const r = routine();
    let list: RoutineAction[] = [];
    const { changed, onPending } = setup([r], { listRoutineActions: () => list });
    await flush();
    expect(body().textContent).not.toContain("waiting for you");
    list = [action({ routineId: r.id })];
    changed(r.id);
    await flush();
    expect(onPending).toHaveBeenLastCalledWith(1);
    expect(body().textContent).toContain("1 waiting for you");
  });

  it("hides the new UI and ignores the bridge when the methods are absent; unsubscribes on destroy", async () => {
    const r = routine();
    const { fake, ctrl, unsubActions, unsubChanged } = setup([r], {}, ["setRoutineGrants", "listRoutineActions", "approveRoutineAction", "declineRoutineAction"]);
    await flush();
    expect(body().textContent).not.toContain("waiting for you");
    expect(btn(body(), "Edit what it may do")).toBeUndefined();
    expect(fake.fn("getRoutine")).not.toHaveBeenCalled();
    ctrl.destroy();
    expect(unsubActions).toHaveBeenCalledTimes(1);
    expect(unsubChanged).toHaveBeenCalledTimes(1);
  });
});
