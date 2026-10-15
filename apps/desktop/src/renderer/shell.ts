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
import { mountOverridesStrip } from "./panels/overrides.js";
import { mountApprovals } from "./panels/approvals.js";
import { mountActivity } from "./panels/activity.js";
import { mountChat } from "./panels/chat.js";
import { mountSideTabs } from "./panels/side-tabs.js";
import { mountSettings } from "./panels/settings.js";
import { mountHandoff } from "./panels/handoff.js";
import { mountAddressBar } from "./panels/address-bar.js";

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
  const addressBar = mountAddressBar({
    input: addressInput,
    currentValue: () => {
      const tab = activeTab();
      return tab ? (pendingAddressValue ?? tab.url) : undefined;
    },
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
  const connection = mountConnection({
    onPopoverOpen: overlayOpened("connection"),
    onPopoverClose: overlayClosed("connection"),
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
    tabs = next;
    tabLabels.remember(next);
    renderTabStrip(tabsNode, tabs, activity.agentsByTab(), {
      onActivate: (tab) => void bridge.focusTab(tab.id).then(renderTabs),
      onClose: (tab) => void bridge.closeTab(tab.id).then(renderTabs),
    });

    const current = activeTab();
    if (current && current.status !== "loading") {
      pendingAddressValue = null;
    }
    addressBar.sync();
    approvals.tabsChanged();
    if (current?.id !== previousActive) {
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
  mountSideTabs({ onChange: (panel) => panel === "chat" && chat.show() });

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
  for (const id of ["override-strip", "approval-banner", "activity-panel"]) {
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
    viewport.stabilize(1200, 120);
  });

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
