import { contextBridge, ipcRenderer } from "electron";

import {
  BrowserShellChannel,
  type AgentActivityEntry,
  type AgentChatEvent,
  type AgentConnectionStatus,
  type AgentLogEntry,
  type FindInPageResult,
  type ShortcutId,
  type BrowserShellBridge,
  type HumanHandoffRecord,
  type PendingApproval,
  type ReportSummary,
  type RoutineRunSummary,
  type RoutineSummary,
  type TabId,
  type TabOverrideKind,
  type TabOverrides,
  type ViewportRect
} from "../../../../packages/shared/src/index.js";

const browserShell: BrowserShellBridge = {
  openTab: (url?: string) => ipcRenderer.invoke(BrowserShellChannel.OpenTab, url),
  navigate: (tabId: TabId, url: string) => ipcRenderer.invoke(BrowserShellChannel.Navigate, tabId, url),
  listTabs: () => ipcRenderer.invoke(BrowserShellChannel.ListTabs),
  focusTab: (tabId: TabId) => ipcRenderer.invoke(BrowserShellChannel.FocusTab, tabId),
  closeTab: (tabId: TabId) => ipcRenderer.invoke(BrowserShellChannel.CloseTab, tabId),
  goBack: (tabId: TabId) => ipcRenderer.invoke(BrowserShellChannel.GoBack, tabId),
  goForward: (tabId: TabId) => ipcRenderer.invoke(BrowserShellChannel.GoForward, tabId),
  reload: (tabId: TabId, hard?: boolean) => ipcRenderer.invoke(BrowserShellChannel.Reload, tabId, hard),
  stopLoading: (tabId: TabId) => ipcRenderer.invoke(BrowserShellChannel.StopLoading, tabId),
  findInPage: (tabId, text, options) => ipcRenderer.invoke(BrowserShellChannel.FindInPage, tabId, text, options),
  stopFindInPage: (tabId) => ipcRenderer.invoke(BrowserShellChannel.StopFindInPage, tabId),
  zoomTab: (tabId, action) => ipcRenderer.invoke(BrowserShellChannel.ZoomTab, tabId, action),
  focusPage: () => ipcRenderer.invoke(BrowserShellChannel.FocusPage),
  setViewport: (rect: ViewportRect) => ipcRenderer.invoke(BrowserShellChannel.SetViewport, rect),
  captureSnapshot: (tabId: TabId) => ipcRenderer.invoke(BrowserShellChannel.CaptureSnapshot, tabId),
  getLatestObservation: (tabId: TabId) => ipcRenderer.invoke(BrowserShellChannel.GetLatestObservation, tabId),
  capturePerception: (tabId: TabId) => ipcRenderer.invoke(BrowserShellChannel.CapturePerception, tabId),
  getPerceptionPacket: (tabId: TabId) => ipcRenderer.invoke(BrowserShellChannel.GetPerceptionPacket, tabId),
  listCapabilityManifests: (tabId: TabId) => ipcRenderer.invoke(BrowserShellChannel.ListCapabilityManifests, tabId),
  executeCommand: (tabId: TabId, command) => ipcRenderer.invoke(BrowserShellChannel.ExecuteCommand, tabId, command),
  approveCommand: (requestId: string) => ipcRenderer.invoke(BrowserShellChannel.ApproveCommand, requestId),
  rejectCommand: (requestId: string) => ipcRenderer.invoke(BrowserShellChannel.RejectCommand, requestId),
  listVaultSecrets: () => ipcRenderer.invoke(BrowserShellChannel.ListVaultSecrets),
  saveVaultSecrets: (updates) => ipcRenderer.invoke(BrowserShellChannel.SaveVaultSecrets, updates),
  getVaultStatus: () => ipcRenderer.invoke(BrowserShellChannel.GetVaultStatus),
  listApprovalPolicies: () => ipcRenderer.invoke(BrowserShellChannel.ListApprovalPolicies),
  updateApprovalPolicy: (key, decision) => ipcRenderer.invoke(BrowserShellChannel.UpdateApprovalPolicy, key, decision),
  getFixtureUrl: (name) => ipcRenderer.invoke(BrowserShellChannel.GetFixtureUrl, name),
  // Screenshot
  captureScreenshot: (tabId) => ipcRenderer.invoke(BrowserShellChannel.CaptureScreenshot, tabId),
  // Element picker (human inspect → agent)
  pickElement: (tabId: TabId) => ipcRenderer.invoke(BrowserShellChannel.PickElement, tabId),
  // Handoffs
  listHandoffs: () => ipcRenderer.invoke(BrowserShellChannel.ListHandoffs),
  resolveHandoff: (requestId) => ipcRenderer.invoke(BrowserShellChannel.ResolveHandoff, requestId),
  cancelHandoff: (requestId) => ipcRenderer.invoke(BrowserShellChannel.CancelHandoff, requestId),
  // Accounts
  listAccounts: () => ipcRenderer.invoke(BrowserShellChannel.ListAccounts),
  saveAccount: (input) => ipcRenderer.invoke(BrowserShellChannel.SaveAccount, input),
  updateAccount: (id, update) => ipcRenderer.invoke(BrowserShellChannel.UpdateAccount, id, update),
  deleteAccount: (id) => ipcRenderer.invoke(BrowserShellChannel.DeleteAccount, id),
  lookupAccounts: (origin) => ipcRenderer.invoke(BrowserShellChannel.LookupAccounts, origin),
  generateTotp: (accountId) => ipcRenderer.invoke(BrowserShellChannel.GenerateTotp, accountId),
  // Intent
  setIntent: (intent: string) => ipcRenderer.invoke(BrowserShellChannel.SetIntent, intent),
  getIntent: () => ipcRenderer.invoke(BrowserShellChannel.GetIntent),
  // Agent status surfaces
  listPendingApprovals: () => ipcRenderer.invoke(BrowserShellChannel.ListPendingApprovals),
  getTabOverrides: (tabId: TabId) => ipcRenderer.invoke(BrowserShellChannel.GetTabOverrides, tabId),
  clearTabOverrides: (tabId: TabId, kind: TabOverrideKind | "all") =>
    ipcRenderer.invoke(BrowserShellChannel.ClearTabOverrides, tabId, kind),
  listAgentActivity: () => ipcRenderer.invoke(BrowserShellChannel.ListAgentActivity),
  getConnectionStatus: () => ipcRenderer.invoke(BrowserShellChannel.GetConnectionStatus),
  // Reports
  listReports: () => ipcRenderer.invoke(BrowserShellChannel.ListReports),
  saveReportAs: (id, format) => ipcRenderer.invoke(BrowserShellChannel.SaveReportAs, id, format),
  openReport: (id) => ipcRenderer.invoke(BrowserShellChannel.OpenReport, id),
  revealReport: (id) => ipcRenderer.invoke(BrowserShellChannel.RevealReport, id),
  deleteReport: (id) => ipcRenderer.invoke(BrowserShellChannel.DeleteReport, id),
  // Routines
  listRoutines: () => ipcRenderer.invoke(BrowserShellChannel.ListRoutines),
  getRoutine: (id) => ipcRenderer.invoke(BrowserShellChannel.GetRoutine, id),
  getRoutineEngineStatus: () => ipcRenderer.invoke(BrowserShellChannel.GetRoutineEngineStatus),
  approveRoutine: (id, grants) => ipcRenderer.invoke(BrowserShellChannel.ApproveRoutine, id, grants),
  rejectRoutine: (id) => ipcRenderer.invoke(BrowserShellChannel.RejectRoutine, id),
  pauseRoutine: (id) => ipcRenderer.invoke(BrowserShellChannel.PauseRoutine, id),
  resumeRoutine: (id) => ipcRenderer.invoke(BrowserShellChannel.ResumeRoutine, id),
  stopRoutine: (id) => ipcRenderer.invoke(BrowserShellChannel.StopRoutine, id),
  deleteRoutine: (id) => ipcRenderer.invoke(BrowserShellChannel.DeleteRoutine, id),
  runRoutineNow: (id) => ipcRenderer.invoke(BrowserShellChannel.RunRoutineNow, id),
  cancelRoutineRun: (id) => ipcRenderer.invoke(BrowserShellChannel.CancelRoutineRun, id),
  listRoutineRuns: (id) => ipcRenderer.invoke(BrowserShellChannel.ListRoutineRuns, id),
  getRoutineRun: (id, runId) => ipcRenderer.invoke(BrowserShellChannel.GetRoutineRun, id, runId),
  listRoutineNotes: (id, limit) => ipcRenderer.invoke(BrowserShellChannel.ListRoutineNotes, id, limit),
  getRoutineMemory: (id) => ipcRenderer.invoke(BrowserShellChannel.GetRoutineMemory, id),
  clearRoutineMemory: (id) => ipcRenderer.invoke(BrowserShellChannel.ClearRoutineMemory, id),
  setRoutineKillSwitch: (on) => ipcRenderer.invoke(BrowserShellChannel.SetRoutineKillSwitch, on),
  setRoutineGrants: (id, grants) => ipcRenderer.invoke(BrowserShellChannel.SetRoutineGrants, id, grants),
  listRoutineActions: (id) => ipcRenderer.invoke(BrowserShellChannel.ListRoutineActions, id),
  approveRoutineAction: (id, actionId) => ipcRenderer.invoke(BrowserShellChannel.ApproveRoutineAction, id, actionId),
  declineRoutineAction: (id, actionId) => ipcRenderer.invoke(BrowserShellChannel.DeclineRoutineAction, id, actionId),
  listRoutineDocs: (id) => ipcRenderer.invoke(BrowserShellChannel.ListRoutineDocs, id),
  getRoutineDoc: (id, docId) => ipcRenderer.invoke(BrowserShellChannel.GetRoutineDoc, id, docId),
  addRoutineDoc: (id, doc) => ipcRenderer.invoke(BrowserShellChannel.AddRoutineDoc, id, doc),
  approveRoutineDoc: (id, docId) => ipcRenderer.invoke(BrowserShellChannel.ApproveRoutineDoc, id, docId),
  deleteRoutineDoc: (id, docId) => ipcRenderer.invoke(BrowserShellChannel.DeleteRoutineDoc, id, docId),
  getRoutineModel: () => ipcRenderer.invoke(BrowserShellChannel.GetRoutineModel),
  setRoutineModel: (choice) => ipcRenderer.invoke(BrowserShellChannel.SetRoutineModel, choice),
  // Connect an agent
  getMcpInstallOverview: () => ipcRenderer.invoke(BrowserShellChannel.GetMcpInstallOverview),
  runMcpInstall: (request) => ipcRenderer.invoke(BrowserShellChannel.RunMcpInstall, request),
  // In-window agent chat
  getAgentRunnerStatus: () => ipcRenderer.invoke(BrowserShellChannel.GetAgentRunnerStatus),
  refreshAgentRunner: () => ipcRenderer.invoke(BrowserShellChannel.RefreshAgentRunner),
  startAgentConversation: (input) => ipcRenderer.invoke(BrowserShellChannel.StartAgentConversation, input),
  sendAgentMessage: (conversationId, text) => ipcRenderer.invoke(BrowserShellChannel.SendAgentMessage, conversationId, text),
  stopAgentTurn: (conversationId) => ipcRenderer.invoke(BrowserShellChannel.StopAgentTurn, conversationId),
  listAgentConversations: (tabId) => ipcRenderer.invoke(BrowserShellChannel.ListAgentConversations, tabId),
  getAgentConversationEvents: (conversationId, afterSeq) =>
    ipcRenderer.invoke(BrowserShellChannel.GetAgentConversationEvents, conversationId, afterSeq),
  closeAgentConversation: (conversationId) => ipcRenderer.invoke(BrowserShellChannel.CloseAgentConversation, conversationId),
  onAgentChatEvent: (callback) => subscribe<AgentChatEvent>(BrowserShellChannel.AgentChatEvent, callback),
  onTabsChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, tabs: Awaited<ReturnType<BrowserShellBridge["listTabs"]>>) => {
      callback(tabs);
    };
    ipcRenderer.on(BrowserShellChannel.TabsChanged, listener);
    return () => ipcRenderer.removeListener(BrowserShellChannel.TabsChanged, listener);
  },
  onPageObserved: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      observation: Awaited<ReturnType<BrowserShellBridge["getLatestObservation"]>>
    ) => {
      if (observation) {
        callback(observation);
      }
    };
    ipcRenderer.on(BrowserShellChannel.PageObserved, listener);
    return () => ipcRenderer.removeListener(BrowserShellChannel.PageObserved, listener);
  },
  onHandoffRequested: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, handoff: HumanHandoffRecord) => {
      callback(handoff);
    };
    ipcRenderer.on(BrowserShellChannel.HandoffRequested, listener);
    return () => ipcRenderer.removeListener(BrowserShellChannel.HandoffRequested, listener);
  },
  onAgentLog: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, entry: AgentLogEntry) => {
      callback(entry);
    };
    ipcRenderer.on(BrowserShellChannel.AgentLog, listener);
    return () => ipcRenderer.removeListener(BrowserShellChannel.AgentLog, listener);
  },
  onFindResult: (callback) => subscribe<FindInPageResult>(BrowserShellChannel.FindResult, callback),
  onShortcut: (callback) => subscribe<ShortcutId>(BrowserShellChannel.Shortcut, callback),
  onApprovalsChanged: (callback) => subscribe<PendingApproval[]>(BrowserShellChannel.ApprovalsChanged, callback),
  onTabOverridesChanged: (callback) => subscribe<TabOverrides>(BrowserShellChannel.TabOverridesChanged, callback),
  onAgentActivity: (callback) => subscribe<AgentActivityEntry>(BrowserShellChannel.AgentActivity, callback),
  onConnectionStatusChanged: (callback) =>
    subscribe<AgentConnectionStatus>(BrowserShellChannel.ConnectionStatusChanged, callback),
  onReportsChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, reports: ReportSummary[], created?: ReportSummary) =>
      callback(reports, created);
    ipcRenderer.on(BrowserShellChannel.ReportsChanged, listener);
    return () => ipcRenderer.removeListener(BrowserShellChannel.ReportsChanged, listener);
  },
  onRoutineActionsChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, routineId: string) => callback(routineId);
    ipcRenderer.on(BrowserShellChannel.RoutineActionsChanged, listener);
    return () => ipcRenderer.removeListener(BrowserShellChannel.RoutineActionsChanged, listener);
  },
  onRoutineDocsChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, routineId: string) => callback(routineId);
    ipcRenderer.on(BrowserShellChannel.RoutineDocsChanged, listener);
    return () => ipcRenderer.removeListener(BrowserShellChannel.RoutineDocsChanged, listener);
  },
  onRoutineRunUpdated: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, run: RoutineRunSummary) => callback(run);
    ipcRenderer.on(BrowserShellChannel.RoutineRunUpdated, listener);
    return () => ipcRenderer.removeListener(BrowserShellChannel.RoutineRunUpdated, listener);
  },
  onRoutinesChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, routines: RoutineSummary[], proposed?: RoutineSummary) =>
      callback(routines, proposed);
    ipcRenderer.on(BrowserShellChannel.RoutinesChanged, listener);
    return () => ipcRenderer.removeListener(BrowserShellChannel.RoutinesChanged, listener);
  }
};

/** Forward one main-process event channel to `callback`; returns the unsubscribe. */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld("browserShell", browserShell);
