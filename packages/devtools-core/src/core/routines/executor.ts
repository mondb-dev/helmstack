/**
 * Runs one routine once: the deterministic steps of a validated spec, over real pages.
 *
 * What this file does NOT do, by design (phase 2):
 *  - It never calls a model. An `infer` step applies its own policy deterministically (see
 *    {@link Executor.inferStep}); a `branch` has nothing to branch on and hands the run to a human.
 *  - It never fills, clicks, submits, posts, purchases or downloads. The only things it does to a
 *    page are: load a URL, and read it with a fixed script (see `page-data.ts`).
 *  - It never leaves the routine's scope: every navigation is checked against `scope.start`,
 *    `follow.allow_hosts`, `max_depth`, the page budget, and (for followed pages) robots.txt, and
 *    the final URL after redirects is checked again.
 *
 * All time, waiting, randomness, browser access and robots fetching come in through
 * {@link ExecutorDeps} so tests run instantly and deterministically.
 */
import { createHash } from "node:crypto";

import {
  ROUTINE_LIMITS,
  type RoutineNote,
  type RoutineRunLogEntry,
  type RoutineRunOutcome,
  type RoutineSpec,
  type RoutineStep
} from "../../../../shared/src/index.js";
import { evaluateRobots, parseRobotsTxt, type ParsedRobots } from "../reports/robots-txt.js";
import { MAX_SET_ITEMS, type RoutineStateData } from "../stores/routine-data-store.js";
import { STRUCTURED_CONFIDENCE, sanitizePageData, type PageData, type PageItem } from "./page-data.js";
import { hostInScope, maxDepthOf, parseHttpUrl } from "./scope.js";

export const ROBOTS_USER_AGENT = "helmstack";
export const DEFAULT_PAGE_DELAY_MS = 1000;
export const MIN_PAGE_DELAY_MS = 1000 / ROUTINE_LIMITS.maxRequestsPerSecond;
export const DEFAULT_MAX_RUNTIME_MS = 30 * 60_000;
export const DEFAULT_NAV_TIMEOUT_MS = 30_000;
export const MAX_NOTES_PER_RUN = 200;

/** How the executor touches a browser. The core adapts a `BrowserBackend` to this. */
export interface RoutineBrowser {
  /** A fresh tab for one run. */
  openTab(): Promise<string>;
  /** Load `url` and resolve once loaded, with the URL the tab ended on. */
  navigate(tabId: string, url: string): Promise<{ url: string }>;
  /** Run the fixed page-data script and return whatever it produced. */
  collect(tabId: string): Promise<unknown>;
  closeTab(tabId: string): Promise<void>;
}

export type RobotsFetcher = (url: string) => Promise<{ status: number; text: string }>;

export type ExecutorDeps = {
  browser: RoutineBrowser;
  fetchRobots: RobotsFetcher;
  now: () => number;
  /** Resolves after `ms`; must resolve early (or reject) when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  random: () => string;
  /** Delay between page loads when the spec sets no `safety.rate`. Default {@link DEFAULT_PAGE_DELAY_MS}; never below {@link MIN_PAGE_DELAY_MS}. */
  defaultPageDelayMs?: number;
  navTimeoutMs?: number;
  maxRuntimeMs?: number;
};

export type ExecutorInput = {
  routineId: string;
  runId: string;
  spec: RoutineSpec;
  /** Mutated in place: sets grow, logs/values change. The caller persists it afterwards. */
  state: RoutineStateData;
  signal: AbortSignal;
  log: (level: RoutineRunLogEntry["level"], message: string, step?: string) => void;
  /** Called after each page load and note, and between loop items, with the counts so far. */
  onProgress: (counts: { pages: number; notes: number }) => void;
};

export type ExecutorResult = {
  outcome: RoutineRunOutcome;
  /** Fixed wording plus counts. Never contains page text. */
  summary: string;
  pagesVisited: number;
  notes: RoutineNote[];
};

// ── control flow ────────────────────────────────────────────────────────────

/** Ends the run with this outcome. */
class RunEnd extends Error {
  constructor(readonly outcome: RoutineRunOutcome, readonly summaryText: string) {
    super(summaryText);
  }
}
/** A problem with one page or item: inside a loop the item is skipped, elsewhere the run fails. */
class SoftError extends Error {
  constructor(message: string, readonly needsHuman = false) {
    super(message);
  }
}
class SkipItem extends Error {}

