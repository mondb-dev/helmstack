import { app, BrowserWindow, ipcMain, session } from "electron";
import path from "node:path";

import {
  type AccountInput,
  type AccountUpdate,
  type ApprovalDecision,
  type ApprovalPolicyKey,
  BrowserShellChannel,
  type BrowserShellApi,
  type FixturePageName,
  type HumanHandoffRecord,
  type PageObservation,
  type TabId,
  type TabOverrideKind,
  type VaultSecretInput,
  type ViewportRect
} from "../../../../packages/shared/src/index.js";
import { ElectronBackend } from "./tab-manager.js";
import { ExtensionManager } from "./extension-manager.js";
import { AccountStore } from "./account-store.js";
import { VaultStore } from "./vault-store.js";
import { createDesktopSecrets } from "./desktop-secrets.js";
import type { AccountsApi, ExtensionsApi } from "../../../../packages/devtools-core/src/api.js";
import { HelmstackCore } from "../../../../packages/devtools-core/src/core/helmstack-core.js";
import { isAgentApprovalsEnabled } from "../../../../packages/devtools-core/src/core/runtime-config.js";
import {
  type AgentServer,
  agentTokenPath,
  createAgentServer,
  readOrCreateAgentToken
} from "../../../../packages/devtools-core/src/http/index.js";

const appDir = __dirname;

// ── Side-by-side overrides ──────────────────────────────────────────────────
// HELMSTACK_USER_DATA_DIR isolates profile/vault/token storage and
// HELMSTACK_PORT moves the agent server, so a second instance (e.g. a dev build
// next to the installed app) can run without sharing state or the port.
// userData must be redirected before anything reads it (i.e. before whenReady).
const userDataOverride = process.env.HELMSTACK_USER_DATA_DIR?.trim();
if (userDataOverride) {
  app.setPath("userData", path.resolve(userDataOverride));
}
const agentServerPort = resolveAgentServerPort(process.env.HELMSTACK_PORT);

function resolveAgentServerPort(raw: string | undefined): number {
  const DEFAULT_PORT = 7070;
  if (!raw || raw.trim() === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.warn(`[main] Ignoring invalid HELMSTACK_PORT=${JSON.stringify(raw)}; using ${DEFAULT_PORT}`);
    return DEFAULT_PORT;
  }
  return port;
}

let mainWindow: BrowserWindow | null = null;
let core: HelmstackCore | null = null;
let agentServer: AgentServer | null = null;

/**
 * Send an event to the shell renderer, guarding against a destroyed window or
 * webContents. During tab close / reload / app shutdown a `page_observed` (or
 * other) event can still arrive after the renderer's webContents is gone;
 * `mainWindow?.` only guards the window being null, not a live window whose
 * webContents has been destroyed — which throws "Object has been destroyed".
 */
