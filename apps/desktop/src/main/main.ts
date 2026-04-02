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
  type VaultSecretInput,
  type ViewportRect
} from "../../../../packages/shared/src/index.js";
import { TabManager } from "./tab-manager.js";
import { ExtensionManager } from "./extension-manager.js";
import { AgentServer } from "./agent-server.js";

const appDir = __dirname;

let mainWindow: BrowserWindow | null = null;
let tabManager: TabManager | null = null;
let agentServer: AgentServer | null = null;

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

  tabManager = new TabManager(mainWindow, appDir, userDataPath, pagePreloadPath);
  registerIpcHandlers(tabManager);

  // ── Agent server ──────────────────────────────────────────────────────────
  // Binds to 127.0.0.1 only.  External agents connect here.
  agentServer = new AgentServer(tabManager, extensions);
  await agentServer.start().catch((err: unknown) => {
    console.error("[AgentServer] Failed to start:", err);
  });

  // Intent IPC — owned by the agent server, registered after it's created
  ipcMain.handle(BrowserShellChannel.SetIntent, (_event, intent: string) => {
    agentServer!.setIntent(intent);
  });
  ipcMain.handle(BrowserShellChannel.GetIntent, () => {
    return agentServer!.getIntent();
  });

  agentServer.onAgentLog((entry) => {
    mainWindow?.webContents.send(BrowserShellChannel.AgentLog, entry);
  });

  await mainWindow.loadFile(path.join(appDir, "../renderer/index.html"));
  await tabManager.createTab("https://example.com");
}

function registerIpcHandlers(manager: TabManager) {
  const handlers: BrowserShellApi = {
    openTab: async (url?: string) => manager.createTab(url),
    navigate: async (tabId: TabId, url: string) => manager.navigate(tabId, url),
    listTabs: async () => manager.listTabs(),
    focusTab: async (tabId: TabId) => manager.focusTab(tabId),
    closeTab: async (tabId: TabId) => manager.closeTab(tabId),
    setViewport: async (rect: ViewportRect) => manager.setViewport(rect),
    captureSnapshot: async (tabId: TabId) => manager.captureSnapshot(tabId),
    getLatestObservation: async (tabId: TabId) => manager.getLatestObservation(tabId),
    capturePerception: async (tabId: TabId) => manager.capturePerception(tabId),
    getPerceptionPacket: async (tabId: TabId) => manager.getPerceptionPacket(tabId),
    listCapabilityManifests: async (tabId: TabId) => manager.listCapabilityManifests(tabId),
    executeCommand: async (tabId: TabId, command) => manager.executeCommand(tabId, command),
    approveCommand: async (requestId: string) => manager.approveCommand(requestId),
    rejectCommand: async (requestId: string) => manager.rejectCommand(requestId),
    listVaultSecrets: async () => manager.listVaultSecrets(),
    saveVaultSecrets: async (updates: VaultSecretInput[]) => manager.saveVaultSecrets(updates),
    getVaultStatus: async () => manager.getVaultStatus(),
    listApprovalPolicies: async () => manager.listApprovalPolicies(),
    updateApprovalPolicy: async (key: ApprovalPolicyKey, decision: ApprovalDecision) => manager.updateApprovalPolicy(key, decision),
    getFixtureUrl: async (name: FixturePageName) => manager.getFixtureUrl(name),
    // Screenshot
    captureScreenshot: async (tabId: TabId) => manager.captureScreenshot(tabId),
    // Handoffs
    listHandoffs: async () => manager.listHandoffs(),
    resolveHandoff: async (requestId: string) => manager.resolveHandoff(requestId),
    cancelHandoff: async (requestId: string) => manager.cancelHandoff(requestId),
    // Accounts
    listAccounts: async () => manager.listAccounts(),
    saveAccount: async (input: AccountInput) => manager.saveAccount(input),
    updateAccount: async (id: string, update: AccountUpdate) => manager.updateAccount(id, update),
    deleteAccount: async (id: string) => manager.deleteAccount(id),
    lookupAccounts: async (origin: string) => manager.lookupAccounts(origin),
    generateTotp: async (accountId: string) => manager.generateTotp(accountId),
    // Intent — handled outside this function (needs agentServer reference)
    setIntent: async () => {},
    getIntent: async () => ""
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

  ipcMain.on(BrowserShellChannel.PageObserved, (_event, observation: PageObservation) => {
    manager.recordObservation(observation);
  });

  manager.onTabsChanged((tabs) => {
    mainWindow?.webContents.send(BrowserShellChannel.TabsChanged, tabs);
  });
  manager.onPageObserved((observation) => {
    mainWindow?.webContents.send(BrowserShellChannel.PageObserved, observation);
  });
  manager.onHandoffRequested((handoff: HumanHandoffRecord) => {
    mainWindow?.webContents.send(BrowserShellChannel.HandoffRequested, handoff);
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
