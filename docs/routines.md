# Routines

A routine is a procedure an agent writes down from your request and you approve: "watch this page for news on this topic and related ones; check and note every new update." This page explains what a routine is, the JSON an agent writes, how decisions and confidence work, and what this version does and does not do.

**Prerequisites:** a running HelmStack (desktop or daemon) and an agent connected to it. See [Connect an agent](connect-an-agent.md).

## What this version does

Routines can be **proposed, validated, previewed, approved and now run**, with a limit: this version runs only the **deterministic** steps. It never calls a model.

| Phase | What it adds | Status |
| --- | --- | --- |
| 1 | Store, validate, preview in plain language, human approval | Done |
| 2 | The engine that runs the fixed steps exactly: `manual` and `interval` triggers, memory, notes, run history, kill switch | This version |
| 3 | The inference runtime that answers the judgment points (`infer`, `branch`) | Later |
| 4 | Schedule and event triggers (cron, watches that start a routine) | Later |
| 5 | A learned cache of where things are on a page | Later |

What runs now, and what does not:

| Part of the spec | In this version |
| --- | --- |
| Trigger `manual`, `interval` | Runs. `manual` runs when you press **Run now**; `interval` also runs on its own |
| Trigger `schedule`, `event` | Does **not** run. The Routines tab shows "not run yet" with the reason |
| Steps `open`, `locate`, `extract`, `diff`, `for_each`, `note`, `mark_seen`, `open_item`, `wait`, `report` | Run exactly. `locate` and `extract` use the `structured_data` and `repeating_blocks` strategies |
| Step `infer` and the `infer` strategy | Never run. The step's own `on_uncertain` / `on_low` policy is applied without a model (see below) |
| Step `branch` | Hands the run to a person: it can only branch on an `infer` verdict, and there is none |
| `related` | Never followed. Widening scope needs a person |
| `stop.budgets.tokens_per_run`, `cost_usd_total`, `stop.any.when_inferred` | Never reached or evaluated: nothing spends tokens or money, and there is no model to infer a stop |

Nothing a run does is an action on a site: it loads pages and reads them. It never fills a field, clicks, submits, posts, buys, downloads, uploads or signs in. Those step kinds do not exist in the vocabulary.

## How it works

1. You ask an agent, for example "please watch this page for updates on accessibility law and note anything new". Agents offer or accept this when you ask them to watch, monitor or repeat something.
2. The agent reads the schema (`browser_routine_schema`) and **compiles your request into the JSON described below**, then calls `browser_propose_routine`.
3. HelmStack validates it strictly, stores it as `proposed` and builds a plain-language preview without using any model: when it runs, where it may go, what it notes, how it decides (with the real thresholds), what could widen its scope, when it stops, and what it will never do without asking.
4. The agent reads the preview back to you and tells you it needs your approval.
5. You review it in the HelmStack window and approve, reject, pause, resume, stop or delete it. **Only you can.** There is no agent route for any of these.

An agent can edit an earlier routine by proposing a new one that `replaces` it. The preview then starts with a "Changed" line, and the old routine is stopped only when you approve the new one. An agent can also withdraw its own proposal while it is still waiting for you.

## The shape of a routine

A routine has a **deterministic skeleton** and **typed inference points**.

- The skeleton is a list of steps from a **closed vocabulary** that is the same on every site. HelmStack will execute these exactly. The agent cannot add a step type, a script, a selector or an expression.
- Where judgment is needed ("is this about my topic?"), the agent writes an `infer` step. Each one yields `{ value, confidence, evidence }`, and the **spec** says what to do at each confidence level. The agent decides nothing at run time that the spec did not already say.