type Item = PageItem;
type Val = { t: "items"; items: Item[] } | { t: "record"; rec: Item };
type Env = { item?: Item; loopAgainst?: string; loopKey?: string[] };
type Visit = { url: string; depth: number; data: PageData | null };

const FIELD_ALIASES: string[][] = [
  ["title", "name", "headline"],
  ["url", "link", "href"],
  ["date", "published", "published_at", "datetime"],
  ["summary", "description", "text", "excerpt", "snippet"]
];

const clean = (v: string, max: number): string => v.replace(/\s+/g, " ").trim().slice(0, max);

export async function executeRoutine(deps: ExecutorDeps, input: ExecutorInput): Promise<ExecutorResult> {
  const ex = new Executor(deps, input);
  return ex.run();
}

class Executor {
  private readonly spec: RoutineSpec;
  private readonly vars = new Map<string, Val>();
  private readonly diffs = new Map<string, { against: string; key: string[] }>();
  private readonly itemDepth = new WeakMap<Item, number>();
  private readonly notes: RoutineNote[] = [];
  private readonly robots = new Map<string, ParsedRobots | "open" | "unreachable">();
  private readonly startedAt: number;
  private readonly pageLimit: number;
  private readonly deadline: number;
  private readonly pageDelayMs: number;
  private tabId: string | null = null;
  private visit: Visit | null = null;
  private pages = 0;
  private lastLoadAt: number | null = null;
  private loopDepth = 0;

  constructor(private readonly deps: ExecutorDeps, private readonly input: ExecutorInput) {
    this.spec = input.spec;
    this.startedAt = deps.now();
    const budgets = this.spec.stop?.budgets;
    this.pageLimit = Math.min(this.spec.scope.max_pages_per_run, budgets?.pages_per_run ?? Number.POSITIVE_INFINITY, ROUTINE_LIMITS.maxPagesPerRun);
    const runtime = budgets?.runtime_minutes_per_run !== undefined ? budgets.runtime_minutes_per_run * 60_000 : (deps.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS);
    this.deadline = this.startedAt + Math.min(runtime, deps.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS);
    this.pageDelayMs = Math.max(MIN_PAGE_DELAY_MS, rateDelayMs(this.spec.safety?.rate) ?? deps.defaultPageDelayMs ?? DEFAULT_PAGE_DELAY_MS);
    // tokens_per_run and cost_usd_total are never reached: nothing here spends tokens or money.
  }

  async run(): Promise<ExecutorResult> {
    let outcome: RoutineRunOutcome = "completed";
    let summaryText = "";
    try {
      this.input.log("info", `Run started (${this.spec.steps.length} step${this.spec.steps.length === 1 ? "" : "s"}).`);
      try {
        await this.runSteps(this.spec.steps, {});
      } catch (err) {
        if (err instanceof SoftError) throw new RunEnd(err.needsHuman ? "needs_human" : "failed", err.message);
        if (err instanceof SkipItem) this.input.log("warn", "A step was skipped outside a loop.");
        else throw err;
      }
    } catch (err) {
      if (err instanceof RunEnd) {
        outcome = err.outcome;
        summaryText = err.summaryText;
      } else if (this.input.signal.aborted) {
        outcome = "cancelled";
      } else {
        outcome = "failed";
        summaryText = "Failed: a step did not work.";
        this.input.log("error", `Unexpected error: ${clean(err instanceof Error ? err.message : String(err), 200)}`);
      }
    } finally {
      await this.closeTab();
    }
    if (this.input.signal.aborted && outcome !== "cancelled" && outcome !== "failed") outcome = "cancelled";
    const counts = `${this.pages} page${this.pages === 1 ? "" : "s"}, ${this.notes.length} note${this.notes.length === 1 ? "" : "s"}`;
    if (outcome === "completed") summaryText = `Completed: ${counts}.`;
    else if (!summaryText) summaryText = outcome === "cancelled" ? "Cancelled." : `Ended: ${outcome}.`;
    else if (outcome !== "cancelled") summaryText = `${summaryText} (${counts})`;
    return { outcome, summary: summaryText, pagesVisited: this.pages, notes: this.notes };
  }

