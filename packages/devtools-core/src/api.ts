/**
 * `AgentApi` — the contract the agent HTTP+SSE server calls (ADR 0001 §4.2).
 *
 * The server in `./http/agent-server.ts` is typed against this interface and
 * never against a concrete browser implementation. Today the desktop's
 * `TabManager` satisfies it structurally; later `HelmstackCore` (ADR §4.3)
 * implements it for both the Electron desktop and the headless daemon.
 *
 * Method names and signatures mirror the existing `TabManager` methods exactly
 * so that assignment compiles without touching `tab-manager.ts`.
 *
 * Desktop-only features are optional slices. When a slice is absent the server
 * answers `501 { code: "unsupported_on_backend" }` (see `OptionalCapability`).
 */
import type {
  A11yAuditReport,
  SeoAuditOptions,
  SeoAuditReport,
  AccountInput,
  AccountSummary,
  AccountUpdate,
  AssertionResult,
  AssertionTransition,
  AssertionWatch,
  BrowserCommandResult,
  BrowserOutputCommand,
  BrowserPerceptionPacket,
  ChangedElement,
  ComponentSourceReport,
  ComponentTreeReport,
  CookieEntry,
  CssCoverageReport,
  DesignTokensReport,
  DiffRegion,
  DownloadEntry,
  ElementPickResult,
  ElementStyleAssertionReport,
  ElementStyleInspectionReport,
  FileUploadTarget,
  FocusOrderReport,
  FrameworkReport,
  HarArchive,
  HealthReport,
  HumanElementPick,
  HumanHandoffRecord,
  JsCoverageReport,
  LayoutIssuesReport,
  LocationOverride,
  MediaEmulation,
  MediaStateReport,
  MutationTimelineReport,
  NetworkInterceptRule,
  PageObservation,
  PageScreenshot,
  PendingApproval,
  ApprovalResolution,
  PerceptionDiff,
  PerceptionSnapshotEntry,
  PerformanceReport,
  RecordingSession,
  RecordingStopResult,
  ResourceBudget,
  ScreenshotDiff,
  ScreenshotOptions,
  SiteCapabilityManifest,
  StorageArea,
  StorageEntry,
  StorageReport,
  StyleAssertion,
  TabId,
  TabLogSnapshot,
  TabSummary,
  ThreeSceneReport,
  TotpResult,
  TraceReport,
  ViewportPresetName,
  ViewportSuiteReport
} from "../../shared/src/index.js";

/** Which runtime is serving the API. Reported by `GET /api/health`. */
export type BackendKind = "desktop" | "daemon";

/**
 * Optional, backend-dependent features. `GET /api/health` lists the ones the
 * running backend provides in `capabilities`; routes for missing ones return
 * `501 { code: "unsupported_on_backend" }`.
 */
export type OptionalCapability = "accounts" | "extensions" | "pick";

export const OPTIONAL_CAPABILITIES: readonly OptionalCapability[] = ["accounts", "extensions", "pick"];

// ── Core slices (every backend must provide these) ─────────────────────────

/** Tab lifecycle. */
export interface TabsApi {
  listTabs(): TabSummary[];
  createTab(url?: string, parentTabId?: TabId): Promise<TabSummary[]>;
  closeTab(tabId: TabId): Promise<TabSummary[]>;
  navigate(tabId: TabId, url: string): Promise<TabSummary[]>;
}

/** Perception packets, capability manifests and named perception snapshots. */
export interface PerceptionApi {
  getPerceptionPacket(tabId: TabId): Promise<BrowserPerceptionPacket>;
  listCapabilityManifests(tabId: TabId): Promise<SiteCapabilityManifest[]>;
  saveNamedPerception(tabId: TabId, snapshotId: string): Promise<PerceptionSnapshotEntry>;
  listPerceptionSnapshots(): PerceptionSnapshotEntry[];
  deletePerceptionSnapshot(id: string): boolean;
  diffPerception(beforeId: string, afterId: string): PerceptionDiff;
}

/** Command execution, approval gating, human handoffs and site patterns. */
export interface CommandApi {
  executeCommand(tabId: TabId, command: BrowserOutputCommand): Promise<BrowserCommandResult>;
  approveCommand(requestId: string): Promise<BrowserCommandResult>;
  rejectCommand(requestId: string): BrowserCommandResult;
  listPendingApprovals(): PendingApproval[];
  listHandoffs(): HumanHandoffRecord[];
  resolveHandoff(requestId: string): BrowserCommandResult;
  cancelHandoff(requestId: string): BrowserCommandResult;
  getSitePatterns(tabId: TabId): string[];
  setSitePatterns(tabId: TabId, patterns: string[]): string[];
  addSitePatterns(tabId: TabId, patterns: string[]): string[];
  clearSitePatterns(tabId: TabId): void;
}

