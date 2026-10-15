import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AgentChatEvent,
  AgentCliInfo,
  AgentConversationSummary,
  AgentRunnerStatus,
} from "../../../packages/shared/src/index.js";
import {
  CHAT_CHAR_LIMIT,
  EXAMPLE_PROMPTS,
  SELECTION_STORAGE_KEY,
  mountChat,
  validateCustomModel,
  validateWorkingDirectory,
  type ChatController,
} from "../src/renderer/panels/chat.js";
import { SIDE_TAB_STORAGE_KEY, mountSideTabs } from "../src/renderer/panels/side-tabs.js";
import { humanizeToolName } from "../src/renderer/ui/chat-tools.js";
import { applyChatEvent, createThread } from "../src/renderer/ui/chat-thread.js";
import { createFakeBridge, flush, loadShellDom, type FakeBridge } from "./helpers/shell-fixtures.js";

function cli(partial: Partial<AgentCliInfo> = {}): AgentCliInfo {
  return {
    id: "claude",
    label: "Claude Code",
    path: "/usr/local/bin/claude",
    version: "2.0.0",
    available: true,
    models: [
      { id: "", label: "Default", source: "configured" },
      { id: "sonnet", label: "Sonnet", source: "alias" },
    ],
    confined: true,
    experimental: false,
    supportsResume: true,
    ...partial,
  };
}

function runnerStatus(partial: Partial<AgentRunnerStatus> = {}): AgentRunnerStatus {
  return {
    enabled: true,
    clis: [
      cli(),
      cli({
        id: "gemini",
        label: "Gemini CLI",
        path: null,
        available: false,
        reason: "Not installed",
        models: [],
        experimental: true,
      }),
    ],
    defaultWorkingDirectory: "/Users/dev/project",
    ...partial,
  };
}

function summary(partial: Partial<AgentConversationSummary> = {}): AgentConversationSummary {
  return {
    id: "conv-1",
    tabId: "tab-1",
    cliId: "claude",
    model: "sonnet",
    workingDirectory: "/Users/dev/project",
    title: "Chat",
    createdAt: 1_700_000_000_000,
    busy: false,
    turnCount: 0,
    ...partial,
  };
}

let seq = 0;
function ev<T extends AgentChatEvent["type"]>(
  type: T,
  fields: Omit<Extract<AgentChatEvent, { type: T }>, "type" | "conversationId" | "seq" | "at" | "turnId"> & {
    conversationId?: string;
    turnId?: string;
    seq?: number;
  }
): AgentChatEvent {
  seq += 1;
  return { type, conversationId: "conv-1", seq, at: 1_700_000_000_000 + seq, turnId: "turn-1", ...fields } as AgentChatEvent;
}

let activeTab = "tab-1";
let fake: FakeBridge;
let chat: ChatController | null = null;
let clock = 1_700_000_000_000;

function setup(
  overrides: Record<string, (...args: never[]) => unknown> = {},
  extra: Partial<Parameters<typeof mountChat>[0]> = {}
) {
  fake = createFakeBridge({
    getAgentRunnerStatus: () => runnerStatus(),
    refreshAgentRunner: () => runnerStatus(),
    listAgentConversations: () => [],
    getAgentConversationEvents: () => [],
    startAgentConversation: () => summary(),
    sendAgentMessage: () => ({ turnId: "turn-1" }),
    stopAgentTurn: () => undefined,
    closeAgentConversation: () => undefined,
    ...overrides,
  });
  chat = mountChat({
    bridge: fake.bridge,
    activeTabId: () => activeTab,
    tabHost: () => "example.com",
    now: () => clock,
    ...extra,
  });
  return chat;
}

const q = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(`#chat-body ${sel}`)!;
const select = () => q<HTMLSelectElement>("#chat-model");
const input = () => q<HTMLTextAreaElement>("#chat-input");
const sendBtn = () => q<HTMLButtonElement>('button[type="submit"]');
const stopBtn = () => Array.from(document.querySelectorAll<HTMLButtonElement>("#chat-body button")).find((b) => b.textContent === "Stop" || b.textContent === "Stopping…")!;
const logText = () => q<HTMLElement>('[role="log"]').textContent ?? "";
const button = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("#chat-body button")).find((b) => b.textContent === label)!;

async function open(): Promise<void> {
  chat!.show();
  await flush();
}

async function type(text: string): Promise<void> {
  input().value = text;
  input().dispatchEvent(new Event("input", { bubbles: true }));
}

