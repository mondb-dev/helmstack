/**
 * Runs one routine once: the deterministic steps of a validated spec, over real pages.
 *
 * What this file does NOT do, by design:
 *  - It never gives a model anything to call. An `infer` step is one tool-less request that is
 *    answered with JSON (see `inference.ts`); the answer is parsed, grounded in the page text and
 *    routed by the spec's thresholds, and a model that is missing or fails ends the run for a
 *    person instead of guessing. Prompts and answers are never logged.
 *  - It never fills, clicks, submits, posts, purchases or downloads on its own. The only things it
 *    does to a page are: load a URL, read it with a fixed script (see `page-data.ts`), and carry out
 *    an `act` step. An `act` goes through the checks in `actStep` (scope, protect list, what always
 *    asks, the human's grants, a check of the page afterwards) and through HelmStack's own command
 *    pipeline; nothing else can change a page.
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
import {
  ALWAYS_ASK,
  candidatesFor,
  chooserQuestion,
  describeAction,
  locateDeterministic,
  mergedProtect,
  numberedList,
  performAndVerify,
  plain,
  protectApplies,
  protectedMatch,
  sensitiveKind,
  shortlist,
  SUBJECT_CHARS,
  type ActBrowser,
  type ActGate,
  type ActionPrivate,
  type RoutineControl
} from "./act.js";
import { DEFAULT_PER_DAY, DEFAULT_PER_RUN } from "./grants.js";
import { MAX_SET_ITEMS, type RoutineStateData } from "../stores/routine-data-store.js";
import {
  INFER_DATA_CHARS,
  INFER_DATA_CHARS_LARGE,
  ModelCallError,
  normalizeForMatch,
  parseOutputKind,
  runInference,
  sanitizeData,
  type InferResult,
  type InferenceModel,
  type OutputKind
} from "./inference.js";
import { CHOOSE_MODEL_MESSAGE, type InferenceResolution } from "./routine-model.js";
import { STRUCTURED_CONFIDENCE, sanitizePageData, type PageData, type PageItem } from "./page-data.js";
import { hostInScope, maxDepthOf, parseHttpUrl } from "./scope.js";

export const ROBOTS_USER_AGENT = "helmstack";
export const DEFAULT_PAGE_DELAY_MS = 1000;
export const MIN_PAGE_DELAY_MS = 1000 / ROUTINE_LIMITS.maxRequestsPerSecond;
export const DEFAULT_MAX_RUNTIME_MS = 30 * 60_000;
export const DEFAULT_NAV_TIMEOUT_MS = 30_000;
export const MAX_NOTES_PER_RUN = 200;

/** How the executor touches a browser. The core adapts a `BrowserBackend` to this. */
export interface RoutineBrowser extends Partial<ActBrowser> {
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
  /** Which model answers judgments. Without it a judgment ends the run asking for a model. */
  resolveModel?: () => Promise<InferenceResolution>;
  /** What an `act` step needs: grants, counters and the action list. Without it an `act` step ends the run. */
  acts?: ActGate;
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
  /** Newest notes of earlier runs; the data a `when_inferred` stop condition is judged on. */
  recentNotes?: readonly RoutineNote[];
};

export type ExecutorResult = {
  outcome: RoutineRunOutcome;
  /** Fixed wording plus counts. Never contains page text. */
  summary: string;
  pagesVisited: number;
  notes: RoutineNote[];
  /** Set when a `when_inferred` stop condition was judged to hold; the engine stops the routine. */
  stopReason?: string;
  /** An action failed its check: the engine pauses the routine at once. */
  pauseNow?: boolean;
  /** The run ended `needs_human` only because actions are waiting for a tap (the engine does not auto-pause for that). */
  waitingOnActions?: boolean;
};

// ── control flow ────────────────────────────────────────────────────────────

