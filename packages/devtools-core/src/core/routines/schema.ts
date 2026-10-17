/**
 * The routine spec as a JSON Schema (draft 2020-12), written by hand for models to read.
 *
 * The schema is *necessary, not sufficient*: it states the shape, enums, patterns and
 * numeric ranges, and unrolls step nesting to the 4-level limit. What a schema cannot say
 * (every reference resolves to an earlier step in scope, ids are unique, thresholds are
 * ordered, at most 60 steps, cron ranges, time zones, URL credentials, the 64 KB size) is
 * checked by `validateRoutineSpec`. `routines.schema.test.ts` keeps the two in agreement
 * and records, per invalid case, whether the schema alone catches it.
 */
import {
  ROUTINE_ACT_ACTIONS,
  ROUTINE_APPROVAL_KINDS,
  ROUTINE_AUTO_EFFECTS,
  ROUTINE_EFFECTS,
  ROUTINE_INFER_MODELS,
  ROUTINE_LIMITS,
  ROUTINE_ON_LOW,
  ROUTINE_ON_UNCERTAIN,
  ROUTINE_STATE_TYPES,
  ROUTINE_STRATEGIES
} from "../../../../shared/src/index.js";
import {
  ACTIVE_HOURS_PATTERN,
  CRON_PATTERN,
  EVERY_PATTERN,
  FIELD_TYPE_PATTERN,
  HOST_PATTERN,
  HTTP_URL_PATTERN,
  INFER_OUTPUT_PATTERN,
  LABEL_PATTERN,
  NAME_PATTERN,
  RATE_PATTERN,
  REF_PATTERN,
  TIMEZONE_PATTERN,
  WAIT_PATTERN,
  WHEN_PATTERN
} from "./patterns.js";

type Json = Record<string, unknown>;

const text = (description: string, max: number = ROUTINE_LIMITS.stringChars): Json => ({
  type: "string",
  minLength: 1,
  maxLength: max,
  description
});
const unit = (description: string): Json => ({ type: "number", minimum: 0, maximum: 1, description });
const int = (min: number, max: number, description: string): Json => ({ type: "integer", minimum: min, maximum: max, description });
const pattern = (p: string, description: string, max = 200): Json => ({ type: "string", pattern: p, maxLength: max, description });
const strategies = (): Json => ({
  type: "array",
  minItems: 1,
  maxItems: ROUTINE_STRATEGIES.length,
  uniqueItems: true,
  items: { enum: [...ROUTINE_STRATEGIES] },
  description: "Ways to find it, in order of preference."
});
const ref = (description: string): Json => ({ type: "string", pattern: REF_PATTERN, description });

const MAX_LEVEL = ROUTINE_LIMITS.maxNesting;

/** A step object: `do` plus its own keys. */
function stepVariant(kind: string, properties: Json, required: string[], extra: Json = {}): Json {
  return {
    type: "object",
    additionalProperties: false,
    required: ["do", ...required],
    properties: {
      do: { const: kind },
      id: pattern(NAME_PATTERN, "Optional unique id, needed only when another step refers to this one."),
      ...properties
    },
    ...extra
  };
}

