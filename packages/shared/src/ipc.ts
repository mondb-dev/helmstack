import type { AccountInput, AccountSummary, AccountUpdate, TotpResult } from "./account.js";
import type { BrowserCommandResult, BrowserOutputCommand, BrowserPerceptionPacket, HumanHandoffRecord, PendingApproval, SiteCapabilityManifest } from "./substrate.js";
import type { PageObservation, PerceptionResult } from "./perception.js";
import type { ElementPickResult, PageScreenshot, PageSnapshot, TabId, TabSummary, ViewportRect } from "./browser.js";
import type { ApprovalPolicyRecord } from "./policy.js";
import type { AgentActivityEntry, AgentConnectionStatus, TabOverrideKind, TabOverrides } from "./shell-status.js";
import type { FixturePageName, VaultSecretInput, VaultSecretSummary, VaultStatus } from "./vault.js";

export const BrowserShellChannel = {
  OpenTab: "browser-shell:open-tab",
  Navigate: "browser-shell:navigate",
  ListTabs: "browser-shell:list-tabs",
  FocusTab: "browser-shell:focus-tab",
  CloseTab: "browser-shell:close-tab",
  SetViewport: "browser-shell:set-viewport",
  CaptureSnapshot: "browser-shell:capture-snapshot",
  GetLatestObservation: "browser-shell:get-latest-observation",
  CapturePerception: "browser-shell:capture-perception",
  GetPerceptionPacket: "browser-shell:get-perception-packet",
  ListCapabilityManifests: "browser-shell:list-capability-manifests",
  ExecuteCommand: "browser-shell:execute-command",
  ApproveCommand: "browser-shell:approve-command",
  RejectCommand: "browser-shell:reject-command",
  ListVaultSecrets: "browser-shell:list-vault-secrets",
  SaveVaultSecrets: "browser-shell:save-vault-secrets",
  GetVaultStatus: "browser-shell:get-vault-status",
  ListApprovalPolicies: "browser-shell:list-approval-policies",
  UpdateApprovalPolicy: "browser-shell:update-approval-policy",
  GetFixtureUrl: "browser-shell:get-fixture-url",
  // Screenshot
  CaptureScreenshot: "browser-shell:capture-screenshot",
  // Element picker (human inspect → agent)
  PickElement: "browser-shell:pick-element",
  // Handoff
  ListHandoffs: "browser-shell:list-handoffs",
  ResolveHandoff: "browser-shell:resolve-handoff",
  CancelHandoff: "browser-shell:cancel-handoff",
  // Accounts
  ListAccounts: "browser-shell:list-accounts",
  SaveAccount: "browser-shell:save-account",
  UpdateAccount: "browser-shell:update-account",
  DeleteAccount: "browser-shell:delete-account",
  LookupAccounts: "browser-shell:lookup-accounts",
  GenerateTotp: "browser-shell:generate-totp",
  // Intent
  SetIntent: "browser-shell:set-intent",
  GetIntent: "browser-shell:get-intent",
  // Agent status surfaces
  ListPendingApprovals: "browser-shell:list-pending-approvals",
  GetTabOverrides: "browser-shell:get-tab-overrides",
  ClearTabOverrides: "browser-shell:clear-tab-overrides",
  ListAgentActivity: "browser-shell:list-agent-activity",
  GetConnectionStatus: "browser-shell:get-connection-status",

  TabsChanged: "browser-shell:tabs-changed",
  PageObserved: "browser-shell:page-observed",
  HandoffRequested: "browser-shell:handoff-requested",
  AgentLog: "browser-shell:agent-log",
  ApprovalsChanged: "browser-shell:approvals-changed",
  TabOverridesChanged: "browser-shell:tab-overrides-changed",
  AgentActivity: "browser-shell:agent-activity",
  ConnectionStatusChanged: "browser-shell:connection-status-changed"
} as const;

