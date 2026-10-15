/**
 * Desktop shell entry: wires the tab strip, address bar, "Select for agent",
 * and the agent-status panels (connection, overrides, approvals, activity,
 * settings, handoff) to `window.browserShell`, and keeps the native page view
 * glued to `#viewport-frame` as the chrome around it changes.
 */

import type { AgentConnectionStatus, TabSummary } from "../../../../packages/shared/src/index.js";
import { toast } from "./ui/toast.js";
import { attachRovingKeys } from "./ui/roving.js";
import { initTheme } from "./ui/theme.js";
import { icon } from "./ui/icons.js";
import { normalizeNavigationTarget, safeHostLabel } from "./ui/format.js";
import { createTabLabelCache } from "./ui/tab-labels.js";
import { createViewportSync } from "./panels/viewport-sync.js";
import { renderTabStrip } from "./panels/tabs.js";
import { mountConnection } from "./panels/connection.js";
import { mountMcpInstall } from "./panels/mcp-install.js";
import { mountOverridesStrip } from "./panels/overrides.js";
import { mountApprovals } from "./panels/approvals.js";
import { mountActivity } from "./panels/activity.js";
import { mountChat } from "./panels/chat.js";
import { mountSideTabs } from "./panels/side-tabs.js";
import { mountSettings } from "./panels/settings.js";
import { mountHandoff } from "./panels/handoff.js";
import { mountAddressBar } from "./panels/address-bar.js";
import { mountNavControls } from "./panels/nav-controls.js";
import { mountFindBar } from "./panels/find-bar.js";
import { mountShortcutsDialog } from "./panels/shortcuts-dialog.js";
import { detectShortcutPlatform } from "../../../../packages/shared/src/shortcuts.js";

// Apply the resolved theme as early as possible to minimise a flash of the
// default (dark) chrome before the renderer paints.
const themeController = initTheme();

declare global {
  interface Window {
    browserShell: import("../../../../packages/shared/src/index.js").BrowserShellBridge;
  }
}

function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Shell markup missing: #${id}`);
  return el as T;
}

