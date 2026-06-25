import type {
  AgentLogEntry,
  BrowserCommandResult,
  BrowserPerceptionPacket,
  HumanHandoffRecord,
  PageGraph,
  PageObservation,
  PerceptionResult,
  TabSummary,
  VaultSecretSummary,
  ViewportRect
} from "../../../../packages/shared/src/index.js";
import { validateAccountForm, type AccountFormValues, type FieldError } from "./ui/validate.js";
import { buildEmptyState, buildSkeletonRows } from "./ui/states.js";
import { openDialog, type DialogHandle } from "./ui/dialog.js";
import { toast } from "./ui/toast.js";
import { attachRovingKeys } from "./ui/roving.js";
import { createMenu } from "./ui/menu.js";
import { initTheme } from "./ui/theme.js";

// Apply the resolved theme as early as possible to minimise a flash of the
// default (dark) chrome before the renderer paints.
const themeController = initTheme();

declare global {
  interface Window {
    browserShell: import("../../../../packages/shared/src/index.js").BrowserShellBridge;
  }
}

const tabsNode = document.getElementById("tabs");
const addressForm = document.getElementById("address-form") as HTMLFormElement | null;
const addressInput = document.getElementById("address-input") as HTMLInputElement | null;
const newTabButton = document.getElementById("new-tab-button") as HTMLButtonElement | null;
const snapshotButton = document.getElementById("snapshot-button") as HTMLButtonElement | null;
const inspectButton = document.getElementById("inspect-button") as HTMLButtonElement | null;
const fixtureOpenButton = document.getElementById("fixture-open-button") as HTMLButtonElement | null;
const fixtureRunButton = document.getElementById("fixture-run-button") as HTMLButtonElement | null;
const snapshotOutput = document.getElementById("snapshot-output") as HTMLPreElement | null;
const viewportFrame = document.getElementById("viewport-frame");
const fixtureStatus = document.getElementById("fixture-status");
const vaultList = document.getElementById("vault-list");
const accountsList = document.getElementById("accounts-list");
const accountForm = document.getElementById("account-form") as HTMLFormElement | null;
const accountLabelInput = document.getElementById("account-label") as HTMLInputElement | null;
const accountOriginInput = document.getElementById("account-origin") as HTMLInputElement | null;
const accountUsernameInput = document.getElementById("account-username") as HTMLInputElement | null;
const accountPasswordInput = document.getElementById("account-password") as HTMLInputElement | null;
const accountTotpInput = document.getElementById("account-totp") as HTMLInputElement | null;

type AccountFieldKey = keyof AccountFormValues;
const accountFieldInputs: Partial<Record<AccountFieldKey, HTMLInputElement | null>> = {
  label: accountLabelInput,
  origin: accountOriginInput,
  username: accountUsernameInput,
  password: accountPasswordInput,
};
const accountFieldErrorNodes: Partial<Record<AccountFieldKey, HTMLElement | null>> = {
  label: document.getElementById("account-label-error"),
  origin: document.getElementById("account-origin-error"),
  username: document.getElementById("account-username-error"),
  password: document.getElementById("account-password-error"),
};

function clearAccountFieldError(field: AccountFieldKey): void {
  accountFieldInputs[field]?.removeAttribute("aria-invalid");
  const node = accountFieldErrorNodes[field];
  if (node) {
    node.textContent = "";
    node.hidden = true;
  }
}

/** Paints (or clears) inline errors and focuses the first invalid field. */
function showAccountFieldErrors(errors: FieldError[]): void {
  for (const field of Object.keys(accountFieldInputs) as AccountFieldKey[]) {
    clearAccountFieldError(field);
  }
  for (const { field, message } of errors) {
    accountFieldInputs[field]?.setAttribute("aria-invalid", "true");
    const node = accountFieldErrorNodes[field];
    if (node) {
      node.textContent = message;
      node.hidden = false;
    }
  }
  if (errors.length > 0) {
    accountFieldInputs[errors[0].field]?.focus();
  }
}

