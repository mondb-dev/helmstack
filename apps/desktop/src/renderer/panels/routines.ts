/**
 * "Routines" tab of the right-hand panel: procedures an agent has proposed from
 * the user's request. The human reviews each one in plain language and approves
 * or rejects it here; agents cannot. In this version nothing runs a routine, so
 * the tab says so and never describes an approved routine as active while the
 * engine is off.
 *
 * Everything that came from a model or a spec (title, request, hosts, lines,
 * risk messages, spec JSON, agent id) is rendered with textContent only.
 */

import type {
  AgentCliInfo,
  AgentRunnerStatus,
  BrowserShellBridge,
  RoutineDetail,
  RoutineEngineStatus,
  RoutineMemory,
  RoutineModelChoice,
  RoutineModelStatus,
  RoutineNote,
  RoutineRisk,
  RoutineRiskLevel,
  RoutineRunDetail,
  RoutineRunStatus,
  RoutineRunSummary,
  RoutineState,
  RoutineSummary,
} from "../../../../../packages/shared/src/index.js";
import { openDialog, type DialogHandle } from "../ui/dialog.js";
import { plural, relativeTime } from "../ui/format.js";
import { icon, type IconName } from "../ui/icons.js";
import { toast } from "../ui/toast.js";

type RoutinesBridgeCore = Pick<
  BrowserShellBridge,
  | "listRoutines"
  | "getRoutine"
  | "getRoutineEngineStatus"
  | "approveRoutine"
  | "rejectRoutine"
  | "pauseRoutine"
  | "resumeRoutine"
  | "stopRoutine"
  | "deleteRoutine"
  | "onRoutinesChanged"
>;

/** Phase 2 (running routines). Feature-detected at call time so an older preload still works. */
type RoutinesBridgeRun = Pick<
  BrowserShellBridge,
  | "runRoutineNow"
  | "cancelRoutineRun"
  | "listRoutineRuns"
  | "getRoutineRun"
  | "listRoutineNotes"
  | "getRoutineMemory"
  | "clearRoutineMemory"
  | "setRoutineKillSwitch"
  | "onRoutineRunUpdated"
  | "openTab"
>;

/** Phase 3 (model for judgment calls). Feature-detected at call time. */
type RoutinesBridgeModel = Pick<
  BrowserShellBridge,
  "getRoutineModel" | "setRoutineModel" | "getAgentRunnerStatus" | "refreshAgentRunner"
>;

export type RoutinesBridge = RoutinesBridgeCore & Partial<RoutinesBridgeRun> & Partial<RoutinesBridgeModel>;

/** True when the preload bridge exposes every routine method. */
export function routinesSupported(bridge: Partial<RoutinesBridge>): bridge is RoutinesBridge {
  return (
    typeof bridge.listRoutines === "function" &&
    typeof bridge.getRoutine === "function" &&
    typeof bridge.getRoutineEngineStatus === "function" &&
    typeof bridge.approveRoutine === "function" &&
    typeof bridge.rejectRoutine === "function" &&
    typeof bridge.pauseRoutine === "function" &&
    typeof bridge.resumeRoutine === "function" &&
    typeof bridge.stopRoutine === "function" &&
    typeof bridge.deleteRoutine === "function" &&
    typeof bridge.onRoutinesChanged === "function"
  );
}

export const ROUTINE_ROW_CAP = 100;
export const ENGINE_FALLBACK_REASON = "Routines can be reviewed and approved, but running them isn't available yet.";
const INTENT_LIMIT = 140;
const HOST_CHIP_LIMIT = 6;
const TICK_MS = 1000;
export const RUN_CAP = 20;
export const NOTE_CAP = 25;
export const NOTE_FIELD_CAP = 12;
export const LOG_CAP = 200;
const MEMORY_PREFETCH_CAP = 30;
const VALUE_LIMIT = 200;
const SUMMARY_LIMIT = 160;
const URL_LIMIT = 80;
export const MODEL_EXPLANATION =
  "Routines use this model to decide things like whether an update matters. It reads page text and answers with a verdict; it can't click or open anything.";
const LOCAL_LABEL = "local, runs on this computer";
const DEFAULT_MODEL = "__default__";

/** True when a routine's preview says it makes judgment calls. */
export function hasJudgment(routine: RoutineSummary): boolean {
  return (routine.preview?.risks ?? []).some((risk) => risk.code === "judged_by_model");
}

const modelValue = (cli: string, model?: string): string => `${cli}::${model ?? DEFAULT_MODEL}`;
function parseModelValue(value: string): RoutineModelChoice | null {
  const index = value.indexOf("::");
  if (index <= 0) return null;
  const cli = value.slice(0, index);
  const model = value.slice(index + 2);
  return model === DEFAULT_MODEL || model === "" ? { cli } : { cli, model };
}

const RUN_STATUS_WORD: Record<RoutineRunStatus, string> = {
  running: "Running",
  completed: "Completed",
  stopped: "Stopped",
  budget: "Stopped at its limit",
  needs_human: "Needs you",
  failed: "Failed",
  cancelled: "Cancelled",
};

function statusWord(status: RoutineRunStatus): string {
  return RUN_STATUS_WORD[status] ?? "Ended";
}

/** "in 5m", "in 2h", "in a moment". */
export function untilText(at: number, nowMs: number): string {
  const seconds = Math.round((at - nowMs) / 1000);
  if (seconds <= 1) return "in a moment";
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.floor(hours / 24)}d`;
}

/** Only plain web pages get an Open link. */
function openableUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

interface DetailData {
  runs: RoutineRunSummary[] | null;
  runsError?: string;
  notes: RoutineNote[] | null;
  notesError?: string;
  memoryError?: string;
}

interface LogData {
  detail: RoutineRunDetail | null;
  loading: boolean;
  error?: string;
}

type SectionId = "review" | "approved" | "paused" | "closed";
interface SectionDef {
  id: SectionId;
  title: string;
  states: RoutineState[];
  collapsible?: boolean;
}

const SECTIONS: SectionDef[] = [
  { id: "review", title: "Needs review", states: ["proposed"] },
  { id: "approved", title: "Approved", states: ["approved"] },
  { id: "paused", title: "Paused", states: ["paused"] },
  { id: "closed", title: "Stopped / rejected", states: ["stopped", "rejected"], collapsible: true },
];

const LEVEL_WORD: Record<RoutineRiskLevel, string> = { high: "High", warning: "Warning", info: "Info" };
const LEVEL_ICON: Record<RoutineRiskLevel, IconName> = { high: "shield-alert", warning: "triangle-alert", info: "info" };
const LEVEL_RANK: Record<RoutineRiskLevel, number> = { high: 0, warning: 1, info: 2 };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string, action: string, ariaLabel?: string): HTMLButtonElement {
  const node = el("button", `btn btn--sm ${className}`, label);
  node.type = "button";
  node.dataset.action = action;
  if (ariaLabel) node.setAttribute("aria-label", ariaLabel);
  return node;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max).trimEnd()}…`;
}

function levelIcon(level: RoutineRiskLevel): SVGSVGElement {
  const node = icon(LEVEL_ICON[level], { size: 14 });
  node.setAttribute("aria-hidden", "true");
  return node;
}

export function highestRisk(risks: RoutineRisk[]): RoutineRiskLevel | null {
  let best: RoutineRiskLevel | null = null;
  for (const risk of risks) {
    if (best === null || LEVEL_RANK[risk.level] < LEVEL_RANK[best]) best = risk.level;
  }
  return best;
}

/** High first; otherwise the original order. */
export function sortRisks(risks: RoutineRisk[]): RoutineRisk[] {
  return risks
    .map((risk, index) => ({ risk, index }))
    .sort((a, b) => LEVEL_RANK[a.risk.level] - LEVEL_RANK[b.risk.level] || a.index - b.index)
    .map((entry) => entry.risk);
}

export interface RoutinesOptions {
  bridge: RoutinesBridge;
  root?: ParentNode;
  /** Called whenever the number of routines waiting for review changes. */
  onNeedsReviewChange?: (count: number) => void;
  /** Bring the Routines tab on screen (used by the notification's Review action). */
  onReveal?: () => void;
  /** The review dialog opened/closed: hide and restore the native page view. */
  onDialogOpen?: () => void;
  onDialogClose?: () => void;
  now?: () => number;
}

export interface RoutinesController {
  refresh(): Promise<void>;
  handleChanged(routines: RoutineSummary[], proposed?: RoutineSummary): void;
  /** The tab was shown: re-sync. */
  show(): void;
  needsReview(): number;
  openReview(id: string, opener?: HTMLElement | null): void;
  destroy(): void;
}

interface ReviewState {
  summary: RoutineSummary;
  handle: DialogHandle | null;
  busy: boolean;
  spec: "idle" | "loading" | "done";
}