function stepLevel(level: number): Json {
  const next = `#/$defs/step_${level + 1}`;
  const variants: Json[] = [
    stepVariant("open", { url: { type: "string", maxLength: ROUTINE_LIMITS.urlChars, description: "$scope.start[i], $item, or an http(s) URL inside the scope." } }, ["url"]),
    stepVariant(
      "locate",
      {
        target: text("What to find on the page, in plain language."),
        strategies: strategies(),
        min_confidence: unit("Below this confidence the locator counts as not found."),
        on_low: { enum: [...ROUTINE_ON_LOW], description: "What to do when it is not found confidently." }
      },
      ["target", "strategies", "min_confidence", "on_low"]
    ),
    stepVariant(
      "extract",
      {
        fields: {
          type: "object",
          minProperties: 1,
          maxProperties: ROUTINE_LIMITS.extractFields,
          propertyNames: { pattern: NAME_PATTERN },
          additionalProperties: pattern(FIELD_TYPE_PATTERN, 'Field type: text, text<=N, date, url, number or bool; add "?" when optional.'),
          description: "Field name -> type."
        },
        strategies: strategies(),
        from: ref("Optional: $item or a locate step. Defaults to the current item, or the page outside a loop.")
      },
      ["fields", "strategies"]
    ),
    stepVariant(
      "diff",
      {
        items: ref("A locate step whose items are compared."),
        against: ref("A declared set, state.<key>."),
        key: { type: "array", minItems: 1, maxItems: 5, items: { type: "string", pattern: NAME_PATTERN }, description: "Extracted field names that identify an item." }
      },
      ["items", "against", "key"]
    ),
    stepVariant(
      "infer",
      {
        question: text("The judgment to make, as a question about the current item."),
        output: pattern(INFER_OUTPUT_PATTERN, 'One of "score", "label", "bool" or "text<=N".'),
        labels: { type: "array", minItems: 2, maxItems: ROUTINE_LIMITS.labels, uniqueItems: true, items: { type: "string", pattern: LABEL_PATTERN }, description: 'Only with output "label".' },
        accept_at: unit("Accept at or above this."),
        reject_below: unit("Reject below this; between reject_below and accept_at is uncertain."),
        on_uncertain: { enum: [...ROUTINE_ON_UNCERTAIN], description: "What to do with an uncertain result." },
        evidence: { enum: ["quote", "none"], description: 'Default "quote": the answer must quote the page.' },
        samples: int(1, ROUTINE_LIMITS.samples, "Ask this many times and combine (default 1)."),
        uses: ref("Extra context: state.<key>, $item or an earlier step."),
        model: { enum: [...ROUTINE_INFER_MODELS], description: 'Default "default".' }
      },
      ["question", "output", "accept_at", "reject_below", "on_uncertain"],
      {
        allOf: [
          { if: { required: ["output"], properties: { output: { const: "label" } } }, then: { required: ["labels"] }, else: { not: { required: ["labels"] } } }
        ]
      }
    ),
    stepVariant(
      "act",
      {
        action: { enum: [...ROUTINE_ACT_ACTIONS], description: "click, fill (type text) or select (choose an option)." },
        effect: {
          enum: [...ROUTINE_EFFECTS],
          description:
            "What it changes: rearrange (reorder your own items), add_item, remove_item, offer (propose something to another person), respond (answer someone's proposal) or other. The user decides what may run without asking; offer, respond and other always wait for the user."
        },
        target: text("The control to use, in plain language ('the Add button next to this player').", ROUTINE_LIMITS.actTargetChars),
        strategies: strategies(),
        min_confidence: unit("Below this confidence the control counts as not found."),
        on_low: { enum: [...ROUTINE_ON_LOW], description: "What to do when the control is not found confidently. Actions are never retried." },
        subject: ref("The thing this changes (for example a player): $item, an extract/infer step or a state value. Shown to the user and matched against actions.protect."),
        value: text("fill/select only: literal text or a reference ($item, an extract/infer step, state.<value key>).", ROUTINE_LIMITS.actValueChars),
        verify: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          description: "What must be true on the page afterwards. At least one of present or absent. A failed check stops the run and pauses the routine.",
          properties: {
            present: { type: "array", minItems: 1, maxItems: ROUTINE_LIMITS.verifyEntries, items: text("Text that must appear (literal or a reference).", ROUTINE_LIMITS.verifyChars) },
            absent: { type: "array", minItems: 1, maxItems: ROUTINE_LIMITS.verifyEntries, items: text("Text that must not appear (literal or a reference).", ROUTINE_LIMITS.verifyChars) }
          }
        }
      },
      ["action", "effect", "target", "strategies", "min_confidence", "on_low", "verify"],
      {
        allOf: [
          { if: { required: ["action"], properties: { action: { const: "click" } } }, then: { not: { required: ["value"] } }, else: { required: ["value"] } }
        ]
      }
    ),
    stepVariant("note", { tag: pattern(NAME_PATTERN, 'Short tag such as "maybe".'), fields: { type: "array", maxItems: ROUTINE_LIMITS.noteFields, items: ref("Reference to include in the note.") } }, []),
    stepVariant("mark_seen", { into: ref("A declared set. Optional inside a for_each over a diff step.") }, []),
    stepVariant("open_item", {}, []),
    stepVariant("wait", { for: pattern(WAIT_PATTERN, 'Duration up to 1h, such as "30s" or "5m".') }, ["for"]),
    stepVariant("report", { when: pattern(WHEN_PATTERN, '"always" or "new_notes>N".') }, [])
  ];
  if (level < MAX_LEVEL) {
    variants.push(
      stepVariant(
        "for_each",
        {
          items: ref("A locate or diff step, or a declared set."),
          limit: int(1, ROUTINE_LIMITS.forEachLimit, "Most items handled per run."),
          steps: { type: "array", minItems: 1, items: { $ref: next }, description: "Steps for each item; $item is the current one." }
        },
        ["items", "limit", "steps"]
      ),
      stepVariant(
        "branch",
        {
          on: pattern(NAME_PATTERN, "Bare id of an earlier infer step."),
          accept: { type: "array", items: { $ref: next } },
          maybe: { type: "array", items: { $ref: next } },
          reject: { type: "array", items: { $ref: next } }
        },
        ["on"],
        { anyOf: [{ required: ["accept"] }, { required: ["maybe"] }, { required: ["reject"] }] }
      )
    );
  }
  return { oneOf: variants };
}

