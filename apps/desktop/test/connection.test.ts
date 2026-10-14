import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTH_TOKEN_PLACEHOLDER,
  buildMcpConfig,
  connectionLabel,
  livePort,
  mountConnection,
} from "../src/renderer/panels/connection.js";
import { flush, loadShellDom, status } from "./helpers/shell-fixtures.js";

const parse = (text: string | null) => {
  expect(text).not.toBeNull();
  return JSON.parse(text as string);
};

describe("connectionLabel", () => {
  it("shows port and client count when listening", () => {
    expect(connectionLabel(status({ sseClients: 2 }))).toBe(":7070 · 2 clients");
    expect(connectionLabel(status({ sseClients: 0, agentIds: ["claude-code"] }))).toBe(":7070 · 1 client");
    expect(connectionLabel(status({ port: 7171 }))).toBe(":7171 · 0 clients");
  });

  it("shows a compact 'off' label — never a guessed port or the raw error — when not listening", () => {
    expect(connectionLabel(status({ listening: false, port: null, error: "listen EADDRINUSE: address already in use 127.0.0.1:7070" }))).toBe(
      "Agent API off"
    );
    expect(connectionLabel(status({ listening: false, port: 7070, error: "port in use" }))).toBe("Agent API off");
    expect(connectionLabel(status({ listening: true, port: null }))).toBe("Agent API off");
    expect(connectionLabel(null)).toBe("Checking…");
  });

  it("livePort is null unless the server is listening on a known port", () => {
    expect(livePort(status({ port: 7171 }))).toBe(7171);
    expect(livePort(status({ listening: false, port: 7070 }))).toBeNull();
    expect(livePort(status({ port: null }))).toBeNull();
    expect(livePort(null)).toBeNull();
  });
});

describe("buildMcpConfig", () => {
  it("runs @helmstack/mcp-server with the live port and token file", () => {
    const config = parse(buildMcpConfig(status({ port: 7171 })));
    const server = config.mcpServers.helmstack;
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(["-y", "@helmstack/mcp-server"]);
    expect(server.env.HELMSTACK_PORT).toBe("7171");
    expect(server.env.HELMSTACK_TOKEN_FILE).toBe("/Users/dev/Library/Application Support/HelmStack/agent-token");
    expect(server.env.HELMSTACK_AUTH_TOKEN).toBeUndefined();
    expect(server.env.HELMSTACK_PROFILE).toBeUndefined();
  });

  it("uses a HELMSTACK_AUTH_TOKEN placeholder when the token isn't file-based, and passes non-default profiles", () => {
    const env = parse(buildMcpConfig(status({ tokenPath: null, profile: "full" }))).mcpServers.helmstack.env;
    expect(env.HELMSTACK_TOKEN_FILE).toBeUndefined();
    expect(env.HELMSTACK_AUTH_TOKEN).toBe(AUTH_TOKEN_PLACEHOLDER);
    expect(env.HELMSTACK_AUTH_TOKEN).toBe("<paste your token>");
    expect(env.HELMSTACK_PROFILE).toBe("full");
  });

  it("produces nothing while the agent API isn't listening (or status is unknown)", () => {
    expect(buildMcpConfig(null)).toBeNull();
    expect(buildMcpConfig(status({ listening: false, port: null, error: "port in use" }))).toBeNull();
    expect(buildMcpConfig(status({ listening: false, port: 7070 }))).toBeNull();
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

    controller.update(status({ listening: false, port: null, error: "port 7070 in use" }));
    expect(button().dataset.state).toBe("error");
    expect(document.getElementById("connection-text")!.textContent).toBe("Agent API off");
    expect(button().title).toContain("port 7070 in use");
  });

  it("when not listening: full error in the popover, copy disabled with an explanation, no port anywhere", async () => {
    const writeClipboard = vi.fn(async (_text: string) => undefined);
    const controller = mountConnection({ writeClipboard });
    controller.update(status({ listening: false, port: null, error: "listen EADDRINUSE 127.0.0.1:7070" }));
    button().click();
    const panel = document.getElementById("connection-popover")!;
    expect(panel.textContent).toContain("Not listening — listen EADDRINUSE 127.0.0.1:7070");
    expect(document.getElementById("mcp-config-snippet")).toBeNull();
    expect(panel.textContent).not.toContain("HELMSTACK_PORT");

    const copy = document.getElementById("copy-mcp-config") as HTMLButtonElement;
    expect(copy.disabled).toBe(true);
    const reasonId = copy.getAttribute("aria-describedby")!;
    expect(document.getElementById(reasonId)!.textContent).toMatch(/isn't listening/);
    copy.click();
    await flush();
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  it("explains where an env-provided token comes from, with a placeholder (never a real token)", () => {
    const controller = mountConnection({ writeClipboard: vi.fn(async () => undefined) });
    controller.update(status({ tokenPath: null }));
    const snippet = document.getElementById("mcp-config-snippet")!.textContent!;
    expect(JSON.parse(snippet).mcpServers.helmstack.env.HELMSTACK_AUTH_TOKEN).toBe("<paste your token>");
    expect(document.getElementById("mcp-token-note")!.textContent).toContain("HELMSTACK_AUTH_TOKEN");
    expect(document.getElementById("connection-popover")!.textContent).toContain("From HELMSTACK_AUTH_TOKEN");
  });

  it("caps the indicator width so it can't squeeze the tab strip", () => {
    const css = readFileSync("apps/desktop/src/renderer/styles/components.css", "utf8");
    const layout = readFileSync("apps/desktop/src/renderer/styles/layout.css", "utf8");
    const rule = (source: string, selector: string) => {
      const match = source.match(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
      expect(match, selector).not.toBeNull();
      return match![2];
    };
    expect(rule(layout, ".titlebar-connection")).toMatch(/max-width:\s*240px/);
    expect(rule(layout, ".titlebar-connection")).toMatch(/flex:\s*0 1 auto/);
    expect(rule(layout, ".tab-rail")).toMatch(/min-width:\s*120px/);
    expect(rule(layout, ".tab-new")).toMatch(/flex-shrink:\s*0/);
    expect(rule(css, ".conn")).toMatch(/max-width:\s*100%/);
    expect(rule(css, ".conn__text")).toMatch(/text-overflow:\s*ellipsis/);
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
    expect(copied.mcpServers.helmstack.env.HELMSTACK_PORT).toBe("7070");
    expect(copied.mcpServers.helmstack.env.HELMSTACK_PROFILE).toBe("agent-substrate");

    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(button());
  });
});
