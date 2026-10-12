/**
 * `HelmstackCore` — every agent tool implemented once on top of a
 * `BrowserBackend` (ADR 0001 §4.3). Owns one `TabSession` per backend tab
 * (created/disposed from lifecycle events), the cross-tab stores, the event
 * listener sets and the cross-tab methods. Served by `createAgentServer` on
 * both the Electron desktop and the headless daemon.
 */
import type {
  A11yAuditReport,
  ApprovalDecision,
  ApprovalPolicyKey,
  ApprovalPolicyRecord,
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
  HumanHandoffRecord,
  JsCoverageReport,
  LayoutIssuesReport,
  LocationOverride,
  MediaEmulation,
  MediaStateReport,
  MutationTimelineReport,
  NetworkInterceptRule,
  PageGraph,
  PageObservation,
  PageScreenshot,
  PageSnapshot,
  PendingApproval,
  PerceptionDiff,
  PerceptionResult,
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
  TraceReport,
  ViewportPresetName,
  ViewportSuiteReport
} from "../../../shared/src/index.js";
import { VIEWPORT_PRESETS } from "../../../shared/src/index.js";
import type { AgentApi, BackendKind } from "../api.js";
import type { BackendTab, BrowserBackend, TabLifecycleEvent } from "../backend.js";
import { waitForPageSettled } from "./cdp/dom-actuator.js";
import { SiteCapabilityRegistry } from "./commands/site-capability-registry.js";
import { passthroughSecrets, type SecretResolver } from "./commands/types.js";
import { evaluateAssertionAgainstGraph } from "./perception/assertions.js";
import { computePerceptionDiff } from "./perception/diff.js";
import { buildHealthReport } from "./reports/health-report.js";
import { ApprovalPolicyStore } from "./stores/approval-policy-store.js";
import { ApprovalStore } from "./stores/approval-store.js";
import { AssertionWatchStore } from "./stores/assertion-watch.js";
import { PerceptionBaselineStore, type PerceptionBaselineEntry } from "./stores/baseline-store.js";
import { HandoffStore } from "./stores/handoff-store.js";
import { SitePatternStore } from "./stores/site-pattern-store.js";
import { VisualDiffStore } from "./stores/visual-diff-store.js";
import { TabSession } from "./tab-session.js";
import { createTabState } from "./tab-state.js";

export type HelmstackCoreOptions = {
  /** Where disk-backed stores (baselines, policies, site patterns) live. */
  dataDir: string;
  /** Resolves vault/account refs in command values. Default: passthrough. */
  secrets?: SecretResolver;
  /** Social-surface perception for pulled observations. Default false. */
  includeSocial?: boolean;
  /**
   * Pull a fresh observation over CDP before each perception capture
   * (default true). The desktop passes false: its preload pushes observations
   * and a pull would ship the whole perception bundle on every capture.
   */
  pullObservations?: boolean;
};

type ScreenshotListEntry = { id: string; tabId: string; url: string; width: number; height: number; capturedAt: number };
type HandoffContext = Pick<HumanHandoffRecord, "relatedTabIds" | "groupId" | "origin" | "title">;

const VIEWPORT_SETTLE_MS = 200;

export class HelmstackCore implements AgentApi {
  readonly backend: BackendKind;
  /** Present only when the backend can pick elements (needs a visible window). */
  readonly pickElement?: (tabId: TabId) => Promise<ElementPickResult>;

  private readonly sessions = new Map<TabId, TabSession>();
  private readonly includeSocial: boolean;
  private readonly pullObservations: boolean;

  private readonly approvals = new ApprovalStore();
  private readonly handoffs = new HandoffStore();
  private readonly policies: ApprovalPolicyStore;
  private readonly sitePatterns: SitePatternStore;
  private readonly capabilityRegistry: SiteCapabilityRegistry;
  private readonly visualDiff: VisualDiffStore;
  private readonly perceptionStore: PerceptionBaselineStore;
  private readonly perceptionCache = new Map<string, PerceptionBaselineEntry>();
  private readonly assertionWatches = new AssertionWatchStore();

