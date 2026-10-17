/**
 * Routine actions: the queue of actions waiting for a human, the record of what was done, the
 * grants a human set, and the one place a human-approved action is carried out.
 *
 * - The executor records what it does here (through {@link ActGate}), so the human sees every
 *   action (done, blocked, failed or waiting) in one list, newest first, 100 kept.
 * - A queued action lapses after 12 hours and never runs after that. Pausing, stopping, deleting a
 *   routine or turning on the kill switch expires what is waiting and cancels what is running.
 * - Approving a queued action re-opens the recorded page, finds the control again and checks it is
 *   still the control that was queued; if the page changed, nothing is done.
 * - Everything the human does here (set grants, approve, decline) is called by the shell only. There
 *   is no HTTP route for any of it.
 *
 * Time, waiting and ids are injected. Nothing here writes page text anywhere except the
 * descriptions the executor passes in, which are already clipped single lines.
 */
import { randomBytes } from "node:crypto";

import type {
  RoutineAction,
  RoutineActionEvent,
  RoutineGrants,
  RoutineSpec,
  RoutineState,
  RoutineSummary
} from "../../../../shared/src/index.js";
import type { RoutineDataStore } from "../stores/routine-data-store.js";
import { RoutineError, isValidRoutineId } from "../stores/routine-store.js";
import {
  ACT_MIN_GAP_MS,
  PENDING_TTL_MS,
  protectApplies,
  protectedMatch,
  mergedProtect,
  performAndVerify,
  relocate,
  type ActBrowser,
  type ActGate,
  type ActionDraft,
  type ActionPatch,
  type StoredAction
} from "./act.js";
import { parseGrants } from "./grants.js";
import { hostInScope, parseHttpUrl } from "./scope.js";

export const ACTION_ID_PATTERN = /^act-[a-z0-9]{4,12}-[0-9a-f]{4,16}$/;
export const isValidActionId = (id: unknown): id is string => typeof id === "string" && ACTION_ID_PATTERN.test(id);
const NAV_TIMEOUT_MS = 30_000;

/** The browser the service uses to carry out a human-approved action. */
export interface ActionTabs extends ActBrowser {
  openTab(): Promise<string>;
  navigate(tabId: string, url: string): Promise<{ url: string }>;
  closeTab(tabId: string): Promise<void>;
}

export interface ActionRoutines {
  get(id: string): RoutineSummary | undefined;
  spec(id: string): RoutineSpec | undefined;
  list(): RoutineSummary[];
  transition(id: string, action: "pause"): RoutineSummary;
}

export type ActionServiceOptions = {
  data: RoutineDataStore;
  routines: ActionRoutines;
  /** Absent when the browser cannot act (tests of other things): approving then fails with a clear message. */
  browser: Partial<ActionTabs> & Pick<ActionTabs, "openTab" | "navigate" | "closeTab">;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  random: () => string;
  isKilled: () => boolean;
  log: (message: string) => void;
  navTimeoutMs?: number;
};

const ACTIVE: RoutineState = "approved";

function publicAction(a: StoredAction): RoutineAction {
  const { secret: _secret, ...rest } = a;
  return rest;
}

export class ActionService {
  private readonly lastActionAt = new Map<string, number>();
  private readonly inflight = new Map<string, AbortController>();
  private readonly listeners = new Set<(event: RoutineActionEvent) => void>();

  constructor(private readonly o: ActionServiceOptions) {}

  // ── grants ───────────────────────────────────────────────────────────────

  /** What the human allowed. Read from disk on every call. */
  grants(id: string): RoutineGrants {
    return this.o.data.readGrants(id);
  }

