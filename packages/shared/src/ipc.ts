import type { AccountInput, AccountSummary, AccountUpdate, TotpResult } from "./account.js";
import type { BrowserCommandResult, BrowserOutputCommand, BrowserPerceptionPacket, HumanHandoffRecord, PendingApproval, SiteCapabilityManifest } from "./substrate.js";
import type { PageObservation, PerceptionResult } from "./perception.js";
import type { ElementPickResult, PageScreenshot, PageSnapshot, TabId, TabSummary, ViewportRect } from "./browser.js";
import type { ApprovalPolicyRecord } from "./policy.js";
import type { ReportFormat, ReportSummary } from "./report.js";
import type {
  RoutineDetail,
  RoutineEngineStatus,
  RoutineAction,
  RoutineGrants,
  RoutineMemory,
  RoutineModelChoice,
  RoutineModelStatus,
  RoutineNote,
  RoutineRunDetail,
  RoutineRunSummary,
  RoutineSummary
} from "./routine.js";
import type { AgentChatEvent, AgentConversationSummary, AgentRunnerStatus, StartAgentConversationInput } from "./agent-chat.js";
import type { AgentActivityEntry, AgentConnectionStatus, TabOverrideKind, TabOverrides } from "./shell-status.js";
import type { ShortcutId } from "./shortcuts.js";
import type { McpInstallOverview, McpInstallRequest, McpInstallResult } from "./mcp-install.js";
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
  // Routines (reviewed and approved by the human; agents can only propose)
  ListRoutines: "browser-shell:list-routines",
  GetRoutine: "browser-shell:get-routine",
  GetRoutineEngineStatus: "browser-shell:get-routine-engine-status",
  ApproveRoutine: "browser-shell:approve-routine",
  RejectRoutine: "browser-shell:reject-routine",
  PauseRoutine: "browser-shell:pause-routine",
  ResumeRoutine: "browser-shell:resume-routine",
  StopRoutine: "browser-shell:stop-routine",
  DeleteRoutine: "browser-shell:delete-routine",
  RunRoutineNow: "browser-shell:run-routine-now",
  CancelRoutineRun: "browser-shell:cancel-routine-run",
  ListRoutineRuns: "browser-shell:list-routine-runs",
  GetRoutineRun: "browser-shell:get-routine-run",
  ListRoutineNotes: "browser-shell:list-routine-notes",
  GetRoutineMemory: "browser-shell:get-routine-memory",
  ClearRoutineMemory: "browser-shell:clear-routine-memory",
  SetRoutineKillSwitch: "browser-shell:set-routine-kill-switch",
  SetRoutineGrants: "browser-shell:set-routine-grants",
  ListRoutineActions: "browser-shell:list-routine-actions",
  ApproveRoutineAction: "browser-shell:approve-routine-action",
  DeclineRoutineAction: "browser-shell:decline-routine-action",
  GetRoutineModel: "browser-shell:get-routine-model",
  SetRoutineModel: "browser-shell:set-routine-model",
  // Reports (files live in the app's data directory; the shell never reads their contents)
  ListReports: "browser-shell:list-reports",
  SaveReportAs: "browser-shell:save-report-as",
  OpenReport: "browser-shell:open-report",
  RevealReport: "browser-shell:reveal-report",
  DeleteReport: "browser-shell:delete-report",
  // In-window agent chat (human-initiated only)
  GetAgentRunnerStatus: "browser-shell:get-agent-runner-status",
  RefreshAgentRunner: "browser-shell:refresh-agent-runner",
  StartAgentConversation: "browser-shell:start-agent-conversation",
  SendAgentMessage: "browser-shell:send-agent-message",
  StopAgentTurn: "browser-shell:stop-agent-turn",
  ListAgentConversations: "browser-shell:list-agent-conversations",
  GetAgentConversationEvents: "browser-shell:get-agent-conversation-events",
  CloseAgentConversation: "browser-shell:close-agent-conversation",
  // Connect an agent (MCP client install; shell only)
  GetMcpInstallOverview: "browser-shell:get-mcp-install-overview",
  RunMcpInstall: "browser-shell:run-mcp-install",

  // Browser navigation, find and zoom (human-initiated, shell only)
  GoBack: "browser-shell:go-back",
  GoForward: "browser-shell:go-forward",
  Reload: "browser-shell:reload",
  StopLoading: "browser-shell:stop-loading",
  FindInPage: "browser-shell:find-in-page",
  StopFindInPage: "browser-shell:stop-find-in-page",
  ZoomTab: "browser-shell:zoom-tab",
  FocusPage: "browser-shell:focus-page",

  TabsChanged: "browser-shell:tabs-changed",
  FindResult: "browser-shell:find-result",
  Shortcut: "browser-shell:shortcut",
  PageObserved: "browser-shell:page-observed",
  HandoffRequested: "browser-shell:handoff-requested",
  AgentLog: "browser-shell:agent-log",
  ApprovalsChanged: "browser-shell:approvals-changed",
  TabOverridesChanged: "browser-shell:tab-overrides-changed",
  AgentActivity: "browser-shell:agent-activity",
  ConnectionStatusChanged: "browser-shell:connection-status-changed",
  AgentChatEvent: "browser-shell:agent-chat-event",
  ReportsChanged: "browser-shell:reports-changed",
  RoutinesChanged: "browser-shell:routines-changed",
  RoutineRunUpdated: "browser-shell:routine-run-updated",
  RoutineActionsChanged: "browser-shell:routine-actions-changed"
} as const;

