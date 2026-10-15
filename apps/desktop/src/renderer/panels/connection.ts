/**
 * Titlebar connection indicator ("● :7070 · 2 clients" / "● Agent API off")
 * and its popover:
 * status, token file, active profile, and a "Copy MCP config" button that
 * produces a ready-to-paste `mcpServers` entry for `@helmstack/mcp-server`.
 */

import type { AgentConnectionStatus } from "../../../../../packages/shared/src/index.js";
import { icon } from "../ui/icons.js";
import { createPopover, type PopoverController } from "../ui/popover.js";
import { plural } from "../ui/format.js";
import { toast } from "../ui/toast.js";

/** Clients shown in the indicator: open SSE streams or distinct agent ids, whichever is larger. */
export function clientCount(status: AgentConnectionStatus): number {
  return Math.max(status.sseClients, status.agentIds.length);
}

/**
 * The port agents can actually reach, or null. Never guessed: when the server
 * isn't listening (e.g. its port was taken) there is no port to hand out.
 */
export function livePort(status: AgentConnectionStatus | null): number | null {
  if (!status || !status.listening || typeof status.port !== "number") return null;
  return status.port;
}

/** Compact label shown in the titlebar when the agent API is down. */
export const AGENT_API_OFF_LABEL = "Agent API off";

/**
 * Indicator text, e.g. ":7070 · 2 clients", or "Agent API off" when not
 * listening (the full error lives in the popover, never in the titlebar).
 */
export function connectionLabel(status: AgentConnectionStatus | null): string {
  if (!status) return "Checking…";
  const port = livePort(status);
  if (port === null) return AGENT_API_OFF_LABEL;
  return `:${port} · ${plural(clientCount(status), "client")}`;
}

/** Placeholder for an env-provided token. The shell never sees the real one. */
export const AUTH_TOKEN_PLACEHOLDER = "<paste your token>";

export const PROFILE_LABEL: Record<AgentConnectionStatus["profile"], string> = {
  "fe-dev": "Frontend dev (fe-dev)",
  "agent-substrate": "Agent substrate",
  full: "Full",
};

/**
 * JSON for an MCP client config (Claude Code `.mcp.json`, Claude Desktop,
 * Cursor…). Mirrors the env vars `@helmstack/mcp-server` / agent-sdk read:
 * `HELMSTACK_PORT`, `HELMSTACK_TOKEN_FILE` | `HELMSTACK_AUTH_TOKEN`,
 * `HELMSTACK_PROFILE`. Returns null while the agent API isn't listening — a
 * config pointing at a port the server isn't on would just fail silently.
 */
