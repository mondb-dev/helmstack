import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildMcpConfig, connectionLabel, mountConnection } from "../src/renderer/panels/connection.js";
import { flush, loadShellDom, status } from "./helpers/shell-fixtures.js";

describe("connectionLabel", () => {
  it("shows port and client count when listening", () => {
    expect(connectionLabel(status({ sseClients: 2 }))).toBe(":7070 · 2 clients");
    expect(connectionLabel(status({ sseClients: 0, agentIds: ["claude-code"] }))).toBe(":7070 · 1 client");
    expect(connectionLabel(status())).toBe(":7070 · 0 clients");
  });

  it("shows the error when not listening", () => {
    expect(connectionLabel(status({ listening: false, error: "port in use" }))).toBe(":7070 · port in use");
    expect(connectionLabel(status({ listening: false, port: null }))).toBe(":7070 · not listening");
  });
});

describe("buildMcpConfig", () => {
  it("runs @helmstack/mcp-server with the port and token file", () => {
    const config = JSON.parse(buildMcpConfig(status({ port: 7171 })));
    const server = config.mcpServers.helmstack;
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(["-y", "@helmstack/mcp-server"]);
    expect(server.env.HELMSTACK_PORT).toBe("7171");
    expect(server.env.HELMSTACK_TOKEN_FILE).toBe("/Users/dev/Library/Application Support/HelmStack/agent-token");
    expect(server.env.HELMSTACK_PROFILE).toBeUndefined();
  });

  it("omits the token file when not file-based and passes non-default profiles", () => {
    const env = JSON.parse(buildMcpConfig(status({ tokenPath: null, profile: "full" }))).mcpServers.helmstack.env;
    expect(env.HELMSTACK_TOKEN_FILE).toBeUndefined();
    expect(env.HELMSTACK_PROFILE).toBe("full");
  });

  it("falls back to port 7070 before status is known", () => {
    expect(JSON.parse(buildMcpConfig(null)).mcpServers.helmstack.env).toEqual({ HELMSTACK_PORT: "7070" });
  });
});

describe("connection indicator", () => {
  beforeEach(() => {
    loadShellDom();
  });

  const button = () => document.getElementById("connection-indicator")!;

  it("reflects listening vs error state", () => {
    const controller = mountConnection({ writeClipboard: vi.fn(async () => undefined) });
    controller.update(status({ sseClients: 1 }));
    expect(button().dataset.state).toBe("listening");
    expect(document.getElementById("connection-text")!.textContent).toBe(":7070 · 1 client");

    controller.update(status({ listening: false, error: "port 7070 in use" }));
    expect(button().dataset.state).toBe("error");
    expect(document.getElementById("connection-text")!.textContent).toBe(":7070 · port 7070 in use");
  });

  it("opens a popover with status, token path and profile, and copies the MCP config", async () => {
    const writeClipboard = vi.fn(async (_text: string) => undefined);
    const onPopoverOpen = vi.fn();
    const controller = mountConnection({ writeClipboard, onPopoverOpen });
    controller.update(status({ profile: "agent-substrate", agentIds: ["claude-code"] }));
    button().click();
    const panel = document.getElementById("connection-popover")!;
    expect(panel.hidden).toBe(false);
    expect(onPopoverOpen).toHaveBeenCalled();
    expect(panel.textContent).toContain("Listening on 127.0.0.1:7070");
    expect(panel.textContent).toContain("agent-token");
    expect(panel.textContent).toContain("Agent substrate");
    expect(panel.textContent).toContain("claude-code");

    document.getElementById("copy-mcp-config")!.click();
    await flush();
    expect(writeClipboard).toHaveBeenCalledTimes(1);
    const copied = JSON.parse(writeClipboard.mock.calls[0][0]);
    expect(copied.mcpServers.helmstack.env.HELMSTACK_PROFILE).toBe("agent-substrate");

    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(button());
  });
});
