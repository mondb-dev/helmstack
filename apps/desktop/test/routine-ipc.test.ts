import { describe, expect, it, vi } from "vitest";

import type { RoutineSummary } from "../../../packages/shared/src/index.js";
import { createRoutineIpc, parseRoutineId, type RoutineIpcDeps } from "../src/main/routine-ipc.js";

const SHELL = { shell: true };
const ID = "rt-20261017-093000-abcdef01";
const SUMMARY = { id: ID, state: "approved" } as RoutineSummary;
const RUN_ID = "run-abc123-0123abcd";
const ACTION = "act-abc123-0123abcd";
const RUN = { id: RUN_ID, routineId: ID, status: "running" } as never;

function setup() {
  const deps = {
    core: {
      listRoutines: vi.fn(() => [SUMMARY]),
      getRoutine: vi.fn(() => ({ ...SUMMARY, specJson: "{}" }) as never),
      getRoutineEngineStatus: vi.fn(() => ({ enabled: true, killed: false, running: [] })),
      approveRoutine: vi.fn(() => SUMMARY),
      rejectRoutine: vi.fn(() => SUMMARY),
      pauseRoutine: vi.fn(() => SUMMARY),
      resumeRoutine: vi.fn(() => SUMMARY),
      stopRoutine: vi.fn(() => SUMMARY),
      deleteRoutine: vi.fn(() => true),
      runRoutineNow: vi.fn(() => RUN),
      cancelRoutineRun: vi.fn(() => undefined),
      listRoutineRuns: vi.fn(() => [RUN]),
      getRoutineRun: vi.fn(() => null),
      listRoutineNotes: vi.fn(() => []),
      getRoutineMemory: vi.fn(() => ({ routineId: ID, sets: {}, values: {} })),
      clearRoutineMemory: vi.fn(() => undefined),
      setRoutineGrants: vi.fn(() => ({ ...SUMMARY, specJson: "{}" }) as never),
      listRoutineActions: vi.fn(() => []),
      approveRoutineAction: vi.fn(async () => ({ id: ACTION } as never)),
      declineRoutineAction: vi.fn(() => ({ id: ACTION }) as never),
      setRoutineKillSwitch: vi.fn((on: boolean) => ({ enabled: true, killed: on, running: [] })),
      getRoutineModel: vi.fn(async () => ({ choice: null, available: false })),
      setRoutineModel: vi.fn(async (choice: { cli: string; model?: string } | null) => ({ choice, available: true }))
    },
    isShellSender: (s: unknown) => s === SHELL
  } satisfies RoutineIpcDeps;
  return { deps, ipc: createRoutineIpc(deps) };
}