export function buildMcpConfig(status: AgentConnectionStatus | null): string | null {
  const port = livePort(status);
  if (!status || port === null) return null;
  const env: Record<string, string> = { HELMSTACK_PORT: String(port) };
  if (status.tokenPath) {
    env.HELMSTACK_TOKEN_FILE = status.tokenPath;
  } else {
    // Token came from the app's HELMSTACK_AUTH_TOKEN; the user pastes it themselves.
    env.HELMSTACK_AUTH_TOKEN = AUTH_TOKEN_PLACEHOLDER;
  }
  if (status.profile !== "fe-dev") {
    env.HELMSTACK_PROFILE = status.profile;
  }
  const config = {
    mcpServers: {
      helmstack: {
        command: "npx",
        args: ["-y", "@helmstack/mcp-server"],
        env,
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

/** One-line note on where the snippet's auth token comes from. */
export function tokenSourceNote(status: AgentConnectionStatus): string {
  return status.tokenPath
    ? "The agent reads its auth token from the token file above."
    : "Auth token comes from the HELMSTACK_AUTH_TOKEN env var HelmStack was started with — paste that value in place of the placeholder.";
}

/** Why there's no MCP config to copy right now. */
export function mcpUnavailableReason(status: AgentConnectionStatus | null): string {
  if (!status) return "Waiting for the agent API status…";
  return "The agent API isn't listening, so there's no port to point an agent at. Fix the error above (e.g. free the port) and restart HelmStack.";
}

export interface ConnectionOptions {
  root?: ParentNode;
  onPopoverOpen?: () => void;
  onPopoverClose?: () => void;
  /** Clipboard writer (defaults to navigator.clipboard). */
  writeClipboard?: (text: string) => Promise<void>;
  /** Opens the "Connect an agent" dialog (the popover closes first). Button hidden when absent. */
  onConnectAgents?: () => void;
}

export interface ConnectionController {
  update(status: AgentConnectionStatus): void;
  status(): AgentConnectionStatus | null;
  open(): void;
  popover: PopoverController;
}

function kvRow(list: HTMLElement, key: string, value: string | Node, mono = false): void {
  const dt = document.createElement("dt");
  dt.className = "kv__key";
  dt.textContent = key;
  const dd = document.createElement("dd");
  dd.className = mono ? "kv__val" : "kv__val kv__val--sans";
  if (typeof value === "string") dd.textContent = value;
  else dd.append(value);
  list.append(dt, dd);
}

export function mountConnection(options: ConnectionOptions = {}): ConnectionController {
  const root = options.root ?? document;
  const button = root.querySelector<HTMLButtonElement>("#connection-indicator");
  const text = root.querySelector<HTMLElement>("#connection-text");
  const panel = root.querySelector<HTMLDivElement>("#connection-popover");
  if (!button || !text || !panel) {
    throw new Error("Connection indicator markup missing.");
  }

  let current: AgentConnectionStatus | null = null;
  const writeClipboard =
    options.writeClipboard ?? ((value: string) => navigator.clipboard.writeText(value));

  const renderPanel = (): void => {
    const heading = document.createElement("p");
    heading.className = "popover__title";
    heading.textContent = "Agent connection";

    const kv = document.createElement("dl");
    kv.className = "kv";
    if (!current) {
      kvRow(kv, "Status", "Checking…");
    } else {
      const port = livePort(current);
      const statusValue = document.createElement("span");
      statusValue.className = `status-inline status-inline--${port !== null ? "ok" : "fail"}`;
      statusValue.append(
        icon(port !== null ? "check" : "circle-x", { size: 14 }),
        document.createTextNode(
          port !== null
            ? `Listening on 127.0.0.1:${port}`
            : `Not listening${current.error ? ` — ${current.error}` : ""}`
        )
      );
      kvRow(kv, "Status", statusValue);
      kvRow(kv, "Event streams", String(current.sseClients));
      kvRow(kv, "Agents seen", current.agentIds.length > 0 ? current.agentIds.join(", ") : "None yet");
      kvRow(kv, "Auth token", current.tokenPath ?? "From HELMSTACK_AUTH_TOKEN", Boolean(current.tokenPath));
      kvRow(kv, "Profile", PROFILE_LABEL[current.profile] ?? current.profile);
    }

    const hint = document.createElement("p");
    hint.className = "popover__hint";
    const snippet = buildMcpConfig(current);
    const nodes: HTMLElement[] = [heading, kv, hint];

    const actions = document.createElement("div");
    actions.className = "popover__actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "btn btn--sm btn--ghost";
    copy.id = "copy-mcp-config";
    copy.append(icon("copy", { size: 14 }), document.createTextNode("Copy MCP config"));

    if (snippet === null || !current) {
      hint.id = "mcp-config-unavailable";
      hint.textContent = mcpUnavailableReason(current);
      copy.disabled = true;
      copy.setAttribute("aria-describedby", hint.id);
    } else {
      hint.textContent = "Add this to your coding agent's MCP config (e.g. .mcp.json) to let it drive HelmStack.";
      const code = document.createElement("pre");
      code.className = "code code--compact";
      code.id = "mcp-config-snippet";
      code.textContent = snippet;
      const note = document.createElement("p");
      note.className = "popover__hint";
      note.id = "mcp-token-note";
      note.textContent = tokenSourceNote(current);
      nodes.push(code, note);
      copy.addEventListener("click", async () => {
        const text = buildMcpConfig(current);
        if (text === null) return;
        try {
          await writeClipboard(text);
          toast("MCP config copied to the clipboard.", "success");
        } catch (error) {
          toast(`Couldn't copy — ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      });
    }
    if (options.onConnectAgents) {
      const connect = document.createElement("button");
      connect.type = "button";
      connect.className = "btn btn--sm btn--primary";
      connect.id = "connect-agents";
      connect.setAttribute("aria-haspopup", "dialog");
      connect.append(icon("bot", { size: 14 }), document.createTextNode("Connect agents…"));
      connect.addEventListener("click", () => {
        popover.close();
        options.onConnectAgents?.();
      });
      actions.append(connect);
    }
    actions.append(copy);
    nodes.push(actions);

    panel.replaceChildren(...nodes);
  };

  const popover = createPopover(button, panel, {
    label: "Agent connection",
    align: "end",
    onOpen: () => options.onPopoverOpen?.(),
    onClose: () => options.onPopoverClose?.(),
  });

  const update = (status: AgentConnectionStatus): void => {
    current = status;
    const up = livePort(status) !== null;
    button.dataset.state = up ? "listening" : "error";
    text.textContent = connectionLabel(status);
    button.title = up
      ? "Agent API listening — show connection details"
      : `Agent API not listening${status.error ? ` (${status.error})` : ""} — show details`;
    // Keep focus stable: only rebuild an open panel when focus isn't inside it.
    if (!popover.isOpen() || !panel.contains(document.activeElement)) {
      renderPanel();
    }
  };

  renderPanel();

  return {
    update,
    status: () => current,
    open: () => popover.open(),
    popover,
  };
}