  // ── steps ─────────────────────────────────────────────────────────────────

  private async runSteps(steps: RoutineStep[], env: Env): Promise<void> {
    for (const step of steps) {
      this.checkLimits();
      await this.runStep(step, env);
    }
  }

  private checkLimits(): void {
    if (this.input.signal.aborted) throw new RunEnd("cancelled", "Cancelled.");
    if (this.deps.now() >= this.deadline) throw new RunEnd("budget", "Stopped: the time limit for a run was reached.");
  }

  private async runStep(step: RoutineStep, env: Env): Promise<void> {
    const label = step.id ?? step.do;
    switch (step.do) {
      case "open":
        return this.openStep(step.url, env, label);
      case "locate":
        return this.locateStep(step, label);
      case "extract":
        return this.extractStep(step, env, label);
      case "diff":
        return this.diffStep(step, label);
      case "for_each":
        return this.forEachStep(step, label);
      case "infer":
        return this.inferStep(step, env, label);
      case "branch":
        this.input.log("warn", `Branch on "${step.on}" needs a judgment this version cannot make.`, label);
        throw new RunEnd("needs_human", "Needs a person: a branch depends on a judgment step that isn't available yet.");
      case "note":
        return this.noteStep(step, env, label);
      case "mark_seen":
        return this.markSeenStep(step, env, label);
      case "open_item":
        return this.openItemStep(env, label);
      case "wait":
        return this.waitStep(step.for, label);
      case "report":
        this.input.log("info", "A report was requested; reports from routines are not available yet. Notes were still recorded.", label);
        return;
    }
  }

  private progress(): void {
    this.input.onProgress({ pages: this.pages, notes: this.notes.length });
  }

  // open ────────────────────────────────────────────────────────────────────

  private async openStep(urlRef: string, env: Env, label: string): Promise<void> {
    let url: string | undefined;
    let depth = 0;
    let follow = false;
    const start = /^\$scope\.start\[(\d+)\]$/.exec(urlRef);
    if (start) {
      url = this.spec.scope.start[Number(start[1])];
    } else if (urlRef === "$item") {
      url = env.item?.url;
      depth = (env.item ? this.itemDepth.get(env.item) ?? this.visit?.depth ?? 0 : 0) + 1;
      follow = true;
    } else {
      url = urlRef;
      follow = !this.spec.scope.start.some((s) => sameUrl(s, urlRef));
      depth = follow ? 1 : 0;
    }
    if (!url) throw new SoftError("There was no address to open.");
    await this.load(url, follow, depth, label);
  }

  private async openItemStep(env: Env, label: string): Promise<void> {
    const item = env.item;
    if (!item?.url) throw new SkipItem();
    await this.load(item.url, true, (this.itemDepth.get(item) ?? this.visit?.depth ?? 0) + 1, label);
  }

  /** The one place a page is loaded. Every refusal happens here, before anything is requested. */
  private async load(rawUrl: string, follow: boolean, depth: number, label: string): Promise<void> {
    this.checkLimits();
    const parsed = parseHttpUrl(rawUrl);
    if (!parsed.ok) throw new SoftError(`Refused to open an address that is not a plain http(s) URL.`);
    const url = parsed.url;
    if (!hostInScope(url.hostname, this.spec.scope)) {
      this.input.log("warn", `Refused ${url.hostname}: outside the routine's scope.`, label);
      throw new SoftError("Refused a page outside the routine's scope.");
    }
    if (follow && depth > maxDepthOf(this.spec.scope)) {
      this.input.log("warn", `Refused ${url.hostname}: deeper than max_depth ${maxDepthOf(this.spec.scope)}.`, label);
      throw new SoftError("Refused a page deeper than the routine's max_depth.");
    }
    if (this.pages >= this.pageLimit) {
      throw new RunEnd("budget", `Stopped: the page limit (${this.pageLimit}) for a run was reached.`);
    }
    if (follow && !(await this.robotsAllows(url))) {
      this.input.log("warn", `Refused ${url.hostname}${url.pathname}: robots.txt does not allow it.`, label);
      throw new SoftError("Refused a page that robots.txt does not allow.");
    }
    await this.pace();
    const tab = await this.ensureTab();
    let landed: string;
    try {
      const res = await this.guard(this.deps.browser.navigate(tab, url.href), this.deps.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS);
      landed = res.url || url.href;
    } catch (err) {
      if (err instanceof RunEnd) throw err;
      this.input.log("warn", `Could not load ${url.hostname}${url.pathname}.`, label);
      throw new SoftError("A page could not be opened.");
    }
    this.pages += 1;
    this.lastLoadAt = this.deps.now();
    this.progress();
    const final = parseHttpUrl(landed);
    if (!final.ok || !hostInScope(final.url.hostname, this.spec.scope)) {
      this.visit = null;
      this.input.log("warn", `Refused: the page redirected outside the routine's scope (${final.ok ? final.url.hostname : "not http(s)"}).`, label);
      throw new SoftError("A page redirected outside the routine's scope.");
    }
    this.visit = { url: final.url.href, depth, data: null };
    this.input.log("info", `Opened ${final.url.hostname}${final.url.pathname}${depth > 0 ? ` (depth ${depth})` : ""}.`, label);
  }

