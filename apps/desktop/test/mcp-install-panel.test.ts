import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpClientStatus, McpInstallOverview, McpInstallResult } from "../../../packages/shared/src/index.js";
import { mountConnection } from "../src/renderer/panels/connection.js";
import { CHATGPT_NOTE, mountMcpInstall } from "../src/renderer/panels/mcp-install.js";
import { createFakeBridge, flush, loadShellDom, status } from "./helpers/shell-fixtures.js";

const client = (over: Partial<McpClientStatus> & { id: McpClientStatus["id"] }): McpClientStatus => ({
  label: over.id,
  kind: "cli",
  detected: true,
  installed: false,
  needsAttention: false,
  canInstall: true,
  provenance: "verified-cli",
  ...over
});

const overview = (over: Partial<McpInstallOverview> = {}): McpInstallOverview => ({
  ready: true,
  port: 7070,
  tokenFile: "/h/agent-token",
  profile: "fe-dev",
  sources: [
    { id: "bundled", label: "HelmStack's bundled MCP server", available: true, commandLine: "/usr/bin/node /app/helmstack-mcp.mjs", warnings: ["Inside the app bundle."] },
    { id: "npx", label: "npx @helmstack/mcp-server", available: false, reason: "Package not published yet.", warnings: [] }
  ],
  clients: [
    client({ id: "claude-code", label: "Claude Code", version: "2.1.12" }),
    client({ id: "gemini-cli", label: "Gemini CLI", installed: true, needsAttention: true, note: "It points at port 7070; this HelmStack is on 7171." }),
    client({ id: "cursor", label: "Cursor", kind: "json-file", detected: false, canInstall: false, configPath: "/h/.cursor/mcp.json", provenance: "docs-only" }),
    client({ id: "generic", label: "Other client (copy JSON)", kind: "copy-only", canInstall: false }),
    client({ id: "chatgpt", label: "ChatGPT", kind: "explainer", detected: false, canInstall: false })
  ],
  ...over
});

const preview = (change: "add" | "update" | "remove" | "none" = "add") => ({
  previewId: "a".repeat(32),
  kind: "command" as const,
  change,
  commandLine: "claude mcp add helmstack -s user -e HELMSTACK_PORT=7070 -- /usr/bin/node /app/helmstack-mcp.mjs",
  diff: '@@ mcpServers.helmstack @@\n+ "command": "/usr/bin/node"',
  copyText: "claude mcp add helmstack …",
  warnings: ["Inside the app bundle."]
});

function setup(run: (req: never) => McpInstallResult | Promise<McpInstallResult>, ov = overview()) {
  loadShellDom();
  const fake = createFakeBridge({ getMcpInstallOverview: () => ov, runMcpInstall: run as never });
  const writeClipboard = vi.fn(async () => undefined);
  const controller = mountMcpInstall({ bridge: fake.bridge, writeClipboard });
  return { fake, controller, writeClipboard };
}
const row = (id: string) => document.querySelector<HTMLElement>(`[data-client="${id}"]`) as HTMLElement;
const action = (id: string, name: string) => row(id).querySelector<HTMLButtonElement>(`[data-action="${name}"]`);