function buildSchema(): Json {
  const defs: Json = {};
  for (let level = 1; level <= MAX_LEVEL; level += 1) defs[`step_${level}`] = stepLevel(level);

  const stopCondition = {
    oneOf: [
      { type: "object", additionalProperties: false, required: ["after_runs"], properties: { after_runs: int(1, 100_000, "Stop after this many runs.") } },
      { type: "object", additionalProperties: false, required: ["after_days"], properties: { after_days: int(1, 3650, "Stop this many days after approval.") } },
      {
        type: "object",
        additionalProperties: false,
        required: ["when_inferred", "confidence"],
        properties: {
          when_inferred: text("A condition judged on each run, such as 'the event has happened'."),
          confidence: unit("Stop only when the judgment reaches this confidence.")
        }
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["when_count"],
        properties: {
          when_count: {
            type: "object",
            additionalProperties: false,
            required: ["key", "at_least"],
            properties: { key: pattern(NAME_PATTERN, "A declared set or log (notes always exists)."), at_least: int(1, 1_000_000, "Stop when it holds this many entries.") }
          }
        }
      }
    ]
  };

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "urn:helmstack:routine-spec:1",
    title: "HelmStack routine spec, version 1",
    description:
      "A routine compiled from the user's request. The skeleton (steps) is a closed vocabulary that HelmStack runs exactly; judgment lives in infer steps whose thresholds you write. " +
      "References are only $scope.start[i], $<step id>, $item and state.<key>; there are no expressions. A reference must point at a step defined earlier and in scope, at $item inside a for_each, or at a declared state key. " +
      "Thresholds: for output \"score\" they apply to the score; for label, bool and text they apply to the reported confidence. value >= accept_at is accepted, value < reject_below is rejected, anything between is uncertain and handled by on_uncertain. " +
      "Beyond this schema HelmStack checks: unique ids, resolvable references, 0 <= reject_below <= accept_at <= 1, at most 60 steps, cron ranges, time zones, URLs without credentials and a 64 KB size limit. Unknown keys are rejected.",
    type: "object",
    additionalProperties: false,
    required: ["version", "title", "intent", "scope", "trigger", "steps"],
    properties: {
      version: { const: 1 },
      title: text("Short name shown to the user.", ROUTINE_LIMITS.titleChars),
      intent: text("The user's request, verbatim."),
      scope: {
        type: "object",
        additionalProperties: false,
        required: ["start", "max_pages_per_run"],
        description: "Where the routine may go.",
        properties: {
          start: {
            type: "array",
            minItems: 1,
            maxItems: ROUTINE_LIMITS.startUrls,
            items: { type: "string", pattern: HTTP_URL_PATTERN, maxLength: ROUTINE_LIMITS.urlChars },
            description: "http(s) URLs to start from."
          },
          follow: {
            type: "object",
            additionalProperties: false,
            description: "Link following. Without allow_hosts and with same_site off (or follow omitted) it may follow links to ANY site (flagged high risk); prefer allow_hosts. max_depth 0 stays on the start pages.",
            properties: {
              same_site: { type: "boolean", description: "Allow links on the same host as a start URL." },
              allow_hosts: {
                type: "array",
                maxItems: ROUTINE_LIMITS.allowHosts,
                items: { type: "string", pattern: HOST_PATTERN, maxLength: 253 },
                description: 'Hosts, or "*.example.com" for subdomains.'
              },
              max_depth: int(0, ROUTINE_LIMITS.maxDepth, "Link hops from a start page. Default 1; 0 stays on the start pages.")
            }
          },
          max_pages_per_run: int(1, ROUTINE_LIMITS.maxPagesPerRun, "Hard cap on pages opened per run.")
        }
      },
      trigger: {
        description: "When it runs.",
        oneOf: [
          { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { const: "manual" } } },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "every"],
            properties: {
              kind: { const: "interval" },
              every: pattern(EVERY_PATTERN, 'Such as "30m", "6h" or "1d" (1 minute to 90 days).'),
              jitter_pct: { type: "number", minimum: 0, maximum: 50, description: "Randomise each interval by up to this percent." },
              active_hours: pattern(ACTIVE_HOURS_PATTERN, 'Local time window such as "08:00-22:00".')
            }
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "cron"],
            properties: {
              kind: { const: "schedule" },
              cron: pattern(CRON_PATTERN, "Five-field cron: minute hour day-of-month month day-of-week."),
              timezone: pattern(TIMEZONE_PATTERN, 'IANA time zone such as "Europe/Berlin".')
            }
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "watch"],
            properties: { kind: { const: "event" }, watch: text("Plain-language condition for an assertion watch.") }
          }
        ]
      },
      steps: { type: "array", minItems: 1, maxItems: ROUTINE_LIMITS.maxSteps, items: { $ref: "#/$defs/step_1" }, description: "The skeleton, run in order." },
      related: {
        type: "object",
        additionalProperties: false,
        required: ["discover", "accept_at", "limit_per_run", "needs"],
        description: "Optional discovery of related pages. Anything it finds needs the user's approval before it is added to the scope.",
        properties: {
          discover: text("Where to look for related pages, in plain language."),
          accept_at: unit("Only suggest candidates judged at least this relevant."),
          limit_per_run: int(1, ROUTINE_LIMITS.relatedPerRun, "Most candidates per run."),
          needs: { const: "human_approval", description: "Always human_approval in version 1." }
        }
      },
      state: {
        type: "object",
        maxProperties: ROUTINE_LIMITS.stateKeys,
        propertyNames: { pattern: NAME_PATTERN },
        additionalProperties: { enum: [...ROUTINE_STATE_TYPES] },
        description: 'Declared keys: "set" (membership), "log" (append-only) or "value". "notes" always exists as a log.'
      },
      stop: {
        type: "object",
        additionalProperties: false,
        description: "When to end, and how much it may spend. Always set both.",
        properties: {
          any: { type: "array", maxItems: ROUTINE_LIMITS.stopConditions, items: stopCondition, description: "Stop when any of these holds." },
          budgets: {
            type: "object",
            additionalProperties: false,
            properties: {
              tokens_per_run: int(1, 50_000_000, "Model tokens per run."),
              pages_per_run: int(1, ROUTINE_LIMITS.maxPagesPerRun, "Pages per run."),
              cost_usd_total: { type: "number", minimum: 0.01, maximum: 10_000, description: "Total model cost across all runs." },
              runtime_minutes_per_run: int(1, 1440, "Wall-clock minutes per run.")
            }
          }
        }
      },
      on_failure: {
        type: "object",
        additionalProperties: false,
        required: ["retries", "backoff", "pause_after", "notify"],
        properties: {
          retries: int(0, 5, "Retries per failed run."),
          backoff: { enum: ["fixed", "exponential"] },
          pause_after: int(1, 10, "Pause the routine after this many failed runs in a row."),
          notify: { type: "boolean", description: "Tell the user when it pauses." }
        }
      },
      output: {
        type: "object",
        additionalProperties: false,
        required: ["notes"],
        properties: {
          notes: { const: "append" },
          report: {
            type: "object",
            additionalProperties: false,
            required: ["every"],
            properties: { every: pattern(EVERY_PATTERN, 'Such as "7d".'), when: pattern(WHEN_PATTERN, '"always" or "new_notes>N".') }
          }
        }
      },
      actions: {
        type: "object",
        additionalProperties: false,
        description:
          "Only for routines with act steps. What the routine ASKS the user to allow; the user decides the real grants when approving, and by default every action waits for them. Never lifts HelmStack's own approvals (purchases, personal data, accounts, terms, messages, downloads, uploads, deletes).",
        properties: {
          request: {
            type: "object",
            additionalProperties: false,
            description: "Per effect. mode auto can only be requested for rearrange, add_item and remove_item; offer, respond and other always wait for the user.",
            properties: Object.fromEntries(
              ROUTINE_EFFECTS.map((effect) => [
                effect,
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["mode"],
                  properties: {
                    mode: (ROUTINE_AUTO_EFFECTS as readonly string[]).includes(effect) ? { enum: ["ask", "auto"] } : { const: "ask" },
                    per_day: int(1, ROUTINE_LIMITS.actionsPerWindowMax, "Most actions of this kind per calendar day."),
                    per_run: int(1, ROUTINE_LIMITS.actionsPerWindowMax, "Most actions of this kind per run.")
                  }
                }
              ])
            )
          },
          protect: {
            type: "array",
            maxItems: ROUTINE_LIMITS.protectNames,
            items: text("A name the routine must never remove or give away.", ROUTINE_LIMITS.protectChars),
            description: "Matched case-insensitively against each act's subject; a match is blocked and never asked."
          }
        }
      },
      safety: {
        type: "object",
        additionalProperties: false,
        description: "Can only add to HelmStack's guardrails. There is no field to disable approvals, enable stealth or use credentials.",
        properties: {
          approval_for: { type: "array", uniqueItems: true, items: { enum: [...ROUTINE_APPROVAL_KINDS] }, description: "Extra actions that always need the user's approval." },
          rate: pattern(RATE_PATTERN, 'Request pacing such as "1 request / 2s" (at most 5 per second).')
        }
      }
    },
    $defs: defs
  };
}

/** JSON Schema (draft 2020-12) of a version 1 routine spec. */
export const ROUTINE_SPEC_JSON_SCHEMA: Readonly<Json> = Object.freeze(buildSchema());