export type BrowserShellApi = {
  openTab(url?: string): Promise<TabSummary[]>;
  navigate(tabId: TabId, url: string): Promise<TabSummary[]>;
  listTabs(): Promise<TabSummary[]>;
  focusTab(tabId: TabId): Promise<TabSummary[]>;
  closeTab(tabId: TabId): Promise<TabSummary[]>;
  setViewport(rect: ViewportRect): Promise<void>;
  captureSnapshot(tabId: TabId): Promise<PageSnapshot>;
  getLatestObservation(tabId: TabId): Promise<PageObservation | null>;
  capturePerception(tabId: TabId): Promise<PerceptionResult>;
  getPerceptionPacket(tabId: TabId): Promise<BrowserPerceptionPacket>;
  listCapabilityManifests(tabId: TabId): Promise<SiteCapabilityManifest[]>;
  executeCommand(tabId: TabId, command: BrowserOutputCommand): Promise<BrowserCommandResult>;
  approveCommand(requestId: string): Promise<BrowserCommandResult>;
  rejectCommand(requestId: string): Promise<BrowserCommandResult>;
  listVaultSecrets(): Promise<VaultSecretSummary[]>;
  saveVaultSecrets(updates: VaultSecretInput[]): Promise<VaultSecretSummary[]>;
  getVaultStatus(): Promise<VaultStatus>;
  listApprovalPolicies(): Promise<ApprovalPolicyRecord[]>;
  updateApprovalPolicy(key: ApprovalPolicyRecord["key"], decision: ApprovalPolicyRecord["decision"]): Promise<ApprovalPolicyRecord[]>;
  getFixtureUrl(name: FixturePageName): Promise<string>;
  // Screenshot
  captureScreenshot(tabId: TabId): Promise<PageScreenshot>;
  // Element picker (human inspect → agent)
  pickElement(tabId: TabId): Promise<ElementPickResult>;
  // Handoffs
  listHandoffs(): Promise<HumanHandoffRecord[]>;
  resolveHandoff(requestId: string): Promise<BrowserCommandResult>;
  cancelHandoff(requestId: string): Promise<BrowserCommandResult>;
  // Accounts
  listAccounts(): Promise<AccountSummary[]>;
  saveAccount(input: AccountInput): Promise<AccountSummary>;
  updateAccount(id: string, update: AccountUpdate): Promise<AccountSummary>;
  deleteAccount(id: string): Promise<void>;
  lookupAccounts(origin: string): Promise<AccountSummary[]>;
  generateTotp(accountId: string): Promise<TotpResult>;
  // Intent
  setIntent(intent: string): Promise<void>;
  getIntent(): Promise<string>;
  // Agent status surfaces
  /** Approvals waiting for a human decision, oldest first. */
  listPendingApprovals(): Promise<PendingApproval[]>;
  getTabOverrides(tabId: TabId): Promise<TabOverrides>;
  /** Clears one override kind, or every agent override on the tab. Returns the new state. */
  clearTabOverrides(tabId: TabId, kind: TabOverrideKind | "all"): Promise<TabOverrides>;
  /** Most recent agent API calls, oldest first (bounded buffer). */
  listAgentActivity(): Promise<AgentActivityEntry[]>;
  getConnectionStatus(): Promise<AgentConnectionStatus>;
};

export type AgentLogEntry = {
  level: "system" | "agent" | "ai" | "error" | "nav";
  message: string;
  timestamp: number;
};

export type BrowserShellBridge = BrowserShellApi & {
  onTabsChanged(callback: (tabs: TabSummary[]) => void): () => void;
  onPageObserved(callback: (observation: PageObservation) => void): () => void;
  onHandoffRequested(callback: (handoff: HumanHandoffRecord) => void): () => void;
  onAgentLog(callback: (entry: AgentLogEntry) => void): () => void;
  /** Fires with the full pending list whenever an approval is queued or resolved. */
  onApprovalsChanged(callback: (pending: PendingApproval[]) => void): () => void;
  onTabOverridesChanged(callback: (overrides: TabOverrides) => void): () => void;
  onAgentActivity(callback: (entry: AgentActivityEntry) => void): () => void;
  onConnectionStatusChanged(callback: (status: AgentConnectionStatus) => void): () => void;
};
