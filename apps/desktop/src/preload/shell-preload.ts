import { contextBridge, ipcRenderer } from "electron";

import {
  BrowserShellChannel,
  type AgentLogEntry,
  type BrowserShellBridge,
  type HumanHandoffRecord,
  type TabId,
  type ViewportRect
} from "../../../../packages/shared/src/index.js";

const browserShell: BrowserShellBridge = {
  openTab: (url?: string) => ipcRenderer.invoke(BrowserShellChannel.OpenTab, url),
  navigate: (tabId: TabId, url: string) => ipcRenderer.invoke(BrowserShellChannel.Navigate, tabId, url),
  listTabs: () => ipcRenderer.invoke(BrowserShellChannel.ListTabs),
  focusTab: (tabId: TabId) => ipcRenderer.invoke(BrowserShellChannel.FocusTab, tabId),
  closeTab: (tabId: TabId) => ipcRenderer.invoke(BrowserShellChannel.CloseTab, tabId),
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
  }
};

contextBridge.exposeInMainWorld("browserShell", browserShell);