  private async pace(): Promise<void> {
    if (this.lastLoadAt === null) return;
    const wait = this.lastLoadAt + this.pageDelayMs - this.deps.now();
    if (wait > 0) await this.deps.sleep(wait, this.input.signal);
    this.checkLimits();
  }

  private async ensureTab(): Promise<string> {
    if (!this.tabId) this.tabId = await this.guard(this.deps.browser.openTab(), this.deps.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS);
    return this.tabId;
  }

  private async closeTab(): Promise<void> {
    const tab = this.tabId;
    this.tabId = null;
    if (!tab) return;
    try {
      await this.deps.browser.closeTab(tab);
    } catch {
      /* the tab may already be gone */
    }
  }

  private async robotsAllows(url: URL): Promise<boolean> {
    let robots = this.robots.get(url.origin);
    if (robots === undefined) {
      try {
        await this.pace();
        const res = await this.guard(this.deps.fetchRobots(`${url.origin}/robots.txt`), 10_000);
        robots = res.status >= 200 && res.status < 300 ? parseRobotsTxt(res.text) : res.status >= 500 ? "unreachable" : "open";
      } catch (err) {
        if (err instanceof RunEnd) throw err;
        robots = "unreachable";
      }
      this.robots.set(url.origin, robots);
    }
    if (robots === "open") return true;
    if (robots === "unreachable") return false;
    return evaluateRobots(robots, ROBOTS_USER_AGENT, `${url.pathname}${url.search}`).allowed;
  }

  // reading a page ──────────────────────────────────────────────────────────

  private async page(): Promise<PageData> {
    const visit = this.visit;
    if (!visit || !this.tabId) throw new SoftError("A step needed an open page, but none was open.");
    if (!visit.data) {
      const raw = await this.guard(this.deps.browser.collect(this.tabId), this.deps.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS).catch((err) => {
        if (err instanceof RunEnd) throw err;
        throw new SoftError("A page could not be read.");
      });
      visit.data = sanitizePageData(raw, visit.url);
    }
    return visit.data;
  }

  // locate ──────────────────────────────────────────────────────────────────

  private async locateStep(step: Extract<RoutineStep, { do: "locate" }>, label: string): Promise<void> {
    const data = await this.page();
    let found: { items: Item[]; how: string; confidence: number } | null = null;
    let best = 0;
    for (const strategy of step.strategies) {
      let cand: { items: Item[]; how: string; confidence: number } | null = null;
      if (strategy === "structured_data" && data.structured.length > 0) {
        cand = { items: data.structured, how: "structured data", confidence: STRUCTURED_CONFIDENCE };
      } else if (strategy === "repeating_blocks" && data.blocks[0]) {
        cand = { items: data.blocks[0].items, how: "repeating blocks", confidence: data.blocks[0].confidence };
      }
      if (!cand) continue;
      best = Math.max(best, cand.confidence);
      if (cand.confidence >= step.min_confidence) {
        found = cand;
        break;
      }
    }
    if (found) {
      const depth = this.visit?.depth ?? 0;
      for (const item of found.items) this.itemDepth.set(item, depth);
      this.input.log("info", `Found ${found.items.length} item${found.items.length === 1 ? "" : "s"} using ${found.how} (confidence ${found.confidence.toFixed(2)}).`, label);
      if (step.id) this.vars.set(step.id, { t: "items", items: found.items });
      return;
    }
    const needsInfer = step.strategies.includes("infer");
    const why = best > 0 ? `best match ${best.toFixed(2)} is below ${step.min_confidence}` : "nothing matched";
    this.input.log("warn", `Could not locate "${clean(step.target, 80)}": ${why}${needsInfer ? "; judgment (infer) is not available yet" : ""}.`, label);
    if (step.on_low === "skip") {
      if (step.id) this.vars.set(step.id, { t: "items", items: [] });
      return;
    }
    if (step.on_low === "ask_human") throw new RunEnd("needs_human", "Needs a person: could not find the expected list on a page with enough confidence.");
    throw new RunEnd("failed", "Failed: could not find the expected list on a page.");
  }