Top-level fields (unknown fields are rejected everywhere, with a JSON path in the error):

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | Always `1` |
| `title` | yes | Short name, up to 120 characters |
| `intent` | yes | Your request, verbatim, up to 2,000 characters |
| `scope` | yes | Where it may go |
| `trigger` | yes | When it runs |
| `steps` | yes | The skeleton |
| `related` | no | Discovery of related pages (always needs your approval) |
| `state` | no | Keys the steps use |
| `stop` | no | Stop conditions and budgets (strongly recommended) |
| `on_failure` | no | Retries and pausing (defaults: 2 retries, exponential, pause after 3, notify) |
| `output` | no | Notes and an optional periodic report |
| `safety` | no | Extra approvals and request pacing |

### scope

```json
{ "start": ["https://example.com/news"], "follow": { "same_site": true, "allow_hosts": ["*.example.org"], "max_depth": 1 }, "max_pages_per_run": 30 }
```

`start` is 1 to 10 `http` or `https` URLs without a username or password. `follow` says which links may be followed: `same_site` (the same host as a start URL, ignoring `www.`), `allow_hosts` (exact hosts or `*.domain` for a domain and its subdomains, at most 20) and `max_depth` (0 to 3, default 1; 0 stays on the start pages). `max_pages_per_run` is a hard cap, 1 to 200.

A scope with no `allow_hosts` and `same_site` off can follow links to **any** site. That is allowed but flagged as high risk (`any_site`). Prefer an allow-list.

### trigger

| Kind | Fields | Text in the app |
| --- | --- | --- |
| `manual` | none | "manual" |
| `interval` | `every` (`30m`, `6h`, `1d`; 1 minute to 90 days), `jitter_pct` (0 to 50), `active_hours` (`"08:00-22:00"`) | "every 6 hours" |
| `schedule` | `cron` (5 fields, numbers, `*`, ranges, lists, steps), `timezone` (IANA) | "weekdays at 09:00" |
| `event` | `watch`: a plain-language condition for an assertion watch | "when a watch fires: ..." |

### steps

Each step is an object with a `do` field and an optional `id` (lower-case letters, digits and underscores, unique across the whole spec). At most 60 steps in total, nested ones included, and `for_each` / `branch` can nest 4 levels deep.

| `do` | Fields | What HelmStack will do |
| --- | --- | --- |
| `open` | `url` | Open `$scope.start[i]`, `$item`, or an http(s) URL inside the scope |
| `locate` | `target`, `strategies`, `min_confidence`, `on_low` | Find something on the page by trying `structured_data`, `repeating_blocks` and `infer` in order; below `min_confidence`, `ask_human`, `skip` or `fail` |
| `extract` | `fields`, `strategies`, `from?` | Read named fields. Types: `text`, `text<=N` (N up to 2000), `date`, `url`, `number`, `bool`; a trailing `?` means optional |
| `diff` | `items`, `against`, `key` | Keep the located items whose `key` fields are not yet in the set `state.<key>` |
| `for_each` | `items`, `limit`, `steps` | Run the nested steps for up to `limit` (1 to 100) items; `$item` is the current one |
| `infer` | see below | A judgment with thresholds |
| `branch` | `on`, `accept`, `maybe`, `reject` | Run the arm that matches the verdict of the earlier `infer` step `on` (a bare id) |
| `note` | `tag?`, `fields?` | Append a note (the listed references) to the notes log |
| `mark_seen` | `into?` | Add the current item to a set. `into` may be left out inside a `for_each` over a `diff` |
| `open_item` | none | Open the current item's page (needs `max_depth` of at least 1) |
| `wait` | `for` (`30s`, `5m`, up to `1h`) | Pause |
| `report` | `when?` (`always` or `new_notes>N`) | Write a report |

### References

A reference is one of exactly four forms:

| Form | Points at |
| --- | --- |
| `$scope.start[i]` | A start URL |
| `$<step id>` | An earlier step in the same or an enclosing step list |
| `$item` | The current item inside a `for_each` |
| `state.<key>` | A declared state key (`notes` always exists) |

