/**
 * "Connect an agent" dialog: detects the AI clients the human already uses and
 * installs HelmStack's MCP server into them. The renderer only names a client,
 * an action and allowlisted options; main builds and validates every command
 * and path. Install/Remove always show the exact command or file diff first
 * and need an explicit Confirm.
 */
import type {
  BrowserShellApi,
  McpClientId,
  McpClientStatus,
  McpCommandSourceId,
  McpInstallOverview,
  McpInstallPreview,
  McpInstallResult,
  McpToolset
} from "../../../../../packages/shared/src/index.js";
import { openDialog, type DialogHandle } from "../ui/dialog.js";
import { toast } from "../ui/toast.js";

type Bridge = Pick<BrowserShellApi, "getMcpInstallOverview" | "runMcpInstall">;

export interface McpInstallOptions {
  bridge: Bridge;
  root?: ParentNode;
  onOpen?: () => void;
  onClose?: () => void;
  writeClipboard?: (text: string) => Promise<void>;
}

export interface McpInstallController {
  open(): Promise<void>;
  close(): void;
  isOpen(): boolean;
}

type Pending = { clientId: McpClientId; action: "install" | "remove"; preview: McpInstallPreview };

export const CHATGPT_NOTE =
  "ChatGPT only takes remote MCP connectors on a public HTTPS address, so a local server can't be installed there. " +
  "Using it would mean exposing HelmStack's agent API through a tunnel, which is a security decision HelmStack won't make for you.";

function badge(client: McpClientStatus): { text: string; cls: string } | null {
  if (client.kind === "explainer" || client.kind === "copy-only") return null;
  if (client.installed && client.needsAttention) return { text: "Needs attention", cls: "badge badge-warning" };
  if (client.installed) return { text: "Installed", cls: "badge badge-info" };
  if (client.detected) return { text: "Detected", cls: "badge" };
  return { text: "Not found", cls: "badge" };
}