/** Zoom steps the human can request for a tab. */
export type ZoomAction = "in" | "out" | "reset";

export type FindInPageOptions = {
  /** Search direction; default true (forward). */
  forward?: boolean;
  /** Continue to the next match of the same text instead of starting a new search. */
  findNext?: boolean;
  matchCase?: boolean;
};

/** Result of a find-in-page request; `cleared` means the find state was dropped (navigation, tab close). */
export type FindInPageResult = {
  tabId: TabId;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
  cleared?: boolean;
};

export type BrowserShellApi = {
  openTab(url?: string): Promise<TabSummary[]>;
  navigate(tabId: TabId, url: string): Promise<TabSummary[]>;
  listTabs(): Promise<TabSummary[]>;
  focusTab(tabId: TabId): Promise<TabSummary[]>;
  closeTab(tabId: TabId): Promise<TabSummary[]>;
  /** History back (no-op when there is nothing behind). Resolves with the tab list. */
  goBack(tabId: TabId): Promise<TabSummary[]>;
  goForward(tabId: TabId): Promise<TabSummary[]>;
  /** `hard` bypasses the cache. */
  reload(tabId: TabId, hard?: boolean): Promise<TabSummary[]>;
  stopLoading(tabId: TabId): Promise<TabSummary[]>;
  /** Starts or continues a find; the outcome arrives through `onFindResult`. */
  findInPage(tabId: TabId, text: string, options?: FindInPageOptions): Promise<void>;
  /** Clears highlights and the selection. */
  stopFindInPage(tabId: TabId): Promise<void>;
  zoomTab(tabId: TabId, action: ZoomAction): Promise<TabSummary[]>;
  /** Moves keyboard focus from the shell into the active page (after Enter / Esc in the address bar). */
  focusPage(): Promise<void>;
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
  // Routines. Every state change is a human action through the shell; there is no agent route for it.
  listRoutines(): Promise<RoutineSummary[]>;
  getRoutine(id: string): Promise<RoutineDetail | null>;
  getRoutineEngineStatus(): Promise<RoutineEngineStatus>;
  /** proposed -> approved. Rejects if the routine is not currently proposed. */
  approveRoutine(id: string, grants?: RoutineGrants): Promise<RoutineSummary>;
  /** proposed -> rejected. */
  rejectRoutine(id: string): Promise<RoutineSummary>;
  /** approved -> paused. */
  pauseRoutine(id: string): Promise<RoutineSummary>;
  /** paused -> approved. */
  resumeRoutine(id: string): Promise<RoutineSummary>;
  /** approved | paused -> stopped. */
  stopRoutine(id: string): Promise<RoutineSummary>;
  deleteRoutine(id: string): Promise<void>;
  /** Start a run of an approved routine now. Rejects if it is not approved, is already running, or the kill switch is on. */
  runRoutineNow(id: string): Promise<RoutineRunSummary>;
  /** Cancel the running run of this routine (no-op if none). */
  cancelRoutineRun(id: string): Promise<void>;
  /** Newest first, capped at the 50 most recent runs per routine. */
  listRoutineRuns(id: string): Promise<RoutineRunSummary[]>;
  getRoutineRun(id: string, runId: string): Promise<RoutineRunDetail | null>;
  /** Newest first. */
  listRoutineNotes(id: string, limit?: number): Promise<RoutineNote[]>;
  getRoutineMemory(id: string): Promise<RoutineMemory>;
  /** Forget what the routine has seen (human only). Notes and run history are kept. */
  clearRoutineMemory(id: string): Promise<void>;
  /** On: abort running routines and start nothing until turned off. */
  setRoutineKillSwitch(on: boolean): Promise<RoutineEngineStatus>;
  /** Change what a routine may do without asking (human only). Lowering takes effect on the next action. */
  setRoutineGrants(id: string, grants: RoutineGrants): Promise<RoutineDetail>;
  /** Newest first, capped at the last 100 per routine. */
  listRoutineActions(id: string): Promise<RoutineAction[]>;
  /** Run a pending action now (re-checks the page and the target first). */
  approveRoutineAction(id: string, actionId: string): Promise<RoutineAction>;
  declineRoutineAction(id: string, actionId: string): Promise<RoutineAction>;
  /** Which model answers routine inference points (human only). */
  getRoutineModel(): Promise<RoutineModelStatus>;
  /** Pass null to clear. Rejects an unknown runtime or a flag-like model id. */
  setRoutineModel(choice: RoutineModelChoice | null): Promise<RoutineModelStatus>;
  // Reports. Save/open/reveal/delete are human actions through the shell only.
  listReports(): Promise<ReportSummary[]>;
  /** Shows a native save dialog and copies the report there. Resolves with the chosen path, or null if cancelled. */
  saveReportAs(id: string, format: ReportFormat): Promise<string | null>;
  /** Opens the HTML report in the system's default browser. */
  openReport(id: string): Promise<void>;
  /** Reveals the HTML report in the system file manager. */
  revealReport(id: string): Promise<void>;
  deleteReport(id: string): Promise<void>;
  // In-window agent chat. Started by the human only; there is no agent HTTP route for this.
  getAgentRunnerStatus(): Promise<AgentRunnerStatus>;
  /** Re-detect installed CLIs and their settings. */
  refreshAgentRunner(): Promise<AgentRunnerStatus>;
  startAgentConversation(input: StartAgentConversationInput): Promise<AgentConversationSummary>;
  /**
   * Starts a turn; resolves with its id once the CLI process has been launched.
   * Events of the turn (`user_message`, `turn_started`, `text_delta`,
   * `tool_call` …) may be delivered through `onAgentChatEvent` before this
   * resolves; dedupe by `seq`. Rejects (clear message) if a turn is running.
   */
  sendAgentMessage(conversationId: string, text: string): Promise<{ turnId: string }>;
  /** Stops the running turn, if any. Idempotent. */
  stopAgentTurn(conversationId: string): Promise<void>;
  listAgentConversations(tabId?: TabId): Promise<AgentConversationSummary[]>;
  /**
   * Replay buffer (bounded) for a conversation, oldest first, for events after
   * `afterSeq`, including the in-progress turn's events so far. Pass the last
   * `seq` you hold: replay + subsequent live events have no gap or duplicate.
   */
  getAgentConversationEvents(conversationId: string, afterSeq?: number): Promise<AgentChatEvent[]>;
  closeAgentConversation(conversationId: string): Promise<void>;
  // Connect an agent: detect clients / build, preview and run installs. The
  // renderer names a client and an action; main builds every command and path.
  getMcpInstallOverview(): Promise<McpInstallOverview>;
  runMcpInstall(request: McpInstallRequest): Promise<McpInstallResult>;
};