const approvalModal = document.getElementById("approval-modal");
const approvalCopy = document.getElementById("approval-copy");
const approvalEffects = document.getElementById("approval-effects");
const approvalApproveButton = document.getElementById("approval-approve-button") as HTMLButtonElement | null;
const approvalRejectButton = document.getElementById("approval-reject-button") as HTMLButtonElement | null;
const handoffModal = document.getElementById("handoff-modal");
const handoffReason = document.getElementById("handoff-reason");
const handoffDoneButton = document.getElementById("handoff-done-button") as HTMLButtonElement | null;
const handoffCancelButton = document.getElementById("handoff-cancel-button") as HTMLButtonElement | null;
const intentBox = document.querySelector(".intent-box") as HTMLTextAreaElement | null;
const intentRunButton = document.getElementById("intent-run-button") as HTMLButtonElement | null;
const terminalOutput = document.getElementById("terminal-output");

let tabs: TabSummary[] = [];
let viewportSyncFrame = 0;
let viewportStabilizer = 0;
let isEditingAddress = false;
let pendingAddressValue: string | null = null;
let activeApprovalRequestId: string | null = null;
let activeHandoffRequestId: string | null = null;
let approvalDialog: DialogHandle | null = null;
let handoffDialog: DialogHandle | null = null;

function getActiveTab(): TabSummary | undefined {
  return tabs.find((tab) => tab.isActive);
}

async function syncActiveObservation() {
  const activeTab = getActiveTab();
  if (!activeTab) {
    return;
  }

  const observation = await window.browserShell.getLatestObservation(activeTab.id);
  if (observation) {
    renderObservation(observation);
  }
}

function renderTabs(nextTabs: TabSummary[]) {
  tabs = nextTabs;
  if (!tabsNode) {
    return;
  }

  tabsNode.replaceChildren(
    ...nextTabs.map((tab) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `tab-pill${tab.isActive ? " is-active" : ""}${tab.status === "loading" ? " is-loading" : ""}${tab.status === "error" ? " is-error" : ""}`;
      button.title = tab.url;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", tab.isActive ? "true" : "false");
      button.setAttribute("aria-controls", "viewport-frame");
      // Roving tabindex: only the active tab is in the Tab order; ←/→ rove the rest.
      button.tabIndex = tab.isActive ? 0 : -1;
      button.addEventListener("click", async () => {
        renderTabs(await window.browserShell.focusTab(tab.id));
        await syncActiveObservation();
      });

      const status = document.createElement("span");
      status.className = "tab-status";

      const copy = document.createElement("span");
      copy.className = "tab-copy";

      const title = document.createElement("span");
      title.className = "tab-title";
      title.textContent = tab.status === "error" ? "Load failed" : tab.title || "New Tab";

      const meta = document.createElement("span");
      meta.className = "tab-meta";
      meta.textContent = safeHostLabel(tab.url);

      copy.append(title, meta);

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "tab-close";
      closeBtn.textContent = "×";
      closeBtn.title = "Close tab";
      closeBtn.setAttribute("aria-label", `Close ${tab.title || "tab"}`);
      // Out of the Tab order — reachable via the tab's Delete/Backspace key.
      closeBtn.tabIndex = -1;
      closeBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        renderTabs(await window.browserShell.closeTab(tab.id));
        await syncActiveObservation();
      });

      button.append(status, copy, closeBtn);
      return button;
    })
  );

  const activeTab = getActiveTab();
  if (addressInput && activeTab && !isEditingAddress) {
    addressInput.value = pendingAddressValue ?? activeTab.url;
  }

  if (activeTab && activeTab.status !== "loading") {
    pendingAddressValue = null;
  }

  queueViewportSync();
}

function renderVaultSecrets(secrets: VaultSecretSummary[]) {
  if (!vaultList) {
    return;
  }

  if (secrets.length === 0) {
    vaultList.replaceChildren(
      buildEmptyState({ title: "Vault is empty", hint: "Saved-account secrets appear here." })
    );
    return;
  }

  vaultList.replaceChildren(
    ...secrets.map((secret) => {
      const item = document.createElement("div");
      item.className = "vault-chip";

      const label = document.createElement("strong");
      label.textContent = secret.label;

      const value = document.createElement("span");
      value.textContent = `${secret.id} · ${secret.maskedValue}`;

      item.append(label, value);
      return item;
    })
  );
}

