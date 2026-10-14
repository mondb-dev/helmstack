/**
 * Titlebar connection indicator ("● :7070 · 2 clients") and its popover:
 * status, token file, active profile, and a "Copy MCP config" button that
 * produces a ready-to-paste `mcpServers` entry for `@helmstack/mcp-server`.
 */

import type { AgentConnectionStatus } from "../../../../../packages/shared/src/index.js";
import { icon } from "../ui/icons.js";
import { createPopover, type PopoverController } from "../ui/popover.js";
import { plural } from "../ui/format.js";
import { toast } from "../ui/toast.js";

export const DEFAULT_AGENT_PORT = 7070;

/** Clients shown in the indicator: open SSE streams or distinct agent ids, whichever is larger. */
export function clientCount(status: AgentConnectionStatus): number {
  return Math.max(status.sseClients, status.agentIds.length);
}

/** Indicator text, e.g. ":7070 · 2 clients" or ":7070 · port in use". */
export function connectionLabel(status: AgentConnectionStatus | null): string {
  if (!status) return "Checking…";
  const port = `:${status.port ?? DEFAULT_AGENT_PORT}`;
  if (!status.listening) {
    return `${port} · ${status.error ?? "not listening"}`;
  }
  return `${port} · ${plural(clientCount(status), "client")}`;
}

export const PROFILE_LABEL: Record<AgentConnectionStatus["profile"], string> = {
  "fe-dev": "Frontend dev (fe-dev)",
  "agent-substrate": "Agent substrate",
  full: "Full",
};

/**
 * JSON for an MCP client config (Claude Code `.mcp.json`, Claude Desktop,
 * Cursor…). Mirrors the env vars `@helmstack/mcp-server` / agent-sdk read:
 * `HELMSTACK_PORT`, `HELMSTACK_TOKEN_FILE`, `HELMSTACK_PROFILE`.
 */
export function buildMcpConfig(status: AgentConnectionStatus | null): string {
  const env: Record<string, string> = {
    HELMSTACK_PORT: String(status?.port ?? DEFAULT_AGENT_PORT),
  };
  if (status?.tokenPath) {
    env.HELMSTACK_TOKEN_FILE = status.tokenPath;
  }
  if (status && status.profile !== "fe-dev") {
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

export interface ConnectionOptions {
  root?: ParentNode;
  onPopoverOpen?: () => void;
  onPopoverClose?: () => void;
  /** Clipboard writer (defaults to navigator.clipboard). */
  writeClipboard?: (text: string) => Promise<void>;
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
      const statusValue = document.createElement("span");
      statusValue.className = `status-inline status-inline--${current.listening ? "ok" : "fail"}`;
      statusValue.append(
        icon(current.listening ? "check" : "circle-x", { size: 14 }),
        document.createTextNode(
          current.listening
            ? `Listening on 127.0.0.1:${current.port ?? DEFAULT_AGENT_PORT}`
            : `Not listening${current.error ? ` — ${current.error}` : ""}`
        )
      );
      kvRow(kv, "Status", statusValue);
      kvRow(kv, "Event streams", String(current.sseClients));
      kvRow(kv, "Agents seen", current.agentIds.length > 0 ? current.agentIds.join(", ") : "None yet");
      kvRow(kv, "Token file", current.tokenPath ?? "Not file-based", Boolean(current.tokenPath));
      kvRow(kv, "Profile", PROFILE_LABEL[current.profile] ?? current.profile);
    }

    const hint = document.createElement("p");
    hint.className = "popover__hint";
    hint.textContent = "Add this to your coding agent's MCP config (e.g. .mcp.json) to let it drive HelmStack.";

    const code = document.createElement("pre");
    code.className = "code code--compact";
    code.id = "mcp-config-snippet";
    code.textContent = buildMcpConfig(current);

    const actions = document.createElement("div");
    actions.className = "popover__actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "btn btn--sm btn--ghost";
    copy.id = "copy-mcp-config";
    copy.append(icon("copy", { size: 14 }), document.createTextNode("Copy MCP config"));
    copy.addEventListener("click", async () => {
      try {
        await writeClipboard(buildMcpConfig(current));
        toast("MCP config copied to the clipboard.", "success");
      } catch (error) {
        toast(`Couldn't copy — ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    });
    actions.append(copy);

    panel.replaceChildren(heading, kv, hint, code, actions);
  };

  const popover = createPopover(button, panel, {
    label: "Agent connection",
    align: "end",
    onOpen: () => options.onPopoverOpen?.(),
    onClose: () => options.onPopoverClose?.(),
  });

  const update = (status: AgentConnectionStatus): void => {
    current = status;
    button.dataset.state = status.listening ? "listening" : "error";
    text.textContent = connectionLabel(status);
    button.title = status.listening ? "Agent API listening — show connection details" : "Agent API not listening — show details";
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