  // extract ─────────────────────────────────────────────────────────────────

  private async extractStep(step: Extract<RoutineStep, { do: "extract" }>, env: Env, label: string): Promise<void> {
    let source: Item | undefined;
    if (step.from === undefined) source = env.item ?? (await this.page()).page;
    else if (step.from === "$item") source = env.item;
    else {
      const val = this.vars.get(step.from.slice(1));
      source = val?.t === "items" ? val.items[0] : val?.rec;
    }
    if (!source) throw new SoftError("An extract step had nothing to read from.");
    const rec: Item = {};
    const missing: string[] = [];
    for (const [name, type] of Object.entries(step.fields)) {
      const raw = lookup(source, name);
      const optional = type.endsWith("?");
      const value = raw === undefined ? undefined : coerce(raw, type.replace(/\?$/, ""), this.visit?.url);
      if (value === undefined) {
        if (!optional) missing.push(name);
      } else rec[name] = value;
    }
    if (missing.length > 0) {
      const infer = step.strategies.includes("infer");
      this.input.log("warn", `Could not read ${missing.join(", ")} from the page${infer ? "; judgment (infer) is not available yet" : ""}.`, label);
      const needsHuman = infer && this.loopDepth === 0;
      throw new SoftError(
        needsHuman ? "Needs a person: a field could not be read without judgment, which isn't available yet." : "A required field could not be read from a page.",
        needsHuman
      );
    }
    const depth = this.itemDepth.get(source);
    if (depth !== undefined) this.itemDepth.set(rec, depth);
    if (step.id) this.vars.set(step.id, { t: "record", rec });
  }

  // diff / for_each / mark_seen ─────────────────────────────────────────────

  private diffStep(step: Extract<RoutineStep, { do: "diff" }>, label: string): void {
    const src = this.vars.get(step.items.slice(1));
    const items = src?.t === "items" ? src.items : [];
    const seenKey = step.against.replace(/^state\./, "");
    const seen = new Set(this.input.state.sets[seenKey] ?? []);
    const fresh: Item[] = [];
    const inRun = new Set<string>();
    let untrackable = 0;
    for (const item of items) {
      const key = keyOf(item, step.key);
      if (key === null) {
        untrackable += 1;
        continue;
      }
      if (seen.has(key) || inRun.has(key)) continue;
      inRun.add(key);
      fresh.push(item);
    }
    if (untrackable > 0) this.input.log("warn", `${untrackable} item${untrackable === 1 ? " has" : "s have"} none of the key fields (${step.key.join(", ")}) and cannot be tracked.`, label);
    this.input.log("info", `${fresh.length} new of ${items.length} item${items.length === 1 ? "" : "s"}.`, label);
    if (step.id) {
      this.vars.set(step.id, { t: "items", items: fresh });
      this.diffs.set(step.id, { against: step.against, key: step.key });
    }
  }