describe("routine IPC", () => {
  it("validates ids", () => {
    expect(parseRoutineId(ID)).toBe(ID);
    for (const bad of ["../x", "", 5, null, undefined, `${ID}/..`, "/etc/passwd", { id: ID }, `${ID}\n`]) {
      expect(() => parseRoutineId(bad)).toThrow("Invalid routine id.");
    }
  });

  it("passes list, read and status through for the shell", () => {
    const { ipc } = setup();
    expect(ipc.list(SHELL)).toEqual([SUMMARY]);
    expect(ipc.get(SHELL, ID)?.id).toBe(ID);
    expect(ipc.engineStatus(SHELL)).toEqual({ enabled: true, killed: false, running: [] });
  });

  it("routes each action to the matching core method with only the validated id", () => {
    const { deps, ipc } = setup();
    ipc.approve(SHELL, ID);
    ipc.reject(SHELL, ID);
    ipc.pause(SHELL, ID);
    ipc.resume(SHELL, ID);
    ipc.stop(SHELL, ID);
    ipc.delete(SHELL, ID);
    for (const fn of ["approveRoutine", "rejectRoutine", "pauseRoutine", "resumeRoutine", "stopRoutine", "deleteRoutine"] as const) {
      expect(deps.core[fn]).toHaveBeenCalledTimes(1);
      expect(deps.core[fn]).toHaveBeenCalledWith(ID);
    }
  });

  it("refuses every call from anything but the shell window and touches nothing", () => {
    const { deps, ipc } = setup();
    const stranger = { webContents: "page" };
    const calls = [
      () => ipc.list(stranger),
      () => ipc.get(stranger, ID),
      () => ipc.engineStatus(stranger),
      () => ipc.approve(stranger, ID),
      () => ipc.reject(stranger, ID),
      () => ipc.pause(stranger, ID),
      () => ipc.resume(stranger, ID),
      () => ipc.stop(stranger, ID),
      () => ipc.delete(stranger, ID),
      () => ipc.approve(undefined, ID),
      () => ipc.runNow(stranger, ID),
      () => ipc.cancelRun(stranger, ID),
      () => ipc.listRuns(stranger, ID),
      () => ipc.getRun(stranger, ID, RUN_ID),
      () => ipc.listNotes(stranger, ID),
      () => ipc.memory(stranger, ID),
      () => ipc.clearMemory(stranger, ID),
      () => ipc.setKillSwitch(stranger, true),
      () => ipc.getModel(stranger),
      () => ipc.setModel(stranger, { cli: "claude" })
    ];
    for (const call of calls) expect(call).toThrow("only available from the HelmStack window");
    for (const fn of Object.values(deps.core)) expect(fn).not.toHaveBeenCalled();
  });

  it("routes the run controls with validated arguments only", () => {
    const { deps, ipc } = setup();
    expect(ipc.runNow(SHELL, ID)).toBe(RUN);
    ipc.cancelRun(SHELL, ID);
    ipc.listRuns(SHELL, ID);
    ipc.getRun(SHELL, ID, RUN_ID);
    ipc.listNotes(SHELL, ID, 25);
    ipc.listNotes(SHELL, ID);
    ipc.memory(SHELL, ID);
    ipc.clearMemory(SHELL, ID);
    expect(ipc.setKillSwitch(SHELL, true)).toMatchObject({ killed: true });
    expect(deps.core.runRoutineNow).toHaveBeenCalledWith(ID);
    expect(deps.core.cancelRoutineRun).toHaveBeenCalledWith(ID);
    expect(deps.core.getRoutineRun).toHaveBeenCalledWith(ID, RUN_ID);
    expect(deps.core.listRoutineNotes).toHaveBeenNthCalledWith(1, ID, 25);
    expect(deps.core.listRoutineNotes).toHaveBeenNthCalledWith(2, ID, undefined);
    expect(deps.core.clearRoutineMemory).toHaveBeenCalledWith(ID);
    expect(deps.core.setRoutineKillSwitch).toHaveBeenCalledWith(true);
  });

  it("rejects malformed run ids, note limits and kill switch values before the core", () => {
    const { deps, ipc } = setup();
    for (const bad of ["../x", "", 5, null, `${RUN_ID}/..`, { id: RUN_ID }]) {
      expect(() => ipc.getRun(SHELL, ID, bad)).toThrow("Invalid run id.");
    }
    for (const bad of [0, -1, 1.5, 1001, "10", NaN]) {
      expect(() => ipc.listNotes(SHELL, ID, bad)).toThrow("Invalid note limit.");
    }
    for (const bad of ["true", 1, null, undefined, {}]) {
      expect(() => ipc.setKillSwitch(SHELL, bad)).toThrow("kill switch must be on or off");
    }
    expect(() => ipc.runNow(SHELL, "nope")).toThrow("Invalid routine id.");
    expect(deps.core.getRoutineRun).not.toHaveBeenCalled();
    expect(deps.core.listRoutineNotes).not.toHaveBeenCalled();
    expect(deps.core.setRoutineKillSwitch).not.toHaveBeenCalled();
    expect(deps.core.runRoutineNow).not.toHaveBeenCalled();
  });

  it("validates the routine model choice before the core", async () => {
    const { deps, ipc } = setup();
    await ipc.getModel(SHELL);
    await ipc.setModel(SHELL, { cli: "claude" });
    await ipc.setModel(SHELL, { cli: "claude", model: "haiku" });
    await ipc.setModel(SHELL, { cli: "ollama", model: "llama3.2:3b" });
    await ipc.setModel(SHELL, null);
    expect(deps.core.setRoutineModel).toHaveBeenNthCalledWith(1, { cli: "claude" });
    expect(deps.core.setRoutineModel).toHaveBeenNthCalledWith(2, { cli: "claude", model: "haiku" });
    expect(deps.core.setRoutineModel).toHaveBeenNthCalledWith(3, { cli: "ollama", model: "llama3.2:3b" });
    expect(deps.core.setRoutineModel).toHaveBeenNthCalledWith(4, null);
    const calls = deps.core.setRoutineModel.mock.calls.length;
    const bad: unknown[] = [
      undefined,
      "claude",
      [],
      {},
      { cli: "bash" },
      { cli: "claude", model: "--dangerously-skip-permissions" },
      { cli: "claude", model: "-x" },
      { cli: "claude", model: "a b" },
      { cli: "claude", model: "a".repeat(81) },
      { cli: "claude", model: 5 },
      { cli: "ollama" }
    ];
    for (const value of bad) expect(() => ipc.setModel(SHELL, value)).toThrow();
    expect(deps.core.setRoutineModel).toHaveBeenCalledTimes(calls);
  });

  it("does not call the core with a malformed id", () => {
    const { deps, ipc } = setup();
    expect(() => ipc.approve(SHELL, "../../x")).toThrow("Invalid routine id.");
    expect(deps.core.approveRoutine).not.toHaveBeenCalled();
  });

  it("lets a core error (an illegal transition) reach the shell", () => {
    const { deps, ipc } = setup();
    deps.core.pauseRoutine.mockImplementation(() => {
      throw new Error("Can't pause a routine that is proposed.");
    });
    expect(() => ipc.pause(SHELL, ID)).toThrow("Can't pause a routine that is proposed.");
  });

  it("validates grants and action ids before the core, and only for the shell", async () => {
    const { deps, ipc } = setup();
    const grants = { effects: { add_item: { mode: "auto", perDay: 2, perRun: 1 } }, protect: ["Star"] };
    ipc.approve(SHELL, ID, grants);
    expect(deps.core.approveRoutine).toHaveBeenLastCalledWith(ID, { effects: { add_item: { mode: "auto", perDay: 2, perRun: 1 } }, protect: ["Star"] });
    ipc.approve(SHELL, ID);
    expect(deps.core.approveRoutine).toHaveBeenLastCalledWith(ID);
    ipc.setGrants(SHELL, ID, grants);
    expect(deps.core.setRoutineGrants).toHaveBeenCalledTimes(1);
    const bad: unknown[] = [
      { effects: { offer: { mode: "auto" } }, protect: [] },
      { effects: { add_item: { mode: "auto", perDay: 51 } } },
      { effects: { add_item: { mode: "auto", perRun: 0 } } },
      { effects: { nope: { mode: "ask" } } },
      { protect: Array.from({ length: 51 }, (_, i) => `n${i}`) },
      { protect: ["x".repeat(81)] },
      { protect: [5] },
      { extra: 1 },
      "all",
      []
    ];
    for (const g of bad) {
      expect(() => ipc.setGrants(SHELL, ID, g)).toThrow();
      expect(() => ipc.approve(SHELL, ID, g)).toThrow();
    }
    expect(deps.core.setRoutineGrants).toHaveBeenCalledTimes(1);
    await ipc.approveAction(SHELL, ID, ACTION);
    ipc.declineAction(SHELL, ID, ACTION);
    ipc.listActions(SHELL, ID);
    for (const badId of ["../x", "", 5, null, `${ACTION}/..`]) {
      expect(() => ipc.declineAction(SHELL, ID, badId)).toThrow("Invalid action id.");
      expect(() => ipc.approveAction(SHELL, ID, badId)).toThrow("Invalid action id.");
    }
    const stranger = {};
    expect(() => ipc.setGrants(stranger, ID, grants)).toThrow("only available");
    expect(() => ipc.approveAction(stranger, ID, ACTION)).toThrow("only available");
    expect(() => ipc.declineAction(stranger, ID, ACTION)).toThrow("only available");
    expect(() => ipc.listActions(stranger, ID)).toThrow("only available");
    expect(deps.core.approveRoutineAction).toHaveBeenCalledTimes(1);
  });
});
