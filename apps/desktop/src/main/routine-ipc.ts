/**
 * Shell-side routine actions (list, read, approve, reject, pause, resume, stop, delete).
 *
 * Routines are proposed by agents and decided by the human. The renderer only ever sends a
 * routine id; it never supplies spec content. The id is validated here, the sender must be
 * the shell window, and every state change goes through the core's state machine (which throws
 * a clear message for an illegal move). Running, cancelling, clearing memory and the kill
 * switch are human-only too: they exist here and over IPC, never as an agent HTTP route.
 */
import {
  ROUTINE_LIBRARY_LIMITS,
  type AddRoutineDocInput,
  type RoutineAction,
  type RoutineDetail,
  type RoutineDoc,
  type RoutineDocDetail,
  type RoutineEngineStatus,
  type RoutineGrants,
  type RoutineMemory,
  type RoutineModelChoice,
  type RoutineModelStatus,
  type RoutineNote,
  type RoutineRunDetail,
  type RoutineRunSummary,
  type RoutineSummary
} from "../../../../packages/shared/src/index.js";
import { isValidActionId } from "../../../../packages/devtools-core/src/core/routines/action-service.js";
import { parseGrants } from "../../../../packages/devtools-core/src/core/routines/grants.js";
import { parseRoutineModelChoice } from "../../../../packages/devtools-core/src/core/routines/routine-model.js";
import { isValidRunId } from "../../../../packages/devtools-core/src/core/stores/routine-data-store.js";
import { isValidDocId } from "../../../../packages/devtools-core/src/core/stores/routine-library-store.js";
import { isValidRoutineId } from "../../../../packages/devtools-core/src/core/stores/routine-store.js";

export type RoutineIpcDeps = {
  core: {
    listRoutines(): RoutineSummary[];
    getRoutine(id: string): RoutineDetail | null;
    getRoutineEngineStatus(): RoutineEngineStatus;
    approveRoutine(id: string, grants?: RoutineGrants): RoutineSummary;
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
    setRoutineGrants(id: string, grants: RoutineGrants): RoutineDetail;
    listRoutineActions(id: string): RoutineAction[];
    approveRoutineAction(id: string, actionId: string): Promise<RoutineAction>;
    declineRoutineAction(id: string, actionId: string): RoutineAction;
    listRoutineDocs(id: string): RoutineDoc[];
    getRoutineDoc(id: string, docId: string): RoutineDocDetail | null;
    addRoutineDoc(id: string, doc: AddRoutineDocInput): RoutineDoc;
    approveRoutineDoc(id: string, docId: string): RoutineDoc;
    deleteRoutineDoc(id: string, docId: string): void;
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

export function parseActionId(value: unknown): string {
  if (!isValidActionId(value)) throw new Error("Invalid action id.");
  return value;
}

/**
 * What the human lets a routine do without asking, as sent by the renderer. Strictly checked here
 * (unknown fields, bad numbers, `auto` on an effect that always asks, more than 50 names...) and
 * again by the core: the renderer's value is never trusted as it arrives.
 */
export function parseGrantsInput(value: unknown): RoutineGrants {
  const parsed = parseGrants(value);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.grants;
}

export function parseDocId(value: unknown): string {
  if (!isValidDocId(value)) throw new Error("Invalid document id.");
  return value;
}

/**
 * A document from the renderer: exactly `{ title, text, source? }`, all text, within size bounds
 * (the store applies the precise limits again after normalising the text). Anything else is refused.
 */
export function parseDocInput(value: unknown): AddRoutineDocInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("A document must be an object.");
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o)) if (key !== "title" && key !== "text" && key !== "source") throw new Error(`Unknown document field "${key}".`);
  const L = ROUTINE_LIBRARY_LIMITS;
  if (typeof o.title !== "string" || o.title.trim() === "") throw new Error("A document needs a title.");
  if (o.title.length > L.titleChars) throw new Error(`The title is longer than ${L.titleChars} characters.`);
  if (typeof o.text !== "string" || o.text.trim() === "") throw new Error("A document needs text.");
  if (o.text.length > L.docChars * 2) throw new Error(`The text is longer than ${L.docChars} characters.`);
  if (o.source !== undefined && typeof o.source !== "string") throw new Error("The source must be text.");
  if (typeof o.source === "string" && o.source.length > L.sourceChars) throw new Error(`The source is longer than ${L.sourceChars} characters.`);
  return { title: o.title, text: o.text, ...(typeof o.source === "string" && o.source.trim() !== "" ? { source: o.source } : {}) };
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
    approve(sender: unknown, rawId: unknown, rawGrants?: unknown): RoutineSummary {
      guard(sender);
      const id = parseRoutineId(rawId);
      if (rawGrants === undefined || rawGrants === null) return deps.core.approveRoutine(id);
      return deps.core.approveRoutine(id, parseGrantsInput(rawGrants));
    },
    setGrants(sender: unknown, rawId: unknown, rawGrants: unknown): RoutineDetail {
      guard(sender);
      return deps.core.setRoutineGrants(parseRoutineId(rawId), parseGrantsInput(rawGrants));
    },
    listActions(sender: unknown, rawId: unknown): RoutineAction[] {
      guard(sender);
      return deps.core.listRoutineActions(parseRoutineId(rawId));
    },
    approveAction(sender: unknown, rawId: unknown, rawActionId: unknown): Promise<RoutineAction> {
      guard(sender);
      return deps.core.approveRoutineAction(parseRoutineId(rawId), parseActionId(rawActionId));
    },
    declineAction(sender: unknown, rawId: unknown, rawActionId: unknown): RoutineAction {
      guard(sender);
      return deps.core.declineRoutineAction(parseRoutineId(rawId), parseActionId(rawActionId));
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
    listDocs(sender: unknown, rawId: unknown): RoutineDoc[] {
      guard(sender);
      return deps.core.listRoutineDocs(parseRoutineId(rawId));
    },
    getDoc(sender: unknown, rawId: unknown, rawDocId: unknown): RoutineDocDetail | null {
      guard(sender);
      return deps.core.getRoutineDoc(parseRoutineId(rawId), parseDocId(rawDocId));
    },
    addDoc(sender: unknown, rawId: unknown, rawDoc: unknown): RoutineDoc {
      guard(sender);
      return deps.core.addRoutineDoc(parseRoutineId(rawId), parseDocInput(rawDoc));
    },
    approveDoc(sender: unknown, rawId: unknown, rawDocId: unknown): RoutineDoc {
      guard(sender);
      return deps.core.approveRoutineDoc(parseRoutineId(rawId), parseDocId(rawDocId));
    },
    deleteDoc(sender: unknown, rawId: unknown, rawDocId: unknown): void {
      guard(sender);
      deps.core.deleteRoutineDoc(parseRoutineId(rawId), parseDocId(rawDocId));
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
