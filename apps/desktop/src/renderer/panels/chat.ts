/**
 * "Chat" tab of the right-hand panel: talk to a locally installed agent CLI
 * (Claude Code, Gemini CLI…) while it drives the page through HelmStack's MCP
 * server. One conversation per browser tab, created lazily on the first
 * message. Rendering is DOM-only via textContent — model output is never HTML.
 *
 * Accessibility: the message list is a `role="log"` that is NOT live itself
 * (streamed deltas would be read out token by token); a separate polite
 * announcer speaks only the final assistant text and "turn finished".
 */

import type {
  AgentChatEvent,
  AgentCliInfo,
  AgentConversationSummary,
  AgentRunnerStatus,
  BrowserShellBridge,
  StartAgentConversationInput,
  TabId,
} from "../../../../../packages/shared/src/index.js";
import { applyChatEvent, applyChatEvents, createThread, formatElapsed, type ChatItem, type ChatThread } from "../ui/chat-thread.js";
import { humanizeToolName } from "../ui/chat-tools.js";
import { icon } from "../ui/icons.js";
import { buildEmptyState } from "../ui/states.js";
import { toast } from "../ui/toast.js";

export type ChatBridge = Pick<
  BrowserShellBridge,
  | "getAgentRunnerStatus"
  | "refreshAgentRunner"
  | "startAgentConversation"
  | "sendAgentMessage"
  | "stopAgentTurn"
  | "listAgentConversations"
  | "getAgentConversationEvents"
  | "closeAgentConversation"
>;

export const CHAT_CHAR_LIMIT = 8000;
/** The counter appears from here on. */
export const CHAT_COUNTER_FROM = 7000;
export const CUSTOM_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
export const SELECTION_STORAGE_KEY = "helmstack-chat-selection";
export const CUSTOM_OPTION = "__custom__";
export const EXAMPLE_PROMPTS = [
  "Run an accessibility audit and summarize the top issues",
  "Check this page at mobile width",
  "Run an SEO audit",
] as const;

/**
 * Whether the shared `StartAgentConversationInput` carries `allowUnconfined`.
 * It does, so a CLI that can't be confined can be started once the human has
 * ticked the explicit acknowledgement (the runner enforces it again).
 */
type HasAllowUnconfined = "allowUnconfined" extends keyof StartAgentConversationInput ? true : false;
export const UNCONFINED_START_SUPPORTED: HasAllowUnconfined = true;

const NEAR_BOTTOM_PX = 48;

/** Absolute POSIX, Windows drive or UNC path. */
export function isAbsolutePath(value: string): boolean {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(value);
}

export function validateCustomModel(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Enter a model id.";
  if (!CUSTOM_MODEL_PATTERN.test(trimmed)) {
    return "Use 1–80 letters, numbers and . _ : / - only.";
  }
  return null;
}

export function validateWorkingDirectory(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Enter a directory path.";
  if (!isAbsolutePath(trimmed)) return "Use an absolute path, e.g. /Users/you/project.";
  return null;
}

export interface ChatOptions {
  root?: ParentNode;
  bridge: ChatBridge;
  activeTabId: () => TabId | undefined;
  /** Host shown in "Working on <host>…". */
  tabHost?: (tabId: TabId) => string | undefined;
  now?: () => number;
  /** Override for tests; defaults to what the shared contract supports. */
  unconfinedSupported?: boolean;
}

export interface ChatController {
  /** The Chat tab became visible: load runner status and this tab's thread. */
  show(): void;
  /** The active browser tab changed. */
  refreshForTab(): void;
  handleEvent(event: AgentChatEvent): void;
  destroy(): void;
}

