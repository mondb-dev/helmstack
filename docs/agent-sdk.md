# Agent SDK reference

`@helmstack/agent-sdk` is a TypeScript client for the [HTTP API](http-api.md). It runs on Node (it uses `node:http`) and is what the MCP server is built on.

**Prerequisites:** a running desktop app or daemon, and Node 20 or newer. The package is not on npm yet; import it from a clone (`packages/agent-sdk`, after `npm run build:packages`) or from the monorepo workspace as `@helmstack/agent-sdk`.

## Create a client

```ts
import { createBrowserClient } from "@helmstack/agent-sdk";

const browser = createBrowserClient({ port: 7070, agentId: "my-agent" });
console.log(await browser.health());
```

| Option | Default | Meaning |
| --- | --- | --- |
| `host` | `127.0.0.1` | Server host |
| `port` | `7070` | Server port |
| `timeout` | `30000` | Request timeout in ms |
| `authToken` | from the environment | Token to send |
| `agentId` | none | Sent as `X-Agent-ID`; attributes activity and scopes tab ownership (advisory, see [Security model](security-model.md)) |

When `authToken` is omitted the client uses `HELMSTACK_AUTH_TOKEN`, then reads the file named by `HELMSTACK_TOKEN_FILE`.

## Methods

Each method maps to one route in the [HTTP API reference](http-api.md); names mirror the MCP tools.

| Group | Methods |
| --- | --- |
| Tabs | `health`, `listTabs`, `openTab`, `navigate`, `reload`, `goBack`, `goForward`, `setViewport` |
| Perception | `getPerception`, `listManifests`, `savePerceptionSnapshot`, `diffPerception`, `listPerceptionSnapshots`, `deletePerceptionSnapshot` |
| Screenshots | `getScreenshot`, `getScreenshotBuffer`, `captureNamedScreenshot`, `diffScreenshots`, `mapRegionsToElements`, `listScreenshots`, `deleteScreenshot`, `captureViewportSuite` |
| Audits | `auditAccessibility`, `seoAudit`, `auditFocusOrder`, `detectLayoutIssues`, `getPerformanceMetrics`, `getHealthReport`, `captureCssCoverage`, `captureJsCoverage`, `captureTrace`, `captureMutationTimeline`, `getMediaState` |
| Styles and components | `inspectElementStyles`, `assertElementStyles`, `extractDesignTokens`, `captureComponentTree`, `captureComponentSources`, `detectFramework`, `captureThreeJsScene` |
| Assertions | `assert`, `watchAssertion`, `listAssertionWatches`, `removeAssertionWatch` |
| Environment | `setResourceBudget`, `setLocationOverride`, `setMediaEmulation`, `enableNetworkMock`, `disableNetworkMock`, `getNetworkMockRules` (and the matching `get`/`clear` methods) |
| Data | `getLogs`, `clearLogs`, `getHar`, `captureStorage`, `getStorage`, `setStorage`, `clearStorage`, `getCookies`, `setCookie`, `deleteCookie`, `clearCookies`, `listDownloads`, `setFileInputFiles` |
| Recording and patterns | `startRecording`, `stopRecording`, `getRecording`, `getSitePatterns`, `setSitePatterns`, `addSitePatterns`, `clearSitePatterns` |
| Human in the loop | `pickElement`, `getLatestPick`, `listPicks`, `listApprovals`, `approveCommand`, `rejectCommand`, `listHandoffs`, `resolveHandoff`, `cancelHandoff`, `waitForHandoffResolved` |
| Accounts (desktop) | `listAccounts`, `saveAccount`, `updateAccount`, `deleteAccount`, `lookupAccounts`, `generateTotp` |
| Misc | `execute` (send a `BrowserOutputCommand`), `getIntent`, `setIntent`, `log`, `stream` |

The class is the authority; see `packages/agent-sdk/src/index.ts` for signatures and the report types it returns.

## Errors

A non-2xx response throws `HelmstackHttpError` with `status`, `body` and `code` (the JSON body's `code`, for example `requires_human` or `unsupported_on_backend`). `getLatestPick` returns `null` when nothing is picked instead of throwing.

## Events

```ts
const handle = browser.stream({
  onApprovalQueued: (a) => console.log("needs a human:", a),
  onApprovalResolved: (r) => console.log(r.outcome),
  onElementPicked: (pick) => console.log(pick),
  onError: (e) => console.error(e)
});
// later
handle.close();
```

Handlers exist for tabs changed, page observed, approval queued and resolved, handoff requested and resolved, intent changed, agent log, assertion changed and element picked. The stream reconnects after 2 seconds when it drops.

## Example

Tested against the daemon:

```ts
const [tab] = await browser.listTabs();
await browser.navigate(tab.id, "http://127.0.0.1:4177/contact-form.html");
const report = await browser.auditAccessibility(tab.id);
console.log(report.score, report.violationCounts);
```

## Natural language assertions

`assert(tabId, "…")` (HTTP `POST /api/tabs/:id/assert`, MCP `browser_assert`) evaluates a sentence against the page's perception graph. There is no model call: the sentence is normalized and matched against a fixed grammar. Anything outside it returns `pass: false` with an "Unsupported assertion" explanation, so an unsupported sentence never passes.

Supported forms:

| Kind | Examples |
| --- | --- |
| Existence and counts | "the page has a heading", "exactly 2 forms", "at least 3 links", "there are no error messages", "there is a \"Sign in\" button" |
| Visibility | "the Save button is visible", "\"Payment failed\" is not shown" |
| State | "the Export button is disabled", "the email field is required" |
| Element text | "the main heading is \"Dashboard\"", "the error says \"Invalid\"" |
| Scoped | "the login form has 2 fields" |
| Page text | "the page shows \"Welcome back\"", "does not contain \"Error\"" |
| Title and URL | "the title contains \"Acme\"", "the URL ends with /login" |
| Page kind | "this is a login page" |
| Accessible names | "all buttons have accessible names" |

The result has `pass`, `confidence`, an `explanation`, the `evidence` it used and the `matched` items. `watchAssertion` registers the same sentence as a standing watch; changes arrive as `assertion_changed` events.

## Lite toolset

`@helmstack/agent-sdk/lite` (also re-exported from the root) exports `createLiteSession`, `LITE_TOOL_SCHEMAS` and helpers. See [Lite toolset](lite-toolset.md).

## Verify it worked

`await browser.health()` resolves to `{ status: "ok", ... }`. A wrong token rejects with `HelmstackHttpError` and `status` 401.