  private readonly tabsListeners = new Set<(tabs: TabSummary[]) => void>();
  private readonly observationListeners = new Set<(observation: PageObservation) => void>();
  private readonly approvalQueuedListeners = new Set<(approval: PendingApproval) => void>();
  private readonly assertionTransitionListeners = new Set<(transition: AssertionTransition) => void>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(private readonly browser: BrowserBackend, options: HelmstackCoreOptions) {
    this.backend = browser.kind;
    this.includeSocial = options.includeSocial ?? false;
    this.pullObservations = options.pullObservations ?? true;

    this.policies = new ApprovalPolicyStore(options.dataDir);
    this.sitePatterns = new SitePatternStore(options.dataDir);
    // Disk-backed baselines: rehydrate so regression references survive a restart.
    this.visualDiff = new VisualDiffStore(options.dataDir, browser.kind);
    this.perceptionStore = new PerceptionBaselineStore(options.dataDir);
    for (const { id, entry } of this.perceptionStore.all()) {
      this.perceptionCache.set(id, entry);
    }

    this.capabilityRegistry = new SiteCapabilityRegistry(
      options.secrets ?? passthroughSecrets,
      this.approvals,
      this.handoffs,
      this.policies,
      (tabId) => this.getHandoffContext(tabId)
    );

    this.approvals.onCreated((approval) => {
      for (const listener of this.approvalQueuedListeners) listener(approval);
    });

    if (browser.pickElement) {
      this.pickElement = (tabId) => {
        this.requireSession(tabId);
        return browser.pickElement!(tabId);
      };
    }

    for (const tab of browser.listTabs()) {
      this.ensureSession(tab);
    }
    this.unsubscribers.push(browser.onLifecycle((event) => this.handleLifecycle(event)));
    this.unsubscribers.push(browser.onObservation((observation) => this.recordObservation(observation)));
    if (browser.onDownload) {
      this.unsubscribers.push(browser.onDownload((tabId, download) => this.sessions.get(tabId)?.recordDownload(download)));
    }
  }

  /** Detaches from the backend and disposes every session. */
  dispose(): void {
    for (const off of this.unsubscribers.splice(0)) off();
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }

  // ── Session lifecycle ─────────────────────────────────────────────────────

  private handleLifecycle(event: TabLifecycleEvent): void {
    switch (event.type) {
      case "created":
        this.ensureSession(event.tab);
        this.emitTabsChanged();
        break;
      case "closed":
        this.removeSession(event.tabId);
        this.emitTabsChanged();
        break;
      case "main-frame-navigation":
        this.sessions.get(event.tabId)?.clearLogBuffers();
        break;
      case "load-finished":
        void this.sessions.get(event.tabId)?.reapplyOverrides();
        break;
      case "summary-changed":
        this.emitTabsChanged();
        break;
    }
  }

  private ensureSession(tab: BackendTab): TabSession {
    const existing = this.sessions.get(tab.id);
    if (existing) return existing;
    const session = new TabSession(tab, createTabState(), {
      defaultViewport: () => this.browser.defaultViewport(),
      includeSocial: this.includeSocial,
      pullObservations: this.pullObservations
    });
    this.sessions.set(tab.id, session);
    // Buffer logs from the first document on, not from the first snapshot.
    session.enableCdpLogging().catch(() => {});
    return session;
  }

  private removeSession(tabId: TabId): void {
    this.sessions.get(tabId)?.dispose();
    this.sessions.delete(tabId);
    this.assertionWatches.clearTab(tabId);
  }

  private requireSession(tabId: TabId): TabSession {
    const session = this.sessions.get(tabId);
    if (session) return session;
    // Lifecycle event not delivered yet: adopt the tab if the backend has it.
    const tab = this.browser.getTab(tabId);
    if (!tab) throw new Error(`Unknown tab: ${tabId}`);
    return this.ensureSession(tab);
  }

  /** Feed for backend observations (preload IPC / CDP binding). */
  recordObservation(observation: PageObservation): void {
    const session = this.sessions.get(observation.tabId);
    if (!session) return;
    session.recordObservation(observation);
    for (const listener of this.observationListeners) listener(observation);
  }