function renderAccounts(accounts: import("../../../../packages/shared/src/index.js").AccountSummary[]) {
  if (!accountsList) return;

  if (accounts.length === 0) {
    accountsList.replaceChildren(
      buildEmptyState({
        title: "No accounts yet",
        hint: "Add credentials above so the agent can sign in for you.",
      })
    );
    return;
  }

  accountsList.replaceChildren(
    ...accounts.map((account) => {
      const chip = document.createElement("div");
      chip.className = "account-chip";

      const body = document.createElement("div");
      body.className = "account-chip-body";

      const labelEl = document.createElement("div");
      labelEl.className = "account-chip-label";
      labelEl.textContent = account.label;

      const meta = document.createElement("div");
      meta.className = "account-chip-meta";
      meta.textContent = `${account.username} · ${account.origins.join(", ")}`;

      body.append(labelEl, meta);

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "account-chip-delete";
      deleteBtn.type = "button";
      deleteBtn.textContent = "×";
      deleteBtn.title = "Delete account";
      deleteBtn.addEventListener("click", async () => {
        await window.browserShell.deleteAccount(account.id);
        renderAccounts(await window.browserShell.listAccounts());
      });

      chip.append(body, deleteBtn);
      return chip;
    })
  );
}

function safeHostLabel(value: string): string {
  try {
    return new URL(value).host || value;
  } catch {
    return value;
  }
}

function normalizeNavigationTarget(rawValue: string): string | null {
  const value = rawValue.trim();
  if (!value) {
    return null;
  }

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value)) {
    return value;
  }

  if (/\s/.test(value)) {
    return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
  }

  return `https://${value}`;
}

function layoutViewport() {
  if (!viewportFrame) {
    return;
  }

  const rect = viewportFrame.getBoundingClientRect();
  const viewport: ViewportRect = {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };

  void window.browserShell.setViewport(viewport);
}

function queueViewportSync() {
  if (viewportSyncFrame) {
    cancelAnimationFrame(viewportSyncFrame);
  }

  viewportSyncFrame = requestAnimationFrame(() => {
    viewportSyncFrame = requestAnimationFrame(() => {
      layoutViewport();
    });
  });
}

function startViewportStabilizer(durationMs = 2000, intervalMs = 120) {
  if (viewportStabilizer) {
    window.clearInterval(viewportStabilizer);
  }

  queueViewportSync();

  viewportStabilizer = window.setInterval(() => {
    queueViewportSync();
  }, intervalMs);

  window.setTimeout(() => {
    if (viewportStabilizer) {
      window.clearInterval(viewportStabilizer);
      viewportStabilizer = 0;
    }
    queueViewportSync();
  }, durationMs);
}

function renderObservation(_observation: PageObservation) {
  // Observation data is logged to the terminal output
}

function renderGraph(graph: PageGraph) {
  if (!snapshotOutput) {
    return;
  }

  snapshotOutput.textContent = JSON.stringify(
    {
      kind: graph.kind,
      title: graph.title,
      url: graph.url,
      topHeading: graph.topHeading,
      forms: graph.forms.map((form) => ({
        purpose: form.purpose,
        fields: form.fields.map((field) => ({
          id: field.id,
          label: field.label,
          type: field.fieldType,
          required: field.required
        })),
        submits: form.submitActions.map((action) => action.label)
      })),
      oauthProviders: graph.oauthProviders,
      alerts: graph.alerts,
      social: graph.social
        ? {
            platform: graph.social.platform,
            kind: graph.social.kind,
            posts: graph.social.posts.map((post) => ({
              id: post.id,
              author: post.author,
              handle: post.handle,
              text: post.text,
              actions: post.actions.map((action) => action.kind)
            })),
            composers: graph.social.composers.map((composer) => ({
              id: composer.id,
              purpose: composer.purpose,
              label: composer.label,
              submitActions: composer.submitActions.map((action) => action.kind)
            })),
            navigation: graph.social.navigation.map((item) => ({
              label: item.label,
              destination: item.destination
            })),
            signals: graph.social.signals
          }
        : undefined,
      accessibilitySummary: graph.accessibility,
      signals: graph.signals
    },
    null,
    2
  );
}