async function submit(): Promise<void> {
  sendBtn().click();
  await flush();
}

function key(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  input().dispatchEvent(event);
  return event;
}

describe("chat panel", () => {
  beforeEach(() => {
    loadShellDom();
    activeTab = "tab-1";
    seq = 0;
    clock = 1_700_000_000_000;
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });
  afterEach(() => {
    chat?.destroy();
    chat = null;
  });

  describe("model dropdown", () => {
    it("groups by CLI, disables unavailable CLIs with their reason, and flags experimental", async () => {
      setup();
      await open();
      const groups = Array.from(select().querySelectorAll("optgroup"));
      expect(groups.map((g) => g.label)).toEqual(["Claude Code", "Gemini CLI — Not installed, Experimental"]);
      expect(groups[1].disabled).toBe(true);
      expect(Array.from(groups[0].querySelectorAll("option")).map((o) => o.textContent)).toEqual([
        "Default",
        "Sonnet",
        "Custom model…",
      ]);
      expect(q(".badge").hidden).toBe(true);
    });

    it("shows the Experimental badge when an experimental CLI is selected", async () => {
      setup({
        getAgentRunnerStatus: () => runnerStatus({ clis: [cli({ experimental: true })] }),
      });
      await open();
      expect(q<HTMLElement>(".badge").hidden).toBe(false);
      expect(q<HTMLElement>(".badge").textContent).toBe("Experimental");
    });

    it("reveals and validates a custom model id", async () => {
      setup();
      await open();
      select().value = "claude::__custom__";
      select().dispatchEvent(new Event("change", { bubbles: true }));
      const field = q<HTMLInputElement>("#chat-custom-model");
      expect(field.closest(".field")!.hasAttribute("hidden")).toBe(false);
      field.value = "bad model!";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      expect(q<HTMLElement>("#chat-custom-model-error").hidden).toBe(false);
      expect(field.getAttribute("aria-invalid")).toBe("true");
      field.value = "claude-sonnet-4.5:beta/1";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      expect(q<HTMLElement>("#chat-custom-model-error").hidden).toBe(true);
    });

    it("does not start a conversation with an invalid custom id", async () => {
      setup();
      await open();
      select().value = "claude::__custom__";
      select().dispatchEvent(new Event("change", { bubbles: true }));
      q<HTMLInputElement>("#chat-custom-model").value = "no spaces";
      await type("hello");
      await submit();
      expect(fake.fn("startAgentConversation")).not.toHaveBeenCalled();
      expect(q<HTMLElement>("#chat-custom-model-error").hidden).toBe(false);
    });

    it("validators", () => {
      expect(validateCustomModel("")).not.toBeNull();
      expect(validateCustomModel("a".repeat(81))).not.toBeNull();
      expect(validateCustomModel("gemini-2.5-pro")).toBeNull();
      // A leading "-" could be read as a CLI flag, so it is never a valid id.
      for (const flagLike of ["--dangerously-skip-permissions", "-m", "--model"]) {
        expect(validateCustomModel(flagLike)).not.toBeNull();
      }
      expect(validateWorkingDirectory("  ")).not.toBeNull();
      expect(validateWorkingDirectory("relative/dir")).not.toBeNull();
      expect(validateWorkingDirectory("/tmp/x")).toBeNull();
      expect(validateWorkingDirectory("C:\\work")).toBeNull();
    });

    it("refresh calls the bridge and re-renders", async () => {
      setup();
      await open();
      fake.fn("refreshAgentRunner").mockResolvedValueOnce(
        runnerStatus({ clis: [cli({ models: [{ id: "opus", label: "Opus", source: "alias" }] })] })
      );
      button("Refresh").click();
      await flush();
      expect(fake.fn("refreshAgentRunner")).toHaveBeenCalledTimes(1);
      expect(Array.from(select().querySelectorAll("option")).map((o) => o.textContent)).toContain("Opus");
    });
  });

  describe("empty states", () => {
    it("shows the reason instead of controls when the runner is disabled", async () => {
      setup({ getAgentRunnerStatus: () => runnerStatus({ enabled: false, reason: "The MCP server entry wasn't found." }) });
      await open();
      expect(q<HTMLElement>(".chat__state").textContent).toContain("The MCP server entry wasn't found.");
      expect(q<HTMLElement>(".chat__setup").hidden).toBe(true);
      expect(q<HTMLElement>(".chat__composer").hidden).toBe(true);
    });

    it("explains how to install a CLI when none is detected", async () => {
      setup({ getAgentRunnerStatus: () => runnerStatus({ clis: [cli({ available: false, reason: "Not installed" })] }) });
      await open();
      expect(document.querySelector("#chat-body")!.textContent).toContain("No agent CLI found");
      expect(document.querySelector("#chat-body")!.textContent).toContain("Claude Code or Gemini CLI");
      expect(q<HTMLElement>(".chat__composer").hidden).toBe(true);
      expect(button("Refresh")).toBeTruthy();
    });

    it("degrades when the bridge has no chat methods", async () => {
      fake = createFakeBridge();
      const bridge = { ...({} as object) } as never;
      chat = mountChat({ bridge, activeTabId: () => activeTab });
      await open();
      expect(document.querySelector("#chat-body")!.textContent).toContain("isn't available");
    });

    it("offers example prompts that fill the composer", async () => {
      setup();
      await open();
      const prompt = button(EXAMPLE_PROMPTS[2]);
      prompt.click();
      expect(input().value).toBe("Run an SEO audit");
    });
  });

  describe("conversation lifecycle", () => {
    it("starts the conversation lazily on the first message with tab, CLI and model", async () => {
      setup();
      await open();
      expect(fake.fn("startAgentConversation")).not.toHaveBeenCalled();
      select().value = "claude::sonnet";
      select().dispatchEvent(new Event("change", { bubbles: true }));
      await type("Run an SEO audit");
      await submit();
      expect(fake.fn("startAgentConversation")).toHaveBeenCalledWith({ tabId: "tab-1", cliId: "claude", model: "sonnet" });
      expect(fake.fn("sendAgentMessage")).toHaveBeenCalledWith("conv-1", "Run an SEO audit");
      expect(input().value).toBe("");
      expect(select().disabled).toBe(true);
      // Second message reuses the conversation (after the turn finishes).
      chat!.handleEvent(ev("turn_finished", { outcome: "completed" }));
      await type("again");
      await submit();
      expect(fake.fn("startAgentConversation")).toHaveBeenCalledTimes(1);
      expect(fake.fn("sendAgentMessage")).toHaveBeenLastCalledWith("conv-1", "again");
    });

    it("passes a typed working directory override", async () => {
      setup();
      await open();
      button("Change…").click();
      const dir = q<HTMLInputElement>("#chat-dir-input");
      dir.value = "";
      button("Use this folder").click();
      expect(q<HTMLElement>("#chat-dir-error").hidden).toBe(false);
      dir.value = "relative";
      button("Use this folder").click();
      expect(q<HTMLElement>("#chat-dir-error").textContent).toContain("absolute");
      dir.value = "/work/app";
      button("Use this folder").click();
      await type("hi");
      await submit();
      expect(fake.fn("startAgentConversation")).toHaveBeenCalledWith(
        expect.objectContaining({ workingDirectory: "/work/app" })
      );
    });

    it("New conversation closes the current one and re-enables the picker", async () => {
      setup();
      await open();
      await type("hi");
      await submit();
      chat!.handleEvent(ev("turn_finished", { outcome: "completed" }));
      button("New conversation").click();
      await flush();
      expect(fake.fn("closeAgentConversation")).toHaveBeenCalledWith("conv-1");
      expect(select().disabled).toBe(false);
      expect(logText()).toBe("");
    });

    it("shows a start failure inline and keeps the draft", async () => {
      setup({
        startAgentConversation: () => {
          throw new Error("binary vanished");
        },
      });
      await open();
      await type("hi");
      await submit();
      expect(q<HTMLElement>("#chat-composer-error").textContent).toContain("binary vanished");
      expect(input().value).toBe("hi");
    });
  });

  describe("streaming thread", () => {
    async function started() {
      setup();
      await open();
      await type("go");
      await submit();
    }

    it("renders user text, streams deltas and replaces them with the final text", async () => {
      await started();
      chat!.handleEvent(ev("user_message", { text: "go" }));
      chat!.handleEvent(ev("turn_started", {}));
      chat!.handleEvent(ev("text_delta", { text: "Hel" }));
      chat!.handleEvent(ev("text_delta", { text: "lo" }));
      expect(logText()).toContain("Hello");
      expect(document.querySelectorAll(".chat-msg--streaming")).toHaveLength(1);
      chat!.handleEvent(ev("text", { text: "Hello, world." }));
      expect(document.querySelectorAll(".chat-msg--assistant")).toHaveLength(1);
      expect(document.querySelectorAll(".chat-msg--streaming")).toHaveLength(0);
      expect(logText()).toContain("Hello, world.");
      expect(logText()).not.toContain("Hello, world.Hello");
    });

    it("announces only the final text and turn finished, not deltas", async () => {
      await started();
      const announcer = document.querySelector<HTMLElement>('#chat-body [role="status"]')!;
      chat!.handleEvent(ev("text_delta", { text: "partial" }));
      expect(announcer.textContent).toBe("");
      chat!.handleEvent(ev("text", { text: "All done here" }));
      expect(announcer.textContent).toBe("All done here");
      chat!.handleEvent(ev("turn_finished", { outcome: "completed" }));
      expect(announcer.textContent).toBe("Agent finished.");
      expect(q<HTMLElement>('[role="log"]').getAttribute("aria-live")).toBe("off");
    });

    it("moves a tool chip from running to ok / error and humanizes names", async () => {
      await started();
      chat!.handleEvent(ev("tool_call", { callId: "c1", name: "mcp__helmstack__browser_a11y_audit", status: "running" }));
      const chip = () => document.querySelector<HTMLElement>(".chat-tool")!;
      expect(chip().classList.contains("chat-tool--running")).toBe(true);
      expect(chip().textContent).toContain("Accessibility audit");
      expect(chip().querySelector(".chat-spinner")).not.toBeNull();
      chat!.handleEvent(ev("tool_call", { callId: "c1", name: "mcp__helmstack__browser_a11y_audit", status: "ok", summary: "4 issues" }));
      expect(document.querySelectorAll(".chat-tool")).toHaveLength(1);
      expect(chip().classList.contains("chat-tool--ok")).toBe(true);
      expect(chip().textContent).toContain("4 issues");
      chat!.handleEvent(ev("tool_call", { callId: "c2", name: "Bash", status: "error" }));
      const second = document.querySelectorAll(".chat-tool")[1];
      expect(second.classList.contains("chat-tool--error")).toBe(true);
      expect(second.textContent).toContain("Bash");
    });

    it("humanizeToolName falls back to the raw name", () => {
      expect(humanizeToolName("browser_viewport_suite")).toBe("Viewport suite");
      expect(humanizeToolName("mcp__helmstack__browser_screenshot")).toBe("Screenshot");
      expect(humanizeToolName("mcp__other__something_new")).toBe("mcp__other__something_new");
      expect(humanizeToolName("toString")).toBe("toString");
    });

    it("shows error and stopped rows", async () => {
      await started();
      chat!.handleEvent(ev("turn_finished", { outcome: "error", error: "The CLI exited unexpectedly." }));
      expect(document.querySelector(".chat-note--error")!.textContent).toContain("The CLI exited unexpectedly.");
      await type("retry");
      await submit();
      chat!.handleEvent(ev("turn_finished", { turnId: "turn-2", outcome: "stopped" }));
      expect(logText()).toContain("Stopped");
    });

    it("never renders model text as HTML", async () => {
      await started();
      chat!.handleEvent(ev("text", { text: '<img src=x onerror="window.pwned=1"><b>bold</b>\nline two' }));
      chat!.handleEvent(ev("user_message", { text: "<script>window.pwned=1</script>" }));
      const log = q<HTMLElement>('[role="log"]');
      expect(log.querySelector("img, b, script")).toBeNull();
      expect(log.textContent).toContain("<b>bold</b>");
      expect(log.textContent).toContain("line two");
    });

    it("ignores duplicate or out-of-date events", async () => {
      await started();
      const delta = ev("text_delta", { text: "x" });
      chat!.handleEvent(delta);
      chat!.handleEvent(delta);
      expect(logText().match(/x/g)).toHaveLength(1);
    });
  });

  describe("busy state", () => {
    it("replaces Send with Stop, disables the composer with an explanation, and stops via the bridge", async () => {
      setup();
      await open();
      await type("work");
      await submit();
      expect(sendBtn().hidden).toBe(true);
      expect(stopBtn().hidden).toBe(false);
      expect(input().disabled).toBe(true);
      expect(q<HTMLElement>("#chat-hint").textContent).toContain("Stop it to send another message");
      expect(q<HTMLElement>(".chat__status").textContent).toContain("Working on example.com");
      stopBtn().click();
      await flush();
      expect(fake.fn("stopAgentTurn")).toHaveBeenCalledWith("conv-1");
      chat!.handleEvent(ev("turn_finished", { outcome: "stopped" }));
      expect(stopBtn().hidden).toBe(true);
      expect(input().disabled).toBe(false);
    });

    it("shows elapsed time in the status line", async () => {
      setup();
      await open();
      await type("work");
      await submit();
      chat!.handleEvent(ev("turn_started", { at: clock - 65_000 } as never));
      expect(q<HTMLElement>(".chat__status").textContent).toBe("Working on example.com… 1m 05s");
    });
  });

  describe("composer", () => {
    it("Enter sends, Shift+Enter does not, IME composition does not", async () => {
      setup();
      await open();
      await type("hello");
      expect(key({ key: "Enter", shiftKey: true }).defaultPrevented).toBe(false);
      expect(key({ key: "Enter", isComposing: true }).defaultPrevented).toBe(false);
      expect(key({ key: "Enter", keyCode: 229 }).defaultPrevented).toBe(false);
      expect(fake.fn("sendAgentMessage")).not.toHaveBeenCalled();
      expect(key({ key: "Enter" }).defaultPrevented).toBe(true);
      await flush();
      expect(fake.fn("sendAgentMessage")).toHaveBeenCalledWith("conv-1", "hello");
    });

    it("validates an empty submit inline", async () => {
      setup();
      await open();
      await type("   ");
      await submit();
      expect(q<HTMLElement>("#chat-composer-error").textContent).toBe("Type a message to send.");
      expect(fake.fn("startAgentConversation")).not.toHaveBeenCalled();
    });

    it("shows a counter near the limit and blocks messages over it", async () => {
      setup();
      await open();
      await type("a".repeat(100));
      expect(q<HTMLElement>(".chat__counter").hidden).toBe(true);
      await type("a".repeat(7500));
      expect(q<HTMLElement>(".chat__counter").hidden).toBe(false);
      expect(q<HTMLElement>(".chat__counter").textContent).toBe("7,500 / 8,000");
      await type("a".repeat(CHAT_CHAR_LIMIT + 1));
      await submit();
      expect(q<HTMLElement>("#chat-composer-error").hidden).toBe(false);
      expect(fake.fn("startAgentConversation")).not.toHaveBeenCalled();
    });
  });

  describe("per-tab threads", () => {
    it("replays a tab's conversation and switches threads with the active tab", async () => {
      setup({
        listAgentConversations: ((tabId: string) =>
          tabId === "tab-1" ? [summary()] : tabId === "tab-2" ? [summary({ id: "conv-2", tabId: "tab-2" })] : []) as never,
        getAgentConversationEvents: ((id: string) =>
          id === "conv-1"
            ? [ev("user_message", { text: "first tab question" }), ev("text", { text: "first tab answer" })]
            : [
                ev("user_message", { conversationId: "conv-2", text: "second tab question" }),
              ]) as never,
      });
      await open();
      expect(fake.fn("listAgentConversations")).toHaveBeenCalledWith("tab-1");
      expect(logText()).toContain("first tab answer");

      activeTab = "tab-2";
      chat!.refreshForTab();
      await flush();
      expect(logText()).toContain("second tab question");
      expect(logText()).not.toContain("first tab");

      // A live event for the hidden thread doesn't leak into the visible one.
      chat!.handleEvent(ev("text", { text: "late tab-1 text" }));
      expect(logText()).not.toContain("late tab-1 text");

      activeTab = "tab-1";
      chat!.refreshForTab();
      await flush();
      expect(logText()).toContain("late tab-1 text");
      expect(fake.fn("listAgentConversations")).toHaveBeenCalledTimes(2); // cached on return
    });

    it("keeps live events that arrive during replay", async () => {
      let release!: (events: AgentChatEvent[]) => void;
      const replay = new Promise<AgentChatEvent[]>((resolve) => (release = resolve));
      setup({
        listAgentConversations: () => [summary({ busy: true })],
        getAgentConversationEvents: () => replay as never,
      });
      await open();
      const old = ev("user_message", { text: "old question" });
      const live = ev("text_delta", { text: "live bit" });
      chat!.handleEvent(live);
      release([old]);
      await flush();
      expect(logText()).toContain("old question");
      expect(logText()).toContain("live bit");
    });
  });

  describe("unconfined CLIs", () => {
    const unconfined = () =>
      runnerStatus({ clis: [cli({ confined: false, label: "Wild CLI" })] });

    it("never starts them when the contract has no allowUnconfined", async () => {
      setup({ getAgentRunnerStatus: unconfined }, { unconfinedSupported: false });
      await open();
      expect(document.querySelector("#chat-body")!.textContent).toContain("can't be limited to browser tools");
      await type("hi");
      await submit();
      expect(fake.fn("startAgentConversation")).not.toHaveBeenCalled();
      expect(q<HTMLElement>("#chat-composer-error").hidden).toBe(false);
    });

    it("requires the acknowledgement checkbox when supported, then sends allowUnconfined", async () => {
      setup({ getAgentRunnerStatus: unconfined }, { unconfinedSupported: true });
      await open();
      const ack = q<HTMLInputElement>("#chat-ack");
      expect(ack.closest("label")!.hidden).toBe(false);
      expect(ack.closest("label")!.textContent).toBe(
        "This agent can edit files and run commands, not just control the browser."
      );
      await type("hi");
      await submit();
      expect(fake.fn("startAgentConversation")).not.toHaveBeenCalled();
      ack.checked = true;
      await submit();
      expect(fake.fn("startAgentConversation")).toHaveBeenCalledWith(
        expect.objectContaining({ allowUnconfined: true })
      );
    });
  });

  describe("scrolling", () => {
    it("shows Jump to latest instead of scrolling when the user is away from the bottom", async () => {
      setup({ listAgentConversations: () => [summary({ busy: true })] });
      await open();
      const log = q<HTMLElement>('[role="log"]');
      Object.defineProperty(log, "scrollHeight", { configurable: true, value: 1000 });
      Object.defineProperty(log, "clientHeight", { configurable: true, value: 200 });
      log.scrollTop = 100;
      log.dispatchEvent(new Event("scroll"));
      chat!.handleEvent(ev("text", { text: "new content" }));
      expect(q<HTMLElement>(".chat__jump").hidden).toBe(false);
      expect(log.scrollTop).toBe(100);
      q<HTMLElement>(".chat__jump").click();
      expect(log.scrollTop).toBe(1000);
      expect(q<HTMLElement>(".chat__jump").hidden).toBe(true);
    });
  });
});

