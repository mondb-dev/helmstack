/**
 * Shell-side routine actions (list, read, approve, reject, pause, resume, stop, delete).
 *
 * Routines are proposed by agents and decided by the human. The renderer only ever sends a
 * routine id; it never supplies spec content. The id is validated here, the sender must be
 * the shell window, and every state change goes through the core's state machine (which throws
 * a clear message for an illegal move). Running, cancelling, clearing memory and the kill
 * switch are human-only too: they exist here and over IPC, never as an agent HTTP route.
 */
import type {
  RoutineDetail,
  RoutineEngineStatus,
  RoutineMemory,
  RoutineModelChoice,
  RoutineModelStatus,
  RoutineNote,
  RoutineRunDetail,
  RoutineRunSummary,
  RoutineSummary
} from "../../../../packages/shared/src/index.js";
import { parseRoutineModelChoice } from "../../../../packages/devtools-core/src/core/routines/routine-model.js";
import { isValidRunId } from "../../../../packages/devtools-core/src/core/stores/routine-data-store.js";
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
    runRoutineNow(id: string): RoutineRunSummary;
    cancelRoutineRun(id: string): void;
    listRoutineRuns(id: string): RoutineRunSummary[];
    getRoutineRun(id: string, runId: string): RoutineRunDetail | null;
    listRoutineNotes(id: string, limit?: number): RoutineNote[];
    getRoutineMemory(id: string): RoutineMemory;
    clearRoutineMemory(id: string): void;
    setRoutineKillSwitch(on: boolean): RoutineEngineStatus;
    getRoutineModel(): Promise<RoutineModelStatus>;
    setRoutineModel(choice: RoutineModelChoice | null): Promise<RoutineModelStatus>;
  };
  /** True when the IPC sender is the shell window's own renderer. */
  isShellSender(sender: unknown): boolean;
};

export function parseRoutineId(value: unknown): string {
  if (!isValidRoutineId(value)) throw new Error("Invalid routine id.");
  return value;
}

export function parseRunId(value: unknown): string {
  if (!isValidRunId(value)) throw new Error("Invalid run id.");
  return value;
}

/** Optional note count: a whole number from 1 to 1000, otherwise the default. */
export function parseNoteLimit(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1000) throw new Error("Invalid note limit.");
  return value;
}

export function parseSwitch(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("The kill switch must be on or off.");
  return value;
}

/**
 * The model for routine judgments: null clears it; otherwise a runtime from the agent CLI list and,
 * if given, a model id that starts with a letter or digit (so it can never be read as a flag).
 */
export function parseModelChoice(value: unknown): RoutineModelChoice | null {
  if (value === null) return null;
  return parseRoutineModelChoice(value);
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
    },
    runNow(sender: unknown, rawId: unknown): RoutineRunSummary {
      guard(sender);
      return deps.core.runRoutineNow(parseRoutineId(rawId));
    },
    cancelRun(sender: unknown, rawId: unknown): void {
      guard(sender);
      deps.core.cancelRoutineRun(parseRoutineId(rawId));
    },
    listRuns(sender: unknown, rawId: unknown): RoutineRunSummary[] {
      guard(sender);
      return deps.core.listRoutineRuns(parseRoutineId(rawId));
    },
    getRun(sender: unknown, rawId: unknown, rawRunId: unknown): RoutineRunDetail | null {
      guard(sender);
      return deps.core.getRoutineRun(parseRoutineId(rawId), parseRunId(rawRunId));
    },
    listNotes(sender: unknown, rawId: unknown, rawLimit?: unknown): RoutineNote[] {
      guard(sender);
      return deps.core.listRoutineNotes(parseRoutineId(rawId), parseNoteLimit(rawLimit));
    },
    memory(sender: unknown, rawId: unknown): RoutineMemory {
      guard(sender);
      return deps.core.getRoutineMemory(parseRoutineId(rawId));
    },
    clearMemory(sender: unknown, rawId: unknown): void {
      guard(sender);
      deps.core.clearRoutineMemory(parseRoutineId(rawId));
    },
    setKillSwitch(sender: unknown, rawOn: unknown): RoutineEngineStatus {
      guard(sender);
      return deps.core.setRoutineKillSwitch(parseSwitch(rawOn));
    },
    getModel(sender: unknown): Promise<RoutineModelStatus> {
      guard(sender);
      return deps.core.getRoutineModel();
    },
    setModel(sender: unknown, rawChoice: unknown): Promise<RoutineModelStatus> {
      guard(sender);
      return deps.core.setRoutineModel(parseModelChoice(rawChoice));
    }
  };
}
