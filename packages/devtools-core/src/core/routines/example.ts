/**
 * The canonical routine: "please watch for the updates of this page on this topic and
 * related ones, every new update should be checked and noted."
 *
 * Kept as a typed template with `<page url>` and `<topic>` placeholders so tests and docs
 * fill it in; `routineExample()` is the filled version served to models.
 */
import type { RoutineSpec } from "../../../../shared/src/index.js";

export const CANONICAL_ROUTINE_TEMPLATE: RoutineSpec = {
  version: 1,
  title: "Updates on <topic>",
  intent:
    "Please watch <page url> for updates on <topic> and related ones. Every new update should be checked and noted.",
  scope: {
    start: ["<page url>"],
    follow: { same_site: true, max_depth: 1 },
    max_pages_per_run: 30
  },
  trigger: { kind: "interval", every: "6h", jitter_pct: 10, active_hours: "07:00-23:00" },
  state: { seen: "set", notes: "log", watchlist: "set" },
  steps: [
    { do: "open", id: "start_page", url: "$scope.start[0]" },
    {
      do: "locate",
      id: "updates",
      target: "the list of dated updates, newest first",
      strategies: ["structured_data", "repeating_blocks", "infer"],
      min_confidence: 0.6,
      on_low: "ask_human"
    },
    { do: "diff", id: "fresh", items: "$updates", against: "state.seen", key: ["url"] },
    {
      do: "for_each",
      items: "$fresh",
      limit: 25,
      steps: [
        {
          do: "extract",
          id: "entry",
          fields: { title: "text<=200", date: "date?", summary: "text<=500", url: "url" },
          strategies: ["structured_data", "repeating_blocks", "infer"],
          from: "$item"
        },
        {
          do: "infer",
          id: "relevance",
          question: "Is this update about <topic> or a closely related subject?",
          output: "score",
          accept_at: 0.7,
          reject_below: 0.3,
          on_uncertain: "note_as_maybe",
          evidence: "quote",
          samples: 3,
          uses: "$entry"
        },
        {
          do: "branch",
          on: "relevance",
          accept: [
            {
              do: "infer",
              id: "whats_new",
              question: "What is new here, and does it extend or contradict our earlier notes?",
              output: "text<=400",
              accept_at: 0.6,
              reject_below: 0.2,
              on_uncertain: "note_as_maybe",
              evidence: "quote",
              samples: 1,
              uses: "state.notes"
            },
            { do: "note", tag: "update", fields: ["$entry", "$relevance", "$whats_new"] },
            { do: "mark_seen" }
          ],
          maybe: [{ do: "note", tag: "maybe", fields: ["$entry", "$relevance"] }, { do: "mark_seen" }],
          reject: [{ do: "mark_seen" }]
        }
      ]
    }
  ],
  related: {
    discover: "pages that cover <topic> or the same subject, on this site or on sites it links to",
    accept_at: 0.8,
    limit_per_run: 3,
    needs: "human_approval"
  },
  stop: {
    any: [
      { after_days: 30 },
      { after_runs: 120 },
      { when_inferred: "The topic is resolved or no longer being updated", confidence: 0.9 }
    ],
    budgets: { tokens_per_run: 200_000, pages_per_run: 30, cost_usd_total: 5, runtime_minutes_per_run: 20 }
  },
  on_failure: { retries: 2, backoff: "exponential", pause_after: 3, notify: true },
  output: { notes: "append", report: { every: "7d", when: "new_notes>0" } },
  safety: { approval_for: ["submit", "personal_data", "purchase", "post"], rate: "1 request / 2s" }
};

/** A deep copy of the template with the placeholders replaced. */
export function fillRoutineTemplate(template: RoutineSpec, vars: { topic: string; pageUrl: string }): RoutineSpec {
  const fill = (value: unknown): unknown => {
    if (typeof value === "string") return value.split("<topic>").join(vars.topic).split("<page url>").join(vars.pageUrl);
    if (Array.isArray(value)) return value.map(fill);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
    }
    return value;
  };
  return fill(template) as RoutineSpec;
}

/** The example served to models (`GET /api/routines/schema`, `browser_routine_schema`). */
export function routineExample(): RoutineSpec {
  return fillRoutineTemplate(CANONICAL_ROUTINE_TEMPLATE, {
    topic: "accessibility law changes",
    pageUrl: "https://example.com/news"
  });
}
