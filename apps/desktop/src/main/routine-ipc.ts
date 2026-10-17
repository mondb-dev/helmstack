/**
 * Shell-side routine actions (list, read, approve, reject, pause, resume, stop, delete).
 *
 * Routines are proposed by agents and decided by the human. The renderer only ever sends a
 * routine id; it never supplies spec content. The id is validated here, the sender must be
 * the shell window, and every state change goes through the core's state machine (which throws
 * a clear message for an illegal move). Nothing here runs a routine.
 */
import type { RoutineDetail, RoutineEngineStatus, RoutineSummary } from "../../../../packages/shared/src/index.js";
import { isValidRoutineId } from "../../../../packages/devtools-core/src/core/stores/routine-store.js";

export type RoutineIpcDeps = {
  core: {
    listRoutines(): RoutineSummary[];
    getRoutine(id: string): RoutineDetail | null;
    getRoutineEngineStatus(): RoutineEngineStatus;
    approveRoutine(id: string): RoutineSummary;
    rejectRoutine(id: string): RoutineSummary;
    pauseRoutine(id: string): RoutineSummary;
    resumeRoutine(id: string): RoutineSummary;
    stopRoutine(id: string): RoutineSummary;
    deleteRoutine(id: string): boolean;
  };
  /** True when the IPC sender is the shell window's own renderer. */
  isShellSender(sender: unknown): boolean;
};

export function parseRoutineId(value: unknown): string {
  if (!isValidRoutineId(value)) throw new Error("Invalid routine id.");
  return value;
}

export function createRoutineIpc(deps: RoutineIpcDeps) {
  const guard = (sender: unknown): void => {
    if (!deps.isShellSender(sender)) throw new Error("Routines are only available from the HelmStack window.");
  };

  return {
    list(sender: unknown): RoutineSummary[] {
      guard(sender);
      return deps.core.listRoutines();
    },
    get(sender: unknown, rawId: unknown): RoutineDetail | null {
      guard(sender);
      return deps.core.getRoutine(parseRoutineId(rawId));
    },
    engineStatus(sender: unknown): RoutineEngineStatus {
      guard(sender);
      return deps.core.getRoutineEngineStatus();
    },
    approve(sender: unknown, rawId: unknown): RoutineSummary {
      guard(sender);
      return deps.core.approveRoutine(parseRoutineId(rawId));
    },
    reject(sender: unknown, rawId: unknown): RoutineSummary {
      guard(sender);
      return deps.core.rejectRoutine(parseRoutineId(rawId));
    },
    pause(sender: unknown, rawId: unknown): RoutineSummary {
      guard(sender);
      return deps.core.pauseRoutine(parseRoutineId(rawId));
    },
    resume(sender: unknown, rawId: unknown): RoutineSummary {
      guard(sender);
      return deps.core.resumeRoutine(parseRoutineId(rawId));
    },
    stop(sender: unknown, rawId: unknown): RoutineSummary {
      guard(sender);
      return deps.core.stopRoutine(parseRoutineId(rawId));
    },
    delete(sender: unknown, rawId: unknown): void {
      guard(sender);
      deps.core.deleteRoutine(parseRoutineId(rawId));
    }
  };
}
