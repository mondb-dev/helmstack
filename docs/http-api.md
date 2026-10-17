# HTTP API reference

The agent API is plain HTTP plus one Server-Sent Events stream, served on `127.0.0.1` by both the desktop app and the daemon. The MCP server and the SDK are thin clients of it.

**Prerequisites:** a running desktop app or daemon, and its token.

## Conventions

| Topic | Behavior |
| --- | --- |
| Address | `http://127.0.0.1:7070` by default (desktop and daemon). Never bound to another interface. |
| Auth | `X-HelmStack-Token: <token>` or `Authorization: Bearer <token>`. Missing or wrong: `401 {"error":"Unauthorized"}`. |
| Agent id | Optional `X-Agent-ID: <name>` header attributes the call and scopes tab ownership. It is not authentication; see [Security model](security-model.md#known-caveat-agent-isolation-is-advisory). |
| Host guard | A `Host` header that is not `127.0.0.1`, `localhost` or `::1` gets `403 {"error":"Forbidden: non-loopback Host header"}`. |
| Origin guard | A browser `Origin` that is not loopback gets `403 {"error":"Forbidden: cross-origin request rejected"}`. Requests without `Origin` (curl, Node, SDK) are fine. |
| Bodies | JSON. Errors are `{ "error": "..." }`. Invalid JSON gives `500 {"error":"Error: Invalid JSON body"}`; a missing required field gives `400` naming it (for example `url is required`). |
| Unknown tab | `500 {"error":"Error: Unknown tab: <id>"}` |
| Unknown route | `404 {"error":"Not found"}` |
| Another agent's tab | `403 {"error":"tab is owned by another agent"}` |
| Optional features | `501 {"error":"...","code":"unsupported_on_backend","feature":"...","backend":"..."}` when the backend lacks accounts, extensions or element picking. |
| Approvals on desktop | `POST /api/approvals/:id/approve` answers `403` with `"code":"requires_human"`. See [Approvals](approvals.md). |
| Pick not made | `404 {"error":"The user has not selected an element in this tab","code":"no_pick"}` |

Tab ids look like `tab-1`. `GET /api/health` returns `status`, `connectedAgents` (open event streams), `tabs`, `backend` (`desktop` or `daemon`) and `capabilities`.

## Routes

Generated from the route comment block in `packages/devtools-core/src/http/agent-server.ts`. The right column is that comment's shorthand for the request body and the response type.

<!-- generated:start http-routes -->
| Method | Path | Body / response |
| --- | --- | --- |
| GET | `/api/health` | → { status, connectedAgents, tabs, backend, capabilities } |
| GET | `/api/tabs` |  |
| POST | `/api/tabs` | { url?: string } |
| POST | `/api/tabs/:id/navigate` | { url: string } |
| POST | `/api/tabs/:id/reload` | { ignoreCache?: boolean }   (waits for the load) |
| POST | `/api/tabs/:id/back` | (waits for the load; unchanged when there is no earlier entry) |
| POST | `/api/tabs/:id/forward` | (likewise) |
| GET | `/api/tabs/:id/perception` |  |
| GET | `/api/tabs/:id/manifests` |  |
| POST | `/api/tabs/:id/command` | { command: BrowserOutputCommand } |
| GET | `/api/approvals` |  |
| POST | `/api/approvals/:id/approve` |  |
| POST | `/api/approvals/:id/reject` |  |
| GET | `/api/tabs/:id/screenshot` |  |
| POST | `/api/tabs/:id/viewport` | { width: number, height: number, mobile?: boolean } |
| GET | `/api/handoffs` |  |
| POST | `/api/handoffs/:id/resolve` |  |
| POST | `/api/handoffs/:id/cancel` |  |
| GET | `/api/extensions` |  |
| POST | `/api/extensions` | { path: string } |
| DELETE | `/api/extensions/:id` |  |
| GET | `/api/accounts` | → AccountSummary[]            (desktop only; the daemon answers 501) |
| POST | `/api/accounts` | AccountInput → AccountSummary |
| PATCH | `/api/accounts/:id` | AccountUpdate → AccountSummary |
| DELETE | `/api/accounts/:id` | → { deleted: id } |
| GET | `/api/accounts/lookup/:origin` | → AccountSummary[]            (origin is URL-encoded) |
| GET | `/api/accounts/:id/totp` | → TotpResult |
| GET | `/api/intent` |  |
| PUT | `/api/intent` | { intent: string } |
| POST | `/api/log` | { level?, message } |
| GET | `/api/tabs/:id/logs` | → TabLogSnapshot |
| GET | `/api/tabs/:id/har` | → HarArchive (HAR 1.2) |
| DELETE | `/api/tabs/:id/logs` | clears buffered logs |
| GET | `/api/tabs/:id/mock` | → { rules } |
| POST | `/api/tabs/:id/mock` | { rules: NetworkInterceptRule[] } |
| DELETE | `/api/tabs/:id/mock` | disables interception |
| POST | `/api/tabs/:id/screenshot/named` | { snapshotId } → PageScreenshot |
| POST | `/api/screenshots/diff` | { beforeId, afterId, ignoreRegions?, perceptual?, threshold? } → ScreenshotDiff |
| POST | `/api/tabs/:id/changed-elements` | { regions: DiffRegion[] } → ChangedElement[] |
| POST | `/api/tabs/:id/viewport-suite` | { presets?, includeDiffs?, includeLayoutIssues? } → ViewportSuiteReport |
| GET | `/api/tabs/:id/performance` | → PerformanceReport |
| GET | `/api/tabs/:id/health` | → HealthReport (aggregated scorecard; ?seo=false omits the SEO category) |
| GET | `/api/tabs/:id/a11y` | → A11yAuditReport (?selector= scopes to a subtree) |
| GET | `/api/tabs/:id/seo` | → SeoAuditReport (?checkLinks=true&maxLinks=25 opts into a bounded link check) |
| GET | `/api/tabs/:id/focus-order` | → FocusOrderReport |
| POST | `/api/tabs/:id/styles/inspect` | { selector, limit? } → ElementStyleInspectionReport |
| POST | `/api/tabs/:id/styles/assert` | { selector, assertions, limit? } → ElementStyleAssertionReport |
| GET | `/api/tabs/:id/component-tree` | → ComponentTreeReport |
| GET | `/api/tabs/:id/design-tokens` | → DesignTokensReport |
| GET | `/api/tabs/:id/css-coverage` | → CssCoverageReport (unused-CSS, reloads tab) |
| GET | `/api/tabs/:id/js-coverage` | → JsCoverageReport (dead-JS, reloads tab) |
| GET | `/api/tabs/:id/trace` | → TraceReport (?durationMs=, long tasks + categories) |
| GET | `/api/tabs/:id/framework` | → FrameworkReport (framework + dev server + HMR) |
| GET | `/api/tabs/:id/pick` | → ElementPickResult (human inspect-and-click; blocks) |
| GET | `/api/tabs/:id/picks/latest` | → HumanElementPick (from "Select for agent"; 404 { code: "no_pick" }) |
| GET | `/api/picks` | → HumanElementPick[] (recent human picks, newest first) |
| GET | `/api/tabs/:id/component-sources` | → ComponentSourceReport (click-to-component) |
| GET | `/api/tabs/:id/layout-issues` | → LayoutIssuesReport |
| GET | `/api/tabs/:id/media-state` | → MediaStateReport |
| GET | `/api/tabs/:id/mutations` | → MutationTimelineReport (?durationMs=) |
| GET | `/api/tabs/:id/threejs-scene` | → ThreeSceneReport |
| POST | `/api/tabs/:id/assert` | { assertion: string } → AssertionResult |
| GET | `/api/tabs/:id/watches` | → AssertionWatch[] |
| POST | `/api/tabs/:id/watches` | { assertion: string } → AssertionWatch |
| DELETE | `/api/tabs/:id/watches/:wid` | → { removed: boolean } |
| GET | `/api/tabs/:id/recording` | → RecordingSession \| null |
| POST | `/api/tabs/:id/recording/start` | → RecordingSession |
| POST | `/api/tabs/:id/recording/stop` | → RecordingStopResult |
| GET | `/api/tabs/:id/site-patterns` | → { patterns: string[] } |
| POST | `/api/tabs/:id/site-patterns` | { patterns: string[], mode?: "set" \| "add" } |
| DELETE | `/api/tabs/:id/site-patterns` | clears persisted origin patterns |
| POST | `/api/tabs/:id/file-input` | { selector, files } → { ok: true } |
| GET | `/api/tabs/:id/downloads` | → DownloadEntry[] |
| DELETE | `/api/tabs/:id/downloads` | clears tracked downloads |
| GET | `/api/tabs/:id/budget` | → ResourceBudget \| null |
| POST | `/api/tabs/:id/budget` | → ResourceBudget |
| DELETE | `/api/tabs/:id/budget` | clears resource budget |
| GET | `/api/tabs/:id/location` | → LocationOverride \| null |
| POST | `/api/tabs/:id/location` | → LocationOverride |
| DELETE | `/api/tabs/:id/location` | clears geolocation/timezone override |
| GET | `/api/tabs/:id/media` | → MediaEmulation \| null |
| POST | `/api/tabs/:id/media` | → MediaEmulation (colorScheme/reducedMotion/forcedColors/media) |
| DELETE | `/api/tabs/:id/media` | clears CSS media emulation |
| GET | `/api/tabs/:id/storage` | → StorageReport (all areas) |
| GET | `/api/tabs/:id/storage/:area` | area=local\|session → StorageEntry[]  (optional ?key=X) |
| POST | `/api/tabs/:id/storage/:area` | { entries: Record<string,string> } → { ok: true } |
| DELETE | `/api/tabs/:id/storage/:area` | body? { keys: string[] } — omit to clear all |
| POST | `/api/tabs/:id/evaluate` | { expression: string } → { value } — evaluates JavaScript in the page; 400 if expression is not a string |
| POST | `/api/tabs/:id/insert-text` | { text } → { ok: true } — CDP Input.insertText into the focused element |
| POST | `/api/tabs/:id/key` | { key, modifiers?, code?, keyCode?, text? } → { ok: true } — CDP key press (chords via modifiers bitmask: Alt=1 Ctrl=2 Meta=4 Shift=8) |
| POST | `/api/tabs/:id/click` | { x, y } → { ok: true } — CDP left mouse click at viewport CSS coords (reaches cross-origin iframes) |
| DELETE | `/api/tabs/:id` | → TabSummary[] — close a tab |
| GET | `/api/tabs/:id/cookies` | → CookieEntry[] |
| POST | `/api/tabs/:id/cookies` | { name, value, domain?, path?, httpOnly?, secure?, sameSite?, expires? } |
| DELETE | `/api/tabs/:id/cookies/:name` | ?url=… (optional) |
| DELETE | `/api/tabs/:id/cookies` | clear all cookies for the tab's origin |
| GET | `/api/screenshots` | → {id,tabId,url,width,height,capturedAt}[] |
| DELETE | `/api/screenshots/:id` | removes snapshot from cache |
| POST | `/api/tabs/:id/perception/named` | { snapshotId } → PerceptionSnapshotEntry |
| POST | `/api/perception/diff` | { beforeId, afterId } → PerceptionDiff |
| GET | `/api/perception` | → PerceptionSnapshotEntry[] |
| DELETE | `/api/perception/:id` | removes perception snapshot from cache |
| POST | `/api/tabs/:id/report` | CreateReportInput (body limit 256 KB) → CreateReportResult (the agent's findings + HelmStack's measurements; 400 on limits) |
| GET | `/api/reports` | → ReportSummary[] (newest first) |
| GET | `/api/reports/:id` | ?format=html\|md → the report file (attachment, nosniff). There is no agent route to delete a report. |
| GET | `/api/routines/schema` | → { schema, example, limits } (JSON Schema of a routine spec, a worked example, size limits) |
| POST | `/api/routines` | { spec, replaces? } (body limit 128 KB) → 201 { routine, preview, warnings, stepCount, message }; 400 { error, errors: [{ path, message }] } |
| GET | `/api/routines` | → RoutineSummary[] (newest first) |
| GET | `/api/routines/:id` | → RoutineDetail (summary, plain-language preview and the validated spec) |
| POST | `/api/routines/:id/withdraw` | → RoutineSummary (only the agent that proposed it, only while it is still proposed). Approving, rejecting, pausing, stopping and deleting a routine are human actions in the HelmStack window and have no route. |
<!-- generated:end -->

### Route coverage

The table above comes from the route comment block in `agent-server.ts`. The generator also compares it with the route matchers in the file. Routes that exist in the code but are missing from the table are listed here, and the list should stay empty:

<!-- generated:start http-undocumented -->
_None._
<!-- generated:end -->

## Event stream

`GET /api/stream` opens a `text/event-stream`. A `: ping` comment is sent every 25 seconds. Events:

<!-- generated:start http-events -->
- `tabs_changed`
- `page_observed`
- `approval_queued`
- `approval_resolved`
- `human_handoff_requested`
- `human_handoff_resolved`
- `intent_changed`
- `agent_log`
- `assertion_changed`
- `element_picked`
- `report_created`
- `routine_proposed`
- `routine_state_changed`
<!-- generated:end -->

`approval_resolved` carries `{ requestId, tabId, outcome, reason?, status?, url?, origin?, resolvedAt }` where `outcome` is `approved`, `rejected`, `cancelled` (the tab navigated or closed first) or `expired`. `element_picked` carries `{ tabId, pickedAt, pick }`.

## Try it

```bash
TOKEN=$(cat /path/to/helmstack-agent-token)
curl -H "X-HelmStack-Token: $TOKEN" http://127.0.0.1:7070/api/tabs
curl -H "X-HelmStack-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"url":"http://127.0.0.1:4177/contact-form.html"}' http://127.0.0.1:7070/api/tabs
curl -N -H "X-HelmStack-Token: $TOKEN" http://127.0.0.1:7070/api/stream
```

## Verify it worked

`GET /api/health` returns `{"status":"ok",...}`. Calling it without the token returns `{"error":"Unauthorized"}`.