export type AgentLogEntry = {
  level: "system" | "agent" | "ai" | "error" | "nav";
  message: string;
  timestamp: number;
};

export type BrowserShellBridge = BrowserShellApi & {
  onTabsChanged(callback: (tabs: TabSummary[]) => void): () => void;
  onFindResult(callback: (result: FindInPageResult) => void): () => void;
  /** A keyboard shortcut handled natively (menu / page key routing) that the shell UI must act on. */
  onShortcut(callback: (id: ShortcutId) => void): () => void;
  onPageObserved(callback: (observation: PageObservation) => void): () => void;
  onHandoffRequested(callback: (handoff: HumanHandoffRecord) => void): () => void;
  onAgentLog(callback: (entry: AgentLogEntry) => void): () => void;
  /** Fires with the full pending list whenever an approval is queued or resolved. */
  onApprovalsChanged(callback: (pending: PendingApproval[]) => void): () => void;
  onTabOverridesChanged(callback: (overrides: TabOverrides) => void): () => void;
  onAgentActivity(callback: (entry: AgentActivityEntry) => void): () => void;
  onConnectionStatusChanged(callback: (status: AgentConnectionStatus) => void): () => void;
  onAgentChatEvent(callback: (event: AgentChatEvent) => void): () => void;
  /** Fires with the full list whenever a report is created or deleted; `created` names a new one. */
  onReportsChanged(callback: (reports: ReportSummary[], created?: ReportSummary) => void): () => void;
  /** Fires with the full list whenever a routine is proposed or changes state; `proposed` names a new proposal. */
  /** Fires when a run starts, logs progress, or ends. */
  /** Fires when an action is queued, decided or finished. */
  onRoutineActionsChanged(callback: (routineId: string) => void): () => void;
  onRoutineRunUpdated(callback: (run: RoutineRunSummary) => void): () => void;
  onRoutinesChanged(callback: (routines: RoutineSummary[], proposed?: RoutineSummary) => void): () => void;
};