export function mountRoutines(options: RoutinesOptions): RoutinesController {
  const { bridge } = options;
  const root = options.root ?? document;
  const found = root.querySelector<HTMLElement>("#routines-body");
  const modal = root.querySelector<HTMLElement>("#routine-review-modal");
  const backdrop = root.querySelector<HTMLElement>("#routine-review-backdrop");
  const titleNode = root.querySelector<HTMLElement>("#routine-review-title");
  const metaNode = root.querySelector<HTMLElement>("#routine-review-meta");
  const bodyNode = root.querySelector<HTMLElement>("#routine-review-body");
  const gateNode = root.querySelector<HTMLElement>("#routine-review-gate");
  const cancelButton = root.querySelector<HTMLButtonElement>("#routine-review-cancel");
  const rejectButton = root.querySelector<HTMLButtonElement>("#routine-review-reject");
  const approveButton = root.querySelector<HTMLButtonElement>("#routine-review-approve");
  if (!found || !modal || !titleNode || !metaNode || !bodyNode || !gateNode || !cancelButton || !rejectButton || !approveButton) {
    throw new Error("Routines markup missing");
  }
  const host: HTMLElement = found;
  const dialogEl: HTMLElement = modal;
  const titleEl: HTMLElement = titleNode;
  const metaEl: HTMLElement = metaNode;
  const bodyEl: HTMLElement = bodyNode;
  const gateEl: HTMLElement = gateNode;
  const approveBtn: HTMLButtonElement = approveButton;
  const rejectBtn: HTMLButtonElement = rejectButton;
  const cancelBtn: HTMLButtonElement = cancelButton;
  const now = options.now ?? Date.now;

  let routines: RoutineSummary[] = [];
  let engine: RoutineEngineStatus | null = null;
  let needs = 0;
  let confirming: { id: string; kind: "stop" | "delete" } | null = null;
  let closedOpen = false;
  const expandedIntent = new Set<string>();
  const notified = new Set<string>();
  const busyRows = new Set<string>();
  let review: ReviewState | null = null;
  let destroyed = false;
  // Phase 2 state (runs, notes, memory). Everything here is cleared on destroy.
  const running = new Set<string>();
  const cancelling = new Set<string>();
  const detailOpen = new Set<string>();
  const details = new Map<string, DetailData>();
  const memories = new Map<string, RoutineMemory>();
  const lastRuns = new Map<string, RoutineRunSummary>();
  const openRuns = new Map<string, string>();
  const logs = new Map<string, LogData>();
  const rowErrors = new Map<string, string>();
  let forgetting: string | null = null;
  let killBusy = false;
  let bannerError = "";
  // Phase 3: model for judgment calls.
  let modelStatus: RoutineModelStatus | null = null;
  let modelLoaded = false;
  let modelLoadError = "";
  let modelError = "";
  let modelBusy = false;
  let runner: AgentRunnerStatus | null = null;
  let runnerError = "";
  let modelDraft = "";

  const canRun = (): boolean => typeof bridge.runRoutineNow === "function";
  const canKill = (): boolean => typeof bridge.setRoutineKillSwitch === "function";
  const canDetail = (): boolean => typeof bridge.listRoutineRuns === "function";
  const isKilled = (): boolean => engine?.killed === true;
  const canModel = (): boolean => typeof bridge.getRoutineModel === "function" && typeof bridge.setRoutineModel === "function";

  const engineOn = (): boolean => engine?.enabled === true;

  const updateNeeds = (): void => {
    const next = routines.filter((routine) => routine.state === "proposed").length;
    if (next !== needs) {
      needs = next;
      options.onNeedsReviewChange?.(needs);
    }
  };

  const sortedFor = (def: SectionDef): RoutineSummary[] =>
    routines.filter((routine) => def.states.includes(routine.state)).sort((a, b) => b.updatedAt - a.updatedAt);

  const titleOf = (id: string | undefined): string => {
    const match = id ? routines.find((routine) => routine.id === id) : undefined;
    return match ? match.title : "an earlier routine";
  };

  // ── focus helpers ─────────────────────────────────────────────────────────
  const rowNode = (id: string): HTMLElement | null =>
    Array.from(host.querySelectorAll<HTMLElement>(".routine-row")).find((node) => node.dataset.routineId === id) ?? null;

  const visibleOrder = (): string[] =>
    Array.from(host.querySelectorAll<HTMLElement>(".routine-row")).map((node) => node.dataset.routineId ?? "");

  const focusRow = (id: string): boolean => {
    const target = rowNode(id)?.querySelector<HTMLElement>("button[data-action]:not(:disabled)");
    target?.focus();
    return target !== undefined && target !== null;
  };

  /** Focus the row if it still exists, else its nearest surviving neighbour, else the heading. */
  const focusNear = (id: string, order: string[]): void => {
    if (focusRow(id)) return;
    const index = order.indexOf(id);
    const after = index >= 0 ? order.slice(index + 1) : [];
    const before = index >= 0 ? order.slice(0, index).reverse() : [];
    for (const candidate of [...after, ...before]) {
      if (focusRow(candidate)) return;
    }
    host.querySelector<HTMLElement>(".routines__heading")?.focus();
  };

  const killButton = (stopping: boolean): HTMLButtonElement => {
    const node = button(stopping ? "Stop all routines" : "Allow routines again", stopping ? "btn--danger" : "btn--ghost", "kill-toggle");
    return node;
  };

  const bannerAlert = (): HTMLElement => {
    const alert = el("p", "routine-row__error", bannerError);
    alert.setAttribute("role", "alert");
    return alert;
  };

  // ── model for judgment calls ──────────────────────────────────────────────
  const cliLabel = (id: string): string => runner?.clis.find((cli) => cli.id === id)?.label ?? id;

  const describeChoice = (choice: RoutineModelChoice): string => {
    const cli = runner?.clis.find((c) => c.id === choice.cli);
    const where = cli?.kind === "local" ? ` (${LOCAL_LABEL})` : "";
    return `${cliLabel(choice.cli)}${choice.model ? ` · ${choice.model}` : " · default model"}${where}`;
  };

  const buildModelOptions = (select: HTMLSelectElement): void => {
    const groups: HTMLElement[] = [];
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choose a model…";
    const usable = (cli: AgentCliInfo): boolean => cli.available;
    for (const cli of runner?.clis ?? []) {
      const group = document.createElement("optgroup");
      const isLocal = cli.kind === "local";
      group.label = isLocal ? `${cli.label} — ${LOCAL_LABEL}` : cli.label;
      if (!usable(cli)) {
        group.disabled = true;
        const only = document.createElement("option");
        only.disabled = true;
        only.textContent = cli.reason ?? "Unavailable";
        group.append(only);
      } else {
        if (!isLocal || cli.models.length === 0) {
          const def = document.createElement("option");
          def.value = modelValue(cli.id);
          def.textContent = isLocal ? `${cli.label} default (${LOCAL_LABEL})` : "Default model";
          group.append(def);
        }
        for (const model of cli.models) {
          const option = document.createElement("option");
          option.value = modelValue(cli.id, model.id);
          option.textContent = isLocal ? `${model.label} (${LOCAL_LABEL})` : model.label;
          if (model.disabledReason) {
            option.disabled = true;
            option.textContent += ` — ${model.disabledReason}`;
          }
          group.append(option);
        }
      }
      groups.push(group);
    }
    select.replaceChildren(placeholder, ...groups);
    const values = Array.from(select.querySelectorAll<HTMLOptionElement>("option:not([disabled])")).map((o) => o.value);
    select.value = values.includes(modelDraft) ? modelDraft : "";
  };

  const modelAlert = (text: string): HTMLElement => {
    const alert = el("p", "routine-row__error", text);
    alert.setAttribute("role", "alert");
    return alert;
  };

  const buildModelSection = (): HTMLElement => {
    const section = el("section", "routines__model");
    section.setAttribute("aria-labelledby", "routines-model-title");
    const title = el("h3", "routines__model-title", "Model for judgment calls");
    title.id = "routines-model-title";
    const explain = el("p", "routine-row__meta", MODEL_EXPLANATION);
    explain.id = "routines-model-explain";
    section.append(title, explain);

    const status = el("p", "routines__model-status");
    status.dataset.role = "model-status";
    if (modelLoadError) {
      section.append(status, modelAlert(`Couldn't load the model choice — ${modelLoadError}`));
      status.textContent = "Unknown";
    } else if (!modelLoaded) {
      status.textContent = "Loading…";
      section.append(status);
    } else if (!modelStatus?.choice) {
      status.textContent = `No model chosen yet.${modelStatus?.reason ? ` ${modelStatus.reason}` : ""}`;
      section.append(status);
    } else {
      const text = describeChoice(modelStatus.choice);
      status.textContent = modelStatus.available
        ? `Chosen: ${text}. Available now.`
        : `Chosen: ${text}. Not available right now${modelStatus.reason ? ` — ${modelStatus.reason}` : ""}.`;
      section.append(status);
    }

    if (modelLoaded && !modelStatus?.choice && routines.some((r) => r.state === "approved" && hasJudgment(r))) {
      const notice = el("p", "routines__notice routines__model-notice", "An approved routine makes judgment calls. Choose a model above so it can finish those steps.");
      notice.setAttribute("role", "note");
      section.append(notice);
    }

    const field = el("div", "field");
    const label = el("label", "field__label", "Model");
    label.htmlFor = "routines-model-select";
    const row = el("div", "chat__row");
    const select = el("select", "select chat__select");
    select.id = "routines-model-select";
    select.dataset.modelCtl = "select";
    select.setAttribute("aria-describedby", "routines-model-explain");
    select.disabled = modelBusy || !runner;
    buildModelOptions(select);
    row.append(select);
    if (typeof bridge.refreshAgentRunner === "function") {
      const refreshBtn = button("Refresh", "btn--sm btn--ghost", "model-refresh", "Detect installed models again");
      refreshBtn.dataset.modelCtl = "model-refresh";
      refreshBtn.disabled = modelBusy;
      row.append(refreshBtn);
    }
    field.append(label, row);
    section.append(field);
    if (runnerError) section.append(modelAlert(`Couldn't detect models — ${runnerError}`));

    const actions = el("div", "routine-row__actions");
    const save = button(modelBusy ? "Saving…" : "Save", "btn--primary", "model-save");
    save.dataset.modelCtl = "model-save";
    save.disabled = modelBusy || modelDraft === "";
    const clear = button("Clear", "btn--ghost", "model-clear");
    clear.dataset.modelCtl = "model-clear";
    clear.disabled = modelBusy || !modelStatus?.choice;
    actions.append(save, clear);
    section.append(actions);
    if (modelError) section.append(modelAlert(modelError));
    return section;
  };

  // ── list ──────────────────────────────────────────────────────────────────
  const buildHosts = (routine: RoutineSummary): HTMLElement => {
    const list = el("ul", "routine-row__hosts");
    list.setAttribute("aria-label", "Sites this routine may visit");
    if (routine.hosts.length === 0) {
      const chip = el("li", "routine-chip routine-chip--warn");
      chip.append(levelIcon("warning"), "Any site");
      list.append(chip);
      return list;
    }
    for (const hostName of routine.hosts.slice(0, HOST_CHIP_LIMIT)) list.append(el("li", "routine-chip", hostName));
    if (routine.hosts.length > HOST_CHIP_LIMIT) {
      const more = el("li", "routine-chip", `+${routine.hosts.length - HOST_CHIP_LIMIT} more`);
      more.title = routine.hosts.slice(HOST_CHIP_LIMIT).join(", ");
      list.append(more);
    }
    return list;
  };

  const buildRisk = (routine: RoutineSummary): HTMLElement => {
    const risks = routine.preview?.risks ?? [];
    const top = highestRisk(risks);
    if (!top) return el("p", "routine-row__meta", "No risks flagged");
    const node = el("p", `routine-row__risk routine-risk--${top}`);
    node.append(levelIcon(top), `${plural(risks.length, "risk")} · highest: ${LEVEL_WORD[top]}`);
    return node;
  };

  const stateLabel = (routine: RoutineSummary): string => {
    switch (routine.state) {
      case "proposed":
        return "Needs your review";
      case "approved":
        return engineOn() ? "Active" : "Approved — waiting for the engine";
      case "paused":
        return "Paused";
      case "stopped":
        return "Stopped";
      default:
        return "Rejected";
    }
  };

  const buildIntent = (routine: RoutineSummary): HTMLElement => {
    const wrap = el("div", "routine-row__request");
    const long = routine.intent.length > INTENT_LIMIT;
    const open = expandedIntent.has(routine.id);
    wrap.append(el("span", "routine-row__label", "Your request"));
    wrap.append(el("blockquote", "routine-row__quote", `“${long && !open ? clip(routine.intent, INTENT_LIMIT) : routine.intent}”`));
    if (long) {
      const toggle = button(open ? "Show less" : "Show full request", "btn--quiet", "toggle-intent");
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", `${open ? "Show less of" : "Show the full"} request: ${routine.title}`);
      wrap.append(toggle);
    }
    return wrap;
  };

  const detailId = (id: string): string => `routine-detail-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;

  const chipFor = (routine: RoutineSummary): HTMLElement | null => {
    if (routine.state === "paused") return statusChip("Paused", "paused");
    if (routine.state !== "approved") return null;
    if (running.has(routine.id)) return statusChip(cancelling.has(routine.id) ? "Cancelling…" : "Running", "running");
    if (isKilled()) return statusChip("Switched off", "off");
    const memory = memories.get(routine.id);
    if (engineOn() && typeof memory?.nextRunAt === "number") {
      const chip = statusChip(`Next run ${untilText(memory.nextRunAt, now())}`, "next");
      chip.dataset.until = String(memory.nextRunAt);
      chip.dataset.prefix = "Next run ";
      return chip;
    }
    const last = lastRuns.get(routine.id) ?? memory?.lastRun;
    if (last) return statusChip(`Last run: ${statusWord(last.status)}`, last.status === "completed" ? "ok" : last.status === "failed" ? "bad" : "paused");
    if (engineOn() && memory?.notScheduledReason) return statusChip("Won't run on its own", "paused");
    return engineOn() ? statusChip("Not run yet", "paused") : null;
  };

  function statusChip(text: string, tone: string): HTMLElement {
    const chip = el("span", `routine-status routine-status--${tone}`, text);
    return chip;
  }

  const buildActions = (routine: RoutineSummary, confirmId: string): HTMLElement => {
    const actions = el("div", "routine-row__actions");
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", `Actions for ${routine.title}`);
    const busy = busyRows.has(routine.id);

    if (confirming && confirming.id === routine.id) {
      const stop = confirming.kind === "stop";
      const question = el(
        "p",
        "routine-row__confirm",
        stop ? "Stop this routine? A stopped routine can't be started again." : "Delete this routine? This can't be undone."
      );
      question.id = confirmId;
      const yes = button(stop ? "Stop" : "Delete", "btn--danger", "confirm", `${stop ? "Confirm stop" : "Confirm delete"}: ${routine.title}`);
      const no = button("Cancel", "btn--quiet", "cancel-confirm");
      no.setAttribute("aria-describedby", confirmId);
      yes.disabled = busy;
      actions.append(question, yes, no);
      return actions;
    }

    const add = (label: string, cls: string, action: string, aria: string): void => {
      const node = button(label, cls, action, aria);
      node.disabled = busy;
      actions.append(node);
    };
    const addRunControls = (): void => {
      if (!canRun()) return;
      const isRunning = running.has(routine.id);
      const run = button("Run now", "btn--ghost", "run-now", `Run now: ${routine.title}`);
      const why =
        routine.state !== "approved"
          ? "Only an approved routine can run."
          : !engineOn()
            ? "Running isn't available yet."
            : isKilled()
              ? "Routines are switched off."
              : isRunning
                ? "It is already running."
                : "";
      run.disabled = busy || why !== "";
      if (why) run.title = why;
      actions.append(run);
      if (isRunning && typeof bridge.cancelRoutineRun === "function") {
        const stopRun = button(cancelling.has(routine.id) ? "Cancelling…" : "Cancel run", "btn--quiet", "cancel-run", `Cancel the running run: ${routine.title}`);
        stopRun.disabled = busy || cancelling.has(routine.id);
        actions.append(stopRun);
      }
    };
    const addDetails = (): void => {
      if (!canDetail()) return;
      const open = detailOpen.has(routine.id);
      const toggle = button(open ? "Hide details" : "Details", "btn--quiet", "toggle-detail", `${open ? "Hide" : "Show"} runs, notes and memory: ${routine.title}`);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-controls", detailId(routine.id));
      actions.append(toggle);
    };
    switch (routine.state) {
      case "proposed":
        add("Review…", "btn--primary", "review", `Review proposal: ${routine.title}`);
        break;
      case "approved":
        addRunControls();
        add("Pause", "btn--ghost", "pause", `Pause routine: ${routine.title}`);
        add("Stop", "btn--quiet", "stop", `Stop routine: ${routine.title}`);
        addDetails();
        break;
      case "paused":
        addRunControls();
        add("Resume", "btn--ghost", "resume", `Resume routine: ${routine.title}`);
        add("Stop", "btn--quiet", "stop", `Stop routine: ${routine.title}`);
        addDetails();
        break;
      default:
        add("Delete", "btn--quiet", "delete", `Delete routine: ${routine.title}`);
        if (routine.state === "stopped") addDetails();
    }
    return actions;
  };

  // ── details: runs, notes, memory (all text from pages is set with textContent) ─
  const timeNode = (at: number): HTMLElement => {
    const node = el("time", undefined, relativeTime(at, now()));
    node.dataset.at = String(at);
    node.title = new Date(at).toLocaleString();
    return node;
  };

  const clipped = (tag: "span" | "p" | "li", className: string, value: string, max: number): HTMLElement => {
    const node = el(tag, className, clip(value, max));
    if (value.length > max) node.title = clip(value, 1000);
    return node;
  };

  const detailSection = (title: string, count?: number): HTMLElement => {
    const section = el("section", "routine-detail__section");
    section.append(el("h5", "routine-detail__heading", count === undefined ? title : `${title} (${count})`));
    return section;
  };

  const buildLog = (routine: RoutineSummary, run: RoutineRunSummary): HTMLElement => {
    const box = el("div", "routine-log");
    const data = logs.get(run.id);
    if (!data || data.loading) {
      const loading = el("p", "routine-row__meta", "Loading the log…");
      loading.setAttribute("role", "status");
      box.append(loading);
      return box;
    }
    if (data.error || !data.detail) {
      const err = el("p", "routine-row__error", data.error ? `Couldn't load the log — ${data.error}` : "This run's log isn't available.");
      err.setAttribute("role", "alert");
      box.append(err);
      return box;
    }
    const entries = Array.isArray(data.detail.log) ? data.detail.log : [];
    if (entries.length === 0) {
      box.append(el("p", "routine-row__meta", "Nothing was logged for this run."));
      return box;
    }
    const list = el("ol", "routine-log__list");
    list.setAttribute("aria-label", `Log for the run ${relativeTime(run.startedAt, now())} of ${routine.title}`);
    list.tabIndex = 0;
    for (const entry of entries.slice(0, LOG_CAP)) {
      const level = entry.level === "error" || entry.level === "warn" ? entry.level : "info";
      const item = el("li", `routine-log__line routine-log__line--${level}`);
      item.append(el("span", "routine-log__level", level === "info" ? "Info" : level === "warn" ? "Warning" : "Error"));
      const step = typeof entry.step === "string" && entry.step ? `${clip(entry.step, 40)}: ` : "";
      const text = el("span", "routine-log__text", `${step}${clip(String(entry.message ?? ""), 400)}`);
      if (String(entry.message ?? "").length > 400) text.title = clip(String(entry.message), 1000);
      item.append(text);
      list.append(item);
    }
    box.append(list);
    if (entries.length > LOG_CAP) box.append(el("p", "routine-row__meta", `Showing the first ${LOG_CAP} of ${entries.length} lines.`));
    return box;
  };

  const buildRuns = (routine: RoutineSummary, data: DetailData): HTMLElement => {
    const runs = data.runs;
    const section = detailSection("Runs", runs?.length);
    if (data.runsError) {
      const err = el("p", "routine-row__error", `Couldn't load runs — ${data.runsError}`);
      err.setAttribute("role", "alert");
      section.append(err);
      return section;
    }
    if (!runs) {
      section.append(el("p", "routine-row__meta", "Loading…"));
      return section;
    }
    if (runs.length === 0) {
      section.append(el("p", "routine-row__meta", "No runs yet."));
      return section;
    }
    const list = el("ol", "routine-detail__list");
    list.setAttribute("aria-label", `Runs of ${routine.title}, newest first`);
    const open = openRuns.get(routine.id);
    for (const run of runs.slice(0, RUN_CAP)) {
      const item = el("li", "routine-run");
      const toggle = el("button", "routine-run__button");
      toggle.type = "button";
      toggle.dataset.action = "open-run";
      toggle.dataset.runId = run.id;
      toggle.setAttribute("aria-expanded", String(open === run.id));
      toggle.setAttribute("aria-label", `${open === run.id ? "Hide" : "Show"} log: ${statusWord(run.status)}, ${relativeTime(run.startedAt, now())}`);
      const head = el("span", "routine-run__head");
      head.append(statusChip(statusWord(run.status), run.status === "completed" ? "ok" : run.status === "failed" ? "bad" : run.status === "running" ? "running" : "paused"), " ", timeNode(run.startedAt));
      toggle.append(head);
      toggle.append(el("span", "routine-run__counts", `${plural(run.pagesVisited, "page")} · ${plural(run.notesAdded, "note")}`));
      toggle.append(clipped("span", "routine-run__summary", String(run.summary ?? ""), SUMMARY_LIMIT));
      item.append(toggle);
      if (open === run.id) item.append(buildLog(routine, run));
      list.append(item);
    }
    section.append(list);
    if (runs.length > RUN_CAP) section.append(el("p", "routine-row__meta", `Showing the latest ${RUN_CAP} runs.`));
    return section;
  };

  const buildNotes = (routine: RoutineSummary, data: DetailData): HTMLElement => {
    const notes = data.notes;
    const section = detailSection("Notes", notes?.length);
    if (data.notesError) {
      const err = el("p", "routine-row__error", `Couldn't load notes — ${data.notesError}`);
      err.setAttribute("role", "alert");
      section.append(err);
      return section;
    }
    if (!notes) {
      section.append(el("p", "routine-row__meta", "Loading…"));
      return section;
    }
    if (notes.length === 0) {
      section.append(el("p", "routine-row__meta", "Nothing noted yet."));
      return section;
    }
    const list = el("ol", "routine-detail__list");
    list.setAttribute("aria-label", `Notes from ${routine.title}, newest first`);
    for (const note of notes.slice(0, NOTE_CAP)) {
      const item = el("li", "routine-note");
      const head = el("p", "routine-note__head");
      head.append(timeNode(note.at));
      if (note.maybe) head.append(" ", el("span", "routine-status routine-status--paused", "uncertain"));
      item.append(head);
      const url = String(note.url ?? "");
      const line = el("p", "routine-note__url");
      line.append(clipped("span", "routine-note__url-text", url, URL_LIMIT));
      const safe = openableUrl(url);
      if (safe && typeof bridge.openTab === "function") {
        const open = button("Open", "btn--quiet", "open-note-url", `Open this page in a new tab: ${clip(url, 60)}`);
        open.dataset.url = safe;
        line.append(" ", open);
      }
      item.append(line);
      const allFields = Object.entries(note.fields ?? {});
      const confidence = allFields.find(([key]) => String(key).toLowerCase() === "confidence");
      const evidence = allFields.find(([key]) => String(key).toLowerCase() === "evidence");
      if (confidence || evidence) {
        const verdict = el("div", "routine-note__verdict");
        if (confidence) verdict.append(clipped("p", "routine-note__field", `Model's confidence: ${String(confidence[1])}`, VALUE_LIMIT));
        if (evidence) verdict.append(clipped("p", "routine-note__field", `Quote: ${String(evidence[1])}`, VALUE_LIMIT));
        item.append(verdict);
      }
      const fields = allFields.filter((entry) => entry !== confidence && entry !== evidence);
      if (fields.length > 0) {
        const dl = el("ul", "routine-note__fields");
        for (const [key, value] of fields.slice(0, NOTE_FIELD_CAP)) {
          dl.append(clipped("li", "routine-note__field", `${clip(String(key), 40)}: ${String(value)}`, VALUE_LIMIT));
        }
        item.append(dl);
        if (fields.length > NOTE_FIELD_CAP) item.append(el("p", "routine-row__meta", `+${fields.length - NOTE_FIELD_CAP} more fields`));
      }
      list.append(item);
    }
    section.append(list);
    if (notes.length > NOTE_CAP) section.append(el("p", "routine-row__meta", `Showing the latest ${NOTE_CAP} notes.`));
    return section;
  };

  const buildMemory = (routine: RoutineSummary, data: DetailData): HTMLElement => {
    const section = detailSection("Memory");
    const memory = memories.get(routine.id);
    if (data.memoryError) {
      const err = el("p", "routine-row__error", `Couldn't load memory — ${data.memoryError}`);
      err.setAttribute("role", "alert");
      section.append(err);
    } else if (!memory) {
      section.append(el("p", "routine-row__meta", "Loading…"));
    } else {
      const list = el("ul", "routine-detail__facts");
      const sets = Object.entries(memory.sets ?? {});
      const values = Object.entries(memory.values ?? {});
      for (const [key, count] of sets.slice(0, NOTE_FIELD_CAP)) {
        list.append(clipped("li", "routine-note__field", `${clip(key, 40)}: ${plural(Number(count) || 0, "item")} remembered`, VALUE_LIMIT));
      }
      for (const [key, value] of values.slice(0, NOTE_FIELD_CAP)) {
        list.append(clipped("li", "routine-note__field", `${clip(key, 40)}: ${String(value)}`, VALUE_LIMIT));
      }
      if (sets.length + values.length === 0) list.append(el("li", "routine-note__field", "It hasn't remembered anything yet."));
      if (typeof memory.nextRunAt === "number") {
        const next = el("li", "routine-note__field", `Next run ${untilText(memory.nextRunAt, now())}`);
        next.dataset.until = String(memory.nextRunAt);
        next.dataset.prefix = "Next run ";
        list.append(next);
      }
      if (memory.notScheduledReason) list.append(clipped("li", "routine-note__field", memory.notScheduledReason, VALUE_LIMIT));
      section.append(list);
    }
    if (typeof bridge.clearRoutineMemory === "function") {
      if (forgetting === routine.id) {
        const confirmId = `routine-forget-${detailId(routine.id)}`;
        const question = el("p", "routine-row__confirm", "Forget everything this routine has seen? It may report old items as new again. Notes and run history are kept.");
        question.id = confirmId;
        const yes = button("Forget", "btn--danger", "confirm-forget", `Confirm: forget what ${routine.title} has seen`);
        const no = button("Cancel", "btn--quiet", "cancel-forget");
        no.setAttribute("aria-describedby", confirmId);
        yes.disabled = busyRows.has(routine.id);
        const wrap = el("div", "routine-row__actions");
        wrap.append(question, yes, no);
        section.append(wrap);
      } else {
        const forget = button("Forget what it has seen", "btn--quiet", "forget", `Forget what it has seen: ${routine.title}`);
        forget.disabled = busyRows.has(routine.id) || running.has(routine.id);
        if (running.has(routine.id)) forget.title = "Wait for the current run to end.";
        section.append(forget);
      }
    }
    return section;
  };

  function buildDetail(routine: RoutineSummary): HTMLElement {
    const wrap = el("div", "routine-detail");
    wrap.id = detailId(routine.id);
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", `Runs, notes and memory of ${routine.title}`);
    const data = details.get(routine.id) ?? { runs: null, notes: null };
    wrap.append(buildRuns(routine, data), buildNotes(routine, data), buildMemory(routine, data));
    return wrap;
  }

  const buildRow = (routine: RoutineSummary, serial: number): HTMLLIElement => {
    const row = el("li", `routine-row routine-row--${routine.state}`);
    row.dataset.routineId = routine.id;
    row.append(el("h4", "routine-row__title", routine.title));
    const stateLine = el("p", "routine-row__state", stateLabel(routine));
    const chip = chipFor(routine);
    if (chip) stateLine.append(" ", chip);
    row.append(stateLine);
    row.append(buildIntent(routine));
    row.append(el("p", "routine-row__meta", `Trigger: ${routine.trigger}`));
    row.append(buildHosts(routine));
    row.append(buildRisk(routine));

    const who = el("p", "routine-row__meta");
    who.append(`Proposed by ${routine.proposedBy?.trim() || "an agent"} · `);
    const time = el("time", undefined, relativeTime(routine.createdAt, now()));
    time.dataset.at = String(routine.createdAt);
    who.append(time);
    row.append(who);
    if (routine.replaces) row.append(el("p", "routine-row__meta", `Replaces “${titleOf(routine.replaces)}”`));

    row.append(buildActions(routine, `routine-confirm-${serial}`));
    const failure = rowErrors.get(routine.id);
    if (failure) {
      const alert = el("p", "routine-row__error", failure);
      alert.setAttribute("role", "alert");
      row.append(alert);
    }
    if (detailOpen.has(routine.id) && canDetail()) row.append(buildDetail(routine));
    return row;
  };

  function render(): void {
    // Remember what had focus so a re-render never drops it.
    const active = document.activeElement as HTMLElement | null;
    const focusedRow = active && host.contains(active) ? active.closest<HTMLElement>(".routine-row")?.dataset.routineId : undefined;
    const focusedAction = active && host.contains(active) ? active.dataset.action : undefined;
    const focusedSection = active && host.contains(active) ? active.dataset.section : undefined;
    const focusedRun = active && host.contains(active) ? active.dataset.runId : undefined;
    const focusedModel = active && host.contains(active) ? active.dataset.modelCtl : undefined;
    const focusedBanner = active && host.contains(active) && active.dataset.action === "kill-toggle";

    const children: HTMLElement[] = [];
    const heading = el("h3", "sr-only routines__heading", "Routines");
    heading.tabIndex = -1;
    children.push(heading);

    if (isKilled()) {
      const off = el("div", "routines__notice routines__notice--off");
      off.setAttribute("role", "note");
      const glyph = icon("shield-alert", { size: 14 });
      glyph.setAttribute("aria-hidden", "true");
      const text = el("div", "routines__banner-text");
      text.append(el("p", undefined, "Routines are switched off. Nothing will run until you allow routines again."));
      off.append(glyph, text);
      if (canKill()) text.append(killButton(false));
      if (bannerError) text.append(bannerAlert());
      children.push(off);
    } else if (!engineOn()) {
      const notice = el("div", "routines__notice");
      notice.setAttribute("role", "note");
      const glyph = icon("info", { size: 14 });
      glyph.setAttribute("aria-hidden", "true");
      notice.append(glyph, el("p", undefined, engine?.reason?.trim() || ENGINE_FALLBACK_REASON));
      children.push(notice);
    } else if (canKill()) {
      const bar = el("div", "routines__killbar");
      bar.append(el("p", "routines__killbar-text", running.size > 0 ? `${plural(running.size, "routine")} running now` : "Routines are on"), killButton(true));
      if (bannerError) bar.append(bannerAlert());
      children.push(bar);
    }

    if (canModel()) children.push(buildModelSection());

    if (routines.length === 0) {
      const empty = el("div", "routines__empty");
      empty.append(
        el("h3", "routines__empty-title", "No routines yet"),
        el(
          "p",
          undefined,
          "A routine is a set of steps your agent writes for something you want done again and again, like keeping an eye on a page. You read it here in plain language and decide whether to approve it. Agents can propose routines but can't approve them."
        ),
        el("p", undefined, 'Ask your agent: "watch this page for updates on X and note anything new". You can type that in the Chat tab or use any connected agent.')
      );
      children.push(empty);
      host.replaceChildren(...children);
      return;
    }

    let budget = ROUTINE_ROW_CAP;
    let serial = 0;
    let hidden = 0;
    for (const def of SECTIONS) {
      const items = sortedFor(def);
      if (items.length === 0) continue;
      const section = el("section", "routines__section");
      const headingId = `routines-section-${def.id}`;
      section.setAttribute("aria-labelledby", headingId);
      const h = el("h3", "routines__section-title");
      h.id = headingId;
      const collapsed = def.collapsible === true && !closedOpen;
      const list = el("ol", "routines__list");
      list.id = `routines-list-${def.id}`;
      list.setAttribute("aria-label", def.title);
      if (def.collapsible) {
        const toggle = el("button", "routines__toggle");
        toggle.type = "button";
        toggle.dataset.section = def.id;
        toggle.setAttribute("aria-expanded", String(!collapsed));
        toggle.setAttribute("aria-controls", list.id);
        const chevron = icon(collapsed ? "chevron-right" : "chevron-down", { size: 14 });
        chevron.setAttribute("aria-hidden", "true");
        toggle.append(chevron, `${def.title} (${items.length})`);
        h.append(toggle);
      } else {
        h.textContent = `${def.title} (${items.length})`;
      }
      section.append(h);
      list.hidden = collapsed;
      if (!collapsed) {
        const shown = items.slice(0, Math.max(0, budget));
        budget -= shown.length;
        hidden += items.length - shown.length;
        for (const routine of shown) {
          serial += 1;
          list.append(buildRow(routine, serial));
        }
      }
      section.append(list);
      children.push(section);
    }
    if (hidden > 0) {
      children.push(el("p", "routines__footer", `Showing the first ${ROUTINE_ROW_CAP} routines. ${plural(hidden, "more routine")} not shown.`));
    }
    host.replaceChildren(...children);

    if (focusedModel) {
      const target = host.querySelector<HTMLElement>(`[data-model-ctl="${focusedModel}"]`);
      if (target && !(target as HTMLButtonElement).disabled) target.focus();
      else host.querySelector<HTMLElement>('[data-model-ctl="select"]')?.focus();
    } else if (focusedSection) {
      host.querySelector<HTMLElement>(`[data-section="${focusedSection}"]`)?.focus();
    } else if (focusedBanner) {
      host.querySelector<HTMLElement>('[data-action="kill-toggle"]')?.focus();
    } else if (focusedRow) {
      const row = rowNode(focusedRow);
      const same = row
        ? Array.from(row.querySelectorAll<HTMLElement>("button[data-action]")).find(
            (b) => b.dataset.action === focusedAction && (focusedRun === undefined || b.dataset.runId === focusedRun)
          )
        : undefined;
      const usable = same && !(same as HTMLButtonElement).disabled ? same : row?.querySelector<HTMLElement>("button[data-action]:not(:disabled)");
      usable?.focus();
    }
  }

  const setList = (next: RoutineSummary[]): void => {
    routines = Array.isArray(next) ? next : [];
    if (confirming && !routines.some((routine) => routine.id === confirming?.id)) confirming = null;
    for (const id of Array.from(detailOpen)) if (!routines.some((routine) => routine.id === id)) closeDetail(id);
    if (forgetting && !routines.some((routine) => routine.id === forgetting)) forgetting = null;
    updateNeeds();
    render();
    syncReviewWithList();
    void loadMemories(false);
  };

  const upsert = (updated: RoutineSummary): void => {
    const exists = routines.some((routine) => routine.id === updated.id);
    setList(exists ? routines.map((routine) => (routine.id === updated.id ? updated : routine)) : [...routines, updated]);
  };

  // ── row actions ───────────────────────────────────────────────────────────
  const runRowAction = async (
    routine: RoutineSummary,
    action: () => Promise<unknown>,
    outcome: RoutineState | "removed",
    failure: string,
    done?: string
  ): Promise<void> => {
    const order = visibleOrder();
    confirming = null;
    busyRows.add(routine.id);
    render();
    try {
      const result = await action();
      busyRows.delete(routine.id);
      if (outcome === "removed") setList(routines.filter((candidate) => candidate.id !== routine.id));
      else upsert(result && typeof result === "object" ? (result as RoutineSummary) : { ...routine, state: outcome });
      if (done) toast(done, "success");
    } catch (error) {
      busyRows.delete(routine.id);
      toast(`${failure} — ${errorText(error)}`, "error");
      render();
    }
    focusNear(routine.id, order);
  };

  host.addEventListener("change", (event) => {
    const select = event.target as HTMLSelectElement | null;
    if (select?.dataset?.modelCtl !== "select") return;
    modelDraft = select.value;
    const save = host.querySelector<HTMLButtonElement>('[data-model-ctl="model-save"]');
    if (save) save.disabled = modelBusy || modelDraft === "";
  });

  host.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("button");
    if (!target || !host.contains(target)) return;
    if (target.dataset.section === "closed") {
      closedOpen = !closedOpen;
      render();
      return;
    }
    if (target.dataset.action === "kill-toggle") {
      void toggleKill();
      return;
    }
    if (target.dataset.action === "model-save") {
      void saveModel();
      return;
    }
    if (target.dataset.action === "model-clear") {
      void clearModel();
      return;
    }
    if (target.dataset.action === "model-refresh") {
      void loadRunner(true);
      return;
    }
    if (target.dataset.action === "open-note-url") {
      openNote(target.dataset.url ?? "");
      return;
    }
    const id = target.closest<HTMLElement>(".routine-row")?.dataset.routineId;
    const routine = id ? routines.find((candidate) => candidate.id === id) : undefined;
    if (!routine) return;
    switch (target.dataset.action) {
      case "toggle-intent":
        if (!expandedIntent.delete(routine.id)) expandedIntent.add(routine.id);
        render();
        break;
      case "review":
        openReview(routine.id, target);
        break;
      case "run-now":
        void runNow(routine);
        break;
      case "cancel-run":
        void cancelRun(routine);
        break;
      case "toggle-detail":
        if (detailOpen.has(routine.id)) closeDetail(routine.id);
        else openDetail(routine.id);
        render();
        break;
      case "open-run": {
        const runId = target.dataset.runId ?? "";
        if (openRuns.get(routine.id) === runId) {
          openRuns.delete(routine.id);
        } else {
          openRuns.set(routine.id, runId);
          void loadLog(routine.id, runId);
        }
        render();
        break;
      }
      case "forget":
        forgetting = routine.id;
        render();
        rowNode(routine.id)?.querySelector<HTMLElement>('[data-action="cancel-forget"]')?.focus();
        break;
      case "cancel-forget":
        forgetting = null;
        render();
        rowNode(routine.id)?.querySelector<HTMLElement>('[data-action="forget"]')?.focus();
        break;
      case "confirm-forget":
        void forgetMemory(routine);
        break;
      case "pause":
        void runRowAction(routine, () => bridge.pauseRoutine(routine.id), "paused", "Couldn't pause the routine", `Paused “${routine.title}”`);
        break;
      case "resume":
        void runRowAction(routine, () => bridge.resumeRoutine(routine.id), "approved", "Couldn't resume the routine", `Resumed “${routine.title}”`);
        break;
      case "stop":
      case "delete":
        confirming = { id: routine.id, kind: target.dataset.action };
        render();
        rowNode(routine.id)?.querySelector<HTMLElement>('[data-action="cancel-confirm"]')?.focus();
        break;
      case "cancel-confirm": {
        const kind = confirming?.kind ?? "stop";
        confirming = null;
        render();
        rowNode(routine.id)?.querySelector<HTMLElement>(`[data-action="${kind}"]`)?.focus();
        break;
      }
      case "confirm":
        if (confirming?.kind === "delete") {
          void runRowAction(routine, () => bridge.deleteRoutine(routine.id), "removed", "Couldn't delete the routine");
        } else {
          void runRowAction(routine, () => bridge.stopRoutine(routine.id), "stopped", "Couldn't stop the routine", `Stopped “${routine.title}”`);
        }
        break;
      default:
        break;
    }
  });

  host.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && forgetting) {
      const id = forgetting;
      forgetting = null;
      event.preventDefault();
      render();
      rowNode(id)?.querySelector<HTMLElement>('[data-action="forget"]')?.focus();
      return;
    }
    if (event.key !== "Escape" || !confirming) return;
    const { id, kind } = confirming;
    confirming = null;
    event.preventDefault();
    render();
    rowNode(id)?.querySelector<HTMLElement>(`[data-action="${kind}"]`)?.focus();
  });

  // ── runs, notes, memory ───────────────────────────────────────────────────
  function closeDetail(id: string): void {
    detailOpen.delete(id);
    details.delete(id);
    const open = openRuns.get(id);
    if (open) logs.delete(open);
    openRuns.delete(id);
    if (forgetting === id) forgetting = null;
  }

  function openDetail(id: string): void {
    detailOpen.add(id);
    details.set(id, { runs: null, notes: null });
    void loadDetail(id);
  }

  const stillOpen = (id: string): boolean => !destroyed && detailOpen.has(id);

  async function loadRuns(id: string): Promise<void> {
    const data = details.get(id);
    if (!data || typeof bridge.listRoutineRuns !== "function") return;
    try {
      const listed = await bridge.listRoutineRuns(id);
      if (!stillOpen(id)) return;
      data.runs = Array.isArray(listed) ? listed.slice(0, 50) : [];
      data.runsError = undefined;
      if (data.runs[0]) lastRuns.set(id, data.runs[0]);
    } catch (error) {
      if (!stillOpen(id)) return;
      data.runsError = errorText(error);
    }
    render();
  }

  async function loadNotes(id: string): Promise<void> {
    const data = details.get(id);
    if (!data || typeof bridge.listRoutineNotes !== "function") {
      if (data) data.notes = [];
      return;
    }
    try {
      const listed = await bridge.listRoutineNotes(id, NOTE_CAP + 1);
      if (!stillOpen(id)) return;
      data.notes = Array.isArray(listed) ? listed : [];
      data.notesError = undefined;
    } catch (error) {
      if (!stillOpen(id)) return;
      data.notesError = errorText(error);
    }
    render();
  }

  async function loadMemory(id: string, silent: boolean): Promise<void> {
    if (typeof bridge.getRoutineMemory !== "function" || destroyed) return;
    try {
      const memory = await bridge.getRoutineMemory(id);
      if (destroyed) return;
      if (memory && typeof memory === "object") {
        memories.set(id, memory);
        if (memory.lastRun && !running.has(id)) lastRuns.set(id, memory.lastRun);
      }
      const data = details.get(id);
      if (data) data.memoryError = undefined;
    } catch (error) {
      if (destroyed) return;
      const data = details.get(id);
      if (data && !silent) data.memoryError = errorText(error);
    }
    render();
  }

  async function loadDetail(id: string): Promise<void> {
    render();
    await Promise.all([loadRuns(id), loadNotes(id), loadMemory(id, false)]);
  }

  async function loadLog(id: string, runId: string): Promise<void> {
    if (typeof bridge.getRoutineRun !== "function") return;
    const prior = logs.get(runId);
    logs.set(runId, { detail: prior?.detail ?? null, loading: !prior?.detail });
    try {
      const detail = await bridge.getRoutineRun(id, runId);
      if (destroyed) return;
      logs.set(runId, { detail: detail ?? null, loading: false });
    } catch (error) {
      if (destroyed) return;
      logs.set(runId, { detail: null, loading: false, error: errorText(error) });
    }
    render();
  }

  /** Next-run and last-run chips need each active routine's memory; fetch the ones we lack. */
  async function loadMemories(force: boolean): Promise<void> {
    if (typeof bridge.getRoutineMemory !== "function") return;
    const wanted = routines
      .filter((routine) => routine.state === "approved" || routine.state === "paused")
      .filter((routine) => force || !memories.has(routine.id))
      .slice(0, MEMORY_PREFETCH_CAP);
    await Promise.all(wanted.map((routine) => loadMemory(routine.id, true)));
  }

  async function runNow(routine: RoutineSummary): Promise<void> {
    if (typeof bridge.runRoutineNow !== "function" || busyRows.has(routine.id)) return;
    rowErrors.delete(routine.id);
    busyRows.add(routine.id);
    render();
    try {
      const run = await bridge.runRoutineNow(routine.id);
      busyRows.delete(routine.id);
      if (run && typeof run === "object") applyRun(run);
      else running.add(routine.id);
      toast(`Started “${clip(routine.title, 60)}”`, "success");
    } catch (error) {
      busyRows.delete(routine.id);
      rowErrors.set(routine.id, `Couldn't start the routine — ${errorText(error)}`);
    }
    render();
    focusRow(routine.id);
  }

  async function cancelRun(routine: RoutineSummary): Promise<void> {
    if (typeof bridge.cancelRoutineRun !== "function" || cancelling.has(routine.id)) return;
    rowErrors.delete(routine.id);
    cancelling.add(routine.id);
    render();
    try {
      await bridge.cancelRoutineRun(routine.id);
    } catch (error) {
      cancelling.delete(routine.id);
      rowErrors.set(routine.id, `Couldn't cancel the run — ${errorText(error)}`);
    }
    render();
  }

  async function forgetMemory(routine: RoutineSummary): Promise<void> {
    if (typeof bridge.clearRoutineMemory !== "function" || busyRows.has(routine.id)) return;
    rowErrors.delete(routine.id);
    busyRows.add(routine.id);
    render();
    try {
      await bridge.clearRoutineMemory(routine.id);
      busyRows.delete(routine.id);
      forgetting = null;
      toast(`“${clip(routine.title, 60)}” has forgotten what it saw`, "success");
      await loadMemory(routine.id, false);
    } catch (error) {
      busyRows.delete(routine.id);
      rowErrors.set(routine.id, `Couldn't clear the memory — ${errorText(error)}`);
    }
    render();
    rowNode(routine.id)?.querySelector<HTMLElement>('[data-action="forget"], [data-action="cancel-forget"]')?.focus();
  }

  async function loadModel(): Promise<void> {
    if (typeof bridge.getRoutineModel !== "function") return;
    try {
      const next = await bridge.getRoutineModel();
      if (destroyed) return;
      modelStatus = next && typeof next === "object" ? next : { choice: null, available: false };
      modelLoadError = "";
      if (modelStatus.choice) modelDraft = modelValue(modelStatus.choice.cli, modelStatus.choice.model);
    } catch (error) {
      if (destroyed) return;
      modelLoadError = errorText(error);
    }
    modelLoaded = true;
    render();
  }

  async function loadRunner(refreshing: boolean): Promise<void> {
    const fn = refreshing && typeof bridge.refreshAgentRunner === "function" ? bridge.refreshAgentRunner : bridge.getAgentRunnerStatus;
    if (typeof fn !== "function") {
      runnerError = "This build of HelmStack can't list models yet.";
      render();
      return;
    }
    modelBusy = refreshing;
    if (refreshing) render();
    try {
      runner = await fn.call(bridge);
      runnerError = "";
    } catch (error) {
      runnerError = errorText(error);
    }
    modelBusy = false;
    if (!destroyed) render();
  }

  async function saveModel(): Promise<void> {
    if (typeof bridge.setRoutineModel !== "function" || modelBusy) return;
    const choice = parseModelValue(modelDraft);
    if (!choice) return;
    modelBusy = true;
    modelError = "";
    render();
    try {
      modelStatus = await bridge.setRoutineModel(choice);
      toast("Model saved", "success");
    } catch (error) {
      modelError = `Couldn't save the model — ${errorText(error)}`;
    }
    modelBusy = false;
    render();
  }

  async function clearModel(): Promise<void> {
    if (typeof bridge.setRoutineModel !== "function" || modelBusy) return;
    modelBusy = true;
    modelError = "";
    render();
    try {
      modelStatus = await bridge.setRoutineModel(null);
      modelDraft = "";
      toast("Model cleared", "success");
    } catch (error) {
      modelError = `Couldn't clear the model — ${errorText(error)}`;
    }
    modelBusy = false;
    render();
  }

  async function toggleKill(): Promise<void> {
    if (typeof bridge.setRoutineKillSwitch !== "function" || killBusy) return;
    const on = !isKilled();
    killBusy = true;
    bannerError = "";
    render();
    try {
      const next = await bridge.setRoutineKillSwitch(on);
      engine = next && typeof next === "object" ? next : { ...(engine ?? { enabled: false }), killed: on };
      running.clear();
      cancelling.clear();
      for (const id of engine.running ?? []) running.add(id);
      toast(on ? "Routines are switched off" : "Routines are allowed again", "success");
    } catch (error) {
      bannerError = `Couldn't ${on ? "switch routines off" : "allow routines again"} — ${errorText(error)}`;
    }
    killBusy = false;
    render();
  }

  function openNote(url: string): void {
    const safe = openableUrl(url);
    if (!safe || typeof bridge.openTab !== "function") return;
    void Promise.resolve(bridge.openTab(safe)).catch((error: unknown) => toast(`Couldn't open the page — ${errorText(error)}`, "error"));
  }

  /** One run changed (started, finished, cancelled). */
  function applyRun(run: RoutineRunSummary): void {
    const id = run.routineId;
    const known = lastRuns.get(id);
    if (!known || run.startedAt >= known.startedAt) lastRuns.set(id, run);
    if (run.status === "running") {
      running.add(id);
    } else {
      running.delete(id);
      cancelling.delete(id);
    }
    const data = details.get(id);
    if (data?.runs) {
      const without = data.runs.filter((entry) => entry.id !== run.id);
      data.runs = [run, ...without].sort((a, b) => b.startedAt - a.startedAt).slice(0, 50);
    }
    if (openRuns.get(id) === run.id) void loadLog(id, run.id);
  }

  const handleRunUpdated = (run: RoutineRunSummary): void => {
    if (destroyed || !run || typeof run.routineId !== "string") return;
    applyRun(run);
    render();
    if (run.status !== "running") {
      void loadMemory(run.routineId, true);
      if (detailOpen.has(run.routineId)) void loadNotes(run.routineId);
    }
  };

  // ── review dialog ─────────────────────────────────────────────────────────
  const hasHighRisk = (summary: RoutineSummary): boolean => (summary.preview?.risks ?? []).some((risk) => risk.level === "high");

  const setReviewButtons = (): void => {
    if (!review) return;
    const gate = bodyEl.querySelector<HTMLInputElement>("#routine-review-ack");
    const blocked = hasHighRisk(review.summary) && !(gate?.checked ?? false);
    approveBtn.disabled = review.busy || blocked;
    rejectBtn.disabled = review.busy;
    gateEl.hidden = !blocked;
  };

  const buildReviewBody = (summary: RoutineSummary): void => {
    const lines = summary.preview?.lines ?? [];
    const risks = sortRisks(summary.preview?.risks ?? []);
    const parts: HTMLElement[] = [];

    const request = el("section", "routine-review__section");
    request.append(el("h3", "routine-review__heading", "Your request"), el("blockquote", "routine-row__quote", `“${summary.intent}”`));
    parts.push(request);

    const what = el("section", "routine-review__section");
    what.append(el("h3", "routine-review__heading", "What it will do"));
    if (lines.length > 0) {
      const list = el("ul", "routine-review__lines");
      for (const line of lines) list.append(el("li", undefined, line));
      what.append(list);
    } else {
      what.append(el("p", "routine-row__meta", "No description was provided."));
    }
    parts.push(what);

    const risk = el("section", "routine-review__section");
    risk.append(el("h3", "routine-review__heading", "Risks"));
    if (risks.length === 0) {
      risk.append(el("p", "routine-row__meta", "No risks flagged."));
    } else {
      const list = el("ul", "routine-review__risks");
      list.setAttribute("aria-label", "Risks, highest first");
      for (const entry of risks) {
        const item = el("li", `routine-review__risk routine-risk--${entry.level}`);
        const head = el("span", "routine-review__risk-level");
        head.append(levelIcon(entry.level), LEVEL_WORD[entry.level]);
        item.append(head, el("span", "routine-review__risk-message", entry.message));
        list.append(item);
      }
      risk.append(list);
    }
    parts.push(risk);

    const facts = el("section", "routine-review__section");
    facts.append(el("p", "routine-row__meta", `Trigger: ${summary.trigger}`), buildHosts(summary));
    parts.push(facts);

    if (summary.replaces) {
      const note = el("p", "routine-review__replaces");
      note.setAttribute("role", "note");
      note.textContent = `Approving this will stop ${titleOf(summary.replaces)}.`;
      parts.push(note);
    }

    // Technical spec: fetched the first time the disclosure opens.
    const spec = el("section", "routine-review__section");
    const toggle = el("button", "routine-review__disclosure");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", "routine-review-spec");
    const chevron = icon("chevron-right", { size: 14 });
    chevron.setAttribute("aria-hidden", "true");
    toggle.append(chevron, "Show the technical spec");
    const specBox = el("div", "routine-review__spec");
    specBox.id = "routine-review-spec";
    specBox.hidden = true;
    const specStatus = el("p", "routine-row__meta");
    specStatus.setAttribute("role", "status");
    const pre = el("pre", "routine-review__pre");
    pre.tabIndex = 0;
    pre.setAttribute("aria-label", "Technical spec (read-only)");
    pre.hidden = true;
    specBox.append(specStatus, pre);
    toggle.addEventListener("click", () => {
      const open = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(open));
      toggle.replaceChildren(icon(open ? "chevron-down" : "chevron-right", { size: 14 }), open ? "Hide the technical spec" : "Show the technical spec");
      toggle.firstElementChild?.setAttribute("aria-hidden", "true");
      specBox.hidden = !open;
      if (open) void loadSpec(summary.id, specStatus, pre);
    });
    spec.append(toggle, specBox);
    parts.push(spec);

    if (hasHighRisk(summary)) {
      const ack = el("label", "routine-review__ack");
      const box = el("input");
      box.type = "checkbox";
      box.id = "routine-review-ack";
      box.addEventListener("change", setReviewButtons);
      ack.append(box, "I've read the risks");
      parts.push(ack);
    }
    bodyEl.replaceChildren(...parts);
  };

  async function loadSpec(id: string, status: HTMLElement, pre: HTMLElement): Promise<void> {
    const current = review;
    if (!current || current.summary.id !== id || current.spec !== "idle") return;
    current.spec = "loading";
    status.textContent = "Loading the spec…";
    status.hidden = false;
    let detail: RoutineDetail | null = null;
    let failure: string | null = null;
    try {
      detail = await bridge.getRoutine(id);
    } catch (error) {
      failure = errorText(error);
    }
    if (review !== current) return;
    if (detail && typeof detail.specJson === "string") {
      current.spec = "done";
      pre.textContent = detail.specJson;
      pre.hidden = false;
      status.textContent = "";
      status.hidden = true;
    } else {
      current.spec = "idle"; // collapsing and reopening tries again
      status.textContent = failure ? `Couldn't load the spec — ${failure}` : "The technical spec isn't available for this routine.";
    }
  }

  const hideReview = (refocusId: string | null): void => {
    const current = review;
    if (!current) return;
    review = null;
    dialogEl.hidden = true;
    current.handle?.close();
    options.onDialogClose?.();
    if (refocusId !== null && !host.contains(document.activeElement)) focusRow(refocusId);
  };

  function openReview(id: string, opener?: HTMLElement | null): void {
    if (review) return;
    const summary = routines.find((routine) => routine.id === id);
    if (!summary) return;
    opener?.focus();
    review = { summary, handle: null, busy: false, spec: "idle" };
    titleEl.textContent = summary.preview?.headline?.trim() || summary.title;
    const by = summary.proposedBy?.trim() || "an agent";
    metaEl.textContent = `${summary.title} · proposed by ${by} · ${relativeTime(summary.createdAt, now())}`;
    buildReviewBody(summary);
    gateEl.textContent = "This proposal has high-risk items. Read them, then tick “I've read the risks” to enable Approve.";
    setReviewButtons();
    dialogEl.hidden = false;
    options.onDialogOpen?.();
    const state = review;
    state.handle = openDialog(dialogEl, {
      dismissable: true,
      initialFocus: titleEl,
      onClose: () => {
        if (review === state) {
          review = null;
          dialogEl.hidden = true;
          options.onDialogClose?.();
          if (!host.contains(document.activeElement)) focusRow(summary.id);
        }
      },
    });
  }

  /** A proposal must not change under the reader: close if it was edited or handled elsewhere. */
  function syncReviewWithList(): void {
    if (!review || review.busy) return;
    const shown = review.summary;
    const latest = routines.find((routine) => routine.id === shown.id);
    if (!latest) {
      hideReview(null);
      toast("The proposal you were reviewing is gone.", "info");
    } else if (latest.state !== "proposed") {
      hideReview(shown.id);
      toast("This proposal was already handled.", "info");
    } else if (latest.updatedAt !== shown.updatedAt || latest.specVersion !== shown.specVersion) {
      hideReview(shown.id);
      toast("This proposal changed while you were reviewing it. Review it again.", "info");
    }
  }

  const decide = async (kind: "approve" | "reject"): Promise<void> => {
    const current = review;
    if (!current || current.busy) return;
    const summary = current.summary;
    current.busy = true;
    setReviewButtons();
    const order = visibleOrder();
    try {
      const updated = kind === "approve" ? await bridge.approveRoutine(summary.id) : await bridge.rejectRoutine(summary.id);
      if (review === current) {
        current.busy = false;
        hideReview(null);
      }
      upsert(updated ?? { ...summary, state: kind === "approve" ? "approved" : "rejected" });
      if (kind === "approve") {
        toast(engineOn() ? `Approved “${summary.title}”` : `Approved “${summary.title}” — it will wait for the engine`, "success");
      } else {
        toast(`Rejected “${summary.title}”`, "success");
      }
      focusNear(summary.id, order);
    } catch (error) {
      if (review === current) {
        current.busy = false;
        setReviewButtons();
      }
      toast(`Couldn't ${kind} the routine — ${errorText(error)}`, "error");
    }
  };

  approveBtn.addEventListener("click", () => void decide("approve"));
  rejectBtn.addEventListener("click", () => void decide("reject"));
  cancelBtn.addEventListener("click", () => hideReview(review?.summary.id ?? null));
  backdrop?.addEventListener("click", () => hideReview(review?.summary.id ?? null));

  // ── data ──────────────────────────────────────────────────────────────────
  const handleChanged = (next: RoutineSummary[], proposed?: RoutineSummary): void => {
    setList(next);
    if (proposed && proposed.state === "proposed" && !notified.has(proposed.id)) {
      notified.add(proposed.id);
      toast(`Routine proposed: ${clip(proposed.title, 80)}`, "info", {
        actions: [
          {
            label: "Review…",
            onClick: () => {
              options.onReveal?.();
              openReview(proposed.id);
            },
          },
        ],
      });
    }
  };

  const loadEngine = async (): Promise<void> => {
    try {
      engine = await bridge.getRoutineEngineStatus();
    } catch {
      engine = { enabled: false };
    }
    if (destroyed) return;
    if (engine && Array.isArray(engine.running)) {
      running.clear();
      for (const id of engine.running) running.add(id);
    }
  };

  const refresh = async (): Promise<void> => {
    await loadEngine();
    let next: RoutineSummary[];
    try {
      const listed = await bridge.listRoutines();
      next = Array.isArray(listed) ? listed : [];
    } catch {
      next = [];
    }
    if (destroyed) return;
    setList(next);
    if (canModel()) {
      void loadModel();
      if (!runner) void loadRunner(false);
    }
    void loadMemories(true);
    for (const id of detailOpen) void loadDetail(id);
  };

  // Relative-time labels only; skipped while the tab or window is hidden.
  const timer = setInterval(() => {
    if (host.hidden || document.visibilityState === "hidden") return;
    const current = now();
    host.querySelectorAll<HTMLElement>("time[data-at]").forEach((node) => {
      node.textContent = relativeTime(Number(node.dataset.at), current);
    });
    host.querySelectorAll<HTMLElement>("[data-until]").forEach((node) => {
      node.textContent = `${node.dataset.prefix ?? ""}${untilText(Number(node.dataset.until), current)}`;
    });
  }, TICK_MS);

  const unsubscribe = bridge.onRoutinesChanged(handleChanged);
  const unsubscribeRuns = typeof bridge.onRoutineRunUpdated === "function" ? bridge.onRoutineRunUpdated(handleRunUpdated) : undefined;
  render();
  void refresh();

  return {
    refresh,
    handleChanged,
    show() {
      void refresh();
    },
    needsReview: () => needs,
    openReview,
    destroy() {
      destroyed = true;
      clearInterval(timer);
      unsubscribe?.();
      unsubscribeRuns?.();
      running.clear();
      details.clear();
      logs.clear();
    },
  };
}