There are **no expressions, property paths, interpolation or evaluation of any kind**. `$entry.title`, `${x}` and `state.seen; drop` are rejected. HelmStack resolves every reference before storing the routine: it must point at something declared earlier and in scope, of the right kind (for example `diff.against` must be a `set`).

### infer: the probabilistic points

```json
{ "do": "infer", "id": "relevance", "question": "Is this update about our topic?",
  "output": "score", "accept_at": 0.7, "reject_below": 0.3,
  "on_uncertain": "note_as_maybe", "evidence": "quote", "samples": 3, "uses": "$entry" }
```

| Field | Meaning |
| --- | --- |
| `question` | The judgment, as a question about the current item |
| `output` | `score` (0 to 1), `label` (with `labels`, 2 to 10), `bool`, or `text<=N` |
| `accept_at`, `reject_below` | Thresholds, required, with `0 <= reject_below <= accept_at <= 1` |
| `on_uncertain` | What to do with a result between the thresholds: `note_as_maybe`, `ask_human`, `skip` or `retry_more_context` |
| `evidence` | `quote` (default): the answer must quote the page; or `none` |
| `samples` | Ask 1 to 5 times and combine (default 1) |
| `uses` | Extra context: `state.<key>`, `$item` or an earlier step |
| `model` | `default`, `cheap` or `strong` |

**Routing.** For `score`, the thresholds apply to the score. For `label`, `bool` and `text`, they apply to the reported confidence. At or above `accept_at` the result is accepted, below `reject_below` it is rejected, and anything in between is **uncertain** and handled by `on_uncertain`. A `branch` then runs its `accept`, `maybe` or `reject` arm.

### Confidence is a guide, not a measurement

A model's own confidence number is **not calibrated**: "0.9" from a model does not mean it is right nine times in ten. The thresholds are therefore only part of the design. When the engine arrives it will not trust a single self-reported number. It will use several samples, require a quote from the page that grounds the answer (`evidence: "quote"`), and send borderline results to the `maybe` path by default, so doubtful items are kept for you to look at rather than dropped or trusted. Treat the thresholds as a way to say how cautious you want to be, and prefer `note_as_maybe` and `ask_human` over `skip`. A routine whose every uncertain outcome is `skip` is flagged (`no_human_fallback`).

### related

```json
{ "discover": "pages on the same subject", "accept_at": 0.8, "limit_per_run": 3, "needs": "human_approval" }
```

Lets the routine suggest related pages, at most 10 per run. `needs` must be `"human_approval"`: widening a routine's scope always needs a person. Anything else is rejected.

### state, stop, output, safety

- `state` declares keys: `set` (membership), `log` (append only) or `value`; at most 12. `notes` is always a log.
- `stop.any` lists conditions, any of which ends the routine: `{ "after_runs": 120 }`, `{ "after_days": 30 }`, `{ "when_inferred": "...", "confidence": 0.9 }`, `{ "when_count": { "key": "notes", "at_least": 50 } }`. `stop.budgets` caps `tokens_per_run`, `pages_per_run`, `cost_usd_total` and `runtime_minutes_per_run`. A routine with no stop condition or no budget is allowed and flagged.
- `output`: `{ "notes": "append", "report": { "every": "7d", "when": "new_notes>0" } }`.
- `safety.approval_for` adds approvals to HelmStack's own list (`submit`, `personal_data`, `purchase`, `post`, `account_creation`, `accept_terms`, `send_message`, `download`, `upload`, `delete`). `safety.rate` is `"<n> request(s) / <n>s"`, at most 5 requests per second.

## The canonical example

"Please watch this page for updates on this topic and related ones. Every new update should be checked and noted." It validates as-is; `browser_routine_schema` returns it too.