  /** Human only. Validated here as well, whoever calls. Takes effect on the routine's next action. */
  setGrants(id: string, raw: unknown): RoutineGrants {
    this.mustExist(id);
    const parsed = parseGrants(raw);
    if (!parsed.ok) throw new RoutineError(parsed.error, "invalid");
    return this.o.data.writeGrants(id, parsed.grants);
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /** Newest first, at most 100. Overdue pending actions are marked expired first. */
  list(id: string): RoutineAction[] {
    this.mustExist(id);
    this.sweep(id);
    return this.o.data.readActions(id).map(publicAction);
  }

  pendingCount(id: string): number {
    return this.o.data.readActions(id).filter((a) => a.status === "pending" && a.expiresAt > this.o.now()).length;
  }

  onChanged(listener: (event: RoutineActionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── what the executor uses ───────────────────────────────────────────────

  gateFor(routineId: string): ActGate {
    return {
      mayAct: () => this.mayAct(routineId),
      grants: () => this.grants(routineId),
      reserveDaily: (effect, limit) => this.o.data.reserveDaily(routineId, effect, limit, this.o.now()),
      record: (draft) => this.create(routineId, draft),
      update: (actionId, patch) => this.patch(routineId, actionId, patch),
      throttle: (signal) => this.throttle(routineId, signal)
    };
  }

  /** null while the routine may act. */
  mayAct(id: string): string | null {
    if (this.o.isKilled()) return "The routine kill switch is on.";
    const routine = this.o.routines.get(id);
    if (!routine) return "The routine no longer exists.";
    if (routine.state !== ACTIVE) return `The routine is ${routine.state}.`;
    return null;
  }

  async throttle(id: string, signal: AbortSignal): Promise<void> {
    const wait = (this.lastActionAt.get(id) ?? Number.NEGATIVE_INFINITY) + ACT_MIN_GAP_MS - this.o.now();
    if (wait > 0) await this.o.sleep(wait, signal);
    this.lastActionAt.set(id, this.o.now());
  }

  // ── records ──────────────────────────────────────────────────────────────

  private create(routineId: string, draft: ActionDraft): RoutineAction {
    const at = this.o.now();
    const settled = draft.status !== "pending" && draft.status !== "approved";
    const action: StoredAction = {
      id: `act-${Math.max(0, Math.floor(at)).toString(36)}-${this.o.random()}`,
      routineId,
      runId: draft.runId,
      createdAt: at,
      expiresAt: at + PENDING_TTL_MS,
      effect: draft.effect,
      action: draft.action,
      description: draft.description,
      host: draft.host,
      url: draft.url,
      ...(draft.subject ? { subject: draft.subject } : {}),
      status: draft.status,
      ...(draft.note ? { note: draft.note } : {}),
      ...(draft.allowedBy ? { allowedBy: draft.allowedBy } : {}),
      ...(settled ? { decidedAt: at } : {}),
      ...(draft.secret ? { secret: draft.secret } : {})
    };
    const list = this.o.data.readActions(routineId);
    this.o.data.writeActions(routineId, [action, ...list]);
    this.emit(action);
    return publicAction(action);
  }

  private patch(routineId: string, actionId: string, patch: ActionPatch): void {
    const list = this.o.data.readActions(routineId);
    const found = list.find((a) => a.id === actionId);
    if (!found) return;
    Object.assign(found, patch);
    // A finished action no longer needs what it took to redo it.
    if (found.status !== "pending" && found.status !== "approved") delete found.secret;
    if (found.decidedAt === undefined && found.status !== "pending") found.decidedAt = this.o.now();
    this.o.data.writeActions(routineId, list);
    this.emit(found);
  }

  private emit(a: StoredAction): void {
    const event: RoutineActionEvent = { routineId: a.routineId, actionId: a.id, effect: a.effect, status: a.status };
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* a listener must not break routine handling */
      }
    }
  }

  /** Mark overdue pending actions expired. */
  private sweep(id: string): void {
    const now = this.o.now();
    const list = this.o.data.readActions(id);
    let changed = false;
    for (const a of list) {
      if (a.status === "pending" && a.expiresAt <= now) {
        a.status = "expired";
        a.note = "It waited more than 12 hours and was dropped. The routine will ask again if it still wants to.";
        a.decidedAt = now;
        delete a.secret;
        changed = true;
        this.emit(a);
      }
    }
    if (changed) this.o.data.writeActions(id, list);
  }

  // ── cancelling ───────────────────────────────────────────────────────────

  /** Expire what is waiting for this routine and cancel an approved action that is running. */
  cancelRoutine(id: string, why: string): void {
    this.inflight.get(id)?.abort();
    try {
      const list = this.o.data.readActions(id);
      let changed = false;
      for (const a of list) {
        if (a.status !== "pending") continue;
        a.status = "expired";
        a.note = why;
        a.decidedAt = this.o.now();
        delete a.secret;
        changed = true;
        this.emit(a);
      }
      if (changed) this.o.data.writeActions(id, list);
    } catch (err) {
      this.o.log(`[Routines] could not expire the waiting actions of ${id}: ${(err as Error).message}`);
    }
  }

  cancelAll(why: string): void {
    for (const routine of this.o.routines.list()) this.cancelRoutine(routine.id, why);
  }

  /** After a restart an action left "approved" can never finish: say so. */
  recover(id: string): void {
    const list = this.o.data.readActions(id);
    let changed = false;
    for (const a of list) {
      if (a.status !== "approved") continue;
      a.status = "failed";
      a.note = "The app closed while this was running. Check the site to see whether it went through.";
      a.decidedAt = this.o.now();
      delete a.secret;
      changed = true;
      this.emit(a);
    }
    if (changed) this.o.data.writeActions(id, list);
  }

  // ── the human decides ────────────────────────────────────────────────────

  decline(id: string, actionId: string): RoutineAction {
    const found = this.pendingOrThrow(id, actionId);
    this.patch(id, found.id, { status: "declined", decidedAt: this.o.now(), note: "You declined this." });
    return this.get(id, actionId);
  }

  /**
   * Run a queued action now. Re-checks everything: the routine may act, the page still has exactly the
   * control that was queued, the protect list, and (afterwards) the page shows the expected result.
   */
  async approve(id: string, actionId: string): Promise<RoutineAction> {
    const found = this.pendingOrThrow(id, actionId);
    const why = this.mayAct(id);
    if (why) throw new RoutineError(`${why} Resume it before approving actions.`, "bad_state");
    if (this.inflight.has(id)) throw new RoutineError("An action of this routine is already running.", "bad_state");
    const b = this.o.browser;
    if (!b.controls || !b.perform || !b.pageState) {
      throw new RoutineError("This browser cannot carry out routine actions.", "bad_state");
    }
    const tabs = b as ActionTabs;
    const controller = new AbortController();
    this.inflight.set(id, controller);
    this.patch(id, found.id, { status: "approved", allowedBy: "human", decidedAt: this.o.now(), note: "Approved by you; running now." });
    try {
      const outcome = await this.carryOut(id, found, tabs, controller.signal);
      this.patch(id, found.id, outcome.patch);
      if (outcome.pause) this.pauseAfterFailure(id);
    } catch (err) {
      const cancelled = controller.signal.aborted;
      this.patch(id, found.id, {
        status: "failed",
        note: cancelled ? "Cancelled because the routine was paused, stopped or the kill switch was turned on." : "Something went wrong before it could finish. Check the site to see whether it went through."
      });
      if (!cancelled) this.o.log(`[Routines] approving an action of ${id} failed: ${(err as Error).message}`);
    } finally {
      this.inflight.delete(id);
    }
    return this.get(id, actionId);
  }

  private async carryOut(
    id: string,
    action: StoredAction,
    tabs: ActionTabs,
    signal: AbortSignal
  ): Promise<{ patch: ActionPatch; pause?: boolean }> {
    const secret = action.secret;
    const spec = this.o.routines.spec(id);
    const failed = (note: string, pause = false) => ({ patch: { status: "failed" as const, note } satisfies ActionPatch, pause });
    if (!secret || !spec) return failed("The details needed to do this are gone. Ask again next run.");
    const inScope = (url: string): boolean => {
      const parsed = parseHttpUrl(url);
      return parsed.ok && hostInScope(parsed.url.hostname, spec.scope);
    };
    if (!inScope(action.url)) return failed("The page is outside the routine's scope, so nothing was done.");

    // The protect list may have changed since this was queued.
    const protect = mergedProtect(spec.actions?.protect, this.grants(id));
    if (protectApplies(action.effect, secret.target, secret.value) && protectedMatch(protect, action.subject)) {
      return { patch: { status: "blocked", note: "This involves a protected name, so it is never done." } };
    }

    let tab: string | null = null;
    try {
      tab = await this.guarded(tabs.openTab(), signal);
      const landed = await this.guarded(tabs.navigate(tab, action.url), signal);
      if (!inScope(landed.url || action.url)) return failed("The page redirected outside the routine's scope, so nothing was done.");
      const controls = await this.guarded(tabs.controls(tab), signal);
      const control = relocate(secret, action.subject, action.action, controls);
      if (!control) return failed("The page changed, ask again next run.");
      await this.throttle(id, signal);
      const stop = this.mayAct(id);
      if (stop || signal.aborted) return failed("Cancelled because the routine is no longer allowed to act.");
      const outcome = await performAndVerify({
        browser: tabs,
        tab,
        control,
        action: action.action,
        ...(secret.value !== undefined ? { value: secret.value } : {}),
        verify: secret.verify,
        inScope,
        sleep: this.o.sleep,
        signal
      });
      if (outcome.status === "done") return { patch: { status: "done", note: "Done, and the page shows the expected result." } };
      if (outcome.status === "needs_approval") {
        return failed(`HelmStack's own approval is needed for this (${outcome.kinds.join(", ")}). Routines cannot do that for you; do it on the site yourself.`);
      }
      if (outcome.status === "blocked") return failed(`HelmStack's approval settings block this: ${outcome.reason}`);
      return failed(outcome.reason, true);
    } finally {
      if (tab) await tabs.closeTab(tab).catch(() => {});
    }
  }

  /** A human-approved action whose result did not show: stop the routine until the human has looked. */
  private pauseAfterFailure(id: string): void {
    try {
      if (this.o.routines.get(id)?.state === ACTIVE) this.o.routines.transition(id, "pause");
    } catch (err) {
      this.o.log(`[Routines] could not pause ${id}: ${(err as Error).message}`);
    }
  }

  private guarded<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("cancelled"));
      const onAbort = () => finish(() => reject(new Error("cancelled")));
      const timer = setTimeout(() => finish(() => reject(new Error("timed out"))), this.o.navTimeoutMs ?? NAV_TIMEOUT_MS);
      (timer as { unref?: () => void }).unref?.();
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        fn();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      p.then(
        (v) => finish(() => resolve(v)),
        (e) => finish(() => reject(e))
      );
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private get(id: string, actionId: string): RoutineAction {
    const found = this.o.data.readActions(id).find((a) => a.id === actionId);
    if (!found) throw new RoutineError("That action no longer exists.", "not_found");
    return publicAction(found);
  }

  private pendingOrThrow(id: string, actionId: string): StoredAction {
    this.mustExist(id);
    if (!isValidActionId(actionId)) throw new RoutineError("invalid action id", "invalid_id");
    this.sweep(id);
    const found = this.o.data.readActions(id).find((a) => a.id === actionId);
    if (!found) throw new RoutineError("That action no longer exists.", "not_found");
    if (found.status === "expired") throw new RoutineError("That action expired. The routine will ask again next run if it still needs to.", "bad_state");
    if (found.status !== "pending") throw new RoutineError(`That action is already ${found.status}.`, "bad_state");
    return found;
  }

  private mustExist(id: string): RoutineSummary {
    if (!isValidRoutineId(id)) throw new RoutineError("invalid routine id", "invalid_id");
    const routine = this.o.routines.get(id);
    if (!routine) throw new RoutineError("That routine no longer exists.", "not_found");
    return routine;
  }
}

export const newActionRandom = (): string => randomBytes(3).toString("hex");
