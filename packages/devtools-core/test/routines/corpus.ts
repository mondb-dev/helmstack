import type { RoutineSpec } from "../../../shared/src/index.js";
import { actionRoutine, canonical, minimal } from "./fixtures.js";

type Any = any;  

export type ValidCase = { name: string; spec: () => unknown };
export type InvalidCase = {
  name: string;
  /** Builds the bad input from a fresh canonical (or minimal) spec. */
  make: () => unknown;
  /** The first error's path must equal this. */
  path: string;
  /** Substring expected in that error's message. */
  says?: string;
  /** Whether the JSON Schema alone rejects it (the rest needs the validator's cross-checks). */
  schemaCatches: boolean;
};

const c = (): Any => canonical();
const a = (): Any => actionRoutine();
/** Paths in the roster-upkeep example: a select act inside a branch arm, and a click act inside a loop. */
const BENCH = "steps[2].steps[2].accept[0]";
const ADD = "steps[5].steps[1]";
const m = (): Any => minimal();
/** Path of the note step in the canonical example's accept arm. */
const NOTE = "steps[3].steps[2].accept[1]";
const INFER = "steps[3].steps[1]";

function nest(levels: number): Any {
  const leaf = { do: "wait", for: "1s" };
  let step: Any = leaf;
  for (let i = 0; i < levels; i += 1) {
    step = { do: "for_each", items: "state.watchlist", limit: 2, steps: [step] };
  }
  const spec = m();
  spec.state = { watchlist: "set" };
  spec.steps = [step];
  return spec;
}

export const VALID: ValidCase[] = [
  { name: "the canonical example", spec: c },
  { name: "a minimal manual routine", spec: m },
  {
    name: "a weekday schedule with a time zone",
    spec: () => ({ ...m(), trigger: { kind: "schedule", cron: "0 9 * * 1-5", timezone: "Europe/Berlin" } })
  },
  { name: "an event trigger", spec: () => ({ ...m(), trigger: { kind: "event", watch: "the price drops below 100" } }) },
  {
    name: "an explicit allow-list with a wildcard host",
    spec: () => ({ ...m(), scope: { start: ["https://a.example.com/x"], follow: { allow_hosts: ["*.example.com", "docs.other.org"], max_depth: 2 }, max_pages_per_run: 20 } })
  },
  {
    name: "a loop over a declared set that opens each item",
    spec: () => ({
      ...m(),
      scope: { start: ["https://example.com/"], follow: { same_site: true, max_depth: 1 }, max_pages_per_run: 10 },
      state: { watchlist: "set" },
      steps: [{ do: "for_each", items: "state.watchlist", limit: 5, steps: [{ do: "open", url: "$item" }, { do: "open_item" }] }]
    })
  },
  {
    name: "a label judgment with a stop on a count",
    spec: () => ({
      ...m(),
      state: { hits: "log" },
      stop: { any: [{ when_count: { key: "hits", at_least: 10 } }, { when_count: { key: "notes", at_least: 3 } }] },
      steps: [
        { do: "open", url: "$scope.start[0]" },
        { do: "infer", id: "kind", question: "What kind of page is this?", output: "label", labels: ["news", "shop", "other"], accept_at: 0.8, reject_below: 0.2, on_uncertain: "ask_human", model: "cheap" },
        { do: "branch", on: "kind", accept: [{ do: "report", when: "new_notes>0" }], reject: [{ do: "wait", for: "30s" }] }
      ]
    })
  },
  { name: "nesting right at the limit (4 levels)", spec: () => nest(3) },
  { name: "the roster-upkeep example: act steps and an actions block", spec: a },
  {
    name: "every kind of act, with literal and referenced values",
    spec: () => ({
      ...m(),
      scope: { start: ["https://example.com/"], follow: { max_depth: 0 }, max_pages_per_run: 5 },
      state: { slot: "value" },
      steps: [
        { do: "open", url: "$scope.start[0]" },
        { do: "act", action: "click", effect: "other", target: "the Save button", strategies: ["structured_data"], min_confidence: 0.9, on_low: "fail", verify: { present: ["Saved"] } },
        { do: "act", action: "fill", effect: "other", target: "the note field", strategies: ["infer"], min_confidence: 0.7, on_low: "skip", value: "state.slot", verify: { absent: ["Error"] } },
        { do: "act", id: "pick", action: "select", effect: "rearrange", target: "the slot menu", strategies: ["repeating_blocks", "infer"], min_confidence: 0.8, on_low: "ask_human", subject: "state.slot", value: "Bench", verify: { present: ["Bench", "Saved"], absent: ["Error", "Failed"] } }
      ],
      actions: { request: { rearrange: { mode: "ask" }, offer: { mode: "ask", per_run: 1 }, add_item: { mode: "auto", per_day: 50, per_run: 50 } }, protect: ["Star", "Another Name"] }
    })
  },
  { name: "an act at the nesting limit", spec: () => { const s = nest(3); s.scope.follow = { max_depth: 0 }; let step = s.steps[0]; while (step.steps) step = step.steps[0]; return s; } },
  {
    name: "every step kind once",
    spec: () => ({
      ...m(),
      scope: { start: ["https://example.com/"], follow: { same_site: true }, max_pages_per_run: 10 },
      state: { seen: "set", v: "value" },
      steps: [
        { do: "open", id: "p", url: "https://example.com/list" },
        { do: "locate", id: "l", target: "items", strategies: ["infer"], min_confidence: 0.5, on_low: "skip" },
        { do: "extract", id: "e", fields: { name: "text", n: "number?", ok: "bool", when: "date", link: "url" }, strategies: ["structured_data"], from: "$l" },
        { do: "diff", id: "d", items: "$l", against: "state.seen", key: ["link"] },
        {
          do: "for_each", items: "$d", limit: 3,
          steps: [
            { do: "open_item" },
            { do: "infer", id: "q", question: "Relevant?", output: "bool", accept_at: 0.9, reject_below: 0.1, on_uncertain: "retry_more_context", evidence: "none", samples: 5, uses: "state.v" },
            { do: "branch", on: "q", accept: [{ do: "note", fields: ["$item", "$q", "state.v"] }, { do: "mark_seen" }] }
          ]
        },
        { do: "wait", for: "1h" },
        { do: "report", when: "always" }
      ],
      output: { notes: "append", report: { every: "1d" } },
      safety: { approval_for: ["download", "upload", "delete", "send_message", "account_creation", "accept_terms"], rate: "2 requests / 1s" }
    })
  }
];

