#!/usr/bin/env node
/**
 * @helmstack/mcp-server
 *
 * Exposes the HelmStack browser substrate as MCP tools over stdio.
 * Any MCP-compatible client (Claude Desktop, Cursor, etc.) can use
 * these tools to drive a live browser session.
 *
 * Usage:
 *   node --experimental-strip-types packages/mcp-server/src/index.ts
 *
 * Configure in Claude Desktop (claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "helmstack": {
 *         "command": "node",
 *         "args": ["--experimental-strip-types", "/path/to/helmstack/packages/mcp-server/src/index.ts"],
 *         "env": { "HELMSTACK_PORT": "7070" }
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createBrowserClient } from "@helmstack/agent-sdk";

// ── Config ────────────────────────────────────────────────────────────────────

const port = Number(process.env.HELMSTACK_PORT ?? 7070);
const host = process.env.HELMSTACK_HOST ?? "127.0.0.1";
const authToken = process.env.HELMSTACK_AUTH_TOKEN || process.env.HELMSTACK_TOKEN;

const browser = createBrowserClient({ host, port, authToken });

const viewportPresetSchema = z.enum([
  "mobile-sm",
  "mobile",
  "mobile-lg",
  "tablet",
  "tablet-lg",
  "laptop",
  "desktop",
  "wide",
]);
const storageAreaSchema = z.enum(["local", "session"]);
const styleAssertionSchema = z.object({
  property: z.string().describe("CSS property, e.g. background-color or backgroundColor"),
  equals: z.union([z.string(), z.number()]).optional().describe("Expected exact CSS value. Hex colors are normalized for comparison."),
  contains: z.string().optional().describe("Substring expected in the computed value"),
  matches: z.string().optional().describe("Regular expression that the computed value must match"),
  not: z.union([z.string(), z.number()]).optional().describe("Value that the computed value must not equal"),
  min: z.number().optional().describe("Numeric minimum for values like px/rem/number"),
  max: z.number().optional().describe("Numeric maximum for values like px/rem/number"),
  tolerance: z.number().optional().describe("Numeric tolerance for equals comparisons"),
});

function jsonResult(data: unknown) {
  return {
    structuredContent: isPlainObject(data) ? data : { result: data },
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function okResult(data: Record<string, unknown> = { ok: true }) {
  return jsonResult(data);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "helmstack",
  version: "0.1.0",
});

// ── Tools ─────────────────────────────────────────────────────────────────────

// Health check
server.tool(
  "browser_health",
  "Check if the HelmStack browser substrate is running and how many tabs are open.",
  {},
  async () => {
    const result = await browser.health();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tabs
server.tool(
  "browser_list_tabs",
  "List all open browser tabs with their id, title, URL, and active status.",
  {},
  async () => {
    const tabs = await browser.listTabs();
    return { content: [{ type: "text", text: JSON.stringify(tabs, null, 2) }] };
  }
);

server.tool(
  "browser_open_tab",
  "Open a new browser tab, optionally navigating to a URL.",
  { url: z.string().url().optional().describe("URL to open in the new tab") },
  async ({ url }) => {
    const tabs = await browser.openTab(url);
    return { content: [{ type: "text", text: JSON.stringify(tabs, null, 2) }] };
  }
);

server.tool(
  "browser_navigate",
  "Navigate a specific tab to a URL.",
  {
    tabId: z.string().describe("Tab ID to navigate (from browser_list_tabs)"),
    url: z.string().url().describe("Destination URL"),
  },
  async ({ tabId, url }) => {
    const tabs = await browser.navigate(tabId, url);
    return { content: [{ type: "text", text: JSON.stringify(tabs, null, 2) }] };
  }
);

server.tool(
  "browser_set_viewport",
  "Resize a tab's viewport.",
  {
    tabId: z.string().describe("Tab ID"),
    width: z.number().int().positive().describe("Viewport width in pixels"),
    height: z.number().int().positive().describe("Viewport height in pixels"),
    mobile: z.boolean().optional().describe("Emulate mobile device (default: false)"),
  },
  async ({ tabId, width, height, mobile }) => {
    const result = await browser.setViewport(tabId, width, height, mobile ?? false);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Perception
server.tool(
  "browser_get_perception",
  "Get a structured perception of the current page: DOM graph, forms, fields, actions, and accessibility metadata. Use this to understand what is on screen before taking action.",
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => {
    const perception = await browser.getPerception(tabId);
    return { content: [{ type: "text", text: JSON.stringify(perception, null, 2) }] };
  }
);

server.tool(
  "browser_list_manifests",
  "List site capability manifests for a tab (available site-specific tools).",
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => {
    const manifests = await browser.listManifests(tabId);
    return { content: [{ type: "text", text: JSON.stringify(manifests, null, 2) }] };
  }
);

server.tool(
  "browser_screenshot",
  "Take a screenshot of a tab and return it as a base64 PNG image.",
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => {
    const shot = await browser.getScreenshot(tabId);
    return {
      content: [
        {
          type: "image",
          data: shot.data,
          mimeType: shot.mimeType,
        },
      ],
    };
  }
);

// Execution
server.tool(
  "browser_execute",
  `Execute a command on a tab. Use browser_get_perception first to discover available tool names and field IDs.

Common command types:
- invoke_site_tool: Run a named DOM tool (e.g. dom.fill.form-1, dom.click.button-1)
  args: { provider: "dom", toolName: "<tool>", args: { "<fieldId>": "<value>", ... } }
- click: Click an element by selector
  args: { selector: "<css-selector>" }
- type: Type text into the focused element
  args: { text: "<text>" }`,
  {
    tabId: z.string().describe("Tab ID"),
    command: z
      .object({
        type: z.string().describe("Command type (e.g. invoke_site_tool, click, type)"),
        provider: z.string().optional(),
        toolName: z.string().optional(),
        args: z.record(z.unknown()).optional(),
        selector: z.string().optional(),
        text: z.string().optional(),
      })
      .describe("Browser command to execute"),
  },
  async ({ tabId, command }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await browser.execute(tabId, command as any);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Approvals
server.tool(
  "browser_list_approvals",
  "List pending approval requests waiting for human confirmation.",
  {},
  async () => {
    const approvals = await browser.listApprovals();
    return { content: [{ type: "text", text: JSON.stringify(approvals, null, 2) }] };
  }
);

server.tool(
  "browser_approve",
  "Approve a pending command that requires human confirmation.",
  { requestId: z.string().describe("Approval request ID") },
  async ({ requestId }) => {
    const result = await browser.approveCommand(requestId);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "browser_reject",
  "Reject a pending command that requires human confirmation.",
  { requestId: z.string().describe("Approval request ID") },
  async ({ requestId }) => {
    const result = await browser.rejectCommand(requestId);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Handoffs
server.tool(
  "browser_list_handoffs",
  "List pending human handoff requests (tasks that require a human to take over).",
  {},
  async () => {
    const handoffs = await browser.listHandoffs();
    return { content: [{ type: "text", text: JSON.stringify(handoffs, null, 2) }] };
  }
);

server.tool(
  "browser_resolve_handoff",
  "Mark a human handoff as resolved, returning control to the agent.",
  { requestId: z.string().describe("Handoff request ID") },
  async ({ requestId }) => {
    const result = await browser.resolveHandoff(requestId);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Accounts (credential vault)
server.tool(
  "browser_list_accounts",
  "List saved accounts (credential entries) stored in the vault.",
  {},
  async () => {
    const accounts = await browser.listAccounts();
    return { content: [{ type: "text", text: JSON.stringify(accounts, null, 2) }] };
  }
);

server.tool(
  "browser_lookup_accounts",
  "Look up saved accounts matching a given origin (e.g. https://github.com).",
  { origin: z.string().describe("Origin URL to look up credentials for") },
  async ({ origin }) => {
    const accounts = await browser.lookupAccounts(origin);
    return { content: [{ type: "text", text: JSON.stringify(accounts, null, 2) }] };
  }
);

server.tool(
  "browser_generate_totp",
  "Generate a TOTP code for an account that has 2FA configured.",
  { accountId: z.string().describe("Account ID") },
  async ({ accountId }) => {
    const result = await browser.generateTotp(accountId);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Intent
server.tool(
  "browser_get_intent",
  "Get the current agent intent/task set in the HelmStack UI.",
  {},
  async () => {
    const result = await browser.getIntent();
    return { content: [{ type: "text", text: result.intent }] };
  }
);

server.tool(
  "browser_set_intent",
  "Set the agent intent/task displayed in the HelmStack UI.",
  { intent: z.string().describe("Intent or task description") },
  async ({ intent }) => {
    const result = await browser.setIntent(intent);
    return { content: [{ type: "text", text: result.intent }] };
  }
);

server.tool(
  "browser_log",
  "Write a message to the HelmStack terminal panel in the UI.",
  {
    message: z.string().describe("Message to log"),
    level: z
      .enum(["system", "agent", "ai", "error", "nav"])
      .optional()
      .describe("Log level (default: agent)"),
  },
  async ({ message, level }) => {
    await browser.log(message, level ?? "agent");
    return okResult({ ok: true, logged: message });
  }
);

server.tool(
  "browser_get_tab_logs",
  "Return buffered console logs, network requests (with headers, SSL details, cache status), WebSocket frames, EventSource events, and JS errors captured for a tab since it was last cleared.",
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => {
    const logs = await browser.getLogs(tabId);
    return jsonResult(logs);
  }
);

server.tool(
  "browser_clear_tab_logs",
  "Clear buffered console, network, WebSocket, EventSource, and JS error logs for a tab.",
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => {
    await browser.clearLogs(tabId);
    return okResult();
  }
);

server.tool(
  "browser_network_audit",
  `Produce a focused network/security audit for a tab. Returns per-request data useful for auditing:
- Response headers (Cache-Control, Content-Security-Policy, Strict-Transport-Security, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, etc.)
- TLS/SSL version, cipher suite, certificate issuer, and validity window
- Whether the response was served from disk cache or a Service Worker
- HTTP status codes and failed requests

Use this after navigating to a page to audit its security posture and caching configuration.`,
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => {
    const logs = await browser.getLogs(tabId);
    const audit = logs.networkRequests.map((r) => ({
      url: r.url,
      method: r.method,
      status: r.statusCode,
      mimeType: r.mimeType,
      failed: r.failed,
      errorText: r.errorText,
      fromDiskCache: r.fromDiskCache,
      fromServiceWorker: r.fromServiceWorker,
      tls: r.securityDetails
        ? {
            protocol: r.securityDetails.protocol,
            cipher: r.securityDetails.cipher,
            keyExchange: r.securityDetails.keyExchange,
            issuer: r.securityDetails.issuer,
            subject: r.securityDetails.subjectName,
            validFrom: new Date(r.securityDetails.validFrom * 1000).toISOString(),
            validTo: new Date(r.securityDetails.validTo * 1000).toISOString(),
            sans: r.securityDetails.sanList,
          }
        : null,
      securityHeaders: r.responseHeaders
        ? Object.fromEntries(
            Object.entries(r.responseHeaders).filter(([k]) =>
              [
                "cache-control",
                "content-security-policy",
                "strict-transport-security",
                "x-frame-options",
                "x-content-type-options",
                "referrer-policy",
                "permissions-policy",
                "cross-origin-opener-policy",
                "cross-origin-embedder-policy",
                "cross-origin-resource-policy",
                "access-control-allow-origin",
                "set-cookie",
              ].includes(k.toLowerCase())
            )
          )
        : null,
      allResponseHeaders: r.responseHeaders ?? null,
    }));
    return jsonResult({ requests: audit });
  }
);

server.tool(
  "browser_get_network_mock",
  "Return the currently active network mock/intercept rules for a tab.",
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => jsonResult(await browser.getNetworkMockRules(tabId))
);

server.tool(
  "browser_enable_network_mock",
  "Enable network request mocking for a tab. Matching requests are fulfilled with the provided response; non-matching requests pass through.",
  {
    tabId: z.string().describe("Tab ID"),
    rules: z
      .array(
        z.object({
          urlPattern: z.string().describe("URL glob pattern with * wildcards, or /regex/flags"),
          method: z.string().optional().describe("HTTP method to match"),
          responseStatus: z.number().int().positive().optional().describe("HTTP status code to return"),
          responseHeaders: z.record(z.string()).optional().describe("Response headers to return"),
          responseBody: z.unknown().optional().describe("Response body; objects are JSON serialized"),
        })
      )
      .describe("Mock rules"),
  },
  async ({ tabId, rules }) => jsonResult(await browser.enableNetworkMock(tabId, rules))
);

server.tool(
  "browser_disable_network_mock",
  "Disable network mocking for a tab and restore normal request handling.",
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => jsonResult(await browser.disableNetworkMock(tabId))
);

server.tool(
  "browser_capture_named_screenshot",
  "Capture a screenshot and store it in HelmStack's in-memory screenshot cache under a snapshot ID.",
  {
    tabId: z.string().describe("Tab ID"),
    snapshotId: z.string().describe("Name for the cached screenshot"),
  },
  async ({ tabId, snapshotId }) => jsonResult(await browser.captureNamedScreenshot(tabId, snapshotId))
);

server.tool(
  "browser_diff_screenshots",
  "Compare two named screenshots pixel-by-pixel and return changed regions plus a base64 diff image.",
  {
    beforeId: z.string().describe("Earlier screenshot ID"),
    afterId: z.string().describe("Later screenshot ID"),
  },
  async ({ beforeId, afterId }) => jsonResult(await browser.diffScreenshots(beforeId, afterId))
);

server.tool(
  "browser_list_screenshots",
  "List named screenshots currently held in HelmStack's in-memory cache.",
  {},
  async () => jsonResult(await browser.listScreenshots())
);

server.tool(
  "browser_delete_screenshot",
  "Delete a named screenshot from HelmStack's in-memory cache.",
  { id: z.string().describe("Screenshot ID") },
  async ({ id }) => {
    await browser.deleteScreenshot(id);
    return okResult({ ok: true, deleted: id });
  }
);

server.tool(
  "browser_viewport_suite",
  "Capture screenshots at multiple responsive viewport presets, optionally including pairwise visual diffs.",
  {
    tabId: z.string().describe("Tab ID"),
    presets: z.array(viewportPresetSchema).optional().describe("Viewport presets to capture"),
    includeDiffs: z.boolean().optional().describe("Include pairwise visual diffs"),
  },
  async ({ tabId, presets, includeDiffs }) => jsonResult(await browser.captureViewportSuite(tabId, presets, includeDiffs ?? false))
);

server.tool(
  "browser_performance",
  "Capture Core Web Vitals, navigation timing, slow resources, and raw CDP performance metrics for a tab.",
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => jsonResult(await browser.getPerformanceMetrics(tabId))
);

server.tool(
  "browser_a11y_audit",
  `Run a comprehensive WCAG 2.2 accessibility audit against the live accessibility tree and DOM.

Returns:
- score: 0–100 (100 = zero violations, weighted by severity)
- violations: per-node violations with selector, description, and specific remediation guidance
- violationCounts: critical / serious / moderate / minor counts
- byPrinciple: counts split across Perceivable / Operable / Understandable / Robust
- violatedRules: deduplicated rule summaries ordered by severity
- recommendations: ordered plain-English action items

Rules checked (WCAG level in parentheses):
- 1.1.1 (A)  Images must have a non-empty accessible name
- 1.3.1 (A)  Form inputs must have an accessible label
- 1.3.1 (A)  Table header cells must have a name
- 2.4.2 (A)  Page must have a descriptive <title>
- 2.4.3 (A)  Heading levels must not skip ranks
- 2.4.4 (A)  Link text must be meaningful out of context
- 2.4.6 (AA) Buttons must have an accessible name
- 2.4.6 (AA) Links must have an accessible name
- 3.1.1 (A)  HTML element must have a lang attribute
- 4.1.2 (A)  ARIA widget roles must include required state attributes (aria-checked, aria-expanded, etc.)
- 4.1.3 (AA) Disabled controls must still have an accessible name`,
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => jsonResult(await browser.auditAccessibility(tabId))
);

server.tool(
  "browser_inspect_element_styles",
  `Inspect computed styles and layout diagnostics for elements matching a CSS selector.

Returns matched elements with:
- computed CSS properties (color, typography, spacing, layout, border, overflow, z-index, etc.)
- bounding rect and box model (margin, border, padding, content size)
- text contrast ratio and WCAG AA pass/fail
- issue flags for invisibility, offscreen placement, clipped content, small tap targets, pointer-events:none, high z-index, and fixed/sticky positioning`,
  {
    tabId: z.string().describe("Tab ID"),
    selector: z.string().describe("CSS selector to inspect"),
    limit: z.number().int().positive().max(100).optional().describe("Maximum matched elements to inspect; default 20"),
  },
  async ({ tabId, selector, limit }) => jsonResult(await browser.inspectElementStyles(tabId, selector, { limit }))
);

server.tool(
  "browser_assert_element_styles",
  `Assert computed CSS styles for all elements matching a selector.

Each assertion supports:
- equals: exact value, with hex color normalization and optional numeric tolerance
- contains: substring match
- matches: regular expression match
- not: disallowed exact value
- min/max: numeric thresholds for CSS lengths or numeric values`,
  {
    tabId: z.string().describe("Tab ID"),
    selector: z.string().describe("CSS selector to check"),
    assertions: z.array(styleAssertionSchema).describe("Style assertions to run against each matched element"),
    limit: z.number().int().positive().max(100).optional().describe("Maximum matched elements to inspect; default 20"),
  },
  async ({ tabId, selector, assertions, limit }) =>
    jsonResult(await browser.assertElementStyles(tabId, selector, assertions, { limit, throw: false }))
);

server.tool(
  "browser_component_tree",
  "Capture a React, Vue, or Svelte component tree when framework dev hooks are exposed on the page.",
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => jsonResult(await browser.captureComponentTree(tabId))
);

server.tool(
  "browser_threejs_scene",
  "Inspect a live Three.js scene graph, renderer stats, materials, and an FPS estimate.",
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => jsonResult(await browser.captureThreeJsScene(tabId))
);

server.tool(
  "browser_assert",
  "Evaluate a natural-language assertion against the current page graph and return evidence.",
  {
    tabId: z.string().describe("Tab ID"),
    assertion: z.string().describe("Assertion to evaluate, e.g. 'the cart shows 3 items'"),
  },
  async ({ tabId, assertion }) => jsonResult(await browser.assert(tabId, assertion, { throw: false }))
);

server.tool(
  "browser_get_recording",
  "Return the current command recording session for a tab, if recording is active.",
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => jsonResult(await browser.getRecording(tabId))
);

server.tool(
  "browser_start_recording",
  "Start recording commands executed against a tab.",
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => jsonResult(await browser.startRecording(tabId))
);

server.tool(
  "browser_stop_recording",
  "Stop recording commands for a tab and return a replayable script.",
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => jsonResult(await browser.stopRecording(tabId))
);

server.tool(
  "browser_get_site_patterns",
  "Return saved site patterns for the current origin of a tab.",
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => jsonResult(await browser.getSitePatterns(tabId))
);

server.tool(
  "browser_add_site_patterns",
  "Add site patterns for the current origin of a tab.",
  {
    tabId: z.string().describe("Tab ID"),
    patterns: z.array(z.string()).describe("Patterns to add"),
  },
  async ({ tabId, patterns }) => jsonResult(await browser.addSitePatterns(tabId, patterns))
);

server.tool(
  "browser_set_site_patterns",
  "Replace site patterns for the current origin of a tab.",
  {
    tabId: z.string().describe("Tab ID"),
    patterns: z.array(z.string()).describe("Replacement pattern list"),
  },
  async ({ tabId, patterns }) => jsonResult(await browser.setSitePatterns(tabId, patterns))
);

server.tool(
  "browser_clear_site_patterns",
  "Clear saved site patterns for the current origin of a tab.",
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => {
    await browser.clearSitePatterns(tabId);
    return okResult();
  }
);

server.tool(
  "browser_set_file_input_files",
  "Set files on a file input matching a CSS selector.",
  {
    tabId: z.string().describe("Tab ID"),
    selector: z.string().describe("CSS selector for the file input"),
    files: z.array(z.string()).describe("Absolute file paths to attach"),
  },
  async ({ tabId, selector, files }) => jsonResult(await browser.setFileInputFiles(tabId, { selector, files }))
);

server.tool(
  "browser_list_downloads",
  "List downloads tracked for a tab.",
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => jsonResult(await browser.listDownloads(tabId))
);

server.tool(
  "browser_clear_downloads",
  "Clear tracked download records for a tab.",
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => {
    await browser.clearDownloads(tabId);
    return okResult();
  }
);

server.tool(
  "browser_get_resource_budget",
  "Return the current CPU/network/heap resource budget for a tab.",
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => jsonResult(await browser.getResourceBudget(tabId))
);

server.tool(
  "browser_set_resource_budget",
  "Set CPU/network/heap resource constraints for a tab.",
  {
    tabId: z.string().describe("Tab ID"),
    budget: z.object({
      cpuThrottlingRate: z.number().optional(),
      downloadThroughputKbps: z.number().optional(),
      uploadThroughputKbps: z.number().optional(),
      latencyMs: z.number().optional(),
      offline: z.boolean().optional(),
      maxJsHeapMb: z.number().optional(),
    }),
  },
  async ({ tabId, budget }) => jsonResult(await browser.setResourceBudget(tabId, budget))
);

server.tool(
  "browser_clear_resource_budget",
  "Clear CPU/network/heap resource constraints for a tab.",
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => {
    await browser.clearResourceBudget(tabId);
    return okResult();
  }
);

server.tool(
  "browser_get_location_override",
  "Return the current geolocation/timezone/locale override for a tab.",
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => jsonResult(await browser.getLocationOverride(tabId))
);

server.tool(
  "browser_set_location_override",
  "Set a geolocation/timezone/locale override for a tab.",
  {
    tabId: z.string().describe("Tab ID"),
    latitude: z.number(),
    longitude: z.number(),
    accuracy: z.number().optional(),
    timezoneId: z.string().optional(),
    locale: z.string().optional(),
  },
  async ({ tabId, latitude, longitude, accuracy, timezoneId, locale }) =>
    jsonResult(await browser.setLocationOverride(tabId, { latitude, longitude, accuracy, timezoneId, locale }))
);

server.tool(
  "browser_clear_location_override",
  "Clear geolocation/timezone/locale overrides for a tab.",
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => {
    await browser.clearLocationOverride(tabId);
    return okResult();
  }
);

server.tool(
  "browser_capture_storage",
  "Capture localStorage, sessionStorage, cookies, and IndexedDB for the tab's current origin.",
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => jsonResult(await browser.captureStorage(tabId))
);

server.tool(
  "browser_get_storage",
  "Read localStorage or sessionStorage entries for a tab.",
  {
    tabId: z.string().describe("Tab ID"),
    area: storageAreaSchema,
    key: z.string().optional().describe("Optional key to read"),
  },
  async ({ tabId, area, key }) => jsonResult(await browser.getStorage(tabId, area, key))
);

server.tool(
  "browser_set_storage",
  "Write localStorage or sessionStorage entries for a tab.",
  {
    tabId: z.string().describe("Tab ID"),
    area: storageAreaSchema,
    entries: z.record(z.string()).describe("String key/value pairs"),
  },
  async ({ tabId, area, entries }) => {
    await browser.setStorage(tabId, area, entries);
    return okResult();
  }
);

server.tool(
  "browser_clear_storage",
  "Clear localStorage or sessionStorage for a tab, optionally limited to specific keys.",
  {
    tabId: z.string().describe("Tab ID"),
    area: storageAreaSchema,
    keys: z.array(z.string()).optional().describe("Keys to remove; omit to clear the whole area"),
  },
  async ({ tabId, area, keys }) => {
    await browser.clearStorage(tabId, area, keys);
    return okResult();
  }
);

server.tool(
  "browser_get_cookies",
  "List cookies for the tab's current origin.",
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => jsonResult(await browser.getCookies(tabId))
);

server.tool(
  "browser_set_cookie",
  "Set or update a cookie for the tab's current origin.",
  {
    tabId: z.string().describe("Tab ID"),
    name: z.string(),
    value: z.string(),
    domain: z.string().optional(),
    path: z.string().optional(),
    httpOnly: z.boolean().optional(),
    secure: z.boolean().optional(),
    sameSite: z.enum(["Strict", "Lax", "None", ""]).optional(),
    expires: z.number().nullable().optional().describe("Epoch milliseconds; null for session cookie"),
  },
  async ({ tabId, name, value, domain, path, httpOnly, secure, sameSite, expires }) => {
    await browser.setCookie(tabId, { name, value, domain, path, httpOnly, secure, sameSite, expires });
    return okResult();
  }
);

server.tool(
  "browser_delete_cookie",
  "Delete a cookie by name for the tab's current origin, or for an explicit URL.",
  {
    tabId: z.string().describe("Tab ID"),
    name: z.string(),
    url: z.string().url().optional(),
  },
  async ({ tabId, name, url }) => {
    await browser.deleteCookie(tabId, name, url);
    return okResult({ ok: true, deleted: name });
  }
);

server.tool(
  "browser_clear_cookies",
  "Clear all cookies for the tab's current origin.",
  { tabId: z.string().describe("Tab ID") },
  async ({ tabId }) => {
    await browser.clearCookies(tabId);
    return okResult();
  }
);

server.tool(
  "browser_save_perception_snapshot",
  "Capture and cache the current semantic PageGraph under a snapshot ID.",
  {
    tabId: z.string().describe("Tab ID"),
    snapshotId: z.string().describe("Name for the cached perception snapshot"),
  },
  async ({ tabId, snapshotId }) => jsonResult(await browser.savePerceptionSnapshot(tabId, snapshotId))
);

server.tool(
  "browser_diff_perception",
  "Compare two named perception snapshots and return structural changes.",
  {
    beforeId: z.string().describe("Earlier perception snapshot ID"),
    afterId: z.string().describe("Later perception snapshot ID"),
  },
  async ({ beforeId, afterId }) => jsonResult(await browser.diffPerception(beforeId, afterId))
);

server.tool(
  "browser_list_perception_snapshots",
  "List cached named perception snapshots.",
  {},
  async () => jsonResult(await browser.listPerceptionSnapshots())
);

server.tool(
  "browser_delete_perception_snapshot",
  "Delete a named perception snapshot from the in-memory cache.",
  { id: z.string().describe("Perception snapshot ID") },
  async ({ id }) => {
    await browser.deletePerceptionSnapshot(id);
    return okResult({ ok: true, deleted: id });
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