  private async forEachStep(step: Extract<RoutineStep, { do: "for_each" }>, label: string): Promise<void> {
    let items: Item[];
    let loop: { against: string; key: string[] } | undefined;
    if (step.items.startsWith("state.")) {
      items = (this.input.state.sets[step.items.slice(6)] ?? []).map((value) => ({ value }));
    } else {
      const ref = step.items.slice(1);
      const val = this.vars.get(ref);
      items = val?.t === "items" ? val.items : [];
      loop = this.diffs.get(ref);
    }
    const list = items.slice(0, step.limit);
    if (items.length > list.length) this.input.log("info", `Looking at the first ${list.length} of ${items.length} items (limit ${step.limit}).`, label);
    this.loopDepth += 1;
    try {
      for (const item of list) {
        this.checkLimits();
        try {
          await this.runSteps(step.steps, { item, ...(loop ? { loopAgainst: loop.against, loopKey: loop.key } : {}) });
        } catch (err) {
          if (err instanceof SkipItem) {
            this.input.log("info", "Skipped an item.", label);
          } else if (err instanceof SoftError && !err.needsHuman) {
            this.input.log("warn", `Skipped an item: ${err.message}`, label);
          } else {
            throw err;
          }
        }
        this.progress();
      }
    } finally {
      this.loopDepth -= 1;
    }
  }

  private markSeenStep(step: Extract<RoutineStep, { do: "mark_seen" }>, env: Env, label: string): void {
    const item = env.item;
    const against = step.into ?? env.loopAgainst;
    if (!item || !against || !against.startsWith("state.")) {
      this.input.log("warn", "mark_seen had no item or no set to add to; skipped.", label);
      return;
    }
    const setKey = against.slice(6);
    const keyFields = step.into === undefined ? env.loopKey : [...this.diffs.values()].find((d) => d.against === against)?.key;
    const key = keyOf(item, keyFields ?? ["url"]);
    if (key === null) {
      this.input.log("warn", "An item had none of the key fields and could not be marked as seen.", label);
      return;
    }
    const set = (this.input.state.sets[setKey] ??= []);
    if (!set.includes(key)) {
      set.push(key);
      if (set.length > MAX_SET_ITEMS) set.splice(0, set.length - MAX_SET_ITEMS);
    }
  }

  // note ────────────────────────────────────────────────────────────────────

  private noteStep(step: Extract<RoutineStep, { do: "note" }>, env: Env, label: string): void {
    if (this.notes.length >= MAX_NOTES_PER_RUN) throw new RunEnd("budget", `Stopped: the note limit (${MAX_NOTES_PER_RUN}) for a run was reached.`);
    const fields: Record<string, string> = {};
    const put = (name: string, value: string): void => {
      if (value && !(name in fields) && Object.keys(fields).length < 30) fields[name] = clean(value, 2000);
    };
    if (step.tag) put("tag", step.tag);
    const refs = step.fields && step.fields.length > 0 ? step.fields : env.item ? ["$item"] : [];
    for (const ref of refs) {
      if (ref === "$item") {
        for (const [k, v] of Object.entries(env.item ?? {})) put(k, v);
      } else if (ref.startsWith("state.")) {
        const key = ref.slice(6);
        const set = this.input.state.sets[key];
        const log = this.input.state.logs[key];
        const value = this.input.state.values[key];
        if (set) put(`${key}_count`, String(set.length));
        else if (log) put(`${key}_count`, String(log.length));
        else if (value !== undefined) put(key, value);
        else if (key === "notes") put("notes_count", "0");
      } else {
        const val = this.vars.get(ref.slice(1));
        if (val?.t === "record") for (const [k, v] of Object.entries(val.rec)) put(k, v);
        else if (val?.t === "items") put(`${ref.slice(1)}_count`, String(val.items.length));
      }
    }
    if (Object.keys(fields).length === 0) {
      this.input.log("warn", "A note had no fields to record; skipped.", label);
      return;
    }
    const at = this.deps.now();
    const url = env.item?.url ?? this.visit?.url ?? "";
    this.notes.push({
      id: `nt-${at.toString(36)}-${this.deps.random()}`,
      routineId: this.input.routineId,
      runId: this.input.runId,
      at,
      url,
      fields
    });
    this.input.log("info", "Recorded a note.", label);
    this.progress();
  }

  // infer / wait ────────────────────────────────────────────────────────────

  /**
   * Phase 2 has no model, so an `infer` step never produces a value. It applies the spec's
   * own policy deterministically: `skip` skips the item (or the step); anything that needs a
   * verdict (`note_as_maybe`, `ask_human`, `retry_more_context`) ends the run as `needs_human`.
   */
  private inferStep(step: Extract<RoutineStep, { do: "infer" }>, env: Env, label: string): void {
    if (step.on_uncertain === "skip") {
      this.input.log("info", "A judgment step was skipped (policy: skip); no model is available in this version.", label);
      if (env.item) throw new SkipItem();
      return;
    }
    this.input.log("warn", `A judgment step needs a person (policy: ${step.on_uncertain}); no model is available in this version.`, label);
    throw new RunEnd("needs_human", "Needs a person: a step needs judgment, which isn't available yet.");
  }