function sendToShell(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

// Resilience: HelmStack drives many tabs whose webContents come and go, so a
// stray lifecycle-race error (an event firing against a destroyed object during
// teardown/reload) must be logged, not surfaced as Electron's fatal dialog that
// bricks the app. We keep running rather than crash on a non-fatal main-process error.
process.on("uncaughtException", (error) => {
  console.error("[main] Uncaught exception (kept alive):", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("[main] Unhandled promise rejection (kept alive):", reason);
});

async function createMainWindow() {
  const shellPreloadPath = path.join(appDir, "../preload/shell-preload.cjs");
  const pagePreloadPath = path.join(appDir, "../preload/page-preload.cjs");
  const userDataPath = app.getPath("userData");

  // ── Extension manager ─────────────────────────────────────────────────────
  // Load extensions BEFORE creating any tabs so they apply to all navigation.
  const extensions = new ExtensionManager(userDataPath, "persist:default");
  await extensions.loadAllExtensions();

  // ── Scrub "Electron/x.x.x" from the session user-agent ───────────────────
  // Removes the Electron signature while keeping a realistic Chrome UA.
  const browserSession = session.fromPartition("persist:default");
  const rawUa = browserSession.getUserAgent();
  const cleanUa = rawUa.replace(/\s*Electron\/[\d.]+/, "").replace(/\s{2,}/g, " ").trim();
  browserSession.setUserAgent(cleanUa);

  // ── Main window ───────────────────────────────────────────────────────────
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    titleBarStyle: "hidden",
    titleBarOverlay: process.platform === "darwin" ? false : { color: "#101214", symbolColor: "#f6f7f9" },
    backgroundColor: "#101214",
    webPreferences: {
      preload: shellPreloadPath,
      contextIsolation: true,
      sandbox: true
    }
  });

  // ── Browser backend + shared core ────────────────────────────────────────
  // ElectronBackend owns the WebContentsViews; every agent tool lives once in
  // HelmstackCore (packages/devtools-core), shared with the headless daemon.
  const vault = new VaultStore(userDataPath);
  const accountStore = new AccountStore(userDataPath);
  const browserBackend = new ElectronBackend(mainWindow, appDir, pagePreloadPath, accountStore);
  core = new HelmstackCore(browserBackend, {
    dataDir: userDataPath,
    secrets: createDesktopSecrets(vault, accountStore),
    // The page preload already pushes fresh observations; skip the CDP pull.
    pullObservations: false
  });

  // ── Agent server ──────────────────────────────────────────────────────────
  // Binds to 127.0.0.1 only.  External agents connect here.
  // Auth is on by default: use HELMSTACK_AUTH_TOKEN if provided, otherwise
  // generate a token and persist it so local agents can read it.
  const envToken = process.env.HELMSTACK_AUTH_TOKEN;
  const authToken = envToken || readOrCreateAgentToken(userDataPath);
  const tokenPath = envToken ? null : agentTokenPath(userDataPath);
  const accounts = accountsApi(accountStore);
  const extensionsApi: ExtensionsApi = extensions;
  agentServer = createAgentServer({
    api: core,
    backend: "desktop",
    accounts,
    extensions: extensionsApi,
    port: agentServerPort,
    authToken,
    tokenPath,
    // Only the human in this window approves queued actions; agents may still
    // reject (withdraw). HELMSTACK_AGENT_APPROVALS=1 restores agent approval,
    // e.g. to run the contract suite against the desktop.
    approvals: isAgentApprovalsEnabled() ? "agent" : "human"
  });
  console.log(`[AgentServer] auth token: ${authToken}`);
  console.log(`[AgentServer] token file: ${agentTokenPath(userDataPath)}`);
  registerIpcHandlers(core, browserBackend, vault, accountStore, agentServer);
  await agentServer.start().catch((err: unknown) => {
    // The connection status carries the error (e.g. port in use) to the shell.
    console.error("[AgentServer] Failed to start:", err);
  });

  await mainWindow.loadFile(path.join(appDir, "../renderer/index.html"));
  await core.createTab("https://example.com");
}

/** The agent server's optional accounts slice over the `safeStorage`-backed store. */
function accountsApi(store: AccountStore): AccountsApi {
  return {
    listAccounts: () => store.listAccounts(),
    saveAccount: (input) => store.saveAccount(input),
    lookupAccounts: (origin) => store.lookupByOrigin(origin),
    updateAccount: (id, update) => store.updateAccount(id, update),
    deleteAccount: (id) => store.deleteAccount(id),
    generateTotp: (accountId) => store.generateTotp(accountId)
  };
}

