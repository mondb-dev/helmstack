# Approvals

Some agent actions need a person's decision before they run. This page explains what is gated, who decides, and what happens to a request that is not answered.

**Prerequisites:** none. For the security reasoning see [Security model](security-model.md).

## What is gated

Effects are classified before a command runs, so `ask` and `block` stop it before anything reaches the page.

| Policy key | Used for | Default |
| --- | --- | --- |
| `share_personal_data` | Submits and fills or typing into personal fields (email, phone, password, address, name, card and similar `autocomplete` hints, or a vault or account reference) | `ask` |
| `create_account` | Submits that look like sign-up forms | `ask` |
| `accept_legal_terms` | Terms and consent gates | `ask` |
| `submit_payment` | Payment and checkout actions | `block` |

Each policy is `auto` (run), `ask` (queue for approval) or `block` (refuse). Filling only non-personal fields is not gated. Policies apply the same on `localhost`: there is no special case for test fixtures.

Policies are stored in `helmstack-approval-policies.json` in the data directory and read when the core starts. The desktop settings sheet edits them (it is visible only under the `agent-substrate` or `full` profile). The daemon has no UI: edit the file in `<data-dir>` before starting it. The file is:

```json
{ "version": 1, "updatedAt": 0, "policies": [
  { "key": "share_personal_data", "label": "Share personal data", "description": "...", "decision": "auto" }
] }
```

Payment and consent detection beyond the form heuristics, and gating of plain `click` and `select`, are not implemented; do not rely on them.

## Who decides

| Runtime | Who can approve | What an agent sees |
| --- | --- | --- |
| Desktop (default) | Only the person in the HelmStack window | `POST /api/approvals/:id/approve` returns `403` with `"code":"requires_human"`. The agent may reject (withdraw) its own request. It receives `approval_queued` and later `approval_resolved` over SSE. |
| Desktop with `HELMSTACK_AGENT_APPROVALS=1` | Any token holder | Approve works. Treat this like running the daemon. |
| Daemon | Any token holder | Approve works; the gate is a pause for the calling agent, not a human checkpoint. |

## Approvals are tied to a page

A request records the tab's URL and origin when it is queued and the dialog shows that page. It is cancelled, never executed, when:

- the tab navigates its main frame. A fragment-only change keeps it; a query-string change cancels;
- the tab closes;
- it expires: unanswered approvals lapse after 10 minutes (`HELMSTACK_APPROVAL_TTL_MS`, `0` disables);
- at approval time the tab's live URL differs from the recorded one.

A cancelled or expired request leaves the pending list and the agent receives `approval_resolved` with `outcome` `cancelled` or `expired`. A later approve or reject of that id returns a `blocked` result: "Page changed before approval — ask again." The agent must re-issue the command on the new page.

## No double prompt for fill then submit

Approving a fill or `type` into form F on tab T records a single-use grant. The next submit of F on T runs without a second prompt when the tab is still on the same document, the submit's effects are a subset of what was approved (a sign-up submit adds `create_account`, so it asks again), and it is within 5 minutes. `block` always wins. A rejected fill grants nothing.

## What the Activity feed shows

A queued command gets one row in the Activity feed. It starts as "awaiting approval" (clock) and the same row is updated when the approval resolves:

| State | Row text | Icon |
| --- | --- | --- |
| Waiting | awaiting approval | clock, warning |
| Approved | approved (or "approved: failed" if the command then failed) | check, success (x if it failed) |
| Rejected | rejected | x, muted - a human said no, not an error |
| Cancelled | cancelled (the page changed or the tab closed) | warning triangle, muted |
| Expired | expired | info, muted |

An agent's refused attempt to approve (`requires_human`) leaves the row waiting. Rows older than the feed's history are not updated.

## Handoffs

Separately from approvals, an agent can ask the human to take over (for example to solve a captcha). The window shows a handoff dialog; the agent waits for **Done** or **Cancel**. Routes: `GET /api/handoffs`, `POST /api/handoffs/:id/resolve`, `POST /api/handoffs/:id/cancel`.

## Verify it worked

Start the desktop app, then with a token call `POST /api/approvals/<any-id>/approve`. You should get `403` and `"code":"requires_human"`. To see a real queue, have an agent fill an email field on `http://127.0.0.1:4177/contact-form.html`: a banner appears in the window.