function renderPerception(result: PerceptionResult) {
  renderGraph(result.graph);
}

/**
 * Update the inline Developer-panel status line, and for notable outcomes
 * ("success"/"error") also surface a toast. Plain "info" progress stays inline
 * only so routine steps don't spam toasts.
 */
function setFixtureStatus(text: string, kind: "info" | "success" | "error" = "info") {
  if (fixtureStatus) {
    fixtureStatus.textContent = text;
  }
  if (kind !== "info") {
    toast(text, kind);
  }
}

function showApprovalModal(requestId: string, summary: string, effects: string[]) {
  activeApprovalRequestId = requestId;
  if (approvalCopy) {
    approvalCopy.textContent = summary;
  }
  if (approvalEffects) {
    approvalEffects.replaceChildren(
      ...effects.map((effect) => {
        const node = document.createElement("div");
        node.className = "approval-effect";
        node.textContent = effect;
        return node;
      })
    );
  }
  approvalModal?.removeAttribute("hidden");
  // Required decision: trap focus, no Esc/backdrop dismissal.
  if (approvalModal) {
    approvalDialog = openDialog(approvalModal, { dismissable: false });
  }
}

function hideApprovalModal() {
  activeApprovalRequestId = null;
  approvalModal?.setAttribute("hidden", "");
  approvalDialog?.close();
  approvalDialog = null;
}

const HANDOFF_REASON_LABELS: Record<HumanHandoffRecord["reason"], string> = {
  captcha: "CAPTCHA — solve the challenge on the page, then click Done.",
  "2fa": "Two-factor authentication — complete the 2FA step, then click Done.",
  payment: "Payment — review and complete the payment form, then click Done.",
  legal: "Legal — review and accept the terms, then click Done."
};

function showHandoffModal(handoff: HumanHandoffRecord) {
  activeHandoffRequestId = handoff.requestId;
  if (handoffReason) {
    handoffReason.textContent = HANDOFF_REASON_LABELS[handoff.reason] ?? handoff.reason;
  }
  handoffModal?.removeAttribute("hidden");
  // Required decision: trap focus, no Esc/backdrop dismissal.
  if (handoffModal) {
    handoffDialog = openDialog(handoffModal, { dismissable: false });
  }
}

function hideHandoffModal() {
  activeHandoffRequestId = null;
  handoffModal?.setAttribute("hidden", "");
  handoffDialog?.close();
  handoffDialog = null;
}

async function navigateActiveTab(url: string) {
  const activeTab = getActiveTab();
  if (!activeTab) {
    throw new Error("No active tab available.");
  }

  pendingAddressValue = url;
  if (addressInput) {
    addressInput.value = url;
  }
  renderTabs(await window.browserShell.navigate(activeTab.id, url));
  startViewportStabilizer(1200, 120);
}

async function waitForPacket(tabId: string, predicate: (packet: BrowserPerceptionPacket) => boolean, timeoutMs = 6000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const packet = await window.browserShell.getPerceptionPacket(tabId);
    if (predicate(packet)) {
      return packet;
    }
    await delay(200);
  }
  throw new Error("Timed out waiting for fixture perception state.");
}

function buildContactFixtureArgs(packet: BrowserPerceptionPacket) {
  const form = packet.result.graph.forms[0];
  if (!form) {
    throw new Error("No form detected on the contact fixture.");
  }

  const args: Record<string, unknown> = {};
  for (const field of form.fields) {
    const label = field.label.toLowerCase();
    if (label.includes("name")) {
      args[field.id] = { kind: "vault", id: "vault.identity.full_name" };
      continue;
    }
    if (label.includes("email")) {
      args[field.id] = { kind: "vault", id: "vault.identity.work_email" };
      continue;
    }
    if (label.includes("topic")) {
      args[field.id] = "sales";
      continue;
    }
    if (label.includes("team")) {
      args[field.id] = "25";
      continue;
    }
    if (label.includes("message")) {
      args[field.id] = "I want to test the browser substrate end to end with vault-backed identity values.";
      continue;
    }
    if (field.fieldType === "checkbox") {
      args[field.id] = true;
    }
  }

  return {
    formId: form.id,
    args
  };
}