```json
{
  "version": 1,
  "title": "Updates on accessibility law changes",
  "intent": "Please watch https://example.com/news for updates on accessibility law changes and related ones. Every new update should be checked and noted.",
  "scope": {
    "start": [
      "https://example.com/news"
    ],
    "follow": {
      "same_site": true,
      "max_depth": 1
    },
    "max_pages_per_run": 30
  },
  "trigger": {
    "kind": "interval",
    "every": "6h",
    "jitter_pct": 10,
    "active_hours": "07:00-23:00"
  },
  "state": {
    "seen": "set",
    "notes": "log",
    "watchlist": "set"
  },
  "steps": [
    {
      "do": "open",
      "id": "start_page",
      "url": "$scope.start[0]"
    },
    {
      "do": "locate",
      "id": "updates",
      "target": "the list of dated updates, newest first",
      "strategies": [
        "structured_data",
        "repeating_blocks",
        "infer"
      ],
      "min_confidence": 0.6,
      "on_low": "ask_human"
    },
    {
      "do": "diff",
      "id": "fresh",
      "items": "$updates",
      "against": "state.seen",
      "key": [
        "url"
      ]
    },
    {
      "do": "for_each",
      "items": "$fresh",
      "limit": 25,
      "steps": [
        {
          "do": "extract",
          "id": "entry",
          "fields": {
            "title": "text<=200",
            "date": "date?",
            "summary": "text<=500",
            "url": "url"
          },
          "strategies": [
            "structured_data",
            "repeating_blocks",
            "infer"
          ],
          "from": "$item"
        },
        {
          "do": "infer",
          "id": "relevance",
          "question": "Is this update about accessibility law changes or a closely related subject?",
          "output": "score",
          "accept_at": 0.7,
          "reject_below": 0.3,
          "on_uncertain": "note_as_maybe",
          "evidence": "quote",
          "samples": 3,
          "uses": "$entry"
        },
        {
          "do": "branch",
          "on": "relevance",
          "accept": [
            {
              "do": "infer",
              "id": "whats_new",
              "question": "What is new here, and does it extend or contradict our earlier notes?",
              "output": "text<=400",
              "accept_at": 0.6,
              "reject_below": 0.2,
              "on_uncertain": "note_as_maybe",
              "evidence": "quote",
              "samples": 1,
              "uses": "state.notes"
            },
            {
              "do": "note",
              "tag": "update",
              "fields": [
                "$entry",
                "$relevance",
                "$whats_new"
              ]
            },
            {
              "do": "mark_seen"
            }
          ],
          "maybe": [
            {
              "do": "note",
              "tag": "maybe",
              "fields": [
                "$entry",
                "$relevance"
              ]
            },
            {
              "do": "mark_seen"
            }
          ],
          "reject": [
            {
              "do": "mark_seen"
            }
          ]
        }
      ]
    }
  ],
  "related": {
    "discover": "pages that cover accessibility law changes or the same subject, on this site or on sites it links to",
    "accept_at": 0.8,
    "limit_per_run": 3,
    "needs": "human_approval"
  },
  "stop": {
    "any": [
      {
        "after_days": 30
      },
      {
        "after_runs": 120
      },
      {
        "when_inferred": "The topic is resolved or no longer being updated",
        "confidence": 0.9
      }
    ],
    "budgets": {
      "tokens_per_run": 200000,
      "pages_per_run": 30,
      "cost_usd_total": 5,
      "runtime_minutes_per_run": 20
    }
  },
  "on_failure": {
    "retries": 2,
    "backoff": "exponential",
    "pause_after": 3,
    "notify": true
  },
  "output": {
    "notes": "append",
    "report": {
      "every": "7d",
      "when": "new_notes>0"
    }
  },
  "safety": {
    "approval_for": [
      "submit",
      "personal_data",
      "purchase",
      "post"
    ],
    "rate": "1 request / 2s"
  }
}
```

Reading it: open the start page, locate the list of dated updates, keep only the ones not in `state.seen`, and for each new one (up to 25) read its fields and judge relevance three times with a quote. Accepted items get a second judgment about what is new compared with earlier notes, are noted and marked seen. Uncertain ones are noted as a `maybe` and marked seen. Rejected ones are marked seen so they are not judged again. Related pages are only ever suggested, up to 3 per run, and each needs your approval.