interface TabChat {
  conv: AgentConversationSummary | null;
  thread: ChatThread;
  loading: boolean;
  loaded: boolean;
  pending: AgentChatEvent[];
  dom: Map<string, { sig: string; el: HTMLElement }>;
  stopping: boolean;
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* preference just won't persist */
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function mountChat(options: ChatOptions): ChatController {
  const root = options.root ?? document;
  const host = root.querySelector<HTMLElement>("#chat-body");
  if (!host) throw new Error("Chat markup missing: #chat-body");
  const now = options.now ?? (() => Date.now());
  const unconfinedSupported = options.unconfinedSupported ?? UNCONFINED_START_SUPPORTED;

  // ── static DOM ────────────────────────────────────────────────────────────
  const setup = el("div", "chat__setup");

  const modelField = el("div", "field");
  const modelLabel = el("label", "field__label", "Agent and model");
  modelLabel.htmlFor = "chat-model";
  const modelRow = el("div", "chat__row");
  const modelSelect = el("select", "select chat__select");
  modelSelect.id = "chat-model";
  const experimentalBadge = el("span", "badge badge-warning chat__badge", "Experimental");
  experimentalBadge.hidden = true;
  const refreshButton = el("button", "btn btn--sm btn--ghost", "Refresh");
  refreshButton.type = "button";
  refreshButton.title = "Detect installed agent CLIs again";
  modelRow.append(modelSelect, refreshButton);
  const modelNote = el("p", "chat__note");
  modelNote.id = "chat-model-note";
  modelSelect.setAttribute("aria-describedby", modelNote.id);
  modelField.append(modelLabel, modelRow, experimentalBadge, modelNote);

  const customField = el("div", "field");
  customField.hidden = true;
  const customLabel = el("label", "field__label", "Custom model id");
  customLabel.htmlFor = "chat-custom-model";
  const customInput = el("input", "input");
  customInput.id = "chat-custom-model";
  customInput.type = "text";
  customInput.placeholder = "e.g. claude-sonnet-4-5";
  customInput.autocomplete = "off";
  customInput.spellcheck = false;
  const customError = el("p", "field__error");
  customError.id = "chat-custom-model-error";
  customError.hidden = true;
  customInput.setAttribute("aria-describedby", customError.id);
  customField.append(customLabel, customInput, customError);

  const dirField = el("div", "field");
  const dirLabel = el("span", "field__label", "Working directory");
  const dirRow = el("div", "chat__row");
  const dirValue = el("code", "chat__dir");
  const dirChange = el("button", "link-btn", "Change…");
  dirChange.type = "button";
  dirRow.append(dirValue, dirChange);
  const dirEdit = el("div", "chat__dir-edit");
  dirEdit.hidden = true;
  const dirInput = el("input", "input");
  dirInput.id = "chat-dir-input";
  dirInput.type = "text";
  dirInput.autocomplete = "off";
  dirInput.spellcheck = false;
  dirInput.setAttribute("aria-label", "Working directory path");
  const dirError = el("p", "field__error");
  dirError.id = "chat-dir-error";
  dirError.hidden = true;
  dirInput.setAttribute("aria-describedby", dirError.id);
  const dirActions = el("div", "chat__row");
  const dirApply = el("button", "btn btn--sm btn--ghost", "Use this folder");
  dirApply.type = "button";
  const dirCancel = el("button", "btn btn--sm btn--quiet", "Cancel");
  dirCancel.type = "button";
  dirActions.append(dirApply, dirCancel);
  dirEdit.append(dirInput, dirError, dirActions);
  dirField.append(dirLabel, dirRow, dirEdit);

  const ackField = el("label", "chat__ack");
  ackField.hidden = true;
  const ackBox = el("input");
  ackBox.type = "checkbox";
  ackBox.id = "chat-ack";
  const ackText = el("span", undefined, "This agent can edit files and run commands, not just control the browser.");
  ackField.append(ackBox, ackText);

  const setupActions = el("div", "chat__row");
  const newButton = el("button", "btn btn--sm btn--ghost", "New conversation");
  newButton.type = "button";
  setupActions.append(newButton);

  setup.append(modelField, customField, dirField, ackField, setupActions);

  const stateBox = el("div", "chat__state");
  stateBox.hidden = true;

  const main = el("div", "chat__main");
  const empty = el("div", "chat__empty");
  const log = el("div", "chat__log");
  log.setAttribute("role", "log");
  log.setAttribute("aria-label", "Conversation");
  log.setAttribute("aria-live", "off");
  log.tabIndex = 0;
  const jump = el("button", "btn btn--sm chat__jump");
  jump.type = "button";
  jump.append(icon("chevron-down", { size: 14 }), document.createTextNode("Jump to latest"));
  jump.hidden = true;
  main.append(empty, log, jump);

  const announcer = el("div", "sr-only");
  announcer.setAttribute("role", "status");
  announcer.setAttribute("aria-live", "polite");

  const statusLine = el("p", "chat__status");
  statusLine.hidden = true;

  const composer = el("form", "chat__composer");
  composer.noValidate = true;
  const composerLabel = el("label", "sr-only", "Message to the agent");
  composerLabel.htmlFor = "chat-input";
  const input = el("textarea", "textarea chat__input");
  input.id = "chat-input";
  input.rows = 3;
  const composerHint = el("p", "chat__hint");
  composerHint.id = "chat-hint";
  input.setAttribute("aria-describedby", composerHint.id);
  const composerError = el("p", "field__error");
  composerError.id = "chat-composer-error";
  composerError.setAttribute("role", "alert");
  composerError.hidden = true;
  const composerFooter = el("div", "chat__row chat__composer-footer");
  const counter = el("span", "chat__counter");
  counter.hidden = true;
  const sendButton = el("button", "btn btn--primary btn--sm", "Send");
  sendButton.type = "submit";
  const stopButton = el("button", "btn btn--danger btn--sm", "Stop");
  stopButton.type = "button";
  stopButton.hidden = true;
  composerFooter.append(counter, sendButton, stopButton);
  composer.append(composerLabel, input, composerHint, composerError, composerFooter);

  host.replaceChildren(setup, stateBox, main, announcer, statusLine, composer);

  // ── state ─────────────────────────────────────────────────────────────────
  let status: AgentRunnerStatus | null = null;
  let statusLoading = false;
  let statusError: string | null = null;
  let isShown = false;
  let selected = readStorage(SELECTION_STORAGE_KEY) ?? "";
  let dirOverride: string | null = null;
  let sending = false;
  let nearBottom = true;
  let timer: number | null = null;
  const tabs = new Map<TabId, TabChat>();
  const byConversation = new Map<string, TabChat>();

  const tabChat = (tabId: TabId): TabChat => {
    let tc = tabs.get(tabId);
    if (!tc) {
      tc = { conv: null, thread: createThread(), loading: false, loaded: false, pending: [], dom: new Map(), stopping: false };
      tabs.set(tabId, tc);
    }
    return tc;
  };
  const active = (): { tabId: TabId; tc: TabChat } | null => {
    const tabId = options.activeTabId();
    return tabId ? { tabId, tc: tabChat(tabId) } : null;
  };

  const availableClis = (): AgentCliInfo[] => status?.clis.filter((cli) => cli.available) ?? [];
  const optionValue = (cliId: string, model: string): string => `${cliId}::${model}`;
  const parseValue = (value: string): { cliId: string; model: string } | null => {
    const index = value.indexOf("::");
    return index < 0 ? null : { cliId: value.slice(0, index), model: value.slice(index + 2) };
  };
  const selectedCli = (): AgentCliInfo | undefined => {
    const parsed = parseValue(selected);
    return parsed ? status?.clis.find((cli) => cli.id === parsed.cliId) : undefined;
  };
  const isCustom = (): boolean => parseValue(selected)?.model === CUSTOM_OPTION;
  const needsAck = (): boolean => {
    const cli = selectedCli();
    return !!cli && cli.available && !cli.confined;
  };

  // ── rendering: header ─────────────────────────────────────────────────────
  const buildModelOptions = (): void => {
    const groups: HTMLElement[] = [];
    for (const cli of status?.clis ?? []) {
      const group = document.createElement("optgroup");
      const tags: string[] = [];
      if (!cli.available) tags.push(cli.reason ?? "Unavailable");
      if (cli.experimental) tags.push("Experimental");
      group.label = tags.length ? `${cli.label} — ${tags.join(", ")}` : cli.label;
      group.dataset.cli = cli.id;
      if (!cli.available) {
        group.disabled = true;
        const only = document.createElement("option");
        only.disabled = true;
        only.textContent = cli.reason ?? "Unavailable";
        group.append(only);
      } else {
        for (const model of cli.models) {
          const option = document.createElement("option");
          option.value = optionValue(cli.id, model.id);
          option.textContent = model.label;
          group.append(option);
        }
        const custom = document.createElement("option");
        custom.value = optionValue(cli.id, CUSTOM_OPTION);
        custom.textContent = "Custom model…";
        group.append(custom);
      }
      groups.push(group);
    }
    modelSelect.replaceChildren(...groups);
    const values = Array.from(modelSelect.querySelectorAll<HTMLOptionElement>("option:not([disabled])")).map((o) => o.value);
    if (!values.includes(selected)) selected = values[0] ?? "";
    modelSelect.value = selected;
  };

  const renderHeader = (): void => {
    const current = active();
    const conv = current?.tc.conv ?? null;
    const cli = selectedCli();

    modelSelect.disabled = !!conv || !availableClis().length;
    if (conv) {
      const cliInfo = status?.clis.find((c) => c.id === conv.cliId);
      modelNote.textContent = `${cliInfo?.label ?? conv.cliId}${conv.model ? ` · ${conv.model}` : ""}. Start a new conversation to change the agent or model.`;
    } else if (cli && !cli.confined) {
      modelNote.textContent = unconfinedSupported
        ? ""
        : `${cli.label} can't be limited to browser tools, so HelmStack won't start it from here yet. Choose another agent.`;
    } else {
      modelNote.textContent = "";
    }
    modelNote.hidden = modelNote.textContent === "";
    experimentalBadge.hidden = !(cli?.experimental ?? false);

    customField.hidden = !!conv || !isCustom();
    dirChange.hidden = !!conv;
    if (conv) {
      dirEdit.hidden = true;
      dirValue.textContent = conv.workingDirectory;
    } else {
      dirValue.textContent = dirOverride ?? status?.defaultWorkingDirectory ?? "";
    }
    dirValue.title = dirValue.textContent ?? "";

    ackField.hidden = !!conv || !(needsAck() && unconfinedSupported);
    newButton.hidden = !conv;
    newButton.disabled = sending;
  };

  const renderStateBox = (): boolean => {
    // Returns true when the controls + composer should be hidden.
    stateBox.replaceChildren();
    stateBox.hidden = true;
    if (statusLoading && !status) {
      stateBox.hidden = false;
      stateBox.append(buildEmptyState({ title: "Looking for agent CLIs…" }));
      return true;
    }
    if (!status) {
      stateBox.hidden = false;
      stateBox.append(
        buildEmptyState({
          title: "Agent chat isn't available",
          hint: statusError ?? "This build of HelmStack can't run agents yet.",
        })
      );
      return true;
    }
    if (!status.enabled) {
      stateBox.hidden = false;
      const state = buildEmptyState({
        title: "Agent chat is turned off",
        hint: status.reason ?? "The agent runner isn't enabled in this build.",
      });
      stateBox.append(state);
      return true;
    }
    return false;
  };

  const renderEmptyThread = (hasThread: boolean, tabId: TabId | undefined, tc: TabChat | null): void => {
    empty.replaceChildren();
    if (!tabId) {
      empty.append(buildEmptyState({ title: "No tab open", hint: "Open a tab, then ask an agent to work on it." }));
      return;
    }
    if (tc?.loading) {
      empty.append(buildEmptyState({ title: "Loading conversation…" }));
      return;
    }
    if (hasThread) return;
    if (availableClis().length === 0) {
      empty.append(
        buildEmptyState({
          title: "No agent CLI found",
          hint: "Install Claude Code or Gemini CLI, make sure it's on your PATH, then choose Refresh.",
        })
      );
      return;
    }
    empty.append(buildEmptyState({ title: "Ask an agent to work on this page", hint: "Try one of these:" }));
    const prompts = el("div", "chat__prompts");
    for (const prompt of EXAMPLE_PROMPTS) {
      const button = el("button", "chat__prompt", prompt);
      button.type = "button";
      button.addEventListener("click", () => {
        input.value = prompt;
        clearComposerError();
        renderComposer();
        input.focus();
      });
      prompts.append(button);
    }
    empty.append(prompts);
  };

  // ── rendering: thread ─────────────────────────────────────────────────────
  const itemSignature = (item: ChatItem): string => JSON.stringify(item);

  const buildItem = (item: ChatItem): HTMLElement => {
    switch (item.kind) {
      case "user": {
        const node = el("div", "chat-msg chat-msg--user");
        node.append(el("span", "sr-only", "You: "), el("p", "chat-msg__text", item.text));
        return node;
      }
      case "assistant": {
        const node = el("div", `chat-msg chat-msg--assistant${item.final ? "" : " chat-msg--streaming"}`);
        node.append(el("span", "sr-only", "Agent: "), el("p", "chat-msg__text", item.text));
        return node;
      }
      case "tool": {
        const node = el("div", `chat-tool chat-tool--${item.status}`);
        node.title = item.name;
        const state = el("span", "chat-tool__state");
        const srLabel = el("span", "sr-only", item.status === "running" ? "Running: " : item.status === "ok" ? "Done: " : "Failed: ");
        if (item.status === "running") {
          const spinner = el("span", "chat-spinner");
          spinner.setAttribute("aria-hidden", "true");
          state.append(spinner);
        } else {
          state.append(icon(item.status === "ok" ? "check" : "circle-x", { size: 14 }));
        }
        state.append(srLabel);
        const label = el("span", "chat-tool__label", humanizeToolName(item.name));
        node.append(state, label);
        if (item.summary) node.append(el("span", "chat-tool__summary", item.summary));
        return node;
      }
      case "error": {
        const node = el("div", "chat-note chat-note--error");
        node.append(icon("triangle-alert", { size: 14 }), el("span", "sr-only", "Error: "), el("span", undefined, item.message));
        return node;
      }
      case "stopped": {
        const node = el("div", "chat-note");
        node.append(icon("circle-x", { size: 14 }), el("span", undefined, "Stopped"));
        return node;
      }
    }
  };

  const renderLog = (forceScroll = false): void => {
    const current = active();
    const tc = current?.tc ?? null;
    const items = tc?.thread.items ?? [];
    const wasNear = nearBottom;

    if (!tc || items.length === 0) {
      log.hidden = true;
      log.replaceChildren();
      jump.hidden = true;
      main.classList.add("chat__main--empty");
      renderEmptyThread(false, current?.tabId, tc);
      return;
    }
    main.classList.remove("chat__main--empty");
    empty.replaceChildren();
    log.hidden = false;

    const seen = new Set<string>();
    const nodes: HTMLElement[] = [];
    for (const item of items) {
      seen.add(item.key);
      const sig = itemSignature(item);
      let entry = tc.dom.get(item.key);
      if (!entry || entry.sig !== sig) {
        entry = { sig, el: buildItem(item) };
        tc.dom.set(item.key, entry);
      }
      nodes.push(entry.el);
    }
    for (const key of Array.from(tc.dom.keys())) if (!seen.has(key)) tc.dom.delete(key);
    const same =
      log.children.length === nodes.length && nodes.every((node, index) => log.children[index] === node);
    if (!same) log.replaceChildren(...nodes);

    if (forceScroll || wasNear) {
      log.scrollTop = log.scrollHeight;
      nearBottom = true;
      jump.hidden = true;
    } else {
      jump.hidden = false;
    }
  };

  const clearComposerError = (): void => {
    composerError.hidden = true;
    composerError.textContent = "";
    input.removeAttribute("aria-invalid");
  };
  const showComposerError = (message: string): void => {
    composerError.textContent = message;
    composerError.hidden = false;
    input.setAttribute("aria-invalid", "true");
  };

  const renderStatusLine = (): void => {
    const current = active();
    const busy = !!current?.tc.thread.busy;
    if (!busy || !current) {
      statusLine.hidden = true;
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
      return;
    }
    const where = options.tabHost?.(current.tabId);
    const startedAt = current.tc.thread.turnStartedAt;
    const elapsed = startedAt === null ? "" : ` ${formatElapsed(now() - startedAt)}`;
    statusLine.textContent = `Working on ${where ?? "this tab"}…${elapsed}`;
    statusLine.hidden = false;
    if (timer === null) timer = window.setInterval(renderStatusLine, 1000);
  };

  const renderComposer = (): void => {
    const current = active();
    const busy = !!current?.tc.thread.busy;
    const length = input.value.length;
    const over = length > CHAT_CHAR_LIMIT;

    input.disabled = busy || !current;
    sendButton.hidden = busy;
    sendButton.disabled = sending || !current;
    stopButton.hidden = !busy;
    stopButton.disabled = !!current?.tc.stopping;
    stopButton.textContent = current?.tc.stopping ? "Stopping…" : "Stop";

    if (!current) {
      input.placeholder = "Open a tab to start chatting";
      composerHint.textContent = "Open a tab to start chatting.";
    } else if (busy) {
      input.placeholder = "The agent is working…";
      composerHint.textContent = "The agent is working. Stop it to send another message.";
    } else {
      input.placeholder = "Ask the agent to work on this page…";
      composerHint.textContent = "Enter to send, Shift+Enter for a new line.";
    }

    counter.hidden = length < CHAT_COUNTER_FROM;
    counter.textContent = `${length.toLocaleString("en-US")} / ${CHAT_CHAR_LIMIT.toLocaleString("en-US")}`;
    counter.classList.toggle("chat__counter--over", over);
    if (over) input.setAttribute("aria-invalid", "true");
    else if (composerError.hidden) input.removeAttribute("aria-invalid");
  };

  const renderAll = (forceScroll = false): void => {
    const hidePanels = renderStateBox();
    setup.hidden = hidePanels;
    main.hidden = hidePanels;
    composer.hidden = hidePanels || availableClis().length === 0;
    if (hidePanels) {
      statusLine.hidden = true;
      return;
    }
    // With no usable CLI only the refresh action and the explanation remain.
    const noCli = availableClis().length === 0;
    modelField.hidden = false;
    modelSelect.hidden = noCli;
    modelLabel.hidden = noCli;
    dirField.hidden = noCli;
    setupActions.hidden = noCli;
    buildModelOptionsIfNeeded();
    renderHeader();
    renderLog(forceScroll);
    renderStatusLine();
    renderComposer();
  };

  let optionsBuiltFor: AgentRunnerStatus | null = null;
  const buildModelOptionsIfNeeded = (): void => {
    if (optionsBuiltFor === status) return;
    optionsBuiltFor = status;
    buildModelOptions();
  };

  // ── data ──────────────────────────────────────────────────────────────────
  const loadStatus = async (refresh = false): Promise<void> => {
    statusLoading = true;
    statusError = null;
    renderAll();
    try {
      const fn = refresh ? options.bridge.refreshAgentRunner : options.bridge.getAgentRunnerStatus;
      if (typeof fn !== "function") throw new Error("This build of HelmStack doesn't include agent chat yet.");
      status = await fn.call(options.bridge);
      optionsBuiltFor = null;
    } catch (error) {
      statusError = errorText(error);
      if (refresh) toast(`Couldn't refresh agent CLIs — ${statusError}`, "error");
    } finally {
      statusLoading = false;
      renderAll();
    }
  };

  const loadTab = async (tabId: TabId): Promise<void> => {
    const tc = tabChat(tabId);
    if (tc.loaded || tc.loading) return;
    tc.loading = true;
    renderAll();
    try {
      const list = await options.bridge.listAgentConversations(tabId);
      const latest = [...(list ?? [])].sort((a, b) => b.createdAt - a.createdAt)[0];
      if (latest && !tc.conv) {
        tc.conv = latest;
        tc.thread = createThread(latest.busy);
        byConversation.set(latest.id, tc);
        const events = await options.bridge.getAgentConversationEvents(latest.id);
        applyChatEvents(tc.thread, events ?? []);
        // Live events that arrived while the replay was in flight.
        applyChatEvents(tc.thread, tc.pending);
      }
      tc.loaded = true;
    } catch (error) {
      toast(`Couldn't load the chat for this tab — ${errorText(error)}`, "error");
      tc.loaded = true;
    } finally {
      tc.pending = [];
      tc.loading = false;
      tc.dom.clear();
      renderAll(true);
    }
  };

  const ensureLoaded = (): void => {
    const current = active();
    if (current) void loadTab(current.tabId);
  };

  const announce = (text: string): void => {
    announcer.textContent = "";
    announcer.textContent = text;
  };

  // ── actions ───────────────────────────────────────────────────────────────
  const validateSelection = (): { cliId: string; model: string } | { error: string } => {
    const parsed = parseValue(selected);
    const cli = selectedCli();
    if (!parsed || !cli || !cli.available) return { error: "Choose an agent and model first." };
    if (parsed.model === CUSTOM_OPTION) {
      const problem = validateCustomModel(customInput.value);
      if (problem) {
        showCustomError(problem);
        customInput.focus();
        return { error: problem };
      }
      return { cliId: parsed.cliId, model: customInput.value.trim() };
    }
    return { cliId: parsed.cliId, model: parsed.model };
  };

  const showCustomError = (message: string | null): void => {
    customError.hidden = message === null;
    customError.textContent = message ?? "";
    if (message === null) customInput.removeAttribute("aria-invalid");
    else customInput.setAttribute("aria-invalid", "true");
  };

  const send = async (): Promise<void> => {
    const current = active();
    if (!current || sending || current.tc.thread.busy) return;
    const text = input.value.trim();
    clearComposerError();
    if (!text) {
      showComposerError("Type a message to send.");
      input.focus();
      return;
    }
    if (input.value.length > CHAT_CHAR_LIMIT) {
      showComposerError(`Messages can be up to ${CHAT_CHAR_LIMIT.toLocaleString("en-US")} characters. Shorten yours to send it.`);
      return;
    }
    if (current.tc.loading) {
      showComposerError("Still loading this conversation — try again in a moment.");
      return;
    }
    const { tabId, tc } = current;
    sending = true;
    renderComposer();
    try {
      if (!tc.conv) {
        const choice = validateSelection();
        if ("error" in choice) {
          showComposerError(choice.error);
          return;
        }
        const cli = selectedCli()!;
        if (!cli.confined) {
          if (!unconfinedSupported) {
            showComposerError(`${cli.label} can't be limited to browser tools, so it can't be started from HelmStack yet.`);
            return;
          }
          if (!ackBox.checked) {
            showComposerError("Confirm that this agent can edit files and run commands before starting.");
            ackBox.focus();
            return;
          }
        }
        const dir = dirOverride ?? undefined;
        const input_ = {
          tabId,
          cliId: choice.cliId as StartAgentConversationInput["cliId"],
          model: choice.model,
          ...(dir ? { workingDirectory: dir } : {}),
          ...(!cli.confined ? { allowUnconfined: true } : {}),
        } as StartAgentConversationInput;
        writeStorage(SELECTION_STORAGE_KEY, selected);
        let conv: AgentConversationSummary;
        try {
          conv = await options.bridge.startAgentConversation(input_);
        } catch (error) {
          showComposerError(`Couldn't start the conversation — ${errorText(error)}`);
          return;
        }
        // The conversation might have been created for a tab that's no longer active.
        tc.conv = conv;
        tc.loaded = true;
        tc.thread = createThread(conv.busy);
        tc.dom.clear();
        byConversation.set(conv.id, tc);
      }
      try {
        const { turnId } = await options.bridge.sendAgentMessage(tc.conv!.id, text);
        if (!tc.thread.finishedTurns.has(turnId) && !tc.thread.busy) {
          tc.thread.busy = true;
          tc.thread.turnId = turnId;
          tc.thread.turnStartedAt = now();
        }
        input.value = "";
        nearBottom = true;
      } catch (error) {
        showComposerError(`Couldn't send the message — ${errorText(error)}`);
      }
    } finally {
      sending = false;
      renderAll(true);
    }
  };

  const stop = async (): Promise<void> => {
    const current = active();
    if (!current?.tc.conv || !current.tc.thread.busy || current.tc.stopping) return;
    current.tc.stopping = true;
    renderComposer();
    try {
      await options.bridge.stopAgentTurn(current.tc.conv.id);
    } catch (error) {
      current.tc.stopping = false;
      toast(`Couldn't stop the agent — ${errorText(error)}`, "error");
      renderComposer();
    }
  };

  const newConversation = async (): Promise<void> => {
    const current = active();
    const conv = current?.tc.conv;
    if (!current || !conv) return;
    try {
      await options.bridge.closeAgentConversation(conv.id);
    } catch (error) {
      toast(`Couldn't close the conversation — ${errorText(error)}`, "error");
      return;
    }
    byConversation.delete(conv.id);
    current.tc.conv = null;
    current.tc.thread = createThread();
    current.tc.dom.clear();
    current.tc.stopping = false;
    clearComposerError();
    renderAll(true);
    input.focus();
  };

  // ── wiring ────────────────────────────────────────────────────────────────
  modelSelect.addEventListener("change", () => {
    selected = modelSelect.value;
    writeStorage(SELECTION_STORAGE_KEY, selected);
    ackBox.checked = false;
    showCustomError(null);
    clearComposerError();
    renderHeader();
    if (isCustom()) customInput.focus();
  });
  customInput.addEventListener("input", () => {
    // Re-validate live, but only nag once there is something to check.
    showCustomError(customInput.value ? validateCustomModel(customInput.value) : null);
  });
  customInput.addEventListener("blur", () => {
    if (customInput.value) showCustomError(validateCustomModel(customInput.value));
  });
  refreshButton.addEventListener("click", async () => {
    refreshButton.setAttribute("aria-busy", "true");
    refreshButton.disabled = true;
    try {
      await loadStatus(true);
    } finally {
      refreshButton.removeAttribute("aria-busy");
      refreshButton.disabled = false;
    }
  });
  dirChange.addEventListener("click", () => {
    dirEdit.hidden = false;
    dirInput.value = dirOverride ?? status?.defaultWorkingDirectory ?? "";
    dirInput.focus();
    dirInput.select();
  });
  const applyDir = (): void => {
    const problem = validateWorkingDirectory(dirInput.value);
    if (problem) {
      dirError.textContent = problem;
      dirError.hidden = false;
      dirInput.setAttribute("aria-invalid", "true");
      dirInput.focus();
      return;
    }
    const value = dirInput.value.trim();
    dirOverride = value === status?.defaultWorkingDirectory ? null : value;
    dirError.hidden = true;
    dirInput.removeAttribute("aria-invalid");
    dirEdit.hidden = true;
    renderHeader();
    dirChange.focus();
  };
  dirApply.addEventListener("click", applyDir);
  dirInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      applyDir();
    } else if (event.key === "Escape") {
      event.stopPropagation();
      dirCancel.click();
    }
  });
  dirCancel.addEventListener("click", () => {
    dirEdit.hidden = true;
    dirError.hidden = true;
    dirInput.removeAttribute("aria-invalid");
    dirChange.focus();
  });
  newButton.addEventListener("click", () => void newConversation());

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    void send();
  });
  input.addEventListener("input", () => {
    if (!composerError.hidden && input.value.trim()) clearComposerError();
    renderComposer();
  });
  input.addEventListener("keydown", (event) => {
    // keyCode 229 = IME still composing (older engines don't set isComposing on the final Enter).
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void send();
  });
  stopButton.addEventListener("click", () => void stop());

  log.addEventListener("scroll", () => {
    nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight <= NEAR_BOTTOM_PX;
    if (nearBottom) jump.hidden = true;
  });
  jump.addEventListener("click", () => {
    log.scrollTop = log.scrollHeight;
    nearBottom = true;
    jump.hidden = true;
    log.focus();
  });

  renderAll();

  return {
    show() {
      isShown = true;
      if (!status && !statusLoading) void loadStatus();
      ensureLoaded();
      renderAll();
    },
    refreshForTab() {
      showCustomError(null);
      clearComposerError();
      if (!isShown) return;
      nearBottom = true;
      ensureLoaded();
      renderAll(true);
    },
    handleEvent(event) {
      const tc = byConversation.get(event.conversationId);
      if (!tc) return;
      if (tc.loading) {
        tc.pending.push(event);
        return;
      }
      const changed = applyChatEvent(tc.thread, event);
      if (!changed) return;
      if (event.type === "turn_finished") tc.stopping = false;
      const current = active();
      if (!current || current.tc !== tc) return;
      if (event.type === "user_message") nearBottom = true;
      if (isShown) renderAll();
      if (event.type === "text") announce(event.text.length > 600 ? `${event.text.slice(0, 600)}…` : event.text);
      else if (event.type === "turn_finished") {
        announce(
          event.outcome === "stopped"
            ? "Agent stopped."
            : event.outcome === "error" || event.error
              ? `Agent ran into an error. ${event.error ?? ""}`.trim()
              : "Agent finished."
        );
        if (document.activeElement === document.body || document.activeElement === stopButton) input.focus();
      }
    },
    destroy() {
      if (timer !== null) window.clearInterval(timer);
    },
  };
}