async function handleCommandResult(result: BrowserCommandResult) {
  if (result.status === "completed") {
    if (result.graph) {
      renderGraph(result.graph);
    }
    if (result.observation) {
      renderObservation(result.observation);
    }
    setFixtureStatus("Command completed.", "success");
    return result;
  }

  if (result.status === "awaiting_approval") {
    setFixtureStatus("Waiting for approval before submitting the form.");
    showApprovalModal(
      result.requestId,
      result.summary,
      result.effects.map((effect) => {
        switch (effect.type) {
          case "create_account":
            return `Create account: ${effect.label}`;
          case "share_personal_data":
            return `Share personal data: ${effect.fields.join(", ")}`;
          case "accept_legal_terms":
            return `Accept legal terms: ${effect.provider}`;
          case "submit_payment":
            return `Submit payment`;
        }
      })
    );
    return result;
  }

  if (result.status === "awaiting_human") {
    setFixtureStatus(`Agent paused: ${result.reason} — take over and click Done.`);
    const activeTab = getActiveTab();
    const tabId = activeTab?.id ?? "";
    showHandoffModal({
      requestId: result.requestId,
      tabId,
      relatedTabIds: tabId ? [tabId] : [],
      reason: result.reason,
      origin: activeTab ? safeHostLabel(activeTab.url) : undefined,
      title: activeTab?.title,
      createdAt: Date.now()
    });
    return result;
  }

  setFixtureStatus(result.reason, "error");
  return result;
}

async function runContactFixture() {
  const activeTab = getActiveTab();
  if (!activeTab) {
    return;
  }

  setFixtureStatus("Opening contact-form fixture.");
  const fixtureUrl = await window.browserShell.getFixtureUrl("contact-form");
  await navigateActiveTab(fixtureUrl);

  const packet = await waitForPacket(activeTab.id, (next) => next.result.graph.forms.length > 0);
  renderGraph(packet.result.graph);
  setFixtureStatus("Filling fixture form with vault-backed name and email.");

  const fillPlan = buildContactFixtureArgs(packet);
  await handleCommandResult(
    await window.browserShell.executeCommand(activeTab.id, {
      type: "invoke_site_tool",
      provider: "dom",
      toolName: `dom.fill.${fillPlan.formId}`,
      args: fillPlan.args
    })
  );

  setFixtureStatus("Requesting approval before submitting the fixture form.");
  await handleCommandResult(
    await window.browserShell.executeCommand(activeTab.id, {
      type: "invoke_site_tool",
      provider: "dom",
      toolName: `dom.submit.${fillPlan.formId}`,
      args: {}
    })
  );
}

// ── Terminal output ──────────────────────────────────────────────────────────

const LEVEL_CLASS: Record<AgentLogEntry["level"], string> = {
  system: "terminal-system",
  agent: "terminal-agent",
  ai: "terminal-ai",
  error: "terminal-error",
  nav: "terminal-nav"
};

