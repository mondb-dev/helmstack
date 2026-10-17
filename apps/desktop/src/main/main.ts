import { app, BrowserWindow, dialog, ipcMain, session, shell as electronShell, type IpcMainInvokeEvent } from "electron";
import os from "node:os";
import path from "node:path";

import {
  type AccountInput,
  type AccountUpdate,
  AGENT_CLI_IDS,
  type AgentCliId,
  type StartAgentConversationInput,
  type ApprovalDecision,
  type ApprovalPolicyKey,
  BrowserShellChannel,
  type BrowserShellApi,
  type FindInPageOptions,
  type FixturePageName,
  type HumanHandoffRecord,
  type PageObservation,
  type TabId,
  type TabOverrideKind,
  type VaultSecretInput,
  type ViewportRect
} from "../../../../packages/shared/src/index.js";
import { ElectronBackend } from "./tab-manager.js";
import { ZoomStore } from "./zoom-store.js";
import { McpInstallService, createMcpInstallIpc } from "./mcp-install-service.js";
import { createReportIpc } from "./report-ipc.js";
import { createRoutineIpc } from "./routine-ipc.js";
import { parseFindOptions, parseFindText, parseReloadMode, parseZoomAction } from "./ipc-validate.js";
import { installAppMenu } from "./app-menu.js";
import { createShortcutRunner, routeKeyInput, type ShortcutHost } from "./shortcut-controller.js";
import { detectShortcutPlatform, type ShortcutId, type ZoomAction } from "../../../../packages/shared/src/index.js";
import { ExtensionManager } from "./extension-manager.js";
import { AccountStore } from "./account-store.js";
import { VaultStore } from "./vault-store.js";
import { createDesktopSecrets } from "./desktop-secrets.js";
import type { AccountsApi, ExtensionsApi } from "../../../../packages/devtools-core/src/api.js";
import { HelmstackCore } from "../../../../packages/devtools-core/src/core/helmstack-core.js";
import { isAgentApprovalsEnabled } from "../../../../packages/devtools-core/src/core/runtime-config.js";
import { AgentRunner } from "../../../../packages/devtools-core/src/agent-runner/index.js";
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
let agentRunner: AgentRunner | null = null;

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
    autoHideMenuBar: true,
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
  const zoomStore = new ZoomStore(userDataPath);
  const browserBackend = new ElectronBackend(mainWindow, appDir, pagePreloadPath, accountStore, zoomStore);
  core = new HelmstackCore(browserBackend, {
    dataDir: userDataPath,
    secrets: createDesktopSecrets(vault, accountStore),
    // The page preload already pushes fresh observations; skip the CDP pull.
    pullObservations: false,
    helmstackVersion: app.getVersion()
  });

  // ── Browser shortcuts: application menu + in-page key routing ────────────
  installBrowserShortcuts(core, browserBackend, mainWindow);

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
  // Never print the token itself: console output ends up in terminals, crash reports and
  // shared logs. Say where it lives instead.
  console.log(
    process.env.HELMSTACK_AUTH_TOKEN
      ? "[AgentServer] auth token: taken from HELMSTACK_AUTH_TOKEN"
      : `[AgentServer] token file: ${agentTokenPath(userDataPath)}`
  );
  // ── In-window agent chat ──────────────────────────────────────────────────
  // Owned here (not by the core/daemon) and reachable only through the shell
  // IPC below: there is no HTTP route that starts or controls a conversation.
  const chatCore = core;
  agentRunner = new AgentRunner({
    port: agentServerPort,
    tokenFile: tokenPath,
    authToken: tokenPath ? null : authToken,
    mcpEntry: path.join(appDir, "../mcp/helmstack-mcp.mjs"),
    disabledReason: "The HelmStack MCP server bundle is missing from this build, so agent chat is unavailable.",
    defaultWorkingDirectory: path.join(userDataPath, "agent-chat-workspace"),
    isTabAlive: (tabId) => chatCore.listTabs().some((tab) => tab.id === tabId),
    electron: true,
    // Local model servers (Ollama, LM Studio, llama.cpp): loopback only, same agent API + token.
    local: true
  });
  const runner = agentRunner;
  void runner.refresh();
  // End a tab's conversations when the tab goes away.
  let knownTabIds = new Set<string>();
  core.onTabsChanged((tabs) => {
    const next = new Set(tabs.map((t) => t.id as string));
    for (const id of knownTabIds) if (!next.has(id)) void runner.closeTab(id);
    knownTabIds = next;
  });
  // Last resort: never leave CLI processes behind.
  process.on("exit", () => runner.killAllSync());
  registerIpcHandlers(core, browserBackend, vault, accountStore, agentServer, runner);
  await agentServer.start().catch((err: unknown) => {
    // The connection status carries the error (e.g. port in use) to the shell.
    console.error("[AgentServer] Failed to start:", err);
  });

  await mainWindow.loadFile(path.join(appDir, "../renderer/index.html"));
  await core.createTab("https://example.com");
}

