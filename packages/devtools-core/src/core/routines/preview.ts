/**
 * Plain-language preview of a routine, built without a model.
 *
 * `buildPreview` is a pure function of the spec: the same spec always yields the same
 * headline, bullets and risk flags, in the same order. The human approves what this says,
 * so it states the real thresholds, scope, stop conditions and budgets.
 */
import {
  ROUTINE_AUTO_EFFECTS,
  ROUTINE_EFFECTS,
  type RoutineEffect,
  type RoutinePreview,
  type RoutineRisk,
  type RoutineSpec,
  type RoutineStep
} from "../../../../shared/src/index.js";
import { minimumMinuteGap, parseCron } from "./cron.js";
import { isScopeOpen, maxDepthOf, parseHttpUrl, scopeHosts } from "./scope.js";
import { parseEveryMinutes } from "./validate.js";

export const MAX_PREVIEW_LINES = 10;

const clip = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};
const num = (n: number): string => String(Number(n.toFixed(2)));
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const pad2 = (n: number): string => String(n).padStart(2, "0");
const naturalList = (items: string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;

// ── Trigger ──────────────────────────────────────────────────────────────────

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function describeEvery(every: string): string {
  const m = /^(\d+)(m|h|d)$/.exec(every);
  if (!m) return `every ${every}`;
  const n = Number(m[1]);
  const unit = m[2] === "m" ? "minute" : m[2] === "h" ? "hour" : "day";
  return n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
}

function describeCron(expr: string, timezone?: string): string {
  const zone = timezone ? ` (${timezone})` : "";
  const p = parseCron(expr);
  if (!p.ok) return `on the schedule "${expr}"${zone}`;
  const parts = expr.trim().split(/\s+/);
  if (parts.every((f) => f === "*")) return `every minute${zone}`;
  const stepMinutes = /^\*\/(\d+)$/.exec(parts[0]!);
  if (stepMinutes && parts.slice(1).every((f) => f === "*")) return `${describeEvery(`${stepMinutes[1]}m`)}${zone}`;
  const allDays = p.star.dom && p.star.month && p.star.dow;
  if (p.minute.length === 1 && !p.star.minute && p.star.hour && allDays) {
    return `every hour${p.minute[0] === 0 ? " on the hour" : ` at :${pad2(p.minute[0]!)}`}${zone}`;
  }
  if (p.minute.length === 1 && !p.star.minute && !p.star.hour && p.hour.length <= 4) {
    const times = p.hour.map((h) => `${pad2(h)}:${pad2(p.minute[0]!)}`).join(" and ");
    if (p.star.month && p.star.dom) {
      if (p.star.dow) return `every day at ${times}${zone}`;
      const d = p.dow.join(",");
      if (d === "1,2,3,4,5") return `weekdays at ${times}${zone}`;
      if (d === "0,6") return `weekends at ${times}${zone}`;
      if (p.dow.length === 1) return `every ${DAY_NAMES[p.dow[0]!]} at ${times}${zone}`;
      return `${p.dow.map((x) => DAY_NAMES[x]!.slice(0, 3)).join(", ")} at ${times}${zone}`;
    }
    if (p.star.month && p.star.dow && p.dom.length === 1) return `on day ${p.dom[0]} of every month at ${times}${zone}`;
  }
  return `on the schedule "${expr}"${zone}`;
}

/** Trigger text for `RoutineSummary.trigger`: "every 6 hours", "weekdays at 09:00", "manual". */
export function triggerText(trigger: RoutineSpec["trigger"]): string {
  switch (trigger.kind) {
    case "manual":
      return "manual";
    case "interval":
      return describeEvery(trigger.every);
    case "schedule":
      return describeCron(trigger.cron, trigger.timezone);
    case "event":
      return `when a watch fires: ${clip(trigger.watch, 120)}`;
  }
}

// ── Steps ────────────────────────────────────────────────────────────────────

/** What each effect means in words that fit any site. */
const EFFECT_TEXT: Record<RoutineEffect, string> = {
  rearrange: "rearrange your items",
  add_item: "add items",
  remove_item: "remove items",
  offer: "send offers to other people",
  respond: "answer other people's offers",
  other: "make other changes"
};

function walk(steps: readonly RoutineStep[], visit: (step: RoutineStep) => void): void {
  for (const step of steps) {
    visit(step);
    if (step.do === "for_each") walk(step.steps, visit);
    if (step.do === "branch") {
      walk(step.accept ?? [], visit);
      walk(step.maybe ?? [], visit);
      walk(step.reject ?? [], visit);
    }
  }
}

export function countSteps(spec: Pick<RoutineSpec, "steps">): number {
  let n = 0;
  walk(spec.steps, () => {
    n += 1;
  });
  return n;
}

function allSteps(spec: RoutineSpec): RoutineStep[] {
  const out: RoutineStep[] = [];
  walk(spec.steps, (s) => out.push(s));
  return out;
}

function urlPhrase(url: string, startCount: number): string {
  if (url === "$item") return "the item's page";
  const m = /^\$scope\.start\[(\d+)\]$/.exec(url);
  if (m) return startCount > 1 ? `start page ${Number(m[1]) + 1}` : "the start page";
  const parsed = parseHttpUrl(url);
  return parsed.ok ? parsed.url.hostname : "a page";
}

function phrase(step: RoutineStep, startCount: number): string {
  switch (step.do) {
    case "open":
      return `open ${urlPhrase(step.url, startCount)}`;
    case "locate":
      return `find ${clip(step.target, 80)}`;
    case "extract":
      return `read ${Object.keys(step.fields).join(", ")}`;
    case "diff":
      return `keep only what is not already in ${step.against.replace(/^state\./, "")}`;
    case "for_each":
      return `for each of up to ${step.limit} items: ${step.steps.map((s) => phrase(s, startCount)).join(", ")}`;
    case "infer":
      return `judge "${clip(step.question, 100)}"`;
    case "act":
      return `${step.action === "click" ? "click" : step.action === "fill" ? "type into" : "choose in"} ${clip(step.target, 80)} (${EFFECT_TEXT[step.effect]})`;
    case "branch": {
      const arm = (label: string, list: RoutineStep[] | undefined) =>
        list && list.length ? `${label}: ${list.map((s) => phrase(s, startCount)).join(" and ")}` : null;
      const arms = [arm("accepted", step.accept), arm("uncertain", step.maybe), arm("rejected", step.reject)].filter(Boolean);
      return `act on the verdict (${arms.join("; ")})`;
    }
    case "note":
      return step.tag ? `note it as ${step.tag}` : "note it";
    case "mark_seen":
      return "mark it as seen";
    case "open_item":
      return "open the item";
    case "wait":
      return `wait ${step.for}`;
    case "report":
      return "write a report";
  }
}

// ── Risks ────────────────────────────────────────────────────────────────────

const LOGIN_HINT = /(^|[/._-])(log-?in|sign-?in|signin|signup|sign-?up|register|auth|account|accounts|my-?account|checkout|cart|payment|billing|password)([/._-]|$)/i;

const RISK_ORDER = [
  "any_site",
  "acts_on_account",
  "has_login_hint",
  "no_stop_condition",
  "fast_interval",
  "no_budgets",
  "low_accept_threshold",
  "requests_auto",
  "no_protect_list",
  "event_trigger_unverified",
  "many_pages",
  "no_evidence_check",
  "no_human_fallback",
  "judged_by_model",
  "related_widens_scope"
] as const;
const LEVEL_RANK = { high: 0, warning: 1, info: 2 } as const;

/** Risk flags with stable codes, most serious first. */
export function assessRisks(spec: RoutineSpec): RoutineRisk[] {
  const risks = new Map<string, RoutineRisk>();
  const flag = (level: RoutineRisk["level"], code: (typeof RISK_ORDER)[number], message: string): void => {
    if (!risks.has(code)) risks.set(code, { level, code, message });
  };
  const steps = allSteps(spec);
  const infers = steps.flatMap((s) => (s.do === "infer" ? [s] : []));

  if (isScopeOpen(spec.scope)) {
    flag("high", "any_site", "This routine is not limited to specific sites: it can follow links to any site. Restrict it to the sites you expect.");
  }
  const acts = steps.flatMap((s) => (s.do === "act" ? [s] : []));
  if (acts.length > 0) {
    flag(
      "high",
      "acts_on_account",
      "This routine can change things on a site (click, type or choose). Each change asks you first unless you allow it when approving, it is checked on the page afterwards, and a failed check pauses the routine."
    );
  }
  const autoAsked = ROUTINE_EFFECTS.filter((e) => spec.actions?.request?.[e]?.mode === "auto");
  if (acts.length > 0 && autoAsked.length > 0) {
    flag(
      "warning",
      "requests_auto",
      `It asks to run without asking you for: ${autoAsked.map((e) => EFFECT_TEXT[e]).join(", ")}. Nothing runs unasked unless you grant it when you approve, and you can change that any time.`
    );
  }
  if (acts.some((a) => a.effect === "remove_item" || a.effect === "offer") && !(spec.actions?.protect && spec.actions.protect.length > 0)) {
    flag("warning", "no_protect_list", "It can remove items or send offers but names nothing to protect. You can add names it must never remove or give away when you approve.");
  }
  const loginish = spec.scope.start.some((u) => {
    const parsed = parseHttpUrl(u);
    return parsed.ok && LOGIN_HINT.test(`${parsed.url.hostname}${parsed.url.pathname}`);
  });
  if (loginish) {
    flag("warning", "has_login_hint", "A start page looks like a login, account or checkout page. Routines never type credentials; use a profile you're already signed into.");
  }
  const stop = spec.stop;
  if (!stop?.any || stop.any.length === 0) {
    flag("warning", "no_stop_condition", "This routine has no stop condition and will keep running until you stop it.");
  }
  const t = spec.trigger;
  if (t.kind === "interval") {
    if ((parseEveryMinutes(t.every) ?? Infinity) < 5) flag("warning", "fast_interval", "It runs more often than every 5 minutes, which is hard on the sites it visits.");
  } else if (t.kind === "schedule") {
    const cron = parseCron(t.cron);
    if (cron.ok && minimumMinuteGap(cron) < 5) flag("warning", "fast_interval", "It runs more often than every 5 minutes, which is hard on the sites it visits.");
  }
  const b = stop?.budgets;
  if (!b || Object.values(b).every((v) => v === undefined)) {
    flag("warning", "no_budgets", "No budgets are set, so a run can use as many model tokens, pages and minutes as it needs.");
  }
  if (infers.some((s) => s.accept_at < 0.5) || (spec.related && spec.related.accept_at < 0.5)) {
    flag("warning", "low_accept_threshold", "A judgment accepts results below 0.5, so it will accept things it thinks are more likely wrong than right.");
  }
  if (t.kind === "event") {
    flag("warning", "event_trigger_unverified", "It waits for a condition that HelmStack cannot check yet; it may never fire.");
  }
  if (spec.scope.max_pages_per_run > 50) {
    flag("info", "many_pages", `It may open up to ${spec.scope.max_pages_per_run} pages per run.`);
  }
  if (infers.some((s) => s.evidence === "none")) {
    flag("info", "no_evidence_check", "A judgment does not have to quote the page as evidence, so it is harder to check.");
  }
  if (infers.length > 0 && infers.every((s) => s.on_uncertain === "skip")) {
    flag("info", "no_human_fallback", "When a judgment is unsure it skips the item; nothing asks you.");
  }
  if (infers.length > 0 || (stop?.any ?? []).some((c) => "when_inferred" in c)) {
    flag("info", "judged_by_model", "Judgments are answered by the model you choose in the Routines tab. It is sent the text of the pages the routine reads and can only reply with an answer: it has no tools and cannot click, type, browse or open anything.");
  }
  if (spec.related) {
    flag("info", "related_widens_scope", "It looks for related pages. Each one it suggests needs your approval before it is added.");
  }
  return [...risks.values()].sort(
    (a, c) => LEVEL_RANK[a.level] - LEVEL_RANK[c.level] || RISK_ORDER.indexOf(a.code as never) - RISK_ORDER.indexOf(c.code as never)
  );
}

// ── Preview ──────────────────────────────────────────────────────────────────

const UNCERTAIN_ACTION: Record<string, string> = {
  note_as_maybe: "is noted as a maybe",
  ask_human: "waits for you to decide",
  skip: "is skipped",
  retry_more_context: "is retried with more context first"
};
const LOW_ACTION: Record<string, string> = {
  ask_human: "it asks you",
  skip: "it skips that step",
  fail: "the run fails"
};

function decisionLines(spec: RoutineSpec): string[] {
  const lines: string[] = [];
  for (const s of allSteps(spec)) {
    if (s.do === "locate") {
      lines.push(`looks for ${clip(s.target, 60)} and needs ${num(s.min_confidence)} confidence or more; below that ${LOW_ACTION[s.on_low]}`);
    } else if (s.do === "infer") {
      const subject = s.output === "score" ? "the score" : "its confidence";
      const samples = s.samples ?? 1;
      const evidence = (s.evidence ?? "quote") === "quote" ? "must quote the page as evidence" : "needs no quote as evidence";
      lines.push(
        `"${clip(s.question, 100)}" accepts when ${subject} is ${num(s.accept_at)} or higher and rejects below ${num(s.reject_below)}; in between it is uncertain and ${UNCERTAIN_ACTION[s.on_uncertain]}. Asked ${plural(samples, "time")}; ${evidence}`
      );
    }
  }
  return lines;
}

function stopLine(spec: RoutineSpec): string {
  const conditions = (spec.stop?.any ?? []).map((c) => {
    if ("after_runs" in c) return `after ${plural(c.after_runs, "run")}`;
    if ("after_days" in c) return `after ${plural(c.after_days, "day")}`;
    if ("when_inferred" in c) return `when it judges "${clip(c.when_inferred, 80)}" (confidence ${num(c.confidence)} or higher)`;
    return `when ${c.when_count.key} holds ${plural(c.when_count.at_least, "entry", "entries")}`;
  });
  const b = spec.stop?.budgets ?? {};
  const budgets: string[] = [];
  if (b.tokens_per_run !== undefined) budgets.push(`${b.tokens_per_run.toLocaleString("en-US")} tokens`);
  if (b.pages_per_run !== undefined) budgets.push(plural(b.pages_per_run, "page"));
  if (b.runtime_minutes_per_run !== undefined) budgets.push(plural(b.runtime_minutes_per_run, "minute"));
  const budgetText =
    budgets.length || b.cost_usd_total !== undefined
      ? `Budgets: ${budgets.length ? `up to ${budgets.join(", ")} per run` : ""}${budgets.length && b.cost_usd_total !== undefined ? "; " : ""}${b.cost_usd_total !== undefined ? `$${num(b.cost_usd_total)} in total` : ""}.`
      : "No budgets are set.";
  const stops = conditions.length
    ? `stops ${naturalList(conditions)}. You can also stop it yourself at any time.`
    : "no stop condition: it keeps running until you stop it.";
  return `${stops[0]!.toUpperCase()}${stops.slice(1)} ${budgetText}`;
}

function approvalsLine(spec: RoutineSpec): string {
  const extra = spec.safety?.approval_for ?? [];
  const base = "HelmStack's usual approvals always apply (sharing personal data, creating accounts, accepting terms, payments)";
  const added = extra.length ? `, plus asking before: ${extra.map((x) => x.replace(/_/g, " ")).join(", ")}` : "";
  const f = spec.on_failure;
  const failure = f
    ? ` If a run fails it retries ${plural(f.retries, "time")} (${f.backoff} backoff) and pauses after ${plural(f.pause_after, "failed run")} in a row${f.notify ? ", then tells you" : ""}.`
    : "";
  return `${base}${added}. It never types passwords or uses saved logins. Pace: ${spec.safety?.rate ?? "1 request / 2s"}.${failure}`;
}

/** One plain sentence about what the routine may change, and who decides. Empty for a read-only routine. */
function actionsLine(spec: RoutineSpec, steps: RoutineStep[], where: string): string {
  const acts = steps.flatMap((s) => (s.do === "act" ? [s] : []));
  if (acts.length === 0) return "";
  const effects = ROUTINE_EFFECTS.filter((e) => acts.some((a) => a.effect === e));
  const list = effects.map((e) => EFFECT_TEXT[e]);
  const sure = effects.filter((e) => !(ROUTINE_AUTO_EFFECTS as readonly string[]).includes(e));
  const asked = ROUTINE_AUTO_EFFECTS.filter((e) => spec.actions?.request?.[e]?.mode === "auto" && effects.includes(e));
  const limits = asked
    .map((e) => {
      const r = spec.actions!.request![e]!;
      const parts = [r.per_run !== undefined ? `${r.per_run} per run` : "", r.per_day !== undefined ? `${r.per_day} per day` : ""].filter(Boolean);
      return `${EFFECT_TEXT[e]}${parts.length ? ` (${parts.join(", ")})` : ""}`;
    })
    .join("; ");
  const protect = spec.actions?.protect ?? [];
  return clip(
    `May change things on ${where}: ${list.join(", ")}. Each change asks you first unless you allow it when approving${sure.length ? `; ${sure.map((e) => EFFECT_TEXT[e]).join(" and ")} always ask you` : ""}. ` +
      `${asked.length ? `It asks to run unasked for: ${limits}. ` : "It does not ask to run anything unasked. "}` +
      `${protect.length ? `Never removes or gives away: ${protect.slice(0, 5).join(", ")}${protect.length > 5 ? ` and ${protect.length - 5} more` : ""}. ` : ""}` +
      "HelmStack's own approvals still apply, every change is checked on the page afterwards, and a failed check pauses the routine.",
    900
  );
}

export type BuildPreviewOptions = {
  /** "What changed" bullets for a proposal that replaces another routine; shown first. */
  changes?: string[];
};

export function buildPreview(spec: RoutineSpec, options: BuildPreviewOptions = {}): RoutinePreview {
  const risks = assessRisks(spec);
  const hosts = scopeHosts(spec.scope);
  const open = isScopeOpen(spec.scope);
  const start = spec.scope.start.length;
  const steps = allSteps(spec);
  const noteCount = steps.filter((s) => s.do === "note").length;
  const hasDiff = steps.some((s) => s.do === "diff");
  const trigger = triggerText(spec.trigger);

  const where = open ? "any site" : hosts.length === 1 ? hosts[0]! : `${hosts[0]} and ${plural(hosts.length - 1, "other site")}`;
  const verb = noteCount ? (hasDiff ? "and note anything new" : "and note what it finds") : "and report what it finds";
  const headline =
    spec.trigger.kind === "manual"
      ? `Check ${where} when you start it ${verb}.`
      : spec.trigger.kind === "event"
        ? `Check ${where} when a watch fires ${verb}.`
        : `Check ${where} ${trigger} ${verb}.`;

  const lines: Array<{ label: string; text: string }> = [];
  const t = spec.trigger;
  lines.push({
    label: "When",
    text:
      t.kind === "manual"
        ? "Only when you start it."
        : t.kind === "event"
          ? `When a watch fires: "${clip(t.watch, 120)}". HelmStack can't check that condition yet.`
          : `${trigger[0]!.toUpperCase()}${trigger.slice(1)}${t.kind === "interval" && t.jitter_pct ? `, each run shifted by up to ${num(t.jitter_pct)}%` : ""}${t.kind === "interval" && t.active_hours ? `, only between ${t.active_hours.replace("-", " and ")}` : ""}.`
  });
  const depth = maxDepthOf(spec.scope);
  const follow = spec.scope.follow ?? {};
  const reach =
    depth === 0
      ? "It stays on the start pages."
      : open
        ? `It can follow links to any site, ${plural(depth, "level")} deep.`
        : follow.allow_hosts && follow.allow_hosts.length
          ? `It follows links only to ${follow.allow_hosts.join(", ")}${follow.same_site ? " and the same site" : ""}, ${plural(depth, "level")} deep.`
          : `It follows links on the same site, ${plural(depth, "level")} deep.`;
  lines.push({
    label: "Where",
    text: `${open ? "Any site" : hosts.join(", ")}; starts from ${plural(start, "page")}, opens up to ${spec.scope.max_pages_per_run} pages per run. ${reach}`
  });
  lines.push({ label: "Does", text: `${clip(steps.length ? spec.steps.map((s) => phrase(s, start)).join(", then ") : "", 700)}.` });
  const actLine = actionsLine(spec, steps, where);
  if (actLine) lines.push({ label: "Actions", text: actLine });
  const tags = [...new Set(steps.flatMap((s) => (s.do === "note" && s.tag ? [s.tag] : [])))];
  const report = spec.output?.report;
  lines.push({
    label: "Notes",
    text: `${
      noteCount
        ? `Adds to a notes log you can read (${plural(noteCount, "note step")}${tags.length ? `; tags: ${tags.join(", ")}` : ""}).`
        : "None of its steps records a note."
    }${report ? ` Writes a report every ${report.every}${report.when ? ` when ${report.when === "always" ? "there is anything" : "there are new notes"}` : ""}.` : ""}`
  });

  const decisions = decisionLines(spec);
  const maxDecisionLines = options.changes?.length ? 2 : 3;
  const shown =
    decisions.length <= maxDecisionLines
      ? decisions
      : [...decisions.slice(0, maxDecisionLines - 1), decisions.slice(maxDecisionLines - 1).join(" | ")];
  shown.forEach((text, i) => lines.push({ label: i === 0 ? "Decides" : `Decides (${i + 1})`, text: `${text[0]!.toUpperCase()}${text.slice(1)}.` }));
  if (shown.length === 0) lines.push({ label: "Decides", text: "It makes no judgments; every step is fixed." });

  lines.push({
    label: "Widening",
    text: spec.related
      ? `Looks for related pages (${clip(spec.related.discover, 90)}), up to ${spec.related.limit_per_run} per run, suggested at ${num(spec.related.accept_at)} or higher. Each one needs your approval before it is added.`
      : open
        ? "It can already follow links anywhere (see the warnings)."
        : "It can't add sites by itself; a wider scope needs a new proposal that you approve."
  });
  lines.push({ label: "Stops", text: stopLine(spec) });
  lines.push({ label: "Safety", text: approvalsLine(spec) });

  const changes = options.changes?.length ? [{ label: "Changed", text: clip(options.changes.join(" "), 600) }] : [];
  // A routine that can change things gets one extra line: its "Actions" line must never be the one that is cut.
  const all = [...changes, ...lines].slice(0, MAX_PREVIEW_LINES + (actLine ? 1 : 0));
  return { headline, lines: all.map((l) => `${l.label}: ${l.text}`), risks };
}

// ── Summary helpers ──────────────────────────────────────────────────────────

/** What changed between two previews of the same routine (labelled bullets and risk flags). */
export function diffPreviews(before: RoutinePreview, after: RoutinePreview): string[] {
  const parse = (lines: string[]): Map<string, string> => {
    const out = new Map<string, string>();
    for (const l of lines) {
      const i = l.indexOf(": ");
      if (i > 0) out.set(l.slice(0, i), l.slice(i + 2));
    }
    return out;
  };
  const old = parse(before.lines);
  const next = parse(after.lines);
  const out: string[] = [];
  for (const [label, text] of next) {
    if (label === "Changed") continue;
    const was = old.get(label);
    if (was === undefined) out.push(`${label} is new: ${clip(text, 120)}`);
    else if (was !== text) out.push(`${label} changed to: ${clip(text, 200)}`);
  }
  for (const label of old.keys()) {
    if (label !== "Changed" && !next.has(label)) out.push(`${label} was removed.`);
  }
  const beforeCodes = new Set(before.risks.map((r) => r.code));
  const afterCodes = new Set(after.risks.map((r) => r.code));
  for (const r of after.risks) if (!beforeCodes.has(r.code)) out.push(`New flag (${r.level}): ${r.message}`);
  for (const r of before.risks) if (!afterCodes.has(r.code)) out.push(`No longer flagged: ${r.code}.`);
  if (out.length === 0) out.push("Nothing visible in the preview changed.");
  return out.slice(0, 8);
}