function registerIpcHandlers(
  manager: HelmstackCore,
  shell: ElectronBackend,
  vault: VaultStore,
  accounts: AccountStore,
  server: AgentServer
) {
  const handlers: BrowserShellApi = {
    openTab: async (url?: string) => manager.createTab(url),
    navigate: async (tabId: TabId, url: string) => manager.navigate(tabId, url),
    listTabs: async () => manager.listTabs(),
    focusTab: async (tabId: TabId) => shell.focusTab(tabId),
    closeTab: async (tabId: TabId) => manager.closeTab(tabId),
    setViewport: async (rect: ViewportRect) => shell.setViewport(rect),
    captureSnapshot: async (tabId: TabId) => manager.captureSnapshot(tabId),
    getLatestObservation: async (tabId: TabId) => manager.getLatestObservation(tabId),
    capturePerception: async (tabId: TabId) => manager.capturePerception(tabId),
    getPerceptionPacket: async (tabId: TabId) => manager.getPerceptionPacket(tabId),
    listCapabilityManifests: async (tabId: TabId) => manager.listCapabilityManifests(tabId),
    executeCommand: async (tabId: TabId, command) => manager.executeCommand(tabId, command),
    approveCommand: async (requestId: string) => manager.approveCommand(requestId),
    rejectCommand: async (requestId: string) => manager.rejectCommand(requestId),
    listVaultSecrets: async () => vault.listSecrets(),
    saveVaultSecrets: async (updates: VaultSecretInput[]) => vault.saveSecrets(updates),
    getVaultStatus: async () => vault.getStatus(),
    listApprovalPolicies: async () => manager.listApprovalPolicies(),
    updateApprovalPolicy: async (key: ApprovalPolicyKey, decision: ApprovalDecision) => manager.updateApprovalPolicy(key, decision),
    getFixtureUrl: async (name: FixturePageName) => shell.getFixtureUrl(name),
    // Screenshot
    captureScreenshot: async (tabId: TabId) => manager.captureScreenshot(tabId),
    // "Select for agent": record the human's pick so agents can read it
    // (GET /api/tabs/:id/picks/latest, SSE element_picked, MCP tool).
    pickElement: async (tabId: TabId) => {
      const pick = await shell.pickElement(tabId);
      manager.recordHumanPick(tabId, pick);
      return pick;
    },
    // Handoffs
    listHandoffs: async () => manager.listHandoffs(),
    resolveHandoff: async (requestId: string) => manager.resolveHandoff(requestId),
    cancelHandoff: async (requestId: string) => manager.cancelHandoff(requestId),
    // Accounts
    listAccounts: async () => accounts.listAccounts(),
    saveAccount: async (input: AccountInput) => accounts.saveAccount(input),
    updateAccount: async (id: string, update: AccountUpdate) => accounts.updateAccount(id, update),
    deleteAccount: async (id: string) => accounts.deleteAccount(id),
    lookupAccounts: async (origin: string) => accounts.lookupByOrigin(origin),
    generateTotp: async (accountId: string) => accounts.generateTotp(accountId),
    // Intent
    setIntent: async (intent: string) => server.setIntent(intent),
    getIntent: async () => server.getIntent(),
    // Agent status surfaces
    listPendingApprovals: async () => manager.listPendingApprovals(),
    getTabOverrides: async (tabId: TabId) => manager.getTabOverrides(tabId),
    clearTabOverrides: async (tabId: TabId, kind: TabOverrideKind | "all") => manager.clearTabOverrides(tabId, kind),
    listAgentActivity: async () => server.listActivity(),
    getConnectionStatus: async () => server.getConnectionStatus()
  };

  ipcMain.handle(BrowserShellChannel.OpenTab, (_event, url?: string) => handlers.openTab(url));
  ipcMain.handle(BrowserShellChannel.Navigate, (_event, tabId: TabId, url: string) => handlers.navigate(tabId, url));
  ipcMain.handle(BrowserShellChannel.ListTabs, () => handlers.listTabs());
  ipcMain.handle(BrowserShellChannel.FocusTab, (_event, tabId: TabId) => handlers.focusTab(tabId));
  ipcMain.handle(BrowserShellChannel.CloseTab, (_event, tabId: TabId) => handlers.closeTab(tabId));
  ipcMain.handle(BrowserShellChannel.SetViewport, (_event, rect: ViewportRect) => handlers.setViewport(rect));
  ipcMain.handle(BrowserShellChannel.CaptureSnapshot, (_event, tabId: TabId) => handlers.captureSnapshot(tabId));
  ipcMain.handle(BrowserShellChannel.GetLatestObservation, (_event, tabId: TabId) => handlers.getLatestObservation(tabId));
  ipcMain.handle(BrowserShellChannel.CapturePerception, (_event, tabId: TabId) => handlers.capturePerception(tabId));
  ipcMain.handle(BrowserShellChannel.GetPerceptionPacket, (_event, tabId: TabId) => handlers.getPerceptionPacket(tabId));
  ipcMain.handle(BrowserShellChannel.ListCapabilityManifests, (_event, tabId: TabId) => handlers.listCapabilityManifests(tabId));
  ipcMain.handle(BrowserShellChannel.ExecuteCommand, (_event, tabId: TabId, command) => handlers.executeCommand(tabId, command));
  ipcMain.handle(BrowserShellChannel.ApproveCommand, (_event, requestId: string) => handlers.approveCommand(requestId));
  ipcMain.handle(BrowserShellChannel.RejectCommand, (_event, requestId: string) => handlers.rejectCommand(requestId));
  ipcMain.handle(BrowserShellChannel.ListVaultSecrets, () => handlers.listVaultSecrets());
  ipcMain.handle(BrowserShellChannel.SaveVaultSecrets, (_event, updates: VaultSecretInput[]) => handlers.saveVaultSecrets(updates));
  ipcMain.handle(BrowserShellChannel.GetVaultStatus, () => handlers.getVaultStatus());
  ipcMain.handle(BrowserShellChannel.ListApprovalPolicies, () => handlers.listApprovalPolicies());
  ipcMain.handle(BrowserShellChannel.UpdateApprovalPolicy, (_event, key: ApprovalPolicyKey, decision: ApprovalDecision) =>
    handlers.updateApprovalPolicy(key, decision)
  );
  ipcMain.handle(BrowserShellChannel.GetFixtureUrl, (_event, name: FixturePageName) => handlers.getFixtureUrl(name));
  // Screenshot
  ipcMain.handle(BrowserShellChannel.CaptureScreenshot, (_event, tabId: TabId) => handlers.captureScreenshot(tabId));
  ipcMain.handle(BrowserShellChannel.PickElement, (_event, tabId: TabId) => handlers.pickElement(tabId));
  // Handoffs
  ipcMain.handle(BrowserShellChannel.ListHandoffs, () => handlers.listHandoffs());
  ipcMain.handle(BrowserShellChannel.ResolveHandoff, (_event, requestId: string) => handlers.resolveHandoff(requestId));
  ipcMain.handle(BrowserShellChannel.CancelHandoff, (_event, requestId: string) => handlers.cancelHandoff(requestId));
  // Accounts
  ipcMain.handle(BrowserShellChannel.ListAccounts, () => handlers.listAccounts());
  ipcMain.handle(BrowserShellChannel.SaveAccount, (_event, input: AccountInput) => handlers.saveAccount(input));
  ipcMain.handle(BrowserShellChannel.UpdateAccount, (_event, id: string, update: AccountUpdate) => handlers.updateAccount(id, update));
  ipcMain.handle(BrowserShellChannel.DeleteAccount, (_event, id: string) => handlers.deleteAccount(id));
  ipcMain.handle(BrowserShellChannel.LookupAccounts, (_event, origin: string) => handlers.lookupAccounts(origin));
  ipcMain.handle(BrowserShellChannel.GenerateTotp, (_event, accountId: string) => handlers.generateTotp(accountId));
  // Intent
  ipcMain.handle(BrowserShellChannel.SetIntent, (_event, intent: string) => handlers.setIntent(intent));
  ipcMain.handle(BrowserShellChannel.GetIntent, () => handlers.getIntent());
  // Agent status surfaces
  ipcMain.handle(BrowserShellChannel.ListPendingApprovals, () => handlers.listPendingApprovals());
  ipcMain.handle(BrowserShellChannel.GetTabOverrides, (_event, tabId: TabId) => handlers.getTabOverrides(tabId));
  ipcMain.handle(BrowserShellChannel.ClearTabOverrides, (_event, tabId: TabId, kind: TabOverrideKind | "all") =>
    handlers.clearTabOverrides(tabId, kind)
  );
  ipcMain.handle(BrowserShellChannel.ListAgentActivity, () => handlers.listAgentActivity());
  ipcMain.handle(BrowserShellChannel.GetConnectionStatus, () => handlers.getConnectionStatus());

  ipcMain.on(BrowserShellChannel.PageObserved, (_event, observation: PageObservation) => {
    shell.recordObservation(observation);
  });

  manager.onTabsChanged((tabs) => {
    sendToShell(BrowserShellChannel.TabsChanged, tabs);
  });
  manager.onPageObserved((observation) => {
    sendToShell(BrowserShellChannel.PageObserved, observation);
  });
  manager.onHandoffRequested((handoff: HumanHandoffRecord) => {
    sendToShell(BrowserShellChannel.HandoffRequested, handoff);
  });
  // Approvals queued from any source (agent API or this shell) reach the human.
  manager.onApprovalsChanged((pending) => {
    sendToShell(BrowserShellChannel.ApprovalsChanged, pending);
  });
  manager.onTabOverridesChanged((overrides) => {
    sendToShell(BrowserShellChannel.TabOverridesChanged, overrides);
  });
  server.onAgentLog((entry) => {
    sendToShell(BrowserShellChannel.AgentLog, entry);
  });
  server.onActivity((entry) => {
    sendToShell(BrowserShellChannel.AgentActivity, entry);
  });
  server.onConnectionStatusChanged((status) => {
    sendToShell(BrowserShellChannel.ConnectionStatusChanged, status);
  });
}

app.whenReady().then(createMainWindow);

app.on("window-all-closed", () => {
  void agentServer?.stop();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createMainWindow();
  }
});