/** Ends the run with this outcome. */
class RunEnd extends Error {
  constructor(readonly outcome: RoutineRunOutcome, readonly summaryText: string, readonly pause = false) {
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
type Val = { t: "items"; items: Item[] } | { t: "record"; rec: Item } | { t: "verdict"; r: InferResult; out: OutputKind };
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
  private modelResolution: Promise<InferenceResolution> | null = null;
  private tokensUsed = 0;
  private costNoted = false;
  /** Notes recorded while this is true are marked as maybes. Reset for each loop item. */
  private maybe = false;
  /** Actions queued for a human this run. After the first, nothing else is done automatically this run. */
  private pendingQueued = 0;
  private readonly attempts = new Map<string, number>();
  private pauseNow = false;

  constructor(private readonly deps: ExecutorDeps, private readonly input: ExecutorInput) {
    this.spec = input.spec;
    this.startedAt = deps.now();
    const budgets = this.spec.stop?.budgets;
    this.pageLimit = Math.min(this.spec.scope.max_pages_per_run, budgets?.pages_per_run ?? Number.POSITIVE_INFINITY, ROUTINE_LIMITS.maxPagesPerRun);
    const runtime = budgets?.runtime_minutes_per_run !== undefined ? budgets.runtime_minutes_per_run * 60_000 : (deps.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS);
    this.deadline = this.startedAt + Math.min(runtime, deps.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS);
    this.pageDelayMs = Math.max(MIN_PAGE_DELAY_MS, rateDelayMs(this.spec.safety?.rate) ?? deps.defaultPageDelayMs ?? DEFAULT_PAGE_DELAY_MS);
    // tokens_per_run is checked before every model call (estimated at characters / 4). cost_usd_total is
    // not tracked: local models cost nothing and CLI models do not report a price HelmStack can trust.
  }

  async run(): Promise<ExecutorResult> {
    let outcome: RoutineRunOutcome = "completed";
    let summaryText = "";
    let stopReason: string | null = null;
    try {
      this.input.log("info", `Run started (${this.spec.steps.length} step${this.spec.steps.length === 1 ? "" : "s"}).`);
      try {
        await this.runSteps(this.spec.steps, {});
        stopReason = await this.evaluateStops();
      } catch (err) {
        if (err instanceof SoftError) throw new RunEnd(err.needsHuman ? "needs_human" : "failed", err.message);
        if (err instanceof SkipItem) this.input.log("warn", "A step was skipped outside a loop.");
        else throw err;
      }
    } catch (err) {
      if (err instanceof RunEnd) {
        outcome = err.outcome;
        summaryText = err.summaryText;
        this.pauseNow = err.pause;
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
    let waiting = false;
    if (outcome === "completed" && this.pendingQueued > 0) {
      outcome = "needs_human";
      waiting = true;
      summaryText = `Waiting for you to approve ${this.pendingQueued} action${this.pendingQueued === 1 ? "" : "s"} (${counts}).`;
    } else if (outcome === "completed") summaryText = `Completed: ${counts}.`;
    else if (!summaryText) summaryText = outcome === "cancelled" ? "Cancelled." : `Ended: ${outcome}.`;
    else if (outcome !== "cancelled") summaryText = `${summaryText} (${counts})`;
    return {
      outcome,
      summary: summaryText,
      pagesVisited: this.pages,
      notes: this.notes,
      ...(stopReason && outcome === "completed" ? { stopReason } : {}),
      ...(this.pauseNow && outcome === "failed" ? { pauseNow: true } : {}),
      ...(waiting ? { waitingOnActions: true } : {})
    };
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
        return this.branchStep(step, env, label);
      case "act":
        return this.actStep(step, env, label);
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
      source = val?.t === "items" ? val.items[0] : val?.t === "record" ? val.rec : undefined;
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
    const maybeBefore = this.maybe;
    try {
      for (const item of list) {
        this.checkLimits();
        this.maybe = maybeBefore;
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
      this.maybe = maybeBefore;
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
        else if (val?.t === "verdict") {
          const id = ref.slice(1);
          put(id, valueText(val.r.value));
          put(`${id}_confidence`, val.r.confidence.toFixed(2));
          put(`${id}_verdict`, val.r.verdict);
          if (val.r.evidence) put(`${id}_evidence`, val.r.evidence);
        } else if (val?.t === "items") put(`${ref.slice(1)}_count`, String(val.items.length));
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
      fields,
      ...(this.maybe ? { maybe: true } : {})
    });
    this.input.log("info", this.maybe ? "Recorded a note (as a maybe)." : "Recorded a note.", label);
    this.progress();
  }

  // infer / wait ────────────────────────────────────────────────────────────

  // infer / branch ──────────────────────────────────────────────────────────

  /**
   * A judgment. Gathers the `uses` data, asks the model once per sample, and routes the result by the
   * spec's thresholds: accept, reject, or uncertain (handled by `on_uncertain`). A model that is
   * missing or fails ends the run for a person; nothing is ever guessed.
   */
  private async inferStep(step: Extract<RoutineStep, { do: "infer" }>, env: Env, label: string): Promise<void> {
    const first = await this.gatherData(step, env, false);
    let result = await this.judge(step, first.text, label);
    if (result.verdict === "maybe" && step.on_uncertain === "retry_more_context") {
      const more = await this.gatherData(step, env, true);
      if (more.text.length > first.text.length) {
        this.input.log("info", "The judgment was uncertain; asking again with more context.", label);
        result = await this.judge(step, more.text, label);
      } else {
        this.input.log("info", "The judgment was uncertain and there is no more context to add.", label);
      }
    }
    this.input.log("info", describeResult(step, result), label);
    // A skipped judgment leaves no verdict behind, so a later branch has nothing to follow.
    const skipped = result.verdict === "maybe" && step.on_uncertain === "skip";
    if (step.id) {
      if (skipped) this.vars.delete(step.id);
      else this.vars.set(step.id, { t: "verdict", r: result, out: parseOutputKind(step.output, step.labels) });
    }
    if (result.verdict !== "maybe") return;
    switch (step.on_uncertain) {
      case "note_as_maybe":
        this.maybe = true;
        return;
      case "skip":
        if (env.item) throw new SkipItem();
        return;
      default:
        throw new RunEnd("needs_human", "Needs a person: a judgment was uncertain and this routine asks you to decide. Nothing was guessed.");
    }
  }

  private async branchStep(step: Extract<RoutineStep, { do: "branch" }>, env: Env, label: string): Promise<void> {
    const v = this.vars.get(step.on);
    if (v?.t !== "verdict") {
      this.input.log("warn", `Branch on "${step.on}" had no judgment to follow; nothing was done.`, label);
      return;
    }
    const verdict = v.r.verdict;
    const arm = verdict === "accept" ? step.accept : verdict === "reject" ? step.reject : step.maybe;
    this.input.log("info", `Branch: following the ${verdict === "maybe" ? "uncertain" : verdict === "accept" ? "accepted" : "rejected"} path${arm && arm.length > 0 ? "" : " (nothing to do)"}.`, label);
    if (!arm || arm.length === 0) return;
    const before = this.maybe;
    if (verdict === "maybe") this.maybe = true;
    try {
      await this.runSteps(arm, env);
    } finally {
      this.maybe = before;
    }
  }

  /** The text a judgment looks at, from `uses` (default: the current item, or the open page). */
  private async gatherData(step: Extract<RoutineStep, { do: "infer" }>, env: Env, larger: boolean): Promise<{ text: string; truncated: boolean }> {
    const cap = larger ? INFER_DATA_CHARS_LARGE : INFER_DATA_CHARS;
    const ref = step.uses ?? (env.item ? "$item" : "$page");
    let text = await this.refText(ref, env);
    if (larger && this.visit) {
      // More context: the page the item came from.
      const page = (await this.page()).page;
      const extra = recordText(page);
      if (extra && !text.includes(extra)) text = `${text}\n\nThe page it is on:\n${extra}`;
    }
    return sanitizeData(text, cap);
  }

  private async refText(ref: string, env: Env): Promise<string> {
    if (ref === "$item") return recordText(env.item ?? {});
    if (ref === "$page") return recordText((await this.page()).page);
    if (ref.startsWith("state.")) {
      const key = ref.slice(6);
      const set = this.input.state.sets[key];
      const log = this.input.state.logs[key];
      const value = this.input.state.values[key];
      if (set) return set.slice(-100).join("\n");
      if (log) return log.slice(-100).join("\n");
      return value ?? "";
    }
    const val = this.vars.get(ref.slice(1));
    if (val?.t === "record") return recordText(val.rec);
    if (val?.t === "items") return val.items.slice(0, 50).map((i) => `- ${recordText(i, " | ")}`).join("\n");
    if (val?.t === "verdict") return `value: ${valueText(val.r.value)}\nconfidence: ${val.r.confidence.toFixed(2)}${val.r.evidence ? `\nevidence: ${val.r.evidence}` : ""}`;
    return "";
  }

  private async model(): Promise<InferenceModel> {
    this.modelResolution ??= this.deps.resolveModel ? this.deps.resolveModel() : Promise.resolve({ ok: false, reason: CHOOSE_MODEL_MESSAGE, chosen: false });
    let res: InferenceResolution;
    try {
      res = await this.guard(this.modelResolution, 20_000);
    } catch (err) {
      if (err instanceof RunEnd) throw err;
      res = { ok: false, reason: "the model could not be checked", chosen: true };
    }
    if (res.ok) {
      if (!this.costNoted && this.spec.stop?.budgets?.cost_usd_total !== undefined && !res.model.local) {
        this.costNoted = true;
        this.input.log("info", "Cost is not tracked for command-line models, so cost_usd_total is not enforced; tokens_per_run still is.");
      }
      return res.model;
    }
    this.input.log("warn", res.chosen ? `The model chosen for routines is not available: ${clean(res.reason, 160)}` : "No model is chosen for routines.");
    throw new RunEnd(
      "needs_human",
      res.chosen ? "Needs a person: the model chosen for routines isn't available. Check it in the Routines tab." : `Needs a person: ${CHOOSE_MODEL_MESSAGE}.`
    );
  }

  /** One judgment, with the token budget, retries and failure handling. Never returns a guess. */
  private async judge(step: Extract<RoutineStep, { do: "infer" }>, data: string, label: string): Promise<InferResult> {
    if (data.trim() === "") {
      this.input.log("warn", "A judgment had nothing to look at.", label);
      return { verdict: "maybe", value: null, confidence: 0, evidence: "", grounded: false, routed: 0, samples: 0, agreed: 0, reason: "invalid" };
    }
    const model = await this.model();
    return this.ask(model, label, {
      question: step.question,
      output: step.output,
      ...(step.labels ? { labels: step.labels } : {}),
      evidence: step.evidence ?? "quote",
      samples: step.samples ?? 1,
      data,
      accept_at: step.accept_at,
      reject_below: step.reject_below
    });
  }

  private async ask(model: InferenceModel, label: string, req: Parameters<typeof runInference>[0]): Promise<InferResult> {
    const budget = this.spec.stop?.budgets?.tokens_per_run;
    const failure = this.spec.on_failure;
    try {
      return await runInference(req, {
        model,
        signal: this.input.signal,
        retries: failure?.retries ?? 1,
        backoffMs: (attempt) => (failure?.backoff === "fixed" ? 2000 : 2000 * 2 ** attempt),
        sleep: this.deps.sleep,
        gate: (estimate) => {
          if (budget !== undefined && this.tokensUsed + estimate > budget) {
            throw new RunEnd("budget", `Stopped: the model token budget (${budget}) for a run was reached.`);
          }
        },
        spent: (tokens) => {
          this.tokensUsed += tokens;
        }
      });
    } catch (err) {
      if (err instanceof RunEnd) throw err;
      if (err instanceof ModelCallError) {
        if (err.kind === "cancelled" || this.input.signal.aborted) throw new RunEnd("cancelled", "Cancelled.");
        this.input.log("warn", `The model could not answer: ${err.message}`, label);
        if (err.kind === "unavailable" || !failure) throw new RunEnd("needs_human", `Needs a person: the model could not answer (${err.message.replace(/\.$/, "")}).`);
        throw new RunEnd("failed", `Failed: the model could not answer (${err.message.replace(/\.$/, "")}).`);
      }
      throw err;
    }
  }

  /**
   * `stop.any` entries of kind `when_inferred`, judged once at the end of a completed run on this run's
   * notes and the newest earlier ones. A condition that holds stops the routine; a model that cannot
   * answer only skips the check, since stopping is never forced by guesswork.
   */
  private async evaluateStops(): Promise<string | null> {
    const conditions = (this.spec.stop?.any ?? []).flatMap((c) => ("when_inferred" in c ? [c] : []));
    if (conditions.length === 0) return null;
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const note of [...this.notes, ...(this.input.recentNotes ?? [])]) {
      if (seen.has(note.id)) continue;
      seen.add(note.id);
      const text = recordText(note.fields, " | ");
      if (text) lines.push(`- ${text}`);
    }
    if (lines.length === 0) {
      this.input.log("info", "A stop condition that needs judgment was not checked: there are no notes to judge yet.");
      return null;
    }
    const data = sanitizeData(lines.join("\n"), INFER_DATA_CHARS).text;
    try {
      const model = await this.model();
      for (const cond of conditions) {
        const result = await this.ask(model, "stop", {
          question: `Is this true? ${cond.when_inferred}`,
          output: "bool",
          evidence: "quote",
          samples: 2,
          data,
          accept_at: cond.confidence,
          reject_below: 0
        });
        this.input.log("info", `Stop condition judged: ${result.verdict === "accept" && result.value === true ? "it holds" : "it does not hold (or is unclear)"} (confidence ${result.confidence.toFixed(2)}).`);
        if (result.verdict === "accept" && result.value === true) return `judged: ${clean(cond.when_inferred, 80)}`;
      }
    } catch (err) {
      if (err instanceof RunEnd && err.outcome === "cancelled") throw err;
      this.input.log("warn", "A stop condition that needs judgment could not be checked this time.");
    }
    return null;
  }

  // act ──────────────────────────────────────────────────────────────────────
  //
  // Every act goes through these checks, in this order, and all of them must pass:
  //  (a) the routine may still act (not paused, stopped, cancelled or killed)
  //  (b) the page is inside the routine's scope
  //  (c) the subject is not on the protect list (remove / offer / respond / moving out of play)
  //  -   the control is located (accessible name and row text; a model only ever picks from a list)
  //  (d) offers, answers to offers and `other` always wait for a human
  //  (e) automatic only with the human's grant and under its per-run and per-day limits
  //  (f) anything HelmStack itself always asks about is never automatic, whatever was granted
  //  (g) afterwards the page must show what `verify` says; if not, the run fails and the routine pauses

  private async actStep(step: Extract<RoutineStep, { do: "act" }>, env: Env, label: string): Promise<void> {
    const acts = this.deps.acts;
    const b = this.deps.browser;
    if (!acts || !b.controls || !b.perform || !b.pageState) {
      throw new RunEnd("failed", "Failed: this setup cannot carry out actions, so the routine did nothing.");
    }
    this.checkLimits();
    // (a)
    const off = acts.mayAct();
    if (off) throw new RunEnd("cancelled", `Stopped: ${off}`);
    const tab = this.tabId;
    if (!this.visit || !tab) throw new SoftError("An action needed an open page, but none was open.");
    const live = await this.guard(b.pageState(tab), this.deps.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS).catch((err) => {
      if (err instanceof RunEnd) throw err;
      throw new SoftError("A page could not be read before an action.");
    });
    const liveUrl = parseHttpUrl(live.url);
    const host = liveUrl.ok ? liveUrl.url.hostname : "an unknown page";
    const inScope = (url: string): boolean => {
      const parsed = parseHttpUrl(url);
      return parsed.ok && hostInScope(parsed.url.hostname, this.spec.scope);
    };
    const text = (ref: string): string => (ref.startsWith("$") || ref.startsWith("state.") ? this.refPlain(ref, env) : ref);
    const subject = step.subject !== undefined ? plain(this.refPlain(step.subject, env), SUBJECT_CHARS) || undefined : undefined;
    const value = step.value !== undefined ? text(step.value).slice(0, ROUTINE_LIMITS.actValueChars) : undefined;
    const verify = {
      present: (step.verify.present ?? []).map((v) => plain(text(v), ROUTINE_LIMITS.verifyChars)),
      absent: (step.verify.absent ?? []).map((v) => plain(text(v), ROUTINE_LIMITS.verifyChars))
    };
    if ((step.action !== "click" && !value) || [...verify.present, ...verify.absent].some((v) => v === "")) {
      this.input.log("warn", "An action was skipped: it had no value to use or nothing to check afterwards.", label);
      throw new SoftError("An action had no value or no check, so it was skipped.");
    }
    const draftBase = { runId: this.input.runId, effect: step.effect, action: step.action, host, url: live.url, ...(subject ? { subject } : {}) };
    const secretBase = { target: step.target, strategies: step.strategies, minConfidence: step.min_confidence, verify, ...(value !== undefined ? { value } : {}) };
    const label2 = (what: string): string => `${step.effect} ${step.action}${subject ? ` for ${subject}` : ""} on ${host}: ${what}`;

    // (b)
    if (!inScope(live.url)) {
      acts.record({ ...draftBase, description: describeAction({ action: step.action, controlName: "control", ...(subject ? { subject } : {}), host }), status: "blocked", note: "The page is outside the routine's scope, so nothing was done." });
      this.input.log("warn", label2("blocked, the page is outside the routine's scope."), label);
      throw new SoftError("An action was blocked: the page is outside the routine's scope.");
    }

    // (c)
    const grants0 = acts.grants();
    const protect = mergedProtect(this.spec.actions?.protect, grants0);
    let forced: string | null = null;
    if (protectApplies(step.effect, step.target, value)) {
      if (subject) {
        if (protectedMatch(protect, subject)) {
          acts.record({
            ...draftBase,
            description: describeAction({ action: step.action, controlName: "control", subject, host, ...(step.action === "select" && value ? { value } : {}) }),
            status: "blocked",
            note: "It involves a protected name, so it is never done and never asked."
          });
          this.input.log("info", label2("blocked, it involves a protected name."), label);
          return;
        }
      } else if (protect.length > 0) {
        forced = "There was no subject to check against the protected names, so it waits for you.";
      }
    }

    // locate
    const controls = await this.guard(b.controls(tab), this.deps.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS).catch((err) => {
      if (err instanceof RunEnd) throw err;
      throw new SoftError("The page's controls could not be read.");
    });
    const found = await this.locateControl(step, subject, controls, label);
    if (!found) {
      this.input.log("warn", `Could not find the control for "${clean(step.target, 80)}" with enough confidence${subject ? ` (for ${subject})` : ""}.`, label);
      if (step.on_low === "skip") return;
      if (step.on_low === "ask_human") throw new RunEnd("needs_human", "Needs a person: could not find the control for an action with enough confidence.");
      throw new RunEnd("failed", "Failed: could not find the control for an action.");
    }
    const control = found.control;
    const description = describeAction({ action: step.action, controlName: control.name, ...(subject ? { subject } : {}), host, ...(step.action === "select" && value ? { value } : step.action === "fill" && value ? { value } : {}) });
    const secret: ActionPrivate = { ...secretBase, controlName: control.name, controlRole: control.role };
    const queue = (note: string): void => {
      acts.record({ ...draftBase, description, status: "pending", note, secret });
      this.pendingQueued += 1;
      this.input.log("info", label2(`waiting for you (${note})`), label);
    };

    // (d) (e) (f)
    if (forced) return queue(forced);
    if (ALWAYS_ASK.includes(step.effect)) return queue("Offers, answers to offers and other changes always wait for you.");
    if (this.pendingQueued > 0) return queue("It waits behind an earlier action that needs you.");
    const grant = acts.grants().effects[step.effect];
    if (grant?.mode !== "auto") return queue("You have not allowed this to run without asking.");
    const kind = sensitiveKind(control.name);
    if (kind) return queue(`HelmStack always asks before ${kind}; no grant changes that.`);
    const perRun = grant.perRun ?? DEFAULT_PER_RUN;
    const perDay = grant.perDay ?? DEFAULT_PER_DAY;
    if ((this.attempts.get(step.effect) ?? 0) >= perRun) return queue(`The limit of ${perRun} per run was reached.`);
    if (!acts.reserveDaily(step.effect, perDay)) return queue(`The limit of ${perDay} per day was reached.`);
    this.attempts.set(step.effect, (this.attempts.get(step.effect) ?? 0) + 1);

    // go
    const rec = acts.record({ ...draftBase, description, status: "approved", allowedBy: "grant", note: "Allowed by your grant; running now.", secret });
    await acts.throttle(this.input.signal);
    const off2 = acts.mayAct();
    if (off2 || this.input.signal.aborted) {
      acts.update(rec.id, { status: "failed", note: "Cancelled before it ran." });
      throw new RunEnd("cancelled", `Stopped: ${off2 ?? "cancelled"}`);
    }
    const outcome = await performAndVerify({
      browser: b as ActBrowser,
      tab,
      control,
      action: step.action,
      ...(value !== undefined ? { value } : {}),
      verify,
      inScope,
      sleep: this.deps.sleep,
      signal: this.input.signal
    });
    if (this.visit) this.visit.data = null;
    switch (outcome.status) {
      case "done":
        acts.update(rec.id, { status: "done", note: "Done, and the page shows the expected result." });
        this.input.log("info", label2("done and checked."), label);
        return;
      case "needs_approval": {
        acts.update(rec.id, { status: "pending", allowedBy: undefined, note: `HelmStack asks for its own approval first (${outcome.kinds.join(", ")}). No grant changes that.` });
        this.pendingQueued += 1;
        this.input.log("info", label2("waiting for you (HelmStack's own approval is needed)."), label);
        return;
      }
      case "blocked":
        acts.update(rec.id, { status: "blocked", note: "HelmStack's approval settings block this kind of change." });
        this.input.log("warn", label2("blocked by HelmStack's approval settings."), label);
        return;
      case "failed":
        acts.update(rec.id, { status: "failed", note: outcome.reason });
        this.input.log("error", label2("failed, the routine was paused."), label);
        throw new RunEnd("failed", "Failed: an action did not do what it should, so the routine was paused. Check the site before resuming.", true);
    }
  }

  /** Text of a reference for a subject, a value or a check. Nothing is evaluated. */
  private refPlain(ref: string, env: Env): string {
    if (ref === "$item") return primaryText(env.item ?? {});
    if (ref.startsWith("state.")) return this.input.state.values[ref.slice(6)] ?? "";
    const val = this.vars.get(ref.slice(1));
    if (val?.t === "record") return primaryText(val.rec);
    if (val?.t === "verdict") return valueText(val.r.value);
    return "";
  }

  /** The control for an act step: the step's strategies in order; a model may only pick from a numbered list. */
  private async locateControl(
    step: Extract<RoutineStep, { do: "act" }>,
    subject: string | undefined,
    controls: readonly RoutineControl[],
    label: string
  ): Promise<{ control: RoutineControl; confidence: number } | null> {
    const candidates = candidatesFor(step.action, controls);
    const det = locateDeterministic(step.strategies, step.target, subject, candidates, step.min_confidence);
    if (det.found) return { control: det.control, confidence: det.confidence };
    if (!step.strategies.includes("infer")) return null;
    const listed = numberedList(shortlist(candidates, subject));
    if (listed.controls.length === 0) return null;
    const { question, labels } = chooserQuestion(step.target, subject, listed.controls.length);
    const data = sanitizeData(listed.text, INFER_DATA_CHARS).text;
    const model = await this.model();
    const result = await this.ask(model, label, {
      question,
      output: "label",
      labels,
      evidence: "quote",
      samples: 2,
      data,
      accept_at: step.min_confidence,
      reject_below: 0
    });
    if (result.verdict !== "accept" || typeof result.value !== "string" || result.value === "none") return null;
    const index = Number(result.value) - 1;
    const chosen = listed.controls[index];
    if (!chosen) return null;
    // The quote has to come from the chosen entry itself, not from a neighbour.
    const line = data.split("\n").find((l) => l.startsWith(`${index + 1}. `));
    if (!line || !result.evidence || !normalizeForMatch(line).includes(normalizeForMatch(result.evidence))) return null;
    return { control: chosen, confidence: result.confidence };
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

/** The field of a record that names it: a name or title first, else the first text that is not a link. */
function primaryText(rec: Record<string, string>): string {
  for (const key of ["name", "title", "player", "label", "text", "summary"]) if (rec[key]) return clean(rec[key]!, 200);
  const first = Object.entries(rec).find(([k, v]) => typeof v === "string" && v !== "" && k !== "url");
  return first ? clean(first[1], 200) : "";
}

/** `key: value` lines of a record (page-supplied text; the caller sanitizes and caps). */
function recordText(rec: Record<string, string>, sep = "\n"): string {
  return Object.entries(rec)
    .filter(([, v]) => typeof v === "string" && v !== "")
    .map(([k, v]) => `${k}: ${v}`)
    .join(sep);
}

/** Short text for a stored value: label, number or bool as is; free text only by length. */
function valueText(value: InferResult["value"]): string {
  return value === null ? "" : String(value);
}

const UNCERTAIN_WHY: Record<NonNullable<InferResult["reason"]>, string> = {
  invalid: "the answer was not usable",
  ungrounded: "the quote was not found in the page text",
  disagreement: "the answers disagreed",
  thresholds: "between the accept and reject thresholds"
};

/** Fixed wording plus the value and confidence; never the prompt, the answer text or page text. */
function describeResult(step: Extract<RoutineStep, { do: "infer" }>, r: InferResult): string {
  const name = step.id ? `"${step.id}"` : "A judgment";
  const asText = step.output.startsWith("text");
  const value = r.value === null ? "no value" : asText ? `text of ${String(r.value).length} characters` : `value ${String(r.value)}`;
  const agree = r.samples > 1 ? `, ${r.agreed} of ${r.samples} agree` : "";
  const quote = r.grounded ? ", quote verified" : "";
  if (r.verdict === "maybe") return `${name} is uncertain (${UNCERTAIN_WHY[r.reason ?? "thresholds"]}; confidence ${r.confidence.toFixed(2)}${agree}).`;
  return `${name} ${r.verdict === "accept" ? "accepted" : "rejected"}: ${value}, confidence ${r.confidence.toFixed(2)}${agree}${quote}.`;
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