## Running a routine

### Starting, stopping and the kill switch

- **Run now** (Routines tab) starts a run of an approved `manual` or `interval` routine. It is refused if the routine is not approved, is already running, or the kill switch is on.
- An approved **interval** routine starts itself. The first run comes about 30 seconds after you approve it; after that, the next run is the `every` interval after the previous run **started**, spread by `jitter_pct` (a random amount up to plus or minus that percentage) and moved to the next `active_hours` window if it falls outside it.
- **No catch-up storm.** If the computer sleeps through ten runs, it does one run on wake and then goes back to its normal rhythm.
- At most **one run per routine** at a time and **2 runs at once** overall. A third waits for the next scheduler pass.
- **Cancel** ends the current run. **Pausing, stopping or deleting** a routine cancels its run too, and so does **replacing** it with an edit you approve.
- **Failures.** A run that fails is retried sooner than the interval, with a fixed or exponential backoff (2 minutes, 4, 8, and so on, never longer than the interval). After 3 failed runs in a row (or the spec's `on_failure.pause_after`) the routine is **paused** automatically, with a line in the run log. Resuming it starts with a clean slate.
- **Needs a person.** If a scheduled run ends as `needs_human` (see "No model yet"), the routine is paused instead of retrying every interval for nothing.
- **Stop conditions.** `after_runs`, `after_days` and `when_count` are checked after each run (and `after_days` also while idle). When one fires the routine is **stopped**, with a line in the run log. `when_inferred` is not evaluated.
- **Kill switch.** The switch at the top of the Routines tab aborts every running routine and starts nothing until you turn it off, whatever the triggers say. It is remembered across restarts. There is no agent route for it.

### Scope, politeness and budgets

Every page a run loads is checked first:

- Its host must be a start host or inside `follow.allow_hosts` / `same_site`, and a followed page must be within `max_depth` links of a start page. Anything else is **refused**, not requested. The URL the page ends up on after redirects is checked again, and a redirect out of scope discards the page.
- A **followed** (non-start) page is also checked against the site's `robots.txt` (for the `helmstack` user agent, falling back to `*`). Disallowed pages are skipped. If `robots.txt` cannot be read (a server error or no answer), followed pages on that site are skipped for the run. Start pages are the ones you chose and are not checked.
- Page loads are spaced out: at least `safety.rate` apart (never faster than 5 per second), or 1 second when the spec sets no rate.
- Budgets end the run with outcome `budget`: the smaller of `scope.max_pages_per_run` and `stop.budgets.pages_per_run`, the run time (`runtime_minutes_per_run`, otherwise 30 minutes), and 200 notes per run. Notes recorded before the limit are kept.

A refused or unreadable page inside a `for_each` skips that item and the run continues; outside a loop it fails the run.

### No model yet

When a run reaches something that needs judgment, it uses the spec's own policy and never asks a model:

| Where | Policy | Result |
| --- | --- | --- |
| `infer` step | `on_uncertain: skip` | Skips the current item (or the step, outside a loop) and carries on |
| `infer` step | `note_as_maybe`, `ask_human`, `retry_more_context` | The run ends as **needs_human**, with a plain log line |
| `locate`: nothing matched with enough confidence | `on_low: skip` | The list is empty; the run carries on |
| | `ask_human` | The run ends as **needs_human** |
| | `fail` | The run ends as **failed** |
| `extract`: a required field could not be read | inside a `for_each` | The item is skipped |
| | outside a loop | **needs_human** if the step lists `infer`, otherwise **failed** |
| `branch` | any | The run ends as **needs_human** |

The canonical example above reaches its first `infer` step on the first new item, so in this version it ends as needs_human after finding the list and noting nothing, and (as a scheduled routine) it is paused. It becomes useful in phase 3. A routine made only of deterministic steps, such as "note every new link in this list", runs fully today.

`locate` is deterministic and does not read `target` (the plain-language description). It uses what the page says about itself: JSON-LD structured data (confidence 0.9) or the largest group of similar sibling blocks that each carry a link (confidence 0.4 to 0.85, from how many there are and how complete they are). `min_confidence` decides whether that is good enough. Items have the fields `title`, `url`, `date` and `summary`, and `extract` fields use those names (with the usual aliases such as `name` for `title`).

### Memory

Each routine remembers between runs, in `routines/<id>/` in the data directory:

| What | Where | Kept |
| --- | --- | --- |
| Sets, logs and values declared in `state` (for example the set `seen`) | `state.json` | Sets: the newest 5,000 entries per key; logs: 500 |
| Run counters, failure count, next run time | `state.json` | |
| Notes | `notes.json` | The newest 1,000 |
| Runs and their logs | `runs/<run id>.json` | The newest 50 runs, each log capped at 200 lines |

A second run of a routine that marks items as seen notes nothing new for the same page. The Routines tab shows the memory (counts only) and a **Forget what it has seen** action (human only; notes and run history stay). Files are written atomically and readable only by you (mode 0600). A run left in progress when the app closed is marked failed on the next start. Deleting a routine deletes its folder.

### Notes and run logs are untrusted text

A note's fields and a run's log lines contain text copied from web pages. They are **data**, shown as plain text in the window, and an agent that reads them over HTTP must treat them as such, never as instructions. Run summaries and the live `routine_run` event use fixed wording and counts only, never page text.

## What the preview and risk flags say

The preview is built from the spec alone, with no model, so the same spec always reads the same. It has a one-sentence headline, 5 to 10 bullets and risk flags with stable codes.

| Code | Level | Raised when |
| --- | --- | --- |
| `any_site` | high | It can follow links anywhere (no allow-list, `same_site` off, `max_depth` above 0) |
| `has_login_hint` | warning | A start URL looks like a login, account or checkout page. Routines never type credentials; use a profile you're already signed into |
| `no_stop_condition` | warning | No stop condition: it will keep running until you stop it |
| `fast_interval` | warning | It runs more often than every 5 minutes |
| `no_budgets` | warning | No token, page, cost or runtime budget |
| `low_accept_threshold` | warning | A judgment (or `related`) accepts below 0.5 |
| `event_trigger_unverified` | warning | The trigger is a watch condition HelmStack cannot check yet |
| `many_pages` | info | More than 50 pages per run |
| `no_evidence_check` | info | A judgment sets `evidence` to `none` |
| `no_human_fallback` | info | Every `on_uncertain` is `skip` |
| `related_widens_scope` | info | `related` is present |

## Safety model

- **Agents propose, humans approve.** Approve, reject, pause, resume, stop and delete exist only as shell actions. The HTTP server and the MCP server have no route or tool for them, and a test asserts it. An agent can read routines and withdraw its own pending proposal.
- **Only approved routines run, and only deterministic steps.** The engine runs `manual` and `interval` routines you approved. It never calls a model, and nothing in its vocabulary fills, clicks, submits, posts, buys, downloads or signs in; a test asserts that the engine code has no such calls. Running, cancelling, clearing memory and the kill switch are shell actions with no HTTP or MCP route.
- **Every page is checked against scope first**, then `robots.txt` for followed pages, a page budget and a rate limit. See "Scope, politeness and budgets".
- **What a run read is untrusted.** Notes and logs hold page text and are never treated as instructions.
- **The vocabulary is closed.** The model fills a schema. It cannot add a capability, and no string in a spec is ever evaluated.
- **A spec can only add caution.** There is no field to disable approvals, enable stealth, type credentials or turn off a guardrail. Fields that look like that are rejected by name.
- **Widening scope needs a human**, always: `related.needs` is fixed to `human_approval`.
- **Validation is strict.** Unknown keys are rejected at every level, references are resolved statically, and the whole spec is limited to 64 KB.
- **The activity feed never contains your request.** It records labels such as "Propose routine" with a summary like "proposed · 12 steps"; the intent, title and spec are never written to it.

## Limits

| What | Limit |
| --- | --- |
| Whole spec | 64 KB (request body 128 KB; `413` above that) |
| Any string | 2,000 characters; title 120; URL 2,048 |
| Start URLs | 10 |
| Steps | 60 in total, nested 4 levels deep |
| `for_each.limit` | 100 |
| `samples` | 5 |
| State keys | 12 |
| `max_pages_per_run` | 200 |
| Routines stored | 50. A 51st proposal is refused with a clear message instead of deleting anything; delete some in the window |
| Runs at once | 2 overall, 1 per routine |
| Page loads | At least 200 ms apart (5 per second at most); 1 s by default |
| Run time | 30 minutes at most (or `runtime_minutes_per_run`) |
| Notes per run / kept | 200 / newest 1,000 per routine |
| Runs kept | Newest 50 per routine, 200 log lines each |
| Items in `seen`-style sets | Newest 5,000 per key |
| Errors returned | 20, in a fixed order, each with a JSON path like `steps[2].steps[0].accept_at` |

## Using it

| From | How |
| --- | --- |
| MCP | `browser_routine_schema`, `browser_propose_routine`, `browser_list_routines`, `browser_get_routine`, `browser_withdraw_routine`. They are part of the default toolset. They are **not** in the [lite toolset](lite-toolset.md). |
| SDK | `getRoutineSchema()`, `proposeRoutine(spec, { replaces? })`, `listRoutines()`, `getRoutine(id)`, `withdrawRoutine(id)`; stream handlers `onRoutineProposed` and `onRoutineStateChanged` |
| HTTP | `GET /api/routines/schema`, `POST /api/routines`, `GET /api/routines`, `GET /api/routines/:id`, `POST /api/routines/:id/withdraw`, and read-only `GET /api/routines/:id/runs` and `GET /api/routines/:id/notes` (untrusted text). The stream carries `routine_run` events. There is no route to run, cancel, clear memory or use the kill switch. See [HTTP API](http-api.md) |

`browser_propose_routine`'s description is the translation guide the model reads: when to use it, to call the schema first, to keep `intent` verbatim, to prefer a narrow scope, to always set stop conditions and budgets, to put judgment in `infer` points with thresholds and `note_as_maybe`, never to try to use credentials or approvals, and to tell you the routine needs your approval in the HelmStack window.

The routine files live in a `routines/` folder in the data directory: one `rt-YYYYMMDD-HHMMSS-<8 hex>.json` per routine plus an `index.json`, and a `rt-.../` folder per routine for its memory, notes and runs. Writes are atomic, and a file that cannot be read is renamed aside (`.corrupt-<time>`) instead of stopping HelmStack.

**Daemon.** The engine is part of the shared core, so the daemon runs approved routines too, in its headless Chrome. But it has no window, so nobody can approve a routine, press Run now or use the kill switch there (the kill switch is read when the daemon starts). It runs only routines already approved in its own data directory. The run tab is opened and closed in that Chrome. On the desktop, a run opens a tab in the window while it works and closes it afterwards.

## Verify it worked

- Ask an agent to watch a page. It should call `browser_routine_schema`, then `browser_propose_routine`, and read you the preview.
- `curl -H "X-HelmStack-Token: $TOKEN" http://127.0.0.1:7070/api/routines` lists it with `"state": "proposed"`.
- `curl -X POST ... /api/routines/<id>/approve` returns `404`: only the window can approve. So do `/run`, `/cancel` and `/kill-switch`.
- Approve a routine whose trigger is `manual`, press **Run now**, and open the run in the Routines tab. `curl ... /api/routines/<id>/runs` shows it, and `.../notes` lists what it noted.