describe("chat thread reducer", () => {
  it("marks lingering running tools when a turn ends", () => {
    const thread = createThread();
    applyChatEvent(thread, { type: "tool_call", conversationId: "c", seq: 1, at: 1, turnId: "t", callId: "x", name: "n", status: "running" });
    applyChatEvent(thread, { type: "turn_finished", conversationId: "c", seq: 2, at: 2, turnId: "t", outcome: "error", error: "boom" });
    expect(thread.items.map((i) => i.kind)).toEqual(["tool", "error"]);
    expect(thread.items[0]).toMatchObject({ status: "error" });
    expect(thread.busy).toBe(false);
  });
});

describe("side tabs", () => {
  beforeEach(() => {
    loadShellDom();
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it("is a labelled tablist with a roving tabindex and shows the activity panel by default", () => {
    mountSideTabs();
    const list = document.getElementById("side-tabs")!;
    expect(list.getAttribute("role")).toBe("tablist");
    expect(list.getAttribute("aria-label")).toBeTruthy();
    const [activity, chatTab] = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(activity.getAttribute("aria-selected")).toBe("true");
    expect(activity.tabIndex).toBe(0);
    expect(chatTab.tabIndex).toBe(-1);
    expect(document.getElementById("chat-body")!.hidden).toBe(true);
  });

  it("switches to Chat, remembers it, and restores it on mount", () => {
    const onChange = vi.fn();
    mountSideTabs({ onChange });
    document.getElementById("side-tab-chat")!.click();
    expect(onChange).toHaveBeenLastCalledWith("chat");
    expect(document.getElementById("chat-body")!.hidden).toBe(false);
    expect(document.getElementById("activity-panel")!.dataset.panel).toBe("chat");
    expect(localStorage.getItem(SIDE_TAB_STORAGE_KEY)).toBe("chat");

    loadShellDom();
    const restored = vi.fn();
    mountSideTabs({ onChange: restored });
    expect(document.getElementById("side-tab-chat")!.getAttribute("aria-selected")).toBe("true");
    expect(restored).toHaveBeenCalledWith("chat");
  });

  it("survives unavailable storage", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const setSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const tabs = mountSideTabs();
    expect(() => tabs.select("chat")).not.toThrow();
    spy.mockRestore();
    setSpy.mockRestore();
  });

  it("remembers the model selection key", () => {
    expect(SELECTION_STORAGE_KEY).toContain("chat");
  });
});