/** Screenshots, visual diff and viewport emulation. */
export interface ScreenshotApi {
  captureScreenshot(tabId: TabId, options?: ScreenshotOptions): Promise<PageScreenshot>;
  setEmulatedViewport(tabId: TabId, width: number, height: number, mobile: boolean): Promise<void>;
  captureNamedScreenshot(
    tabId: TabId,
    snapshotId: string,
    options?: ScreenshotOptions,
    persist?: boolean
  ): Promise<PageScreenshot>;
  diffScreenshots(
    beforeId: string,
    afterId: string,
    options?: { ignoreRegions?: DiffRegion[]; perceptual?: boolean; threshold?: number }
  ): ScreenshotDiff;
  mapRegionsToElements(tabId: TabId, regions: DiffRegion[]): Promise<ChangedElement[]>;
  listScreenshots(): Array<{ id: string; tabId: string; url: string; width: number; height: number; capturedAt: number }>;
  deleteScreenshot(id: string): boolean;
  captureViewportSuite(
    tabId: TabId,
    presets?: ViewportPresetName[],
    includeDiffs?: boolean,
    includeLayoutIssues?: boolean
  ): Promise<ViewportSuiteReport>;
}

/** Read-only page inspection / audit tools. */
export interface InspectApi {
  capturePerformanceMetrics(tabId: TabId): Promise<PerformanceReport>;
  /** `includeSeo` defaults to true; pass false to keep the scorecard to its original five categories. */
  captureHealthReport(tabId: TabId, options?: { includeSeo?: boolean }): Promise<HealthReport>;
  seoAudit(tabId: TabId, options?: SeoAuditOptions): Promise<SeoAuditReport>;
  auditAccessibility(tabId: TabId, selector?: string): Promise<A11yAuditReport>;
  auditFocusOrder(tabId: TabId): Promise<FocusOrderReport>;
  inspectElementStyles(tabId: TabId, selector: string, options?: { limit?: number }): Promise<ElementStyleInspectionReport>;
  assertElementStyles(
    tabId: TabId,
    selector: string,
    assertions: StyleAssertion[],
    options?: { limit?: number }
  ): Promise<ElementStyleAssertionReport>;
  captureComponentTree(tabId: TabId): Promise<ComponentTreeReport>;
  extractDesignTokens(tabId: TabId): Promise<DesignTokensReport>;
  captureCssCoverage(tabId: TabId): Promise<CssCoverageReport>;
  captureJsCoverage(tabId: TabId): Promise<JsCoverageReport>;
  captureTrace(tabId: TabId, durationMs?: number): Promise<TraceReport>;
  detectFramework(tabId: TabId): Promise<FrameworkReport>;
  captureComponentSources(tabId: TabId): Promise<ComponentSourceReport>;
  detectLayoutIssues(tabId: TabId): Promise<LayoutIssuesReport>;
  getMediaState(tabId: TabId): Promise<MediaStateReport>;
  captureMutationTimeline(tabId: TabId, durationMs?: number): Promise<MutationTimelineReport>;
  captureThreeJsScene(tabId: TabId): Promise<ThreeSceneReport>;
}

/** Script evaluation and synthetic input. */
export interface InputApi {
  evaluateExpression(tabId: TabId, expression: string): Promise<{ value: unknown }>;
  insertText(tabId: TabId, text: string): Promise<void>;
  pressKey(
    tabId: TabId,
    opts: { key: string; code?: string; keyCode?: number; modifiers?: number; text?: string }
  ): Promise<void>;
  clickAt(tabId: TabId, x: number, y: number): Promise<void>;
  setFileInputFiles(tabId: TabId, target: FileUploadTarget): Promise<{ ok: true }>;
}

/** Console/network logs, HAR, downloads and network mocking. */
export interface LogsApi {
  getTabLogs(tabId: TabId): TabLogSnapshot;
  clearTabLogs(tabId: TabId): void;
  exportHar(tabId: TabId): HarArchive;
  listDownloads(tabId: TabId): DownloadEntry[];
  clearDownloads(tabId: TabId): void;
  getNetworkMockRules(tabId: TabId): NetworkInterceptRule[] | null;
  enableNetworkMock(tabId: TabId, rules: NetworkInterceptRule[]): Promise<void>;
  disableNetworkMock(tabId: TabId): Promise<void>;
}