const longString = (n: number): string => "x".repeat(n);
const actAt = (path: "bench" | "add", over: (act: Any) => void) => () => {
  const s = a();
  over(path === "bench" ? s.steps[2].steps[2].accept[0] : s.steps[5].steps[1]);
  return s;
};

export const INVALID: InvalidCase[] = [
  // ── unknown keys, wherever they are ──
  { name: "unknown top-level key", make: () => ({ ...c(), extra: 1 }), path: "extra", says: "unknown field", schemaCatches: true },
  { name: "unknown key in a top-level step", make: () => { const s = c(); s.steps[1].foo = 1; return s; }, path: "steps[1].foo", schemaCatches: true },
  { name: "unknown key deep in a branch arm", make: () => { const s = c(); s.steps[3].steps[2].accept[1].colour = "red"; return s; }, path: `${NOTE}.colour`, schemaCatches: true },
  { name: "unknown key in scope.follow", make: () => { const s = c(); s.scope.follow.depth = 1; return s; }, path: "scope.follow.depth", schemaCatches: true },
  { name: "unknown key in the trigger", make: () => { const s = c(); s.trigger.at = "noon"; return s; }, path: "trigger.at", schemaCatches: true },
  // ── guardrail-shaped keys ──
  { name: "a field that disables approvals", make: () => { const s = c(); s.safety.disable_approvals = true; return s; }, path: "safety.disable_approvals", says: "cannot change approvals", schemaCatches: true },
  { name: "a stealth switch", make: () => { const s = c(); s.safety.stealth = true; return s; }, path: "safety.stealth", says: "stealth", schemaCatches: true },
  { name: "credentials at the top level", make: () => ({ ...c(), credentials: { user: "a", password: "b" } }), path: "credentials", says: "credentials", schemaCatches: true },
  { name: "a login block on a step", make: () => { const s = m(); s.steps[0].login = { user: "me" }; return s; }, path: "steps[0].login", says: "not a routine field", schemaCatches: true },
  { name: "an unknown approval kind", make: () => { const s = c(); s.safety.approval_for = ["nothing"]; return s; }, path: "safety.approval_for[0]", schemaCatches: true },
  { name: "an attempt to script a step", make: () => { const s = m(); s.steps.push({ do: "eval", code: "alert(1)" }); return s; }, path: "steps[1].do", schemaCatches: true },
  // ── references ──
  { name: "a property path in a reference", make: () => { const s = c(); s.steps[3].steps[2].accept[1].fields[0] = "$entry.title"; return s; }, path: `${NOTE}.fields[0]`, says: "not a reference", schemaCatches: true },
  { name: "eval-looking text in diff.against", make: () => { const s = c(); s.steps[2].against = "state.seen; process.exit(1)"; return s; }, path: "steps[2].against", says: "expressions", schemaCatches: true },
  { name: "template interpolation in for_each.items", make: () => { const s = c(); s.steps[3].items = "${fresh}"; return s; }, path: "steps[3].items", says: "not a reference", schemaCatches: true },
  { name: "an expression in open.url", make: () => { const s = m(); s.steps[0].url = "$scope.start[0] + '/x'"; return s; }, path: "steps[0].url", says: "not a reference", schemaCatches: false },
  { name: "branch.on names no step", make: () => { const s = c(); s.steps[3].steps[2].on = "nope"; return s; }, path: "steps[3].steps[2].on", says: "no step with id", schemaCatches: false },
  { name: "branch.on names a step that is not an infer", make: () => { const s = c(); s.steps[3].steps[2].on = "entry"; return s; }, path: "steps[3].steps[2].on", says: "must name an infer step", schemaCatches: false },
  { name: "branch.on written with a dollar sign", make: () => { const s = c(); s.steps[3].steps[2].on = "$relevance"; return s; }, path: "steps[3].steps[2].on", says: "bare id", schemaCatches: true },
  { name: "a state key that was never declared", make: () => { const s = c(); s.steps[2].against = "state.unknown"; return s; }, path: "steps[2].against", says: "not declared", schemaCatches: false },
  { name: "a reference to a step that does not exist", make: () => { const s = c(); s.steps[3].items = "$ghost"; return s; }, path: "steps[3].items", says: "no step with id", schemaCatches: false },
  { name: "a forward reference", make: () => { const s = c(); [s.steps[1], s.steps[2]] = [s.steps[2], s.steps[1]]; return s; }, path: "steps[1].items", says: "no step with id", schemaCatches: false },
  { name: "$item outside a for_each", make: () => { const s = m(); s.steps[0].url = "$item"; return s; }, path: "steps[0].url", says: "only valid inside a for_each", schemaCatches: false },
  { name: "$scope.start index past the end", make: () => { const s = m(); s.steps[0].url = "$scope.start[3]"; return s; }, path: "steps[0].url", says: "does not exist", schemaCatches: false },
  { name: "a step id used twice", make: () => { const s = c(); s.steps[1].id = "start_page"; return s; }, path: "steps[1].id", says: "used twice", schemaCatches: false },
  { name: "a reserved step id", make: () => { const s = m(); s.steps[0].id = "item"; return s; }, path: "steps[0].id", says: "reserved", schemaCatches: false },
  { name: "a reference from an arm to a step in a sibling arm", make: () => { const s = c(); s.steps[3].steps[2].maybe[0].fields = ["$whats_new"]; return s; }, path: "steps[3].steps[2].maybe[0].fields[0]", says: "not available here", schemaCatches: false },
  { name: "open_item outside a loop", make: () => { const s = m(); s.steps.push({ do: "open_item" }); return s; }, path: "steps[1]", says: "only valid inside a for_each", schemaCatches: false },
  { name: "mark_seen with nothing to mark", make: () => { const s = m(); s.steps.push({ do: "mark_seen" }); return s; }, path: "steps[1]", says: "needs \"into\"", schemaCatches: false },
  { name: "links followed while max_depth is 0", make: () => { const s = c(); s.scope.follow.max_depth = 0; s.steps[3].steps.push({ do: "open_item" }); return s; }, path: "steps[3].steps[3]", says: "max_depth is 0", schemaCatches: false },
  { name: "a literal URL outside the scope", make: () => { const s = c(); s.scope.follow = { allow_hosts: ["news.example.com"], max_depth: 1 }; s.steps[0].url = "https://evil.example.net/"; return s; }, path: "steps[0].url", says: "outside the scope", schemaCatches: false },
  // ── thresholds and numbers ──
  { name: "reject_below above accept_at", make: () => { const s = c(); s.steps[3].steps[1].reject_below = 0.9; return s; }, path: `${INFER}.reject_below`, says: "accept_at", schemaCatches: false },
  { name: "accept_at above 1", make: () => { const s = c(); s.steps[3].steps[1].accept_at = 1.5; return s; }, path: `${INFER}.accept_at`, schemaCatches: true },
  { name: "negative reject_below", make: () => { const s = c(); s.steps[3].steps[1].reject_below = -0.1; return s; }, path: `${INFER}.reject_below`, schemaCatches: true },
  { name: "more than 5 samples", make: () => { const s = c(); s.steps[3].steps[1].samples = 6; return s; }, path: `${INFER}.samples`, schemaCatches: true },
  { name: "a for_each limit over 100", make: () => { const s = c(); s.steps[3].limit = 101; return s; }, path: "steps[3].limit", schemaCatches: true },
  { name: "max_pages_per_run over 200", make: () => { const s = c(); s.scope.max_pages_per_run = 201; return s; }, path: "scope.max_pages_per_run", schemaCatches: true },
  { name: "a label judgment without labels", make: () => { const s = c(); s.steps[3].steps[1].output = "label"; return s; }, path: `${INFER}.labels`, schemaCatches: true },
  { name: "labels on a score judgment", make: () => { const s = c(); s.steps[3].steps[1].labels = ["a", "b"]; return s; }, path: `${INFER}.labels`, schemaCatches: true },
  { name: "an extract field with an unknown type", make: () => { const s = c(); s.steps[3].steps[0].fields.title = "string"; return s; }, path: "steps[3].steps[0].fields.title", schemaCatches: true },
  { name: "empty locate strategies", make: () => { const s = c(); s.steps[1].strategies = []; return s; }, path: "steps[1].strategies", schemaCatches: true },
  { name: "a repeated locate strategy", make: () => { const s = c(); s.steps[1].strategies = ["infer", "infer"]; return s; }, path: "steps[1].strategies[1]", schemaCatches: true },
  { name: "a branch with no arms", make: () => { const s = c(); s.steps[3].steps[2] = { do: "branch", on: "relevance" }; return s; }, path: "steps[3].steps[2]", schemaCatches: true },
  { name: "a branch whose arms are all empty", make: () => { const s = c(); s.steps[3].steps[2] = { do: "branch", on: "relevance", accept: [] }; return s; }, path: "steps[3].steps[2]", says: "no steps", schemaCatches: false },
  { name: "an empty step list", make: () => { const s = c(); s.steps = []; return s; }, path: "steps", schemaCatches: true },
  { name: "wait longer than an hour", make: () => { const s = m(); s.steps.push({ do: "wait", for: "2h" }); return s; }, path: "steps[1].for", says: "at most 1h", schemaCatches: false },
  // ── size and depth ──
  { name: "more than 60 steps in one list", make: () => { const s = m(); s.steps = Array.from({ length: 61 }, () => ({ do: "wait", for: "1s" })); return s; }, path: "steps[60]", says: "more than 60", schemaCatches: true },
  {
    name: "more than 60 steps once nested ones are counted",
    make: () => {
      const s = m();
      s.state = { watchlist: "set" };
      s.steps = Array.from({ length: 5 }, () => ({ do: "for_each", items: "state.watchlist", limit: 2, steps: Array.from({ length: 12 }, () => ({ do: "wait", for: "1s" })) }));
      return s;
    },
    path: "steps[4].steps[7]",
    says: "more than 60",
    schemaCatches: false
  },
  { name: "nested five levels deep", make: () => nest(4), path: "steps[0].steps[0].steps[0].steps[0]", says: "cannot be nested this deeply", schemaCatches: true },
  { name: "a spec over 64 KB", make: () => { const s = m(); s.steps = Array.from({ length: 40 }, () => ({ do: "wait", for: "1s" })); s.intent = longString(2000); s.state = {}; s.stop = { any: [{ when_inferred: longString(2000), confidence: 0.5 }, { when_inferred: longString(2000), confidence: 0.5 }, { when_inferred: longString(2000), confidence: 0.5 }, { when_inferred: longString(2000), confidence: 0.5 }, { when_inferred: longString(2000), confidence: 0.5 }, { when_inferred: longString(2000), confidence: 0.5 }, { when_inferred: longString(2000), confidence: 0.5 }, { when_inferred: longString(2000), confidence: 0.5 }] }; s.pad = Array.from({ length: 40 }, () => longString(2000)); return s; }, path: "(root)", says: "bytes", schemaCatches: true },
  { name: "an intent over 2,000 characters", make: () => ({ ...c(), intent: longString(2001) }), path: "intent", schemaCatches: true },
  { name: "a title over 120 characters", make: () => ({ ...c(), title: longString(121) }), path: "title", schemaCatches: true },
  { name: "a control character in a string", make: () => ({ ...c(), title: "bad\u0007title" }), path: "title", says: "control characters", schemaCatches: false },
  { name: "more than 12 state keys", make: () => { const s = c(); s.state = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, "set"])); return s; }, path: "state", schemaCatches: true },
  { name: "a state key with an unknown type", make: () => { const s = c(); s.state.seen = "table"; return s; }, path: "state.seen", schemaCatches: true },
  { name: "notes declared as something other than a log", make: () => { const s = c(); s.state.notes = "set"; return s; }, path: "state.notes", says: "reserved", schemaCatches: false },
  // ── trigger ──
  { name: "an interval faster than a minute", make: () => { const s = c(); s.trigger = { kind: "interval", every: "30s" }; return s; }, path: "trigger.every", schemaCatches: true },
  { name: "a zero interval", make: () => { const s = c(); s.trigger = { kind: "interval", every: "0m" }; return s; }, path: "trigger.every", schemaCatches: true },
  { name: "an interval over 90 days", make: () => { const s = c(); s.trigger = { kind: "interval", every: "91d" }; return s; }, path: "trigger.every", says: "at most 90d", schemaCatches: false },
  { name: "jitter over 50 percent", make: () => { const s = c(); s.trigger.jitter_pct = 80; return s; }, path: "trigger.jitter_pct", schemaCatches: true },
  { name: "active hours that are not a time", make: () => { const s = c(); s.trigger.active_hours = "8am-10pm"; return s; }, path: "trigger.active_hours", schemaCatches: true },
  { name: "a cron expression with four fields", make: () => { const s = c(); s.trigger = { kind: "schedule", cron: "0 9 * *" }; return s; }, path: "trigger.cron", schemaCatches: true },
  { name: "a cron expression out of range", make: () => { const s = c(); s.trigger = { kind: "schedule", cron: "61 25 * * *" }; return s; }, path: "trigger.cron", says: "out of range", schemaCatches: false },
  { name: "a cron expression with a command in it", make: () => { const s = c(); s.trigger = { kind: "schedule", cron: "0 9 * * * ; rm -rf /" }; return s; }, path: "trigger.cron", schemaCatches: true },
  { name: "an unknown time zone", make: () => { const s = c(); s.trigger = { kind: "schedule", cron: "0 9 * * *", timezone: "Mars/Base" }; return s; }, path: "trigger.timezone", says: "not a known time zone", schemaCatches: false },
  { name: "an unknown trigger kind", make: () => { const s = c(); s.trigger = { kind: "webhook" }; return s; }, path: "trigger.kind", schemaCatches: true },
  // ── scope ──
  { name: "a file: start URL", make: () => { const s = c(); s.scope.start = ["file:///etc/passwd"]; return s; }, path: "scope.start[0]", schemaCatches: true },
  { name: "a javascript: start URL", make: () => { const s = c(); s.scope.start = ["javascript:alert(1)"]; return s; }, path: "scope.start[0]", schemaCatches: true },
  { name: "an ftp: start URL", make: () => { const s = c(); s.scope.start = ["ftp://example.com/x"]; return s; }, path: "scope.start[0]", schemaCatches: true },
  { name: "a start URL with a password in it", make: () => { const s = c(); s.scope.start = ["https://me:secret@example.com/"]; return s; }, path: "scope.start[0]", says: "username or password", schemaCatches: false },
  { name: "no start URLs", make: () => { const s = c(); s.scope.start = []; return s; }, path: "scope.start", schemaCatches: true },
  { name: "more than 10 start URLs", make: () => { const s = c(); s.scope.start = Array.from({ length: 11 }, (_, i) => `https://example.com/${i}`); return s; }, path: "scope.start", schemaCatches: true },
  { name: "a start URL over 2,048 characters", make: () => { const s = c(); s.scope.start = [`https://example.com/${longString(2100)}`]; return s; }, path: "scope.start[0]", schemaCatches: true },
  { name: "an allowed host written as a URL", make: () => { const s = c(); s.scope.follow = { allow_hosts: ["https://example.com"] }; return s; }, path: "scope.follow.allow_hosts[0]", schemaCatches: true },
  { name: "a wildcard that covers a whole TLD", make: () => { const s = c(); s.scope.follow = { allow_hosts: ["*.com"] }; return s; }, path: "scope.follow.allow_hosts[0]", says: "too broad", schemaCatches: false },
  { name: "max_depth above 3", make: () => { const s = c(); s.scope.follow.max_depth = 4; return s; }, path: "scope.follow.max_depth", schemaCatches: true },
  // ── related, stop, safety ──
  { name: "related.needs that skips the human", make: () => { const s = c(); s.related.needs = "auto"; return s; }, path: "related.needs", says: "human", schemaCatches: true },
  { name: "related.needs missing", make: () => { const s = c(); delete s.related.needs; return s; }, path: "related.needs", schemaCatches: true },
  { name: "related.limit_per_run over 10", make: () => { const s = c(); s.related.limit_per_run = 11; return s; }, path: "related.limit_per_run", schemaCatches: true },
  { name: "a stop condition with two kinds in one", make: () => { const s = c(); s.stop.any = [{ after_runs: 1, after_days: 2 }]; return s; }, path: "stop.any[0].after_days", schemaCatches: true },
  { name: "when_count on a key that is not declared", make: () => { const s = c(); s.stop.any = [{ when_count: { key: "nope", at_least: 2 } }]; return s; }, path: "stop.any[0].when_count.key", says: "not declared", schemaCatches: false },
  { name: "when_count on a value", make: () => { const s = c(); s.state.v = "value"; s.stop.any = [{ when_count: { key: "v", at_least: 2 } }]; return s; }, path: "stop.any[0].when_count.key", says: "only a set or log", schemaCatches: false },
  { name: "when_inferred without a confidence", make: () => { const s = c(); s.stop.any = [{ when_inferred: "done" }]; return s; }, path: "stop.any[0].confidence", schemaCatches: true },
  { name: "a negative budget", make: () => { const s = c(); s.stop.budgets.tokens_per_run = -5; return s; }, path: "stop.budgets.tokens_per_run", schemaCatches: true },
  { name: "a request rate over 5 per second", make: () => { const s = c(); s.safety.rate = "100 requests / 1s"; return s; }, path: "safety.rate", says: "more than 5", schemaCatches: false },
  { name: "a request rate in the wrong format", make: () => { const s = c(); s.safety.rate = "fast"; return s; }, path: "safety.rate", schemaCatches: true },
  { name: "on_failure with too many retries", make: () => { const s = c(); s.on_failure.retries = 9; return s; }, path: "on_failure.retries", schemaCatches: true },
  { name: "output.notes other than append", make: () => { const s = c(); s.output.notes = "overwrite"; return s; }, path: "output.notes", schemaCatches: true },
  // ── act steps and the actions block ──
  { name: "an act without a verify check", make: actAt("bench", (x) => delete x.verify), path: `${BENCH}.verify`, says: "is required", schemaCatches: true },
  { name: "an empty verify object", make: actAt("bench", (x) => { x.verify = {}; }), path: `${BENCH}.verify`, says: "at least one", schemaCatches: true },
  { name: "an empty verify.present list", make: actAt("bench", (x) => { x.verify = { present: [] }; }), path: `${BENCH}.verify.present`, schemaCatches: true },
  { name: "more than 5 verify entries", make: actAt("bench", (x) => { x.verify = { present: ["a", "b", "c", "d", "e", "f"] }; }), path: `${BENCH}.verify.present`, schemaCatches: true },
  { name: "a verify entry over 200 characters", make: actAt("bench", (x) => { x.verify = { absent: [longString(201)] }; }), path: `${BENCH}.verify.absent[0]`, schemaCatches: true },
  { name: "an unknown key in verify", make: actAt("bench", (x) => { x.verify = { present: ["ok"], eventually: ["x"] }; }), path: `${BENCH}.verify.eventually`, schemaCatches: true },
  { name: "a verify reference to an undefined step", make: actAt("bench", (x) => { x.verify = { present: ["$ghost"] }; }), path: `${BENCH}.verify.present[0]`, says: "no step with id", schemaCatches: false },
  { name: "a value on a click", make: actAt("add", (x) => { x.value = "x"; }), path: `${ADD}.value`, says: "only for fill and select", schemaCatches: true },
  { name: "a fill without a value", make: actAt("bench", (x) => { x.action = "fill"; delete x.value; }), path: `${BENCH}.value`, says: "is required for fill", schemaCatches: true },
  { name: "a value that is a bad reference", make: actAt("bench", (x) => { x.value = "$player.name"; }), path: `${BENCH}.value`, says: "not a reference", schemaCatches: false },
  { name: "a value over 200 characters", make: actAt("bench", (x) => { x.value = longString(201); }), path: `${BENCH}.value`, schemaCatches: true },
  { name: "an unknown effect", make: actAt("add", (x) => { x.effect = "purchase"; }), path: `${ADD}.effect`, schemaCatches: true },
  { name: "an unknown action", make: actAt("add", (x) => { x.action = "submit"; }), path: `${ADD}.action`, schemaCatches: true },
  { name: "an act with a selector", make: actAt("add", (x) => { x.selector = "#add"; }), path: `${ADD}.selector`, says: "unknown field", schemaCatches: true },
  { name: "an act with a script", make: actAt("add", (x) => { x.script = "document.forms[0].submit()"; }), path: `${ADD}.script`, says: "not a routine field", schemaCatches: true },
  { name: "an act with no strategies", make: actAt("add", (x) => { x.strategies = []; }), path: `${ADD}.strategies`, schemaCatches: true },
  { name: "an act whose min_confidence is above 1", make: actAt("add", (x) => { x.min_confidence = 2; }), path: `${ADD}.min_confidence`, schemaCatches: true },
  { name: "an act target over 300 characters", make: actAt("add", (x) => { x.target = longString(301); }), path: `${ADD}.target`, schemaCatches: true },
  { name: "an act subject that is literal text", make: actAt("add", (x) => { x.subject = "Jalen"; }), path: `${ADD}.subject`, says: "not a reference", schemaCatches: true },
  { name: "an act subject pointing at a locate step", make: actAt("add", (x) => { x.subject = "$free_agents"; }), path: `${ADD}.subject`, says: "needs", schemaCatches: false },
  { name: "a note that refers to an act step", make: () => { const s = a(); s.steps[5].steps[1].id = "add_it"; s.steps[5].steps.push({ do: "note", fields: ["$add_it"] }); return s; }, path: "steps[5].steps[2].fields[0]", says: "is an act step", schemaCatches: false },
  { name: "an infer that uses an act step", make: () => { const s = a(); s.steps[2].steps[1].uses = "$bench_player"; return s; }, path: "steps[2].steps[1].uses", says: "bench_player", schemaCatches: false },
  { name: "an act id used twice", make: actAt("add", (x) => { x.id = "bench_player"; }), path: `${ADD}.id`, says: "used twice", schemaCatches: false },
  { name: "nested five levels deep with an act at the bottom", make: () => { const s = nest(4); let step = s.steps[0]; for (let i = 0; i < 4; i += 1) step = step.steps[0]; return s; }, path: "steps[0].steps[0].steps[0].steps[0]", says: "cannot be nested this deeply", schemaCatches: true },
  { name: "a request for auto offers", make: () => { const s = a(); s.actions.request.offer = { mode: "auto" }; return s; }, path: "actions.request.offer.mode", says: "always waits for you", schemaCatches: true },
  { name: "a request for auto responses", make: () => { const s = a(); s.actions.request.respond = { mode: "auto", per_day: 1 }; return s; }, path: "actions.request.respond.mode", says: "always waits for you", schemaCatches: true },
  { name: "a request for auto 'other'", make: () => { const s = a(); s.actions.request.other = { mode: "auto" }; return s; }, path: "actions.request.other.mode", schemaCatches: true },
  { name: "a request for an unknown effect", make: () => { const s = a(); s.actions.request.purchase = { mode: "ask" }; return s; }, path: "actions.request.purchase", says: "unknown field", schemaCatches: true },
  { name: "per_run above 50", make: () => { const s = a(); s.actions.request.add_item.per_run = 51; return s; }, path: "actions.request.add_item.per_run", schemaCatches: true },
  { name: "per_day of zero", make: () => { const s = a(); s.actions.request.add_item.per_day = 0; return s; }, path: "actions.request.add_item.per_day", schemaCatches: true },
  { name: "a fractional per_day", make: () => { const s = a(); s.actions.request.add_item.per_day = 1.5; return s; }, path: "actions.request.add_item.per_day", schemaCatches: true },
  { name: "a request without a mode", make: () => { const s = a(); delete s.actions.request.add_item.mode; return s; }, path: "actions.request.add_item.mode", schemaCatches: true },
  { name: "more than 50 protected names", make: () => { const s = a(); s.actions.protect = Array.from({ length: 51 }, (_, i) => `Name ${i}`); return s; }, path: "actions.protect", schemaCatches: true },
  { name: "a protected name over 80 characters", make: () => { const s = a(); s.actions.protect = [longString(81)]; return s; }, path: "actions.protect[0]", schemaCatches: true },
  { name: "a protected name listed twice", make: () => { const s = a(); s.actions.protect = ["Star Player", "star player"]; return s; }, path: "actions.protect[1]", says: "listed twice", schemaCatches: false },
  { name: "an empty protected name", make: () => { const s = a(); s.actions.protect = ["  "]; return s; }, path: "actions.protect[0]", says: "non-empty", schemaCatches: false },
  { name: "an unknown key in actions", make: () => { const s = a(); s.actions.auto_everything = true; return s; }, path: "actions.auto_everything", says: "unknown field", schemaCatches: true },
  // ── whole-document shape ──
  { name: "version 2", make: () => ({ ...c(), version: 2 }), path: "version", schemaCatches: true },
  { name: "a missing title", make: () => { const s = c(); delete s.title; return s; }, path: "title", schemaCatches: true },
  { name: "a missing trigger", make: () => { const s = c(); delete s.trigger; return s; }, path: "trigger", schemaCatches: true },
  { name: "null instead of a spec", make: () => null, path: "(root)", schemaCatches: true },
  { name: "an array instead of a spec", make: () => [], path: "(root)", schemaCatches: true }
];

export type { RoutineSpec };