function appendTerminal(level: AgentLogEntry["level"], message: string) {
  if (!terminalOutput) return;
  const line = document.createElement("div");
  line.className = `terminal-line ${LEVEL_CLASS[level]}`;
  line.textContent = message;
  terminalOutput.appendChild(line);
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

function submitIntent() {
  if (!intentBox) return;
  const text = intentBox.value.trim();
  if (!text) return;
  void window.browserShell.setIntent(text);
  appendTerminal("system", `Intent submitted: ${text}`);
}

async function bootstrap() {
  // Show loading skeletons while the initial sidebar lists are in flight.
  vaultList?.replaceChildren(buildSkeletonRows(2));
  accountsList?.replaceChildren(buildSkeletonRows(2));

  const [tabs, secrets, accounts] = await Promise.all([
    window.browserShell.listTabs(),
    window.browserShell.listVaultSecrets(),
    window.browserShell.listAccounts(),
  ]);
  renderTabs(tabs);
  renderVaultSecrets(secrets);
  renderAccounts(accounts);
  await syncActiveObservation();
  startViewportStabilizer();

  // Load intent (may have been set by an agent via HTTP before UI loaded)
  if (intentBox) {
    intentBox.value = await window.browserShell.getIntent();
  }

  const viewportObserver = viewportFrame ? new ResizeObserver(() => queueViewportSync()) : null;
  if (viewportFrame && viewportObserver) {
    viewportObserver.observe(viewportFrame);
  }

  window.addEventListener("resize", () => startViewportStabilizer(1200, 120));
  window.addEventListener("load", () => startViewportStabilizer(1600, 120));
  window.browserShell.onTabsChanged(renderTabs);

  // Tab strip is an ARIA tablist: ←/→ rove focus; Delete/Backspace closes.
  if (tabsNode) {
    attachRovingKeys(tabsNode, '[role="tab"]', { orientation: "horizontal", wrap: true });
    tabsNode.addEventListener("keydown", async (event) => {
      if (event.key !== "Delete" && event.key !== "Backspace") {
        return;
      }
      const items = Array.from(tabsNode.querySelectorAll<HTMLElement>('[role="tab"]'));
      const index = items.findIndex((el) => el === document.activeElement);
      const target = tabs[index];
      if (index < 0 || !target) {
        return;
      }
      event.preventDefault();
      renderTabs(await window.browserShell.closeTab(target.id));
      await syncActiveObservation();
    });
  }

  const themeToggle = document.getElementById("theme-toggle");
  themeToggle?.addEventListener("click", () => {
    themeController.toggle();
  });

  addressForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const target = addressInput ? normalizeNavigationTarget(addressInput.value) : null;
    if (!target) {
      return;
    }

    isEditingAddress = false;
    await navigateActiveTab(target);
    await syncActiveObservation();
  });

  addressInput?.addEventListener("focus", () => {
    isEditingAddress = true;
  });

  addressInput?.addEventListener("blur", () => {
    isEditingAddress = false;
    const activeTab = getActiveTab();
    if (addressInput && activeTab) {
      addressInput.value = pendingAddressValue ?? activeTab.url;
    }
  });

  const toolsMenuTrigger = document.getElementById("toolbar-menu-trigger");
  const toolsMenuDropdown = document.getElementById("toolbar-menu-dropdown");
  // ARIA menu: trigger toggles + keyboard opens; ↑/↓ rove items; Esc/Tab/outside
  // close; selecting an item closes (the per-item handlers no longer self-hide).
  if (toolsMenuTrigger && toolsMenuDropdown) {
    createMenu(toolsMenuTrigger, toolsMenuDropdown);
  }

  newTabButton?.addEventListener("click", async () => {
    renderTabs(await window.browserShell.openTab("https://example.com"));
    await syncActiveObservation();
    startViewportStabilizer(1200, 120);
  });

  snapshotButton?.addEventListener("click", async () => {    const activeTab = getActiveTab();
    if (!activeTab) {
      return;
    }
    renderPerception(await window.browserShell.capturePerception(activeTab.id));
  });

  inspectButton?.addEventListener("click", async () => {    const activeTab = getActiveTab();
    if (!activeTab) {
      return;
    }
    setFixtureStatus("Inspect: click an element in the page (Esc to cancel)…");
    const pick = await window.browserShell.pickElement(activeTab.id);
    if (!pick.picked) {
      setFixtureStatus("Inspect cancelled.");
      return;
    }
    setFixtureStatus(`Picked ${pick.tagName} → ${pick.selector}`);
    appendTerminal("system", `Inspect → selector ${pick.selector}${pick.text ? ` ("${pick.text}")` : ""}`);
  });

  fixtureOpenButton?.addEventListener("click", async () => {    const fixtureUrl = await window.browserShell.getFixtureUrl("contact-form");
    setFixtureStatus(`Opened fixture: ${fixtureUrl}`);
    await navigateActiveTab(fixtureUrl);
  });

  fixtureRunButton?.addEventListener("click", async () => {    try {
      await runContactFixture();
    } catch (error) {
      setFixtureStatus(error instanceof Error ? error.message : "Fixture runner failed.", "error");
    }
  });

  // Clear a field's inline error as soon as the user edits it.
  for (const field of Object.keys(accountFieldInputs) as AccountFieldKey[]) {
    accountFieldInputs[field]?.addEventListener("input", () => clearAccountFieldError(field));
  }

  accountForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values: AccountFormValues = {
      label: accountLabelInput?.value.trim() ?? "",
      origin: accountOriginInput?.value.trim() ?? "",
      username: accountUsernameInput?.value.trim() ?? "",
      password: accountPasswordInput?.value ?? "",
      totpSeed: accountTotpInput?.value.trim() || undefined,
    };

    const errors = validateAccountForm(values);
    if (errors.length > 0) {
      showAccountFieldErrors(errors);
      return;
    }
    showAccountFieldErrors([]);

    await window.browserShell.saveAccount({
      label: values.label,
      origins: [values.origin],
      username: values.username,
      password: values.password,
      totpSeed: values.totpSeed,
    });
    accountForm.reset();
    renderAccounts(await window.browserShell.listAccounts());
  });

  approvalApproveButton?.addEventListener("click", async () => {
    if (!activeApprovalRequestId) {
      return;
    }

    const result = await window.browserShell.approveCommand(activeApprovalRequestId);
    hideApprovalModal();
    setFixtureStatus("Approval granted. Command executed.", "success");
    await handleCommandResult(result);
  });

  approvalRejectButton?.addEventListener("click", async () => {
    if (!activeApprovalRequestId) {
      return;
    }

    const result = await window.browserShell.rejectCommand(activeApprovalRequestId);
    hideApprovalModal();
    const rejectFailed = result.status === "blocked" || result.status === "failed";
    setFixtureStatus(rejectFailed ? result.reason : "Approval request closed.", rejectFailed ? "error" : "info");
  });

  // Approval is a required decision — backdrop click is intentionally inert
  // (no dismissal). The old `if (!activeApprovalRequestId) hide()` check was
  // dead code: the id is always set while the modal is open.

  handoffDoneButton?.addEventListener("click", async () => {
    if (!activeHandoffRequestId) return;
    const result = await window.browserShell.resolveHandoff(activeHandoffRequestId);
    hideHandoffModal();
    setFixtureStatus("Handoff resolved. Agent resuming.", "success");
    await handleCommandResult(result);
  });

  handoffCancelButton?.addEventListener("click", async () => {
    if (!activeHandoffRequestId) return;
    await window.browserShell.cancelHandoff(activeHandoffRequestId);
    hideHandoffModal();
    setFixtureStatus("Handoff cancelled.");
  });

  // Handoff is likewise a required decision — backdrop click is inert.

  window.browserShell.onHandoffRequested((handoff) => {
    showHandoffModal(handoff);
    setFixtureStatus(`Agent paused: ${handoff.reason} — take over and click Done.`);
  });

  // Send intent to main process on blur
  intentBox?.addEventListener("blur", () => {
    void window.browserShell.setIntent(intentBox.value);
  });

  // Submit intent on Run button or Enter key
  intentRunButton?.addEventListener("click", submitIntent);
  intentBox?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitIntent();
    }
  });

  // Agent log events → terminal
  window.browserShell.onAgentLog((entry) => {
    appendTerminal(entry.level, entry.message);
  });

  // Page observations → terminal
  window.browserShell.onPageObserved((observation) => {
    const activeTab = getActiveTab();
    if (activeTab && activeTab.id === observation.tabId) {
      appendTerminal("nav", `${observation.pageKind} page observed — ${observation.forms.length} forms, ${observation.primaryActions.length} actions`);
    }
  });
}

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

void bootstrap();