/** Resource budget, geolocation/timezone and CSS media overrides. */
export interface OverridesApi {
  getResourceBudget(tabId: TabId): ResourceBudget | null;
  setResourceBudget(tabId: TabId, budget: ResourceBudget): Promise<ResourceBudget>;
  clearResourceBudget(tabId: TabId): Promise<void>;
  getLocationOverride(tabId: TabId): LocationOverride | null;
  setLocationOverride(tabId: TabId, location: LocationOverride): Promise<LocationOverride>;
  clearLocationOverride(tabId: TabId): Promise<void>;
  getMediaEmulation(tabId: TabId): MediaEmulation | null;
  setMediaEmulation(tabId: TabId, emulation: MediaEmulation): Promise<MediaEmulation>;
  clearMediaEmulation(tabId: TabId): Promise<void>;
}

/** Web storage and cookies. */
export interface StorageApi {
  captureStorage(tabId: TabId): Promise<StorageReport>;
  getStorage(tabId: TabId, area: StorageArea, key?: string): Promise<StorageEntry[]>;
  setStorage(tabId: TabId, area: StorageArea, entries: Record<string, string>): Promise<void>;
  clearStorage(tabId: TabId, area: StorageArea, keys?: string[]): Promise<void>;
  setCookie(tabId: TabId, cookie: Partial<CookieEntry> & { name: string; value: string }): Promise<void>;
  deleteCookie(tabId: TabId, name: string, url?: string): Promise<void>;
  clearCookies(tabId: TabId, url?: string): Promise<void>;
}

/** Action recording. */
export interface RecordingApi {
  getRecording(tabId: TabId): RecordingSession | null;
  startRecording(tabId: TabId): RecordingSession;
  stopRecording(tabId: TabId): RecordingStopResult;
}

/** Natural-language assertions and standing assertion watches. */
export interface WatchApi {
  evaluateAssertion(tabId: TabId, assertion: string): Promise<AssertionResult>;
  addAssertionWatch(tabId: TabId, assertion: string): AssertionWatch;
  removeAssertionWatch(id: string): boolean;
  listAssertionWatches(tabId?: TabId): AssertionWatch[];
}

/** Event subscriptions the server fans out over SSE. */
export interface EventsApi {
  onTabsChanged(listener: (tabs: TabSummary[]) => void): void;
  onPageObserved(listener: (observation: PageObservation) => void): void;
  onAssertionTransition(listener: (transition: AssertionTransition) => void): void;
  onApprovalQueued(listener: (approval: PendingApproval) => void): void;
  /** A queued approval settled: approved, rejected, cancelled (page changed) or expired. */
  onApprovalResolved?(listener: (resolution: ApprovalResolution) => void): void;
  onHandoffRequested(listener: (handoff: HumanHandoffRecord) => void): void;
}

// ── Optional slices ─────────────────────────────────────────────────────────

/** Credential accounts + TOTP (desktop: `AccountStore` over `safeStorage`). */
export interface AccountsApi {
  listAccounts(): AccountSummary[];
  saveAccount(input: AccountInput): AccountSummary;
  lookupAccounts(origin: string): AccountSummary[];
  updateAccount(id: string, update: AccountUpdate): AccountSummary;
  deleteAccount(id: string): void;
  generateTotp(accountId: string): TotpResult;
}

/** An unpacked browser extension (desktop: Electron session extension API). */
export interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  /** Absolute path to the unpacked extension directory. */
  sourcePath: string;
}

export interface ExtensionsApi {
  listExtensions(): Promise<ExtensionInfo[]>;
  loadExtension(extensionPath: string): Promise<ExtensionInfo>;
  removeExtension(extensionId: string): Promise<void>;
}

/**
 * Everything the agent server calls on the browser.
 *
 * Deviation from ADR §4.2: `backend` and the `accounts` slice are passed to
 * `createAgentServer` as options rather than being members of `AgentApi`.
 * `TabManager` has no `backend` field and holds a *private* `accounts:
 * AccountStore`, so either member would stop it from satisfying `AgentApi`
 * without edits. `backend` may still be declared here by implementations
 * (e.g. `HelmstackCore`); the server option takes precedence.
 */
export interface AgentApi extends TabsApi, PerceptionApi, CommandApi, ScreenshotApi, InspectApi,
  InputApi, LogsApi, OverridesApi, StorageApi, RecordingApi, WatchApi, EventsApi {
  readonly backend?: BackendKind;
  /** Human inspect-and-click element picker. Needs a visible window → desktop only. */
  pickElement?(tabId: TabId): Promise<ElementPickResult>;
  /**
   * Elements the human selected with "Select for agent" in the shell. Optional:
   * when absent (or on a backend without a picker) the routes report no picks.
   */
  getLatestPick?(tabId: TabId): HumanElementPick | null;
  listPicks?(): HumanElementPick[];
  onElementPicked?(listener: (pick: HumanElementPick) => void): () => void;
}