/**
 * Application menu + `before-input-event` routing. Menu accelerators cover the
 * shell (and macOS pages); the key router makes shortcuts work whichever view
 * has focus on Windows/Linux and handles Esc / Ctrl+Tab everywhere.
 */
function installBrowserShortcuts(manager: HelmstackCore, backend: ElectronBackend, window: BrowserWindow): void {
  const platform = detectShortcutPlatform(process.platform);
  const host: ShortcutHost = {
    activeTabId: () => backend.activeId(),
    tabCount: () => backend.listTabs().length,
    tabAtOffset: (delta) => backend.tabAtOffset(delta),
    tabAtIndex: (index) => backend.tabAtIndex(index),
    isLoading: (tabId) => backend.isLoading(tabId),
    openBlankTab: () => manager.createTab("about:blank"),
    closeTab: (tabId) => manager.closeTab(tabId),
    focusTab: (tabId) => backend.focusTab(tabId),
    reopenClosedTab: async () => {
      const closed = backend.popClosedTab();
      if (!closed) return;
      const tabs = await manager.createTab(closed.url);
      const created = tabs.find((tab) => tab.isActive);
      if (created) backend.moveTab(created.id, closed.index);
    },
    goBack: (tabId) => backend.goBack(tabId),
    goForward: (tabId) => backend.goForward(tabId),
    reload: (tabId, hard) => backend.reload(tabId, { ignoreCache: hard }),
    stop: (tabId) => backend.stop(tabId),
    zoom: (tabId, action) => backend.zoomTab(tabId, action),
    toggleDevTools: (tabId) => backend.toggleDevTools(tabId),
    print: (tabId) => backend.print(tabId),
    closeWindow: () => window.close(),
    toShell: (id: ShortcutId) => sendToShell(BrowserShellChannel.Shortcut, id),
    focusShell: () => {
      if (!window.isDestroyed()) window.webContents.focus();
    },
    focusPage: () => backend.focusActivePage(),
    onError: (id, error) => console.warn(`[shortcuts] ${id} failed:`, error)
  };
  const run = createShortcutRunner(host);

  const router = (surface: "page" | "shell") => (event: Electron.Event, input: Electron.Input) => {
    if (routeKeyInput(input, platform, surface, run) === "consumed") event.preventDefault();
  };
  backend.setKeyRouter(router("page"));
  window.webContents.on("before-input-event", router("shell"));

  void installAppMenu(platform, {
    run,
    openProjectPage: () => void electronShell.openExternal("https://github.com/mondb-dev/helmstack"),
    toggleShellDevTools: app.isPackaged
      ? undefined
      : () => {
          const wc = window.webContents;
          if (wc.isDevToolsOpened()) wc.closeDevTools();
          else wc.openDevTools({ mode: "detach" });
        }
  });
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
  server: AgentServer,
  runner: AgentRunner
) {
  // ── Connect an agent (MCP client install) ─────────────────────────────────
  const mcpInstall = new McpInstallService({
    homedir: os.homedir(),
    platform: process.platform,
    env: process.env,
    execPath: process.execPath,
    electron: true,
    mcpEntry: path.join(appDir, "../mcp/helmstack-mcp.mjs"),
    isPackaged: app.isPackaged,
    getConnection: () => {
      const status = server.getConnectionStatus();
      return { port: status.listening ? status.port : null, tokenFile: status.tokenPath, profile: status.profile };
    },
    extraPathDirs:
      process.platform === "win32"
        ? []
        : ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".claude", "local"), path.join(os.homedir(), ".npm-global", "bin")]
  });

  // Reports: shell window only; the renderer sends an id (and a format), never a path.
  const reportIpc = createReportIpc({
    core: manager,
    isShellSender: (sender) => Boolean(mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents),
    showSaveDialog: (options) =>
      mainWindow && !mainWindow.isDestroyed() ? dialog.showSaveDialog(mainWindow, options) : dialog.showSaveDialog(options),
    openPath: (file) => electronShell.openPath(file),
    showItemInFolder: (file) => electronShell.showItemInFolder(file),
    defaultDirectory: () => app.getPath("downloads"),
    joinPath: (dir, name) => path.join(dir, name)
  });
  // Routines: shell window only; the renderer sends an id, never spec content.
  const routineIpc = createRoutineIpc({
    core: manager,
    isShellSender: (sender) => Boolean(mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents)
  });
  const handlers: BrowserShellApi = {
    openTab: async (url?: string) => manager.createTab(url),
    navigate: async (tabId: TabId, url: string) => manager.navigate(tabId, url),
    listTabs: async () => manager.listTabs(),
    focusTab: async (tabId: TabId) => shell.focusTab(tabId),
    closeTab: async (tabId: TabId) => manager.closeTab(tabId),
    goBack: async (tabId: TabId) => {
      await shell.goBack(tabId);
      return manager.listTabs();
    },
    goForward: async (tabId: TabId) => {
      await shell.goForward(tabId);
      return manager.listTabs();
    },
    reload: async (tabId: TabId, hard?: boolean) => {
      await shell.reload(tabId, { ignoreCache: hard === true });
      return manager.listTabs();
    },
    stopLoading: async (tabId: TabId) => {
      shell.stop(tabId);
      return manager.listTabs();
    },
    findInPage: async (tabId: TabId, text: string, options?: FindInPageOptions) => shell.findInPage(tabId, text, options),
    stopFindInPage: async (tabId: TabId) => shell.stopFindInPage(tabId),
    zoomTab: async (tabId: TabId, action: ZoomAction) => {
      shell.zoomTab(tabId, action);
      return manager.listTabs();
    },
    focusPage: async () => shell.focusActivePage(),
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
    captureScreenshot: async (tabId: TabId) => shell.withHumanCapture(tabId, () => manager.captureScreenshot(tabId)),
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
    getConnectionStatus: async () => server.getConnectionStatus(),
    // In-window agent chat (arguments are validated in the IPC wrappers below)
    getAgentRunnerStatus: async () => runner.getStatus(),
    refreshAgentRunner: async () => runner.refresh(),
    startAgentConversation: async (input: StartAgentConversationInput) => runner.startConversation(input),
    sendAgentMessage: async (conversationId: string, text: string) => runner.sendMessage(conversationId, text),
    stopAgentTurn: async (conversationId: string) => runner.stopTurn(conversationId),
    listAgentConversations: async (tabId?: TabId) => runner.listConversations(tabId),
    getAgentConversationEvents: async (conversationId: string, afterSeq?: number) =>
      runner.getEvents(conversationId, afterSeq ?? 0),
    closeAgentConversation: async (conversationId: string) => runner.closeConversation(conversationId),
    // Reports (the IPC layer re-checks the sender; here the sender is the shell itself)
    listReports: async () => reportIpc.list(mainWindow?.webContents),
    saveReportAs: async (id, format) => reportIpc.saveAs(mainWindow?.webContents, id, format),
    openReport: async (id) => reportIpc.open(mainWindow?.webContents, id),
    revealReport: async (id) => reportIpc.reveal(mainWindow?.webContents, id),
    deleteReport: async (id) => reportIpc.delete(mainWindow?.webContents, id),
    // Routines (the IPC layer re-checks the sender; here the sender is the shell itself)
    listRoutines: async () => routineIpc.list(mainWindow?.webContents),
    getRoutine: async (id) => routineIpc.get(mainWindow?.webContents, id),
    getRoutineEngineStatus: async () => routineIpc.engineStatus(mainWindow?.webContents),
    approveRoutine: async (id, grants) => routineIpc.approve(mainWindow?.webContents, id, grants),
    rejectRoutine: async (id) => routineIpc.reject(mainWindow?.webContents, id),
    pauseRoutine: async (id) => routineIpc.pause(mainWindow?.webContents, id),
    resumeRoutine: async (id) => routineIpc.resume(mainWindow?.webContents, id),
    stopRoutine: async (id) => routineIpc.stop(mainWindow?.webContents, id),
    deleteRoutine: async (id) => routineIpc.delete(mainWindow?.webContents, id),
    runRoutineNow: async (id) => routineIpc.runNow(mainWindow?.webContents, id),
    cancelRoutineRun: async (id) => routineIpc.cancelRun(mainWindow?.webContents, id),
    listRoutineRuns: async (id) => routineIpc.listRuns(mainWindow?.webContents, id),
    getRoutineRun: async (id, runId) => routineIpc.getRun(mainWindow?.webContents, id, runId),
    listRoutineNotes: async (id, limit) => routineIpc.listNotes(mainWindow?.webContents, id, limit),
    getRoutineMemory: async (id) => routineIpc.memory(mainWindow?.webContents, id),
    clearRoutineMemory: async (id) => routineIpc.clearMemory(mainWindow?.webContents, id),
    setRoutineKillSwitch: async (on) => routineIpc.setKillSwitch(mainWindow?.webContents, on),
    setRoutineGrants: async (id, grants) => routineIpc.setGrants(mainWindow?.webContents, id, grants),
    listRoutineActions: async (id) => routineIpc.listActions(mainWindow?.webContents, id),
    approveRoutineAction: async (id, actionId) => routineIpc.approveAction(mainWindow?.webContents, id, actionId),
    declineRoutineAction: async (id, actionId) => routineIpc.declineAction(mainWindow?.webContents, id, actionId),
    listRoutineDocs: async (id) => routineIpc.listDocs(mainWindow?.webContents, id),
    getRoutineDoc: async (id, docId) => routineIpc.getDoc(mainWindow?.webContents, id, docId),
    addRoutineDoc: async (id, doc) => routineIpc.addDoc(mainWindow?.webContents, id, doc),
    approveRoutineDoc: async (id, docId) => routineIpc.approveDoc(mainWindow?.webContents, id, docId),
    deleteRoutineDoc: async (id, docId) => routineIpc.deleteDoc(mainWindow?.webContents, id, docId),
    getRoutineModel: async () => routineIpc.getModel(mainWindow?.webContents),
    setRoutineModel: async (choice) => routineIpc.setModel(mainWindow?.webContents, choice),
    // Connect an agent (MCP client install); see mcp-install-service.ts
    getMcpInstallOverview: async () => mcpInstall.overview(),
    runMcpInstall: async (request) => mcpInstall.handle(request)
  };

  // Chat IPC is accepted only from the shell window's own renderer and every
  // argument is type- and length-checked here (the renderer is not trusted
  // beyond the bridge). Conversation ids are random UUIDs known to the runner;
  // an unknown id is rejected.
  const fromShell = (event: IpcMainInvokeEvent) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      throw new Error("Agent chat is only available from the HelmStack window.");
    }
  };
  const str = (value: unknown, name: string, max: number): string => {
    if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error(`Invalid ${name}.`);
    return value;
  };
  const conversationId = (value: unknown): string => {
    const id = str(value, "conversation id", 64);
    if (!runner.hasConversation(id)) throw new Error("Unknown conversation.");
    return id;
  };
  // Browser navigation / find / zoom: shell-only, tab must exist, arguments checked.
  const liveTab = (event: IpcMainInvokeEvent, value: unknown): TabId => {
    fromShell(event);
    const id = str(value, "tab id", 200);
    if (!shell.getTab(id)) throw new Error("Unknown tab.");
    return id;
  };
  ipcMain.handle(BrowserShellChannel.GoBack, (event, tabId: unknown) => handlers.goBack(liveTab(event, tabId)));
  ipcMain.handle(BrowserShellChannel.GoForward, (event, tabId: unknown) => handlers.goForward(liveTab(event, tabId)));
  ipcMain.handle(BrowserShellChannel.Reload, (event, tabId: unknown, hard: unknown) =>
    handlers.reload(liveTab(event, tabId), parseReloadMode(hard))
  );
  ipcMain.handle(BrowserShellChannel.StopLoading, (event, tabId: unknown) => handlers.stopLoading(liveTab(event, tabId)));
  ipcMain.handle(BrowserShellChannel.FindInPage, (event, tabId: unknown, text: unknown, raw: unknown) =>
    handlers.findInPage(liveTab(event, tabId), parseFindText(text), parseFindOptions(raw))
  );
  ipcMain.handle(BrowserShellChannel.StopFindInPage, (event, tabId: unknown) => handlers.stopFindInPage(liveTab(event, tabId)));
  ipcMain.handle(BrowserShellChannel.ZoomTab, (event, tabId: unknown, action: unknown) =>
    handlers.zoomTab(liveTab(event, tabId), parseZoomAction(action))
  );
  ipcMain.handle(BrowserShellChannel.FocusPage, (event) => {
    fromShell(event);
    return handlers.focusPage();
  });
  shell.onFindResult((result) => sendToShell(BrowserShellChannel.FindResult, result));

  ipcMain.handle(BrowserShellChannel.GetAgentRunnerStatus, (event) => {
    fromShell(event);
    return handlers.getAgentRunnerStatus();
  });
  ipcMain.handle(BrowserShellChannel.RefreshAgentRunner, (event) => {
    fromShell(event);
    return handlers.refreshAgentRunner();
  });
  ipcMain.handle(BrowserShellChannel.StartAgentConversation, (event, raw: unknown) => {
    fromShell(event);
    if (!raw || typeof raw !== "object") throw new Error("Invalid conversation request.");
    const input = raw as Record<string, unknown>;
    const cliId = str(input.cliId, "cli", 32) as AgentCliId;
    if (!(AGENT_CLI_IDS as readonly string[]).includes(cliId)) throw new Error("Unknown agent CLI.");
    const model = typeof input.model === "string" ? input.model : "";
    if (model.length > 80) throw new Error("Invalid model id.");
    const clean: StartAgentConversationInput = {
      tabId: str(input.tabId, "tab id", 200),
      cliId,
      model
    };
    if (input.workingDirectory !== undefined) clean.workingDirectory = str(input.workingDirectory, "working directory", 4096);
    if (input.allowUnconfined === true) clean.allowUnconfined = true;
    return runner.startConversation(clean);
  });
  ipcMain.handle(BrowserShellChannel.SendAgentMessage, (event, id: unknown, text: unknown) => {
    fromShell(event);
    return handlers.sendAgentMessage(conversationId(id), str(text, "message", 32_000));
  });
  ipcMain.handle(BrowserShellChannel.StopAgentTurn, (event, id: unknown) => {
    fromShell(event);
    return handlers.stopAgentTurn(str(id, "conversation id", 64));
  });
  ipcMain.handle(BrowserShellChannel.ListAgentConversations, (event, tabId: unknown) => {
    fromShell(event);
    return handlers.listAgentConversations(tabId === undefined ? undefined : str(tabId, "tab id", 200));
  });
  ipcMain.handle(BrowserShellChannel.GetAgentConversationEvents, (event, id: unknown, afterSeq: unknown) => {
    fromShell(event);
    if (afterSeq !== undefined && (typeof afterSeq !== "number" || !Number.isInteger(afterSeq) || afterSeq < 0)) {
      throw new Error("Invalid sequence number.");
    }
    return handlers.getAgentConversationEvents(conversationId(id), afterSeq as number | undefined);
  });
  ipcMain.handle(BrowserShellChannel.CloseAgentConversation, (event, id: unknown) => {
    fromShell(event);
    return handlers.closeAgentConversation(str(id, "conversation id", 64));
  });
  runner.onEvent((chatEvent) => {
    sendToShell(BrowserShellChannel.AgentChatEvent, chatEvent);
  });

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
  ipcMain.handle(BrowserShellChannel.ListReports, (event) => reportIpc.list(event.sender));
  ipcMain.handle(BrowserShellChannel.SaveReportAs, (event, id: unknown, format: unknown) => reportIpc.saveAs(event.sender, id, format));
  ipcMain.handle(BrowserShellChannel.OpenReport, (event, id: unknown) => reportIpc.open(event.sender, id));
  ipcMain.handle(BrowserShellChannel.RevealReport, (event, id: unknown) => reportIpc.reveal(event.sender, id));
  ipcMain.handle(BrowserShellChannel.DeleteReport, (event, id: unknown) => reportIpc.delete(event.sender, id));
  manager.onReportsChanged((reports, created) => {
    sendToShell(BrowserShellChannel.ReportsChanged, reports, created);
  });
  ipcMain.handle(BrowserShellChannel.ListRoutines, (event) => routineIpc.list(event.sender));
  ipcMain.handle(BrowserShellChannel.GetRoutine, (event, id: unknown) => routineIpc.get(event.sender, id));
  ipcMain.handle(BrowserShellChannel.GetRoutineEngineStatus, (event) => routineIpc.engineStatus(event.sender));
  ipcMain.handle(BrowserShellChannel.ApproveRoutine, (event, id: unknown, grants: unknown) => routineIpc.approve(event.sender, id, grants));
  ipcMain.handle(BrowserShellChannel.RejectRoutine, (event, id: unknown) => routineIpc.reject(event.sender, id));
  ipcMain.handle(BrowserShellChannel.PauseRoutine, (event, id: unknown) => routineIpc.pause(event.sender, id));
  ipcMain.handle(BrowserShellChannel.ResumeRoutine, (event, id: unknown) => routineIpc.resume(event.sender, id));
  ipcMain.handle(BrowserShellChannel.StopRoutine, (event, id: unknown) => routineIpc.stop(event.sender, id));
  ipcMain.handle(BrowserShellChannel.DeleteRoutine, (event, id: unknown) => routineIpc.delete(event.sender, id));
  ipcMain.handle(BrowserShellChannel.RunRoutineNow, (event, id: unknown) => routineIpc.runNow(event.sender, id));
  ipcMain.handle(BrowserShellChannel.CancelRoutineRun, (event, id: unknown) => routineIpc.cancelRun(event.sender, id));
  ipcMain.handle(BrowserShellChannel.ListRoutineRuns, (event, id: unknown) => routineIpc.listRuns(event.sender, id));
  ipcMain.handle(BrowserShellChannel.GetRoutineRun, (event, id: unknown, runId: unknown) => routineIpc.getRun(event.sender, id, runId));
  ipcMain.handle(BrowserShellChannel.ListRoutineNotes, (event, id: unknown, limit: unknown) => routineIpc.listNotes(event.sender, id, limit));
  ipcMain.handle(BrowserShellChannel.GetRoutineMemory, (event, id: unknown) => routineIpc.memory(event.sender, id));
  ipcMain.handle(BrowserShellChannel.ClearRoutineMemory, (event, id: unknown) => routineIpc.clearMemory(event.sender, id));
  ipcMain.handle(BrowserShellChannel.SetRoutineKillSwitch, (event, on: unknown) => routineIpc.setKillSwitch(event.sender, on));
  ipcMain.handle(BrowserShellChannel.SetRoutineGrants, (event, id: unknown, grants: unknown) => routineIpc.setGrants(event.sender, id, grants));
  ipcMain.handle(BrowserShellChannel.ListRoutineActions, (event, id: unknown) => routineIpc.listActions(event.sender, id));
  ipcMain.handle(BrowserShellChannel.ApproveRoutineAction, (event, id: unknown, actionId: unknown) => routineIpc.approveAction(event.sender, id, actionId));
  ipcMain.handle(BrowserShellChannel.DeclineRoutineAction, (event, id: unknown, actionId: unknown) => routineIpc.declineAction(event.sender, id, actionId));
  ipcMain.handle(BrowserShellChannel.ListRoutineDocs, (event, id: unknown) => routineIpc.listDocs(event.sender, id));
  ipcMain.handle(BrowserShellChannel.GetRoutineDoc, (event, id: unknown, docId: unknown) => routineIpc.getDoc(event.sender, id, docId));
  ipcMain.handle(BrowserShellChannel.AddRoutineDoc, (event, id: unknown, doc: unknown) => routineIpc.addDoc(event.sender, id, doc));
  ipcMain.handle(BrowserShellChannel.ApproveRoutineDoc, (event, id: unknown, docId: unknown) => routineIpc.approveDoc(event.sender, id, docId));
  ipcMain.handle(BrowserShellChannel.DeleteRoutineDoc, (event, id: unknown, docId: unknown) => routineIpc.deleteDoc(event.sender, id, docId));
  ipcMain.handle(BrowserShellChannel.GetRoutineModel, (event) => routineIpc.getModel(event.sender));
  ipcMain.handle(BrowserShellChannel.SetRoutineModel, (event, choice: unknown) => routineIpc.setModel(event.sender, choice));
  manager.onRoutineActionUpdated((event) => {
    sendToShell(BrowserShellChannel.RoutineActionsChanged, event.routineId);
  });
  manager.onRoutineDocsChanged((routineId) => {
    sendToShell(BrowserShellChannel.RoutineDocsChanged, routineId);
  });
  manager.onRoutineRunUpdated((run) => {
    sendToShell(BrowserShellChannel.RoutineRunUpdated, run);
  });
  manager.onRoutinesChanged((routines, proposed) => {
    sendToShell(BrowserShellChannel.RoutinesChanged, routines, proposed);
  });
  ipcMain.handle(BrowserShellChannel.GetConnectionStatus, () => handlers.getConnectionStatus());
  // Connect an agent: shell window only; the service validates the request
  // (client id, action and options are allowlisted) and builds every command.
  const mcpIpc = createMcpInstallIpc(
    mcpInstall,
    (sender) => Boolean(mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents)
  );
  ipcMain.handle(BrowserShellChannel.GetMcpInstallOverview, (event) => mcpIpc.overview(event.sender));
  ipcMain.handle(BrowserShellChannel.RunMcpInstall, (event, request: unknown) => mcpIpc.run(event.sender, request));

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

app.on("before-quit", () => {
  void agentRunner?.dispose();
});

app.on("window-all-closed", () => {
  void agentRunner?.dispose();
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
