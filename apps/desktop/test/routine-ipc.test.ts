import { describe, expect, it, vi } from "vitest";

import type { RoutineSummary } from "../../../packages/shared/src/index.js";
import { createRoutineIpc, parseRoutineId, type RoutineIpcDeps } from "../src/main/routine-ipc.js";

const SHELL = { shell: true };
const ID = "rt-20261017-093000-abcdef01";
const SUMMARY = { id: ID, state: "approved" } as RoutineSummary;

function setup() {
  const deps = {
    core: {
      listRoutines: vi.fn(() => [SUMMARY]),
      getRoutine: vi.fn(() => ({ ...SUMMARY, specJson: "{}" }) as never),
      getRoutineEngineStatus: vi.fn(() => ({ enabled: false, reason: "not yet" })),
      approveRoutine: vi.fn(() => SUMMARY),
      rejectRoutine: vi.fn(() => SUMMARY),
      pauseRoutine: vi.fn(() => SUMMARY),
      resumeRoutine: vi.fn(() => SUMMARY),
      stopRoutine: vi.fn(() => SUMMARY),
      deleteRoutine: vi.fn(() => true)
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
    expect(ipc.engineStatus(SHELL)).toEqual({ enabled: false, reason: "not yet" });
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
      () => ipc.approve(undefined, ID)
    ];
    for (const call of calls) expect(call).toThrow("only available from the HelmStack window");
    for (const fn of Object.values(deps.core)) expect(fn).not.toHaveBeenCalled();
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
});