  private emitTabsChanged(): void {
    const tabs = this.listTabs();
    for (const listener of this.tabsListeners) listener(tabs);
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────

  listTabs(): TabSummary[] {
    return this.browser.listTabs().map((tab) => tab.summary());
  }

  async createTab(url = "https://example.com", parentTabId?: TabId): Promise<TabSummary[]> {
    const tab = await this.browser.createTab(url, parentTabId ? { parentTabId } : undefined);
    this.ensureSession(tab);
    return this.listTabs();
  }

  async closeTab(tabId: TabId): Promise<TabSummary[]> {
    this.requireSession(tabId);
    await this.browser.closeTab(tabId);
    this.removeSession(tabId);
    return this.listTabs();
  }

  async navigate(tabId: TabId, url: string): Promise<TabSummary[]> {
    const session = this.requireSession(tabId);
    session.recordCommand("navigate", { type: "navigate", url }, "completed");
    // Fire-and-forget like before: the backend reports load errors via the summary.
    void session.tab.navigate(url).catch(() => {});
    return this.listTabs();
  }

  // ── Snapshot / perception ─────────────────────────────────────────────────

  async captureSnapshot(tabId: TabId): Promise<PageSnapshot> {
    return this.requireSession(tabId).captureSnapshot();
  }

  async getLatestObservation(tabId: TabId): Promise<PageObservation | null> {
    return this.requireSession(tabId).state.lastObservation;
  }

  async capturePerception(tabId: TabId): Promise<PerceptionResult> {
    const result = await this.requireSession(tabId).capturePerception();
    this.evaluateAssertionWatches(tabId, result.graph);
    return result;
  }

  async getPerceptionPacket(tabId: TabId): Promise<BrowserPerceptionPacket> {
    const session = this.requireSession(tabId);
    const result = await this.capturePerception(tabId);
    const packet = await this.capabilityRegistry.buildPerceptionPacket(tabId, session.state.lastObservation, result, session.page);
    return {
      ...packet,
      sitePatterns: this.sitePatterns.get(originFromUrl(result.graph.url))
    };
  }

  async listCapabilityManifests(tabId: TabId): Promise<SiteCapabilityManifest[]> {
    const session = this.requireSession(tabId);
    const result = await this.capturePerception(tabId);
    return this.capabilityRegistry.listCapabilityManifests(tabId, result, session.page);
  }

  async saveNamedPerception(tabId: TabId, snapshotId: string): Promise<PerceptionSnapshotEntry> {
    const result = await this.capturePerception(tabId);
    const session = this.requireSession(tabId);
    const entry = {
      graph: result.graph,
      tabId,
      url: session.cdp.url(),
      title: session.tab.title(),
      capturedAt: Date.now()
    };
    this.perceptionCache.set(snapshotId, entry);
    this.perceptionStore.put(snapshotId, entry);
    return { id: snapshotId, tabId, url: entry.url, title: entry.title, capturedAt: entry.capturedAt };
  }

  listPerceptionSnapshots(): PerceptionSnapshotEntry[] {
    return [...this.perceptionCache.entries()].map(([id, e]) => ({
      id, tabId: e.tabId, url: e.url, title: e.title, capturedAt: e.capturedAt
    }));
  }

  deletePerceptionSnapshot(id: string): boolean {
    const existed = this.perceptionCache.delete(id);
    this.perceptionStore.remove(id);
    return existed;
  }

  diffPerception(beforeId: string, afterId: string): PerceptionDiff {
    const before = this.perceptionCache.get(beforeId);
    const after  = this.perceptionCache.get(afterId);
    if (!before) throw new Error(`Perception snapshot "${beforeId}" not found`);
    if (!after)  throw new Error(`Perception snapshot "${afterId}" not found`);
    return computePerceptionDiff(beforeId, afterId, before, after);
  }

  // ── Commands / approvals / handoffs ───────────────────────────────────────

  async executeCommand(tabId: TabId, command: BrowserOutputCommand): Promise<BrowserCommandResult> {
    const session = this.requireSession(tabId);
    const budgetBlock = await session.checkResourceBudget();
    if (budgetBlock) {
      session.recordCommand("command", command, "blocked");
      return budgetBlock;
    }
    const result = await this.capturePerception(tabId);
    const execution = await this.capabilityRegistry.executeCommand(tabId, command, session.state.lastObservation, result, session.page);
    session.recordCommand("command", command, execution.status);

    if (execution.status !== "completed") {
      return execution;
    }

    await waitForPageSettled(session.cdp);
    const refreshed = await this.capturePerception(tabId);
    return {
      ...execution,
      observation: session.state.lastObservation,
      graph: refreshed.graph
    };
  }

  async approveCommand(requestId: string): Promise<BrowserCommandResult> {
    // Resolve the owning tab directly from the pending approval.
    const pending = this.listPendingApprovals().find((approval) => approval.requestId === requestId);
    if (pending) {
      const session = this.sessions.get(pending.tabId);
      if (!session) {
        return {
          status: "failed",
          command: { type: "request_perception_refresh", tabId: pending.tabId },
          reason: `Tab ${pending.tabId} for approval ${requestId} no longer exists.`,
          retryable: false
        };
      }

      const result = await this.capturePerception(session.id);
      const execution = await this.capabilityRegistry.approveCommand(requestId, session.state.lastObservation, result, session.page);

      if (execution.status === "completed") {
        await waitForPageSettled(session.cdp);
        const refreshed = await this.capturePerception(session.id);
        return {
          ...execution,
          observation: session.state.lastObservation,
          graph: refreshed.graph
        };
      }

      return execution;
    }

    return {
      status: "failed",
      command: {
        type: "request_perception_refresh",
        tabId: this.listTabs().find((tab) => tab.isActive)?.id ?? "unknown"
      },
      reason: `Approval request ${requestId} was not found.`,
      retryable: false
    };
  }

  rejectCommand(requestId: string): BrowserCommandResult {
    return this.capabilityRegistry.rejectCommand(requestId);
  }

  listPendingApprovals(): PendingApproval[] {
    return this.approvals.list();
  }

  listApprovalPolicies(): ApprovalPolicyRecord[] {
    return this.policies.listPolicies();
  }

  updateApprovalPolicy(key: ApprovalPolicyKey, decision: ApprovalDecision): ApprovalPolicyRecord[] {
    return this.policies.updatePolicy(key, decision);
  }

  listHandoffs(): HumanHandoffRecord[] {
    return this.capabilityRegistry.listHandoffs();
  }

  resolveHandoff(requestId: string): BrowserCommandResult {
    return this.capabilityRegistry.resolveHandoff(requestId);
  }

  cancelHandoff(requestId: string): BrowserCommandResult {
    return this.capabilityRegistry.cancelHandoff(requestId);
  }

  private getHandoffContext(tabId: TabId): HandoffContext {
    const tab = this.requireSession(tabId).tab;
    const summary = tab.summary();
    const origin = originFromUrl(summary.url);
    const relatedTabIds = [...new Set(
      this.browser.listTabs()
        .filter((entry) => entry.id === tabId || entry.parentTabId === tabId || tab.parentTabId === entry.id || originFromUrl(entry.summary().url) === origin)
        .map((entry) => entry.id)
    )];

    return {
      relatedTabIds: relatedTabIds.length ? relatedTabIds : [tabId],
      groupId: `${origin}::${tab.parentTabId ?? tabId}`,
      origin,
      title: summary.title
    };
  }

  // ── Site patterns ─────────────────────────────────────────────────────────

  private getTabOrigin(tabId: TabId): string {
    return originFromUrl(this.requireSession(tabId).tab.summary().url);
  }

  getSitePatterns(tabId: TabId): string[] {
    return this.sitePatterns.get(this.getTabOrigin(tabId));
  }

  setSitePatterns(tabId: TabId, patterns: string[]): string[] {
    return this.sitePatterns.set(this.getTabOrigin(tabId), patterns);
  }

  addSitePatterns(tabId: TabId, patterns: string[]): string[] {
    return this.sitePatterns.add(this.getTabOrigin(tabId), patterns);
  }

  clearSitePatterns(tabId: TabId): void {
    this.sitePatterns.clear(this.getTabOrigin(tabId));
  }

  // ── Screenshots / visual diff ─────────────────────────────────────────────

  async captureScreenshot(tabId: TabId, options: ScreenshotOptions = {}): Promise<PageScreenshot> {
    return this.requireSession(tabId).captureScreenshot(options);
  }

  async setEmulatedViewport(tabId: TabId, width: number, height: number, mobile: boolean): Promise<void> {
    return this.requireSession(tabId).setEmulatedViewport(width, height, mobile);
  }

  /** Persisted to disk by default; `persist: false` keeps transient captures in memory only. */
  async captureNamedScreenshot(
    tabId: TabId,
    snapshotId: string,
    options: ScreenshotOptions = {},
    persist = true
  ): Promise<PageScreenshot> {
    const shot = await this.captureScreenshot(tabId, options);
    this.visualDiff.put(snapshotId, shot, persist);
    return shot;
  }

  diffScreenshots(
    beforeId: string,
    afterId: string,
    options: { ignoreRegions?: DiffRegion[]; perceptual?: boolean; threshold?: number } = {}
  ): ScreenshotDiff {
    return this.visualDiff.diff(beforeId, afterId, options);
  }

  async mapRegionsToElements(tabId: TabId, regions: DiffRegion[]): Promise<ChangedElement[]> {
    return this.requireSession(tabId).mapRegionsToElements(regions);
  }

  listScreenshots(): ScreenshotListEntry[] {
    const out: ScreenshotListEntry[] = [];
    for (const [id, shot] of this.visualDiff.entries()) {
      const session = this.sessions.get(shot.tabId);
      const url = session ? session.cdp.url() : "";
      out.push({ id, tabId: shot.tabId, url, width: shot.width, height: shot.height, capturedAt: shot.capturedAt });
    }
    return out;
  }

  deleteScreenshot(id: string): boolean {
    return this.visualDiff.remove(id);
  }

  /** Screenshots at several breakpoints; restores the original emulated viewport afterwards. */
  async captureViewportSuite(
    tabId: TabId,
    presets: ViewportPresetName[] = ["mobile", "tablet", "laptop", "desktop"],
    includeDiffs = false,
    includeLayoutIssues = false
  ): Promise<ViewportSuiteReport> {
    const session = this.requireSession(tabId);
    const runId = Date.now().toString(36);
    const savedViewport = session.state.emulatedViewport ?? null;

    const captures: ViewportSuiteReport["captures"] = [];

    for (const presetName of presets) {
      const def = VIEWPORT_PRESETS[presetName];
      const preset = { name: presetName, ...def };

      await session.setEmulatedViewport(def.width, def.height, def.mobile);

      // Allow the page a short reflow settle before capturing.
      await new Promise<void>((r) => setTimeout(r, VIEWPORT_SETTLE_MS));

      const snapshotId = `${tabId}__${presetName}__${runId}`;
      const screenshot = await this.captureNamedScreenshot(tabId, snapshotId, {}, false);
      const layoutIssues = includeLayoutIssues ? await session.detectLayoutIssues() : undefined;

      captures.push({ preset, snapshotId, screenshot, ...(layoutIssues ? { layoutIssues } : {}) });
    }

    // Restore original emulated viewport (or clear it if none was set).
    if (savedViewport) {
      await session.setEmulatedViewport(savedViewport.width, savedViewport.height, savedViewport.mobile);
    } else {
      await session.clearEmulatedViewport();
    }

    const diffs: ViewportSuiteReport["diffs"] = [];
    if (includeDiffs && captures.length >= 2) {
      for (let i = 0; i < captures.length - 1; i++) {
        const from = captures[i];
        const to   = captures[i + 1];
        diffs.push({ from: from.preset.name, to: to.preset.name, diff: this.diffScreenshots(from.snapshotId, to.snapshotId) });
      }
    }

    return { tabId, runId, captures, diffs, capturedAt: Date.now() };
  }

  // ── Inspection ────────────────────────────────────────────────────────────

  /** Core Web Vitals + WCAG audit + console errors + failed requests + layout overflow. */
  async captureHealthReport(tabId: TabId): Promise<HealthReport> {
    const session = this.requireSession(tabId);
    const [performance, accessibility, layout] = await Promise.all([
      session.capturePerformanceMetrics(),
      session.auditAccessibility(),
      session.detectLayoutIssues()
    ]);
    const logs = session.getTabLogs();
    return buildHealthReport({ performance, accessibility, logs, layout }, tabId, session.cdp.url(), Date.now());
  }

  capturePerformanceMetrics(tabId: TabId): Promise<PerformanceReport> {
    return this.requireSession(tabId).capturePerformanceMetrics();
  }

  auditAccessibility(tabId: TabId, selector?: string): Promise<A11yAuditReport> {
    return this.requireSession(tabId).auditAccessibility(selector);
  }

  auditFocusOrder(tabId: TabId): Promise<FocusOrderReport> {
    return this.requireSession(tabId).auditFocusOrder();
  }

  inspectElementStyles(tabId: TabId, selector: string, options: { limit?: number } = {}): Promise<ElementStyleInspectionReport> {
    return this.requireSession(tabId).inspectElementStyles(selector, options);
  }

  assertElementStyles(
    tabId: TabId,
    selector: string,
    assertions: StyleAssertion[],
    options: { limit?: number } = {}
  ): Promise<ElementStyleAssertionReport> {
    return this.requireSession(tabId).assertElementStyles(selector, assertions, options);
  }

  captureComponentTree(tabId: TabId): Promise<ComponentTreeReport> {
    return this.requireSession(tabId).captureComponentTree();
  }

  extractDesignTokens(tabId: TabId): Promise<DesignTokensReport> {
    return this.requireSession(tabId).extractDesignTokens();
  }

  captureCssCoverage(tabId: TabId): Promise<CssCoverageReport> {
    return this.requireSession(tabId).captureCssCoverage();
  }

  captureJsCoverage(tabId: TabId): Promise<JsCoverageReport> {
    return this.requireSession(tabId).captureJsCoverage();
  }

  captureTrace(tabId: TabId, durationMs?: number): Promise<TraceReport> {
    return this.requireSession(tabId).captureTrace(durationMs);
  }

  detectFramework(tabId: TabId): Promise<FrameworkReport> {
    return this.requireSession(tabId).detectFramework();
  }

  captureComponentSources(tabId: TabId): Promise<ComponentSourceReport> {
    return this.requireSession(tabId).captureComponentSources();
  }

  detectLayoutIssues(tabId: TabId): Promise<LayoutIssuesReport> {
    return this.requireSession(tabId).detectLayoutIssues();
  }

  getMediaState(tabId: TabId): Promise<MediaStateReport> {
    return this.requireSession(tabId).getMediaState();
  }

  captureMutationTimeline(tabId: TabId, durationMs?: number): Promise<MutationTimelineReport> {
    return this.requireSession(tabId).captureMutationTimeline(durationMs);
  }

  captureThreeJsScene(tabId: TabId): Promise<ThreeSceneReport> {
    return this.requireSession(tabId).captureThreeJsScene();
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  evaluateExpression(tabId: TabId, expression: string): Promise<{ value: unknown }> {
    return this.requireSession(tabId).evaluateExpression(expression);
  }

  insertText(tabId: TabId, text: string): Promise<void> {
    return this.requireSession(tabId).insertText(text);
  }

  pressKey(
    tabId: TabId,
    opts: { key: string; code?: string; keyCode?: number; modifiers?: number; text?: string }
  ): Promise<void> {
    return this.requireSession(tabId).pressKey(opts);
  }

  clickAt(tabId: TabId, x: number, y: number): Promise<void> {
    return this.requireSession(tabId).clickAt(x, y);
  }

  setFileInputFiles(tabId: TabId, target: FileUploadTarget): Promise<{ ok: true }> {
    return this.requireSession(tabId).setFileInputFiles(target);
  }

  // ── Logs / downloads / mock ───────────────────────────────────────────────

  getTabLogs(tabId: TabId): TabLogSnapshot {
    return this.requireSession(tabId).getTabLogs();
  }

  clearTabLogs(tabId: TabId): void {
    this.requireSession(tabId).clearTabLogs();
  }

  exportHar(tabId: TabId): HarArchive {
    return this.requireSession(tabId).exportHar();
  }

  listDownloads(tabId: TabId): DownloadEntry[] {
    return this.requireSession(tabId).listDownloads();
  }

  clearDownloads(tabId: TabId): void {
    this.requireSession(tabId).clearDownloads();
  }

  getNetworkMockRules(tabId: TabId): NetworkInterceptRule[] | null {
    return this.requireSession(tabId).getNetworkMockRules();
  }

  enableNetworkMock(tabId: TabId, rules: NetworkInterceptRule[]): Promise<void> {
    return this.requireSession(tabId).enableNetworkMock(rules);
  }

  disableNetworkMock(tabId: TabId): Promise<void> {
    return this.requireSession(tabId).disableNetworkMock();
  }

  // ── Overrides ─────────────────────────────────────────────────────────────

  getResourceBudget(tabId: TabId): ResourceBudget | null {
    return this.requireSession(tabId).getResourceBudget();
  }

  setResourceBudget(tabId: TabId, budget: ResourceBudget): Promise<ResourceBudget> {
    return this.requireSession(tabId).setResourceBudget(budget);
  }

  clearResourceBudget(tabId: TabId): Promise<void> {
    return this.requireSession(tabId).clearResourceBudget();
  }

  getLocationOverride(tabId: TabId): LocationOverride | null {
    return this.requireSession(tabId).getLocationOverride();
  }

  setLocationOverride(tabId: TabId, location: LocationOverride): Promise<LocationOverride> {
    return this.requireSession(tabId).setLocationOverride(location);
  }

  clearLocationOverride(tabId: TabId): Promise<void> {
    return this.requireSession(tabId).clearLocationOverride();
  }

  getMediaEmulation(tabId: TabId): MediaEmulation | null {
    return this.requireSession(tabId).getMediaEmulation();
  }

  setMediaEmulation(tabId: TabId, emulation: MediaEmulation): Promise<MediaEmulation> {
    return this.requireSession(tabId).setMediaEmulation(emulation);
  }

  clearMediaEmulation(tabId: TabId): Promise<void> {
    return this.requireSession(tabId).clearMediaEmulation();
  }

  // ── Storage ───────────────────────────────────────────────────────────────

  captureStorage(tabId: TabId): Promise<StorageReport> {
    return this.requireSession(tabId).captureStorage();
  }

  getStorage(tabId: TabId, area: StorageArea, key?: string): Promise<StorageEntry[]> {
    return this.requireSession(tabId).getStorage(area, key);
  }

  setStorage(tabId: TabId, area: StorageArea, entries: Record<string, string>): Promise<void> {
    return this.requireSession(tabId).setStorage(area, entries);
  }

  clearStorage(tabId: TabId, area: StorageArea, keys?: string[]): Promise<void> {
    return this.requireSession(tabId).clearStorage(area, keys);
  }

  setCookie(tabId: TabId, cookie: Partial<CookieEntry> & { name: string; value: string }): Promise<void> {
    return this.requireSession(tabId).setCookie(cookie);
  }

  deleteCookie(tabId: TabId, name: string, url?: string): Promise<void> {
    return this.requireSession(tabId).deleteCookie(name, url);
  }

  clearCookies(tabId: TabId, url?: string): Promise<void> {
    return this.requireSession(tabId).clearCookies(url);
  }

  // ── Recording ─────────────────────────────────────────────────────────────

  getRecording(tabId: TabId): RecordingSession | null {
    return this.requireSession(tabId).getRecording();
  }

  startRecording(tabId: TabId): RecordingSession {
    return this.requireSession(tabId).startRecording();
  }

  stopRecording(tabId: TabId): RecordingStopResult {
    return this.requireSession(tabId).stopRecording();
  }

  // ── Assertions / watches ──────────────────────────────────────────────────

  async evaluateAssertion(tabId: TabId, assertion: string): Promise<AssertionResult> {
    const result = await this.capturePerception(tabId);
    return evaluateAssertionAgainstGraph(tabId, assertion, result.graph);
  }

  addAssertionWatch(tabId: TabId, assertion: string): AssertionWatch {
    return this.assertionWatches.add(tabId, assertion, Date.now());
  }

  removeAssertionWatch(id: string): boolean {
    return this.assertionWatches.remove(id);
  }

  listAssertionWatches(tabId?: TabId): AssertionWatch[] {
    return this.assertionWatches.list(tabId);
  }

  /** Re-evaluate this tab's watches against a fresh graph and emit transitions. */
  private evaluateAssertionWatches(tabId: TabId, graph: PageGraph): void {
    const transitions = this.assertionWatches.evaluateTab(
      tabId,
      (assertion) => {
        const result = evaluateAssertionAgainstGraph(tabId, assertion, graph);
        return { pass: result.pass, explanation: result.explanation };
      },
      Date.now()
    );
    for (const transition of transitions) {
      for (const listener of this.assertionTransitionListeners) listener(transition);
    }
  }

  // ── Events ────────────────────────────────────────────────────────────────

  onTabsChanged(listener: (tabs: TabSummary[]) => void): void {
    this.tabsListeners.add(listener);
  }

  onPageObserved(listener: (observation: PageObservation) => void): void {
    this.observationListeners.add(listener);
  }

  onAssertionTransition(listener: (transition: AssertionTransition) => void): void {
    this.assertionTransitionListeners.add(listener);
  }

  onApprovalQueued(listener: (approval: PendingApproval) => void): void {
    this.approvalQueuedListeners.add(listener);
  }

  onHandoffRequested(listener: (handoff: HumanHandoffRecord) => void): void {
    this.capabilityRegistry.onHandoffRequested(listener);
  }
}

function originFromUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}