export function mountMcpInstall(options: McpInstallOptions): McpInstallController {
  const root = options.root ?? document;
  const modal = root.querySelector<HTMLElement>("#mcp-install-modal");
  const body = root.querySelector<HTMLElement>("#mcp-install-body");
  const closeButton = root.querySelector<HTMLButtonElement>("#mcp-install-close");
  const backdrop = root.querySelector<HTMLElement>("#mcp-install-backdrop");
  if (!modal || !body || !closeButton) throw new Error("Connect an agent dialog markup missing.");
  const writeClipboard = options.writeClipboard ?? ((text: string) => navigator.clipboard.writeText(text));

  let dialog: DialogHandle | null = null;
  let overview: McpInstallOverview | null = null;
  let loadError: string | null = null;
  let toolset: McpToolset = "full";
  let source: McpCommandSourceId | null = null;
  let pending: Pending | null = null;
  const busy = new Set<McpClientId>();
  const inline = new Map<McpClientId, { text: string; ok: boolean }>();
  let focusAfterRender: string | null = null;

  const opts = (confirm?: string) => ({ toolset, ...(source ? { source } : {}), ...(confirm ? { confirm } : {}) });
  const announce = body.ownerDocument.createElement("div");
  announce.className = "sr-only";
  announce.setAttribute("role", "status");
  announce.setAttribute("aria-live", "polite");

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (label: string, className: string, onClick: () => void, id?: string, disabled = false): HTMLButtonElement => {
    const b = el("button", className, label);
    b.type = "button";
    if (id) b.dataset.action = id;
    b.disabled = disabled;
    b.addEventListener("click", onClick);
    return b;
  };

  const say = (clientId: McpClientId, text: string, ok: boolean): void => {
    inline.set(clientId, { text, ok });
    announce.textContent = text;
  };

  const refresh = async (): Promise<void> => {
    try {
      overview = await options.bridge.getMcpInstallOverview();
      loadError = null;
      if (source && !overview.sources.find((s) => s.id === source)?.available) source = null;
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }
    render();
  };

  const mergeStatus = (status: McpClientStatus | undefined): void => {
    if (!status || !overview) return;
    overview = { ...overview, clients: overview.clients.map((c) => (c.id === status.id ? status : c)) };
  };

  const call = async (clientId: McpClientId, action: "preview" | "install" | "remove" | "verify", confirm?: string): Promise<McpInstallResult | null> => {
    busy.add(clientId);
    render();
    try {
      return await options.bridge.runMcpInstall({ clientId, action, options: opts(confirm) });
    } catch (error) {
      say(clientId, error instanceof Error ? error.message : String(error), false);
      return null;
    } finally {
      busy.delete(clientId);
    }
  };

  const startChange = async (clientId: McpClientId, action: "install" | "remove"): Promise<void> => {
    pending = null;
    inline.delete(clientId);
    const result = await call(clientId, action);
    if (result?.ok && result.needsConfirmation && result.preview) {
      pending = { clientId, action, preview: result.preview };
      focusAfterRender = "preview";
    } else if (result) {
      say(clientId, result.message, result.ok);
      mergeStatus(result.status);
    }
    render();
  };

  const confirmChange = async (): Promise<void> => {
    if (!pending) return;
    const { clientId, action, preview } = pending;
    const result = await call(clientId, action, preview.previewId);
    if (!result) {
      render();
      return;
    }
    if (result.needsConfirmation && result.preview) {
      // The plan changed under us: show the new one instead of acting on a stale review.
      pending = { clientId, action, preview: result.preview };
      say(clientId, result.message, false);
      focusAfterRender = "preview";
    } else {
      pending = null;
      const text = result.backupPath ? `${result.message} Backup: ${result.backupPath}` : result.message;
      say(clientId, text, result.ok);
      mergeStatus(result.status);
      toast(result.ok ? result.message : `Couldn't ${action} — ${result.message}`, result.ok ? "success" : "error");
      focusAfterRender = `row:${clientId}`;
    }
    render();
  };

  const copyConfig = async (clientId: McpClientId): Promise<void> => {
    const result = await call(clientId, "preview");
    if (!result?.ok || !result.preview) {
      if (result) say(clientId, result.message, false);
      render();
      return;
    }
    try {
      await writeClipboard(result.preview.copyText);
      say(clientId, "Config copied to the clipboard.", true);
      toast("Config copied to the clipboard.", "success");
    } catch (error) {
      say(clientId, `Couldn't copy — ${error instanceof Error ? error.message : String(error)}`, false);
    }
    render();
  };

  const verify = async (clientId: McpClientId): Promise<void> => {
    const result = await call(clientId, "verify");
    if (result) {
      say(clientId, result.message, result.ok && result.registered !== false);
      mergeStatus(result.status);
    }
    render();
  };

  const renderPreview = (p: Pending, label: string): HTMLElement => {
    const box = el("section", "mcp-preview");
    box.setAttribute("aria-label", `Review: ${p.action === "install" ? "install" : "remove"} for ${label}`);
    box.tabIndex = -1;
    box.dataset.role = "preview";
    box.append(el("h4", "mcp-preview__title", p.action === "install" ? `Review before installing in ${label}` : `Review before removing from ${label}`));
    if (p.preview.change === "none") box.append(el("p", "popover__hint", "Nothing would change."));
    if (p.preview.commandLine) {
      box.append(el("p", "mcp-preview__label", "HelmStack will run"));
      const pre = el("pre", "code code--compact", p.preview.commandLine);
      pre.dataset.role = "command";
      box.append(pre);
    }
    if (p.preview.filePath) {
      box.append(el("p", "mcp-preview__label", "HelmStack will edit"));
      const pre = el("pre", "code code--compact", p.preview.filePath);
      pre.dataset.role = "file";
      box.append(pre);
    }
    if (p.preview.diff) {
      box.append(el("p", "mcp-preview__label", "Change"));
      const pre = el("pre", "code code--compact", p.preview.diff);
      pre.dataset.role = "diff";
      box.append(pre);
    }
    for (const warning of p.preview.warnings) box.append(el("p", "mcp-preview__warning", warning));
    const actions = el("div", "popover__actions");
    actions.append(
      button("Cancel", "btn btn--sm btn--ghost", () => {
        const id = p.clientId;
        pending = null;
        focusAfterRender = `row:${id}`;
        render();
      }, "cancel"),
      button(p.action === "install" ? "Confirm install" : "Confirm remove", "btn btn--sm btn--primary", () => void confirmChange(), "confirm", p.preview.change === "none")
    );
    box.append(actions);
    return box;
  };

  const renderClient = (client: McpClientStatus): HTMLElement => {
    const row = el("li", "mcp-client");
    row.dataset.client = client.id;
    row.tabIndex = -1;
    const head = el("div", "mcp-client__head");
    head.append(el("span", "mcp-client__name", client.label));
    const b = badge(client);
    if (b) head.append(el("span", b.cls, b.text));
    if (client.version) head.append(el("span", "mcp-client__version", client.version));
    row.append(head);

    if (client.id === "chatgpt") {
      row.append(el("p", "popover__hint", CHATGPT_NOTE));
      return row;
    }
    if (client.note) row.append(el("p", "popover__hint", client.note));
    if (client.configPath && client.kind === "json-file") row.append(el("p", "mcp-client__path", client.configPath));
    const status = inline.get(client.id);
    if (status) {
      const p = el("p", `status-inline status-inline--${status.ok ? "ok" : "fail"}`, status.text);
      row.append(p);
    }

    const working = busy.has(client.id);
    const actions = el("div", "mcp-client__actions");
    const ready = overview?.ready === true;
    if (client.kind !== "copy-only") {
      const canChange = ready && client.canInstall && !working;
      actions.append(
        button(client.installed ? "Update" : "Install", "btn btn--sm btn--primary", () => void startChange(client.id, "install"), "install", !canChange)
      );
      if (client.installed) {
        actions.append(button("Remove", "btn btn--sm btn--ghost", () => void startChange(client.id, "remove"), "remove", working));
      }
      if (client.kind === "cli" || client.installed) {
        actions.append(button("Verify", "btn btn--sm btn--ghost", () => void verify(client.id), "verify", working || !client.detected));
      }
    }
    actions.append(button("Copy config", "btn btn--sm btn--ghost", () => void copyConfig(client.id), "copy", working || !ready));
    row.append(actions);
    if (pending && pending.clientId === client.id) row.append(renderPreview(pending, client.label));
    return row;
  };

  const render = (): void => {
    const nodes: Node[] = [announce];
    if (loadError) {
      nodes.push(el("p", "status-inline status-inline--fail", `Couldn't read your agent clients — ${loadError}`));
      body.replaceChildren(...nodes);
      return;
    }
    if (!overview) {
      nodes.push(el("p", "popover__hint", "Looking for agent clients…"));
      body.replaceChildren(...nodes);
      return;
    }
    nodes.push(
      el(
        "p",
        "popover__hint",
        "HelmStack adds an entry named “helmstack” to the clients you pick. Only the path of the token file is written, never the token itself."
      )
    );
    if (!overview.ready && overview.blockedReason) {
      const warn = el("p", "status-inline status-inline--fail", overview.blockedReason);
      warn.dataset.role = "blocked";
      nodes.push(warn);
    }

    // Options: toolset + command source.
    const optionsBox = el("div", "mcp-options");
    const label = el("label", "mcp-options__check");
    const check = el("input");
    check.type = "checkbox";
    check.id = "mcp-toolset-lite";
    check.checked = toolset === "lite";
    check.addEventListener("change", () => {
      toolset = check.checked ? "lite" : "full";
      pending = null;
    });
    label.append(check, document.createTextNode(" Compact tools — for small models"));
    optionsBox.append(label);

    const sources = el("fieldset", "mcp-options__sources");
    sources.append(el("legend", "mcp-options__legend", "How agents start HelmStack's MCP server"));
    for (const s of overview.sources) {
      const line = el("label", "mcp-source");
      const radio = el("input");
      radio.type = "radio";
      radio.name = "mcp-source";
      radio.value = s.id;
      radio.disabled = !s.available;
      const selected = source ? source === s.id : s.id === overview.sources.find((x) => x.available)?.id;
      radio.checked = selected && s.available;
      radio.addEventListener("change", () => {
        source = s.id;
        pending = null;
        render();
      });
      const text = el("span", "mcp-source__text");
      text.append(el("span", "mcp-source__label", s.label));
      if (s.available && s.commandLine) text.append(el("code", "mcp-source__cmd", s.commandLine));
      if (!s.available && s.reason) {
        const reason = el("span", "popover__hint", s.reason);
        reason.dataset.role = "source-unavailable";
        text.append(reason);
      }
      if (s.available && selected) for (const w of s.warnings) text.append(el("span", "mcp-preview__warning", w));
      line.append(radio, text);
      sources.append(line);
    }
    optionsBox.append(sources);
    nodes.push(optionsBox);

    const list = el("ul", "mcp-clients");
    list.setAttribute("aria-label", "Agent clients");
    for (const client of overview.clients) list.append(renderClient(client));
    nodes.push(list);

    body.replaceChildren(...nodes);
    if (focusAfterRender) {
      const target = focusAfterRender;
      focusAfterRender = null;
      const node =
        target === "preview"
          ? body.querySelector<HTMLElement>('[data-role="preview"]')
          : body.querySelector<HTMLElement>(`[data-client="${target.slice(4)}"]`);
      node?.focus();
    }
  };

  const hide = (): void => {
    if (!dialog) return;
    const handle = dialog;
    dialog = null;
    modal.hidden = true;
    pending = null;
    handle.close();
    options.onClose?.();
  };

  closeButton.addEventListener("click", hide);
  backdrop?.addEventListener("click", hide);

  return {
    async open() {
      if (dialog) return;
      overview = null;
      loadError = null;
      pending = null;
      inline.clear();
      render();
      modal.hidden = false;
      options.onOpen?.();
      dialog = openDialog(modal, {
        dismissable: true,
        initialFocus: closeButton,
        onClose: () => {
          if (dialog) {
            dialog = null;
            modal.hidden = true;
            pending = null;
            options.onClose?.();
          }
        }
      });
      await refresh();
    },
    close: hide,
    isOpen: () => dialog !== null
  };
}