describe("Connect an agent dialog", () => {
  beforeEach(() => document.body.replaceChildren());

  it("lists clients with state badges, an explainer for ChatGPT and gates npx", async () => {
    const { controller } = setup(() => ({ ok: true, clientId: "claude-code", action: "preview", message: "" }));
    await controller.open();
    await flush();
    expect(document.getElementById("mcp-install-modal")?.hidden).toBe(false);
    expect(row("claude-code").textContent).toContain("Detected");
    expect(row("gemini-cli").textContent).toContain("Needs attention");
    expect(row("gemini-cli").textContent).toContain("port 7070");
    expect(row("cursor").textContent).toContain("Not found");
    expect(action("cursor", "install")?.disabled).toBe(true);
    expect(action("claude-code", "install")?.textContent).toBe("Install");
    expect(action("gemini-cli", "install")?.textContent).toBe("Update");
    expect(action("gemini-cli", "remove")).not.toBeNull();
    // ChatGPT: explainer, no buttons at all.
    expect(row("chatgpt").textContent).toContain(CHATGPT_NOTE.slice(0, 40));
    expect(row("chatgpt").querySelectorAll("button")).toHaveLength(0);
    // npx is disabled with the reason; bundled is selected.
    const radios = [...document.querySelectorAll<HTMLInputElement>('input[name="mcp-source"]')];
    expect(radios.map((r) => [r.value, r.disabled, r.checked])).toEqual([["bundled", false, true], ["npx", true, false]]);
    expect(document.body.textContent).toContain("Package not published yet.");
  });

  it("shows the exact command first and only runs after Confirm", async () => {
    const run = vi.fn(async (req: { action: string; options?: { confirm?: string } }): Promise<McpInstallResult> => {
      if (!req.options?.confirm) return { ok: true, clientId: "claude-code", action: "install", message: "Review", needsConfirmation: true, preview: preview() };
      return { ok: true, clientId: "claude-code", action: "install", message: "Installed helmstack in Claude Code.", status: client({ id: "claude-code", label: "Claude Code", installed: true }) };
    });
    const { controller } = setup(run as never);
    await controller.open();
    await flush();
    action("claude-code", "install")?.click();
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toMatchObject({ clientId: "claude-code", action: "install", options: { toolset: "full" } });
    expect(run.mock.calls[0][0].options?.confirm).toBeUndefined();
    const box = row("claude-code").querySelector('[data-role="preview"]') as HTMLElement;
    expect(box.querySelector('[data-role="command"]')?.textContent).toContain("claude mcp add helmstack -s user");
    expect(box.querySelector('[data-role="diff"]')?.textContent).toContain("@@ mcpServers.helmstack @@");
    expect(document.activeElement).toBe(box);

    (box.querySelector('[data-action="confirm"]') as HTMLButtonElement).click();
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0].options?.confirm).toBe("a".repeat(32));
    expect(row("claude-code").textContent).toContain("Installed");
    expect(row("claude-code").querySelector('[data-role="preview"]')).toBeNull();
  });

  it("cancel runs nothing, and the compact-tools checkbox changes the requested toolset", async () => {
    const run = vi.fn(async (): Promise<McpInstallResult> => ({ ok: true, clientId: "claude-code", action: "install", message: "Review", needsConfirmation: true, preview: preview() }));
    const { controller } = setup(run as never);
    await controller.open();
    await flush();
    const lite = document.getElementById("mcp-toolset-lite") as HTMLInputElement;
    lite.checked = true;
    lite.dispatchEvent(new Event("change"));
    action("claude-code", "install")?.click();
    await flush();
    expect((run.mock.calls[0] as unknown as [{ options: { toolset: string } }])[0].options.toolset).toBe("lite");
    (row("claude-code").querySelector('[data-action="cancel"]') as HTMLButtonElement).click();
    expect(row("claude-code").querySelector('[data-role="preview"]')).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("surfaces errors inline, copies config and verifies", async () => {
    const run = vi.fn(async (req: { action: string }): Promise<McpInstallResult> => {
      if (req.action === "preview") return { ok: true, clientId: "claude-code", action: "preview", message: "", preview: { ...preview(), copyText: '{"mcpServers":{}}' } };
      if (req.action === "verify") return { ok: true, clientId: "claude-code", action: "verify", message: "helmstack is not registered in Claude Code.", registered: false };
      return { ok: false, clientId: "claude-code", action: "install", message: "boom" };
    });
    const { controller, writeClipboard } = setup(run as never);
    await controller.open();
    await flush();
    action("claude-code", "copy")?.click();
    await flush();
    expect(writeClipboard).toHaveBeenCalledWith('{"mcpServers":{}}');
    expect(row("claude-code").textContent).toContain("Config copied");
    action("claude-code", "verify")?.click();
    await flush();
    expect(row("claude-code").textContent).toContain("not registered");
    expect(row("claude-code").querySelector(".status-inline--fail")).not.toBeNull();
  });

  it("blocks installs with the reason when the agent API isn't ready, but keeps the explainer", async () => {
    const blocked = overview({ ready: false, blockedReason: "The agent API isn't listening." });
    const { controller } = setup(() => ({ ok: false, clientId: "claude-code", action: "preview", message: "" }), blocked);
    await controller.open();
    await flush();
    expect(document.querySelector('[data-role="blocked"]')?.textContent).toContain("isn't listening");
    expect(action("claude-code", "install")?.disabled).toBe(true);
    expect(action("claude-code", "copy")?.disabled).toBe(true);
  });

  it("closes on Escape and traps focus inside the dialog", async () => {
    const onClose = vi.fn();
    loadShellDom();
    const fake = createFakeBridge({ getMcpInstallOverview: () => overview() });
    const controller = mountMcpInstall({ bridge: fake.bridge, onClose });
    await controller.open();
    await flush();
    const modal = document.getElementById("mcp-install-modal") as HTMLElement;
    modal.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(modal.hidden).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("connection popover entry point", () => {
  it("shows 'Connect agents…' and calls back after closing the popover", () => {
    loadShellDom();
    const onConnectAgents = vi.fn();
    const connection = mountConnection({ onConnectAgents });
    connection.update(status());
    const button = document.getElementById("connect-agents") as HTMLButtonElement;
    expect(button.textContent).toBe("Connect agents…");
    button.click();
    expect(onConnectAgents).toHaveBeenCalledTimes(1);
  });

  it("is available even when the agent API is off (the dialog explains why)", () => {
    loadShellDom();
    const connection = mountConnection({ onConnectAgents: () => undefined });
    connection.update(status({ listening: false, port: null }));
    expect(document.getElementById("connect-agents")).not.toBeNull();
  });
});