async function bootstrap(): Promise<void> {
  const bridge = window.browserShell;
  const tabsNode = must<HTMLElement>("tabs");
  const addressForm = must<HTMLFormElement>("address-form");
  const addressInput = must<HTMLInputElement>("address-input");
  const pickButton = must<HTMLButtonElement>("pick-button");
  const viewportFrame = must<HTMLElement>("viewport-frame");

  let tabs: TabSummary[] = [];
  let pendingAddressValue: string | null = null;

  const activeTab = (): TabSummary | undefined => tabs.find((tab) => tab.isActive);
  // Remembers labels of closed tabs too, so the feed never shows a raw tab id.
  const tabLabels = createTabLabelCache();
  const tabLabel = (tabId: string): string | undefined => tabLabels.label(tabId);
  const platform = detectShortcutPlatform(navigator.platform);
  const focusPage = (): void => {
    void bridge.focusPage?.().catch(() => {});
  };
  const addressBar = mountAddressBar({
    input: addressInput,
    currentValue: () => {
      const tab = activeTab();
      return tab ? (pendingAddressValue ?? tab.url) : undefined;
    },
    onDismiss: focusPage,
  });

  // ── viewport sync ─────────────────────────────────────────────────────────
  const viewport = createViewportSync({
    frame: viewportFrame,
    freeze: document.getElementById("viewport-freeze") as HTMLImageElement | null,
    bridge,
    activeTabId: () => activeTab()?.id,
    emulatedSize: () => overrides.viewportOverride(),
  });
  const overlayOpened = (key: string) => () => void viewport.occlude(key);
  const overlayClosed = (key: string) => () => viewport.release(key);

  // ── panels ────────────────────────────────────────────────────────────────
  const connectAgents: { open: () => void } = { open: () => undefined };
  const connection = mountConnection({
    onPopoverOpen: overlayOpened("connection"),
    onPopoverClose: overlayClosed("connection"),
    onConnectAgents: () => connectAgents.open(),
  });

  const overrides = mountOverridesStrip({
    bridge,
    onLayoutChange: viewport.queue,
    onPopoverOpen: (key) => void viewport.occlude(key),
    onPopoverClose: (key) => viewport.release(key),
    fallbackFocus: () => addressInput,
  });

  const handoff = mountHandoff({
    bridge,
    onOpen: overlayOpened("handoff"),
    onClose: overlayClosed("handoff"),
  });

  const approvals = mountApprovals({
    bridge,
    tabLabel,
    tabUrl: (tabId) => tabs.find((tab) => tab.id === tabId)?.url,
    onLayoutChange: viewport.queue,
    onDialogOpen: overlayOpened("approval"),
    onDialogClose: overlayClosed("approval"),
    // Never the address bar: focusing it would look like the human is about to type.
    fallbackFocus: () => document.getElementById("activity-panel"),
    onResult: (result) => {
      if (result.status === "awaiting_human") {
        const tab = activeTab();
        handoff.show({
          requestId: result.requestId,
          tabId: tab?.id ?? "",
          relatedTabIds: tab ? [tab.id] : [],
          reason: result.reason,
          origin: tab ? safeHostLabel(tab.url) : undefined,
          title: tab?.title,
          createdAt: Date.now(),
        });
      }
    },
  });

  const renderTabs = (next: TabSummary[]): void => {
    const previousActive = activeTab()?.id;
    const wasLoading = activeTab()?.status === "loading";
    tabs = next;
    tabLabels.remember(next);
    renderTabStrip(tabsNode, tabs, activity.agentsByTab(), {
      onActivate: (tab) => void bridge.focusTab(tab.id).then(renderTabs),
      onClose: (tab) => void bridge.closeTab(tab.id).then(renderTabs),
    });

    const current = activeTab();
    if (wasLoading && current && current.id === previousActive && current.status !== "loading") {
      findBar.pageLoaded(current.id);
    }
    if (current && current.status !== "loading") {
      pendingAddressValue = null;
    }
    addressBar.sync();
    navControls.sync();
    approvals.tabsChanged();
    if (current?.id !== previousActive) {
      findBar.tabChanged(previousActive);
      void overrides.setActiveTab(current?.id);
      activity.refreshForTab();
      chat.refreshForTab();
    }
    viewport.queue();
  };

  const activity = mountActivity({
    bridge,
    activeTabId: () => activeTab()?.id,
    tabLabel,
    onLayoutChange: () => viewport.stabilize(400, 60),
    onAgentsByTabChange: () => renderTabs(tabs),
    onShowConnection: () => connection.open(),
  });

  const chat = mountChat({
    bridge,
    activeTabId: () => activeTab()?.id,
    tabHost: (tabId) => {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      return tab ? safeHostLabel(tab.url) : undefined;
    },
  });
  const sideTabs = mountSideTabs({ onChange: (panel) => panel === "chat" && chat.show() });

  const navControls = mountNavControls({
    bridge,
    platform,
    activeTab,
    onTabs: (next) => renderTabs(next),
  });

  const findBar = mountFindBar({
    bridge,
    platform,
    activeTabId: () => activeTab()?.id,
    onLayoutChange: () => viewport.stabilize(400, 60),
    onClosed: focusPage,
  });

  const shortcutsDialog = mountShortcutsDialog({
    platform,
    onOpen: overlayOpened("shortcuts"),
    onClose: overlayClosed("shortcuts"),
    focusPage,
  });

  const mcpInstall = mountMcpInstall({
    bridge,
    onOpen: overlayOpened("mcp-install"),
    onClose: overlayClosed("mcp-install"),
  });
  connectAgents.open = () => void mcpInstall.open();

  const settings = mountSettings({
    bridge,
    onOpen: overlayOpened("settings"),
    onClose: overlayClosed("settings"),
  });

  const applyConnectionStatus = (status: AgentConnectionStatus): void => {
    connection.update(status);
    activity.setConnection(status);
    activity.setIntentListeners(status.intentListeners);
    settings.setProfile(status.profile);
  };

  // Chrome regions that can move/resize the page area.
  for (const id of ["override-strip", "approval-banner", "activity-panel", "find-bar"]) {
    const el = document.getElementById(id);
    if (el) viewport.observe(el);
  }

  // ── static chrome ─────────────────────────────────────────────────────────
  must<HTMLElement>("new-tab-button").replaceChildren(icon("plus", { size: 16 }));
  pickButton.prepend(icon("crosshair", { size: 16 }));

  const themeToggle = must<HTMLButtonElement>("theme-toggle");
  const renderThemeIcon = (): void => {
    themeToggle.replaceChildren(icon(themeController.resolved() === "dark" ? "sun" : "moon"));
  };
  renderThemeIcon();
  themeToggle.addEventListener("click", () => {
    themeController.toggle();
    renderThemeIcon();
  });

  // ── tabs ──────────────────────────────────────────────────────────────────
  attachRovingKeys(tabsNode, '[role="tab"]', { orientation: "horizontal", wrap: true });
  tabsNode.addEventListener("keydown", async (event) => {
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    const items = Array.from(tabsNode.querySelectorAll<HTMLElement>('[role="tab"]'));
    const index = items.findIndex((el) => el === document.activeElement);
    const target = tabs[index];
    if (index < 0 || !target) return;
    event.preventDefault();
    renderTabs(await bridge.closeTab(target.id));
  });

  must<HTMLButtonElement>("new-tab-button").addEventListener("click", async () => {
    renderTabs(await bridge.openTab("https://example.com"));
    viewport.stabilize(1200, 120);
  });

  // ── address bar ───────────────────────────────────────────────────────────
  addressForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const target = normalizeNavigationTarget(addressInput.value);
    const tab = activeTab();
    if (!target || !tab) return;
    addressBar.markSubmitted();
    pendingAddressValue = target;
    addressInput.value = target;
    try {
      renderTabs(await bridge.navigate(tab.id, target));
    } catch (error) {
      toast(`Couldn't open ${target} — ${error instanceof Error ? error.message : String(error)}`, "error");
    }
    focusPage();
    viewport.stabilize(1200, 120);
  });

  // ── keyboard shortcuts routed from the main process ───────────────────────
  const togglePickShortcut = (): void => {
    if (!pickButton.disabled) pickButton.click();
  };
  bridge.onShortcut((id) => {
    switch (id) {
      case "focus-address":
        addressBar.focusAndSelect();
        break;
      case "find":
        findBar.open();
        break;
      case "find-next":
        findBar.step(true);
        break;
      case "find-previous":
        findBar.step(false);
        break;
      case "toggle-agent-panel":
        activity.setCollapsed(!activity.isCollapsed());
        viewport.stabilize(400, 60);
        break;
      case "focus-chat":
        activity.setCollapsed(false);
        sideTabs.select("chat");
        document.getElementById("chat-input")?.focus();
        break;
      case "select-for-agent":
        togglePickShortcut();
        break;
      case "show-shortcuts":
        shortcutsDialog.open();
        break;
      default:
        break;
    }
  });
  bridge.onFindResult((result) => findBar.handleResult(result));

  // ── select for agent ──────────────────────────────────────────────────────
  pickButton.addEventListener("click", async () => {
    const tab = activeTab();
    if (!tab || pickButton.getAttribute("aria-busy") === "true") return;
    pickButton.setAttribute("aria-busy", "true");
    toast("Click an element in the page to select it (Esc to cancel).");
    try {
      const pick = await bridge.pickElement(tab.id);
      if (!pick.picked) {
        toast("Selection cancelled.");
        return;
      }
      // Main records the pick in the core; agents read it via the API / MCP.
      toast(`Selected <${pick.tagName.toLowerCase()}>. Your agent can now read it.`, "success");
    } catch (error) {
      toast(`Couldn't select an element — ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      pickButton.removeAttribute("aria-busy");
    }
  });

  // ── window-level layout ───────────────────────────────────────────────────
  window.addEventListener("resize", () => viewport.stabilize(1200, 120));
  window.addEventListener("load", () => viewport.stabilize(1600, 120));

  // ── events ────────────────────────────────────────────────────────────────
  bridge.onTabsChanged(renderTabs);
  bridge.onHandoffRequested((record) => handoff.show(record));
  bridge.onAgentLog((entry) => activity.addLog(entry));
  bridge.onApprovalsChanged((pending) => approvals.update(pending));
  bridge.onTabOverridesChanged((next) => overrides.update(next));
  bridge.onAgentActivity((entry) => activity.addActivity(entry));
  bridge.onConnectionStatusChanged(applyConnectionStatus);
  // Absent until the agent runner lands in preload.
  if (typeof bridge.onAgentChatEvent === "function") bridge.onAgentChatEvent((event) => chat.handleEvent(event));

  // ── initial state ─────────────────────────────────────────────────────────
  renderTabs(await bridge.listTabs());
  viewport.stabilize();

  const [status, entries] = await Promise.allSettled([
    bridge.getConnectionStatus(),
    bridge.listAgentActivity(),
    approvals.refresh(),
  ]);
  if (status.status === "fulfilled") applyConnectionStatus(status.value);
  if (entries.status === "fulfilled") activity.setActivity(entries.value);
}

void bootstrap().catch((error: unknown) => {
  toast(`The shell failed to start — ${error instanceof Error ? error.message : String(error)}`, "error");
});
