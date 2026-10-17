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
  BrowserShellBridge,
  RoutineDetail,
  RoutineEngineStatus,
  RoutineRisk,
  RoutineRiskLevel,
  RoutineState,
  RoutineSummary,
} from "../../../../../packages/shared/src/index.js";
import { openDialog, type DialogHandle } from "../ui/dialog.js";
import { plural, relativeTime } from "../ui/format.js";
import { icon, type IconName } from "../ui/icons.js";
import { toast } from "../ui/toast.js";

export type RoutinesBridge = Pick<
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
const TIME_REFRESH_MS = 30_000;

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
    const target = rowNode(id)?.querySelector<HTMLElement>("button[data-action]");
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
    switch (routine.state) {
      case "proposed":
        add("Review…", "btn--primary", "review", `Review proposal: ${routine.title}`);
        break;
      case "approved":
        add("Pause", "btn--ghost", "pause", `Pause routine: ${routine.title}`);
        add("Stop", "btn--quiet", "stop", `Stop routine: ${routine.title}`);
        break;
      case "paused":
        add("Resume", "btn--ghost", "resume", `Resume routine: ${routine.title}`);
        add("Stop", "btn--quiet", "stop", `Stop routine: ${routine.title}`);
        break;
      default:
        add("Delete", "btn--quiet", "delete", `Delete routine: ${routine.title}`);
    }
    return actions;
  };

  const buildRow = (routine: RoutineSummary, serial: number): HTMLLIElement => {
    const row = el("li", `routine-row routine-row--${routine.state}`);
    row.dataset.routineId = routine.id;
    row.append(el("h4", "routine-row__title", routine.title));
    row.append(el("p", "routine-row__state", stateLabel(routine)));
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
    return row;
  };

  function render(): void {
    // Remember what had focus so a re-render never drops it.
    const active = document.activeElement as HTMLElement | null;
    const focusedRow = active && host.contains(active) ? active.closest<HTMLElement>(".routine-row")?.dataset.routineId : undefined;
    const focusedAction = active && host.contains(active) ? active.dataset.action : undefined;
    const focusedSection = active && host.contains(active) ? active.dataset.section : undefined;

    const children: HTMLElement[] = [];
    const heading = el("h3", "sr-only routines__heading", "Routines");
    heading.tabIndex = -1;
    children.push(heading);

    const notice = el("div", "routines__notice");
    notice.setAttribute("role", "note");
    if (!engineOn()) {
      const glyph = icon("info", { size: 14 });
      glyph.setAttribute("aria-hidden", "true");
      notice.append(glyph, el("p", undefined, engine?.reason?.trim() || ENGINE_FALLBACK_REASON));
      children.push(notice);
    }

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

    if (focusedSection) {
      host.querySelector<HTMLElement>(`[data-section="${focusedSection}"]`)?.focus();
    } else if (focusedRow) {
      const row = rowNode(focusedRow);
      const same = row ? Array.from(row.querySelectorAll<HTMLElement>("button[data-action]")).find((b) => b.dataset.action === focusedAction) : undefined;
      (same ?? row?.querySelector<HTMLElement>("button[data-action]"))?.focus();
    }
  }

  const setList = (next: RoutineSummary[]): void => {
    routines = Array.isArray(next) ? next : [];
    if (confirming && !routines.some((routine) => routine.id === confirming?.id)) confirming = null;
    updateNeeds();
    render();
    syncReviewWithList();
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

  host.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("button");
    if (!target || !host.contains(target)) return;
    if (target.dataset.section === "closed") {
      closedOpen = !closedOpen;
      render();
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
    if (event.key !== "Escape" || !confirming) return;
    const { id, kind } = confirming;
    confirming = null;
    event.preventDefault();
    render();
    rowNode(id)?.querySelector<HTMLElement>(`[data-action="${kind}"]`)?.focus();
  });

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
    setList(next);
  };

  const timer = setInterval(() => {
    host.querySelectorAll<HTMLElement>("time[data-at]").forEach((node) => {
      node.textContent = relativeTime(Number(node.dataset.at), now());
    });
  }, TIME_REFRESH_MS);

  const unsubscribe = bridge.onRoutinesChanged(handleChanged);
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
      clearInterval(timer);
      unsubscribe?.();
    },
  };
}
