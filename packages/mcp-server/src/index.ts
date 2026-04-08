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

const browser = createBrowserClient({ host, port });

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
    return { content: [{ type: "text", text: "logged" }] };
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