  private async waitStep(spec: string, label: string): Promise<void> {
    const m = /^(\d+)(s|m|h)$/.exec(spec);
    if (!m) return;
    const ms = Number(m[1]) * (m[2] === "s" ? 1000 : m[2] === "m" ? 60_000 : 3_600_000);
    const left = this.deadline - this.deps.now();
    if (ms >= left) {
      this.input.log("info", `Waiting ${spec} would exceed the time limit.`, label);
      throw new RunEnd("budget", "Stopped: the time limit for a run was reached.");
    }
    this.input.log("info", `Waiting ${spec}.`, label);
    await this.deps.sleep(ms, this.input.signal);
  }

  // helpers ─────────────────────────────────────────────────────────────────

  /** Resolve with `p`, or reject early when the run is cancelled or `ms` passes. */
  private guard<T>(p: Promise<T>, ms: number): Promise<T> {
    const signal = this.input.signal;
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(new RunEnd("cancelled", "Cancelled."));
        return;
      }
      const onAbort = () => finish(() => reject(new RunEnd("cancelled", "Cancelled.")));
      const timer = setTimeout(() => finish(() => reject(new Error("timed out"))), ms);
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
}

// ── pure helpers ──────────────────────────────────────────────────────────────

function sameUrl(a: string, b: string): boolean {
  const pa = parseHttpUrl(a);
  const pb = parseHttpUrl(b);
  return pa.ok && pb.ok ? pa.url.href === pb.url.href : a === b;
}

/** Milliseconds between requests for a `safety.rate` string like "1 request / 2s". */
export function rateDelayMs(rate: string | undefined): number | undefined {
  const m = rate ? /^(\d+) requests? \/ (\d+)s$/.exec(rate) : null;
  if (!m) return undefined;
  const n = Number(m[1]);
  const s = Number(m[2]);
  return n > 0 && s > 0 ? Math.ceil((s * 1000) / n) : undefined;
}

/** Stable identity of an item for diff/mark_seen; null when none of the key fields has a value. */
export function keyOf(item: Item, fields: string[]): string | null {
  const parts = fields.map((f) => lookup(item, f) ?? "");
  if (parts.every((p) => p === "")) return null;
  const key = parts.join("\u001f");
  return key.length > 200 ? `h:${createHash("sha1").update(key).digest("hex")}` : key;
}

function lookup(item: Item, name: string): string | undefined {
  const direct = item[name];
  if (direct) return direct;
  const group = FIELD_ALIASES.find((g) => g.includes(name));
  for (const alias of group ?? []) if (item[alias]) return item[alias];
  return undefined;
}

/** Coerce raw page text to a declared field type; undefined when it does not fit. */
export function coerce(raw: string, type: string, baseUrl?: string): string | undefined {
  const text = clean(raw, 2000);
  if (!text) return undefined;
  const t = /^text(?:<=(\d+))?$/.exec(type);
  if (t) return text.slice(0, t[1] ? Number(t[1]) : 2000);
  switch (type) {
    case "url": {
      try {
        const u = new URL(text, baseUrl);
        return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
      } catch {
        return undefined;
      }
    }
    case "date": {
      // An ISO date is taken as written (no time-zone shift); anything else is read in local time.
      const iso = /^(\d{4})-(\d{2})-(\d{2})(?![\d])/.exec(text);
      if (iso) return Number.isFinite(Date.parse(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`)) ? `${iso[1]}-${iso[2]}-${iso[3]}` : undefined;
      const ms = Date.parse(text);
      if (!Number.isFinite(ms)) return undefined;
      const d = new Date(ms);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    case "number": {
      const m = /-?\d[\d,]*(?:\.\d+)?/.exec(text);
      return m ? m[0].replace(/,/g, "") : undefined;
    }
    case "bool": {
      const v = text.toLowerCase();
      return /^(true|yes|y|1)$/.test(v) ? "true" : /^(false|no|n|0)$/.test(v) ? "false" : undefined;
    }
    default:
      return undefined;
  }
}
