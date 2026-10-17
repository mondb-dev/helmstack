/**
 * `HelmstackCore` — every agent tool implemented once on top of a
 * `BrowserBackend` (ADR 0001 §4.3). Owns one `TabSession` per backend tab
 * (created/disposed from lifecycle events), the cross-tab stores, the event
 * listener sets and the cross-tab methods. Served by `createAgentServer` on
 * both the Electron desktop and the headless daemon.
 */
import { readFileSync } from "node:fs";

import type {
  A11yAuditReport,
  SeoAuditOptions,
  SeoAuditReport,
  ApprovalDecision,
  ApprovalPolicyKey,
  ApprovalPolicyRecord,
  ApprovalResolution,
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
  CreateReportInput,
  CreateReportResult,
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
  ReportEvidenceKind,
  ReportFormat,
  ReportSummary,
  ProposeRoutineResult,
  RoutineDetail,
  RoutineEngineStatus,
  RoutineMemory,
  RoutineNote,
  RoutineRunDetail,
  RoutineRunSummary,
  RoutineSummary,
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
  TabOverrideKind,
  TabOverrides,
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
import { buildReport, type ReportEvidence } from "./reports/page-report.js";
import { ReportInputError, parseCreateReportInput } from "./reports/report-input.js";
import { RoutineEngine, type RoutineEngineOptions } from "./routines/engine.js";
import { RoutineSpecInvalidError } from "./routines/errors.js";
import type { RoutineBrowser } from "./routines/executor.js";
import { PAGE_COLLECTOR_SCRIPT } from "./routines/page-data.js";
import { fetchRobotsTxt } from "./routines/robots-fetch.js";
import { buildPreview, countSteps, diffPreviews, triggerText } from "./routines/preview.js";
import { validateRoutineSpec } from "./routines/validate.js";
import { ApprovalPolicyStore } from "./stores/approval-policy-store.js";
import { ApprovalStore, DEFAULT_APPROVAL_TTL_MS, PAGE_CHANGED_REASON, isSameApprovalPage } from "./stores/approval-store.js";
import { AssertionWatchStore } from "./stores/assertion-watch.js";
import { PerceptionBaselineStore, type PerceptionBaselineEntry } from "./stores/baseline-store.js";
import { HandoffStore } from "./stores/handoff-store.js";
import { HumanPickStore } from "./stores/human-pick-store.js";
import { ReportStore, newReportId, type ReportStoreOptions } from "./stores/report-store.js";
import { RoutineDataStore } from "./stores/routine-data-store.js";
import { RoutineError, RoutineStore, isValidRoutineId, type RoutineStoreEvent, type RoutineStoreOptions } from "./stores/routine-store.js";
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
  /**
   * How long a queued approval waits for a decision before it is cancelled as
   * `expired` (ms; `0` disables). Default: `HELMSTACK_APPROVAL_TTL_MS`, else 10 min.
   */
  approvalTtlMs?: number;
  /** HelmStack version printed on reports. Default "unknown". */
  helmstackVersion?: string;
  /** Report store caps (default newest 100 reports / 200 MB). */
  reportStore?: Pick<ReportStoreOptions, "maxReports" | "maxBytes" | "log">;
  /** Per-collector time limit while creating a report (ms). Default 20 000. */
  reportCollectorTimeoutMs?: number;
  /** Routine store options (default cap 50 routines). */
  routineStore?: Pick<RoutineStoreOptions, "maxRoutines" | "log" | "now" | "random">;
  /**
   * Routine engine seams (tests): clock, timers, sleep, robots fetcher, tick and page delays.
   * `autoStart: false` leaves the scheduler off (manual runs still work).
   */
  routineEngine?: Partial<Pick<RoutineEngineOptions, "now" | "timers" | "sleep" | "random" | "fetchRobots" | "tickMs" | "firstRunDelayMs" | "maxConcurrent" | "defaultPageDelayMs" | "navTimeoutMs" | "maxRuntimeMs">> & {
    autoStart?: boolean;
  };
};

/** Default time limit for one report collector. */
const REPORT_COLLECTOR_TIMEOUT_MS = 20_000;

function resolveApprovalTtl(option: number | undefined): number {
  if (option !== undefined) return option;
  const raw = Number((process.env.HELMSTACK_APPROVAL_TTL_MS ?? "").trim());
  return (process.env.HELMSTACK_APPROVAL_TTL_MS ?? "").trim() !== "" && Number.isFinite(raw) ? raw : DEFAULT_APPROVAL_TTL_MS;
}

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

  private readonly approvals: ApprovalStore;
  private readonly handoffs = new HandoffStore();
  private readonly policies: ApprovalPolicyStore;
  private readonly sitePatterns: SitePatternStore;
  private readonly capabilityRegistry: SiteCapabilityRegistry;
  private readonly visualDiff: VisualDiffStore;
  private readonly perceptionStore: PerceptionBaselineStore;
  private readonly perceptionCache = new Map<string, PerceptionBaselineEntry>();
  private readonly assertionWatches = new AssertionWatchStore();
  private readonly humanPicks = new HumanPickStore();
  private readonly reports: ReportStore;
  private readonly helmstackVersion: string;
  private readonly reportCollectorTimeoutMs: number;
  private readonly reportsChangedListeners = new Set<(reports: ReportSummary[], created?: ReportSummary) => void>();
  private readonly routines: RoutineStore;
  private readonly routineEngine: RoutineEngine;
  private readonly routinesChangedListeners = new Set<(routines: RoutineSummary[], proposed?: RoutineSummary) => void>();
  private readonly routineEventListeners = new Set<(event: { type: "proposed" | "changed"; routine: RoutineSummary }) => void>();

  private readonly tabsListeners = new Set<(tabs: TabSummary[]) => void>();
  private readonly observationListeners = new Set<(observation: PageObservation) => void>();
  private readonly approvalQueuedListeners = new Set<(approval: PendingApproval) => void>();
  private readonly approvalsChangedListeners = new Set<(pending: PendingApproval[]) => void>();
  private readonly approvalResolvedListeners = new Set<(resolution: ApprovalResolution) => void>();
  private readonly overridesChangedListeners = new Set<(overrides: TabOverrides) => void>();
  private readonly assertionTransitionListeners = new Set<(transition: AssertionTransition) => void>();
  private readonly elementPickedListeners = new Set<(pick: HumanElementPick) => void>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(private readonly browser: BrowserBackend, options: HelmstackCoreOptions) {
    this.backend = browser.kind;
    this.includeSocial = options.includeSocial ?? false;
    this.pullObservations = options.pullObservations ?? true;
    this.helmstackVersion = options.helmstackVersion ?? "unknown";
    this.reportCollectorTimeoutMs = options.reportCollectorTimeoutMs ?? REPORT_COLLECTOR_TIMEOUT_MS;
    this.reports = new ReportStore(options.dataDir, options.reportStore);
    this.routines = new RoutineStore(options.dataDir, options.routineStore);
    this.unsubscribers.push(this.routines.onEvent((event) => this.handleRoutineEvent(event)));
    const { autoStart, ...engineOptions } = options.routineEngine ?? {};
    this.routineEngine = new RoutineEngine({
      routines: this.routines,
      data: new RoutineDataStore(options.dataDir, { log: options.routineStore?.log ?? ((m) => console.log(m)) }),
      browser: this.routineBrowser(),
      fetchRobots: fetchRobotsTxt,
      log: options.routineStore?.log ?? ((m) => console.log(m)),
      ...engineOptions
    });

    this.approvals = new ApprovalStore({ ttlMs: resolveApprovalTtl(options.approvalTtlMs) });
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
    this.approvals.onChanged((pending) => {
      for (const listener of this.approvalsChangedListeners) listener(pending);
    });
    this.approvals.onResolved((resolution) => {
      for (const listener of this.approvalResolvedListeners) listener(resolution);
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
    if (autoStart !== false) this.routineEngine.start();
  }

  /** Detaches from the backend and disposes every session. */
  dispose(): void {
    this.routineEngine.dispose();
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
        // A fill approval covers one document's form; a new document asks again.
        this.capabilityRegistry.clearApprovalGrants(event.tabId);
        // A pending approval was asked about the old page: never run it on the
        // new one. Fragment-only changes (same document) keep it.
        this.approvals.cancelTab(event.tabId, PAGE_CHANGED_REASON, event.url);
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
    const session = this.sessions.get(tabId);
    session?.dispose();
    this.sessions.delete(tabId);
    this.assertionWatches.clearTab(tabId);
    this.humanPicks.clearTab(tabId);
    // A closed tab's approvals can never run; drop them so the human isn't asked.
    this.approvals.cancelTab(tabId, `${PAGE_CHANGED_REASON} (tab closed)`);
    this.capabilityRegistry.clearApprovalGrants(tabId);
    // Final event (once, even though closeTab and the `closed` lifecycle both
    // land here) so the shell can drop the tab's override chips.
    if (session) this.emitOverridesChanged(emptyOverrides(tabId));
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

  async reload(tabId: TabId, options: { ignoreCache?: boolean } = {}): Promise<TabSummary[]> {
    const session = this.requireSession(tabId);
    const { tab } = session;
    if (!tab.reload) throw new Error("This backend cannot reload tabs.");
    await tab.reload({ ignoreCache: options.ignoreCache === true }).catch(() => {});
    return this.listTabs();
  }

  async goBack(tabId: TabId): Promise<TabSummary[]> {
    return this.stepHistory(tabId, "back");
  }

  async goForward(tabId: TabId): Promise<TabSummary[]> {
    return this.stepHistory(tabId, "forward");
  }

  private async stepHistory(tabId: TabId, direction: "back" | "forward"): Promise<TabSummary[]> {
    const session = this.requireSession(tabId);
    const { tab } = session;
    const step = direction === "back" ? tab.goBack : tab.goForward;
    if (!step) throw new Error("This backend cannot move through history.");
    await step.call(tab).catch(() => {});
    return this.listTabs();
  }

  // ── Snapshot / perception ─────────────────────────────────────────────────

  async captureSnapshot(tabId: TabId): Promise<PageSnapshot> {
    return this.requireSession(tabId).captureSnapshot();
  }

  async getLatestObservation(tabId: TabId): Promise<PageObservation | null> {
    return this.requireSession(tabId).state.lastObservation;
  }

  async capturePerception(tabId: TabId, options: { fresh?: boolean } = {}): Promise<PerceptionResult> {
    // Pull a fresh observation (even with `pullObservations: false`, as on desktop) when the
    // caller asserts on the page or a watch must see the page as it is now, not the debounced push.
    const fresh = options.fresh || this.assertionWatches.list(tabId).length > 0;
    const result = await this.requireSession(tabId).capturePerception({ fresh });
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

      // The backend's view of the tab (desktop: includes a navigation still loading).
      const tabUrl = session.tab.summary().url;
      if (pending.url && tabUrl && !isSameApprovalPage(pending.url, tabUrl)) {
        const reason = `${PAGE_CHANGED_REASON} (approved on ${pending.url}, tab is now on ${tabUrl})`;
        this.approvals.cancel(requestId, reason);
        return { status: "blocked", command: pending.command, reason };
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

    return this.capabilityRegistry.describeSettledApproval(
      requestId,
      this.listTabs().find((tab) => tab.isActive)?.id ?? "unknown"
    );
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
    await this.requireSession(tabId).setEmulatedViewport(width, height, mobile);
    this.notifyOverrides(tabId);
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
  async captureHealthReport(tabId: TabId, options: { includeSeo?: boolean } = {}): Promise<HealthReport> {
    const session = this.requireSession(tabId);
    const includeSeo = options.includeSeo !== false;
    const [performance, accessibility, layout, seo] = await Promise.all([
      session.capturePerformanceMetrics(),
      session.auditAccessibility(),
      session.detectLayoutIssues(),
      // The SEO category is best-effort: an audit failure must not break the report.
      includeSeo ? session.captureSeoAudit().catch(() => undefined) : Promise.resolve(undefined)
    ]);
    const logs = session.getTabLogs();
    return buildHealthReport(
      { performance, accessibility, logs, layout, ...(seo ? { seo } : {}) },
      tabId,
      session.cdp.url(),
      Date.now()
    );
  }

  /** Deterministic SEO audit; see `TabSession.captureSeoAudit`. */
  seoAudit(tabId: TabId, options: SeoAuditOptions = {}): Promise<SeoAuditReport> {
    return this.requireSession(tabId).captureSeoAudit(options);
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

  async enableNetworkMock(tabId: TabId, rules: NetworkInterceptRule[]): Promise<void> {
    await this.mutateOverride(tabId, (s) => s.enableNetworkMock(rules));
  }

  async disableNetworkMock(tabId: TabId): Promise<void> {
    await this.mutateOverride(tabId, (s) => s.disableNetworkMock());
  }

  // ── Overrides ─────────────────────────────────────────────────────────────

  getResourceBudget(tabId: TabId): ResourceBudget | null {
    return this.requireSession(tabId).getResourceBudget();
  }

  setResourceBudget(tabId: TabId, budget: ResourceBudget): Promise<ResourceBudget> {
    return this.mutateOverride(tabId, (s) => s.setResourceBudget(budget));
  }

  clearResourceBudget(tabId: TabId): Promise<void> {
    return this.mutateOverride(tabId, (s) => s.clearResourceBudget());
  }

  getLocationOverride(tabId: TabId): LocationOverride | null {
    return this.requireSession(tabId).getLocationOverride();
  }

  setLocationOverride(tabId: TabId, location: LocationOverride): Promise<LocationOverride> {
    return this.mutateOverride(tabId, (s) => s.setLocationOverride(location));
  }

  clearLocationOverride(tabId: TabId): Promise<void> {
    return this.mutateOverride(tabId, (s) => s.clearLocationOverride());
  }

  getMediaEmulation(tabId: TabId): MediaEmulation | null {
    return this.requireSession(tabId).getMediaEmulation();
  }

  setMediaEmulation(tabId: TabId, emulation: MediaEmulation): Promise<MediaEmulation> {
    return this.mutateOverride(tabId, (s) => s.setMediaEmulation(emulation));
  }

  clearMediaEmulation(tabId: TabId): Promise<void> {
    return this.mutateOverride(tabId, (s) => s.clearMediaEmulation());
  }

  /** Every agent-applied override on a tab, for the shell's override chips. */
  getTabOverrides(tabId: TabId): TabOverrides {
    const session = this.requireSession(tabId);
    const watches = this.assertionWatches.list(tabId);
    return {
      tabId,
      viewport: session.getEmulatedViewport(),
      media: session.getMediaEmulation(),
      resourceBudget: session.getResourceBudget(),
      location: session.getLocationOverride(),
      networkMockRuleCount: session.getNetworkMockRules()?.length ?? 0,
      recording: session.getRecording() !== null,
      watches: {
        total: watches.length,
        passing: watches.filter((w) => w.lastPass === true).length,
        failing: watches.filter((w) => w.lastPass === false).length
      }
    };
  }

  /**
   * Undo one override kind (or all of them) on a tab, including its CDP state,
   * via the same clear methods the agent API uses. A stopped recording is
   * discarded. Emits one overrides-changed event and returns the new state.
   */
  async clearTabOverrides(tabId: TabId, kind: TabOverrideKind | "all"): Promise<TabOverrides> {
    const session = this.requireSession(tabId);
    const kinds: TabOverrideKind[] = kind === "all" ? [...TAB_OVERRIDE_KINDS] : [kind];
    for (const k of kinds) {
      switch (k) {
        case "viewport":
          if (session.getEmulatedViewport()) await session.clearEmulatedViewport();
          break;
        case "media":
          if (session.getMediaEmulation()) await session.clearMediaEmulation();
          break;
        case "resourceBudget":
          if (session.getResourceBudget()) await session.clearResourceBudget();
          break;
        case "location":
          if (session.getLocationOverride()) await session.clearLocationOverride();
          break;
        case "networkMock":
          if (session.getNetworkMockRules()) await session.disableNetworkMock();
          break;
        case "recording":
          if (session.getRecording()) session.stopRecording();
          break;
        case "watches":
          this.assertionWatches.clearTab(tabId);
          break;
        default:
          throw new Error(`Unknown override kind: ${String(k)}`);
      }
    }
    return this.notifyOverrides(tabId);
  }

  /** Run a session mutation, then emit the tab's new overrides (also on failure). */
  private async mutateOverride<T>(tabId: TabId, mutate: (session: TabSession) => Promise<T> | T): Promise<T> {
    const session = this.requireSession(tabId);
    try {
      return await mutate(session);
    } finally {
      this.notifyOverrides(tabId);
    }
  }

  private notifyOverrides(tabId: TabId): TabOverrides {
    const overrides = this.getTabOverrides(tabId);
    this.emitOverridesChanged(overrides);
    return overrides;
  }

  private emitOverridesChanged(overrides: TabOverrides): void {
    for (const listener of this.overridesChangedListeners) listener(overrides);
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
    const recording = this.requireSession(tabId).startRecording();
    this.notifyOverrides(tabId);
    return recording;
  }

  stopRecording(tabId: TabId): RecordingStopResult {
    const result = this.requireSession(tabId).stopRecording();
    this.notifyOverrides(tabId);
    return result;
  }

  // ── Assertions / watches ──────────────────────────────────────────────────

  async evaluateAssertion(tabId: TabId, assertion: string): Promise<AssertionResult> {
    const result = await this.capturePerception(tabId, { fresh: true });
    return evaluateAssertionAgainstGraph(tabId, assertion, result.graph);
  }

  addAssertionWatch(tabId: TabId, assertion: string): AssertionWatch {
    const watch = this.assertionWatches.add(tabId, assertion, Date.now());
    if (this.sessions.has(tabId)) this.notifyOverrides(tabId);
    return watch;
  }

  removeAssertionWatch(id: string): boolean {
    const tabId = this.assertionWatches.list().find((w) => w.id === id)?.tabId;
    const removed = this.assertionWatches.remove(id);
    if (removed && tabId && this.sessions.has(tabId)) this.notifyOverrides(tabId);
    return removed;
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
    if (transitions.length && this.sessions.has(tabId)) this.notifyOverrides(tabId);
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

  /**
   * Full pending list whenever it changes: queued (after `onApprovalQueued`),
   * approved, rejected, cancelled (navigation / tab closed) or expired. Any source counts
   * (agent API, shell IPC). Returns an unsubscribe function.
   */
  onApprovalsChanged(listener: (pending: PendingApproval[]) => void): () => void {
    this.approvalsChangedListeners.add(listener);
    return () => this.approvalsChangedListeners.delete(listener);
  }

  /**
   * Every settled approval: approved (with the run's status), rejected,
   * cancelled (page changed / tab closed) or expired. Drives the
   * `approval_resolved` SSE event. Returns an unsubscribe function.
   */
  onApprovalResolved(listener: (resolution: ApprovalResolution) => void): () => void {
    this.approvalResolvedListeners.add(listener);
    return () => this.approvalResolvedListeners.delete(listener);
  }

  /**
   * A tab's overrides after any change: set/clear via the API or
   * `clearTabOverrides`, recording start/stop, watch add/remove and pass/fail
   * transitions. On tab close fires once with an all-empty `TabOverrides`.
   */
  onTabOverridesChanged(listener: (overrides: TabOverrides) => void): () => void {
    this.overridesChangedListeners.add(listener);
    return () => this.overridesChangedListeners.delete(listener);
  }

  onHandoffRequested(listener: (handoff: HumanHandoffRecord) => void): void {
    this.capabilityRegistry.onHandoffRequested(listener);
  }

  /** Fires after {@link recordHumanPick} stores a completed pick. Returns an unsubscribe function. */
  onElementPicked(listener: (pick: HumanElementPick) => void): () => void {
    this.elementPickedListeners.add(listener);
    return () => this.elementPickedListeners.delete(listener);
  }

  // ── Reports ───────────────────────────────────────────────────────────────

  /**
   * Create a page analysis report: the agent's own findings (validated, never
   * trimmed silently) plus measurements HelmStack collects now. A collector
   * that throws or exceeds the time limit is recorded under `skipped`; the
   * report is still written.
   */
  async createReport(tabId: TabId, rawInput: CreateReportInput, ctx: { agentId?: string } = {}): Promise<CreateReportResult> {
    const parsed = parseCreateReportInput(rawInput);
    if (!parsed.ok) throw new ReportInputError(parsed.error);
    const input = parsed.value;
    const session = this.requireSession(tabId);
    const capturedAt = Date.now();
    const timeoutMs = this.reportCollectorTimeoutMs;

    const wants = new Set<ReportEvidenceKind>(input.include);
    const skipped: Array<{ kind: ReportEvidenceKind; reason: string }> = [];
    const evidence: ReportEvidence = {};
    const attempt = async <T>(kind: ReportEvidenceKind | "screenshot", run: () => Promise<T> | T): Promise<T | undefined> => {
      try {
        return await withTimeout(Promise.resolve().then(run), timeoutMs, `timed out after ${Math.round(timeoutMs / 1000)} s`);
      } catch (err) {
        if (kind !== "screenshot" && wants.has(kind)) skipped.push({ kind, reason: shortReason(err) });
        return undefined;
      }
    };
    // Health reuses the other collectors' results when they all succeeded.
    const needsParts = wants.has("health");
    const need = (k: ReportEvidenceKind) => wants.has(k) || needsParts;

    const [a11y, seo, layout, perf, logs, shot] = await Promise.all([
      need("accessibility") ? attempt("accessibility", () => session.auditAccessibility()) : undefined,
      need("seo") ? attempt("seo", () => session.captureSeoAudit()) : undefined,
      need("layout") ? attempt("layout", () => session.detectLayoutIssues()) : undefined,
      need("performance") ? attempt("performance", () => session.capturePerformanceMetrics()) : undefined,
      wants.has("console") || wants.has("network") || needsParts
        ? Promise.resolve(session.getTabLogs())
        : undefined,
      input.screenshot ? attempt("screenshot", () => session.captureScreenshot({})) : undefined
    ]);

    if (wants.has("accessibility") && a11y) evidence.accessibility = a11y;
    if (wants.has("seo") && seo) evidence.seo = seo;
    if (wants.has("layout") && layout) evidence.layout = layout;
    if (wants.has("performance") && perf) evidence.performance = perf;
    if (wants.has("console") && logs) evidence.logs = { ...evidence.logs, console: logs };
    if (wants.has("network") && logs) evidence.logs = { ...evidence.logs, network: logs };

    if (wants.has("health")) {
      if (perf && a11y && layout && logs) {
        evidence.health = buildHealthReport(
          { performance: perf, accessibility: a11y, logs, layout, ...(seo ? { seo } : {}) },
          tabId,
          session.cdp.url(),
          capturedAt
        );
      } else {
        const health = await attempt("health", () => this.captureHealthReport(tabId));
        if (health) evidence.health = health;
      }
    }
    if (shot) evidence.screenshotPng = Buffer.from(shot.data, "base64");

    const summaryInfo = session.tab.summary();
    const overrides = describeOverrides(this.getTabOverrides(tabId));
    const viewport = layout?.viewport ?? session.getEmulatedViewport() ?? this.browser.defaultViewport();
    const id = newReportId(capturedAt);
    const built = buildReport({
      id,
      page: {
        tabId,
        url: summaryInfo.url || session.cdp.url(),
        title: summaryInfo.title,
        capturedAt,
        viewport: { width: viewport.width, height: viewport.height },
        overrides,
        helmstackVersion: this.helmstackVersion
      },
      input,
      evidence,
      skipped,
      ...(ctx.agentId ? { fallbackAuthor: ctx.agentId } : {})
    });

    this.reports.add(built.summary, { html: built.html, md: built.markdown });
    this.emitReportsChanged(built.summary);
    const filePath = this.reports.resolvePath(id, "html") ?? "";
    return { report: built.summary, path: filePath, preview: built.preview };
  }

  /** Stored reports, newest first. */
  listReports(): ReportSummary[] {
    return this.reports.list();
  }

  /**
   * A stored report file, addressed only by id (validated, then looked up in the
   * index). Returns null for an unknown id; throws `ReportInputError` for a
   * malformed id or format. Never accepts a path.
   */
  getReportFile(id: string, format: ReportFormat): { path: string; bytes: Buffer; summary: ReportSummary } | null {
    const filePath = this.reports.resolvePath(id, format);
    const summary = this.reports.get(id);
    if (!filePath || !summary) return null;
    try {
      return { path: filePath, bytes: readFileSync(filePath), summary };
    } catch {
      return null;
    }
  }

  /** Absolute path of a stored report file (for the shell's save/open/reveal), or null when unknown. */
  resolveReportPath(id: string, format: ReportFormat): string | null {
    return this.reports.resolvePath(id, format);
  }

  /** Human-only (no agent route). Returns whether a report was removed. */
  deleteReport(id: string): boolean {
    const removed = this.reports.delete(id);
    if (removed) this.emitReportsChanged();
    return removed;
  }

  /** Full list on every create/delete; `created` names a new report. Returns an unsubscribe function. */
  onReportsChanged(listener: (reports: ReportSummary[], created?: ReportSummary) => void): () => void {
    this.reportsChangedListeners.add(listener);
    return () => this.reportsChangedListeners.delete(listener);
  }

  private emitReportsChanged(created?: ReportSummary): void {
    const list = this.reports.list();
    for (const listener of this.reportsChangedListeners) {
      try { listener(list, created); } catch { /* a listener must not break report creation */ }
    }
  }

  // ── Routines ──────────────────────────────────────────────────────────────
  // Agents propose routines; the human approves them in the shell. Approved `manual` and
  // `interval` routines run deterministic steps through the engine (`routines/engine.ts`).
  // Everything that changes a routine or runs the engine (approve, pause, run, cancel, clear
  // memory, kill switch, ...) is human-only: the shell calls it over IPC, there is no HTTP route.

  /**
   * Validate a spec and store it as `proposed`. Throws `RoutineSpecInvalidError` (with the
   * error list) for a bad spec and `RoutineError` for a full store or an unknown `replaces`.
   */
  proposeRoutine(rawSpec: unknown, ctx: { agentId?: string; replaces?: string } = {}): ProposeRoutineResult {
    const checked = validateRoutineSpec(rawSpec);
    if (!checked.ok) throw new RoutineSpecInvalidError(checked.errors);
    const spec = checked.spec;
    let previous: RoutineSummary | undefined;
    if (ctx.replaces !== undefined) {
      if (!isValidRoutineId(ctx.replaces)) throw new RoutineError("replaces is not a valid routine id", "invalid_id");
      previous = this.routines.get(ctx.replaces);
      if (!previous) throw new RoutineError(`replaces: no routine ${ctx.replaces}`, "not_found");
    }
    const plain = buildPreview(spec);
    const preview = previous ? buildPreview(spec, { changes: diffPreviews(previous.preview, plain) }) : plain;
    const routine = this.routines.propose({
      spec,
      preview,
      trigger: triggerText(spec.trigger),
      ...(ctx.agentId ? { proposedBy: ctx.agentId } : {}),
      ...(previous ? { replaces: previous.id } : {})
    });
    return { routine, warnings: preview.risks.filter((r) => r.level !== "info").map((r) => r.message), stepCount: countSteps(spec) };
  }

  /** Newest first. */
  listRoutines(): RoutineSummary[] {
    return this.routines.list();
  }

  /** The routine with its validated spec, or null for an unknown or malformed id. */
  getRoutine(id: string): RoutineDetail | null {
    return this.routines.detail(id) ?? null;
  }

  /** Agent route: withdraw the caller's own still-proposed routine (proposed -> rejected). */
  withdrawRoutine(id: string, agentId?: string): RoutineSummary {
    const found = this.routines.get(id);
    if (!found) throw new RoutineError("That routine no longer exists.", "not_found");
    if (found.proposedBy !== (agentId || undefined)) {
      throw new RoutineError("That routine was proposed by a different agent; only its proposer can withdraw it.", "forbidden");
    }
    return this.routines.transition(id, "withdraw");
  }

  /** Human-only. proposed -> approved (the routine it replaces, if any, is stopped). */
  approveRoutine(id: string): RoutineSummary {
    return this.routines.transition(id, "approve");
  }

  /** Human-only. proposed -> rejected. */
  rejectRoutine(id: string): RoutineSummary {
    return this.routines.transition(id, "reject");
  }

  /** Human-only. approved -> paused. */
  pauseRoutine(id: string): RoutineSummary {
    return this.routines.transition(id, "pause");
  }

  /** Human-only. paused -> approved. */
  resumeRoutine(id: string): RoutineSummary {
    return this.routines.transition(id, "resume");
  }

  /** Human-only. approved | paused -> stopped. */
  stopRoutine(id: string): RoutineSummary {
    return this.routines.transition(id, "stop");
  }

  /** Human-only. Removes a routine of any state; returns whether it existed. */
  deleteRoutine(id: string): boolean {
    return this.routines.delete(id);
  }

  getRoutineEngineStatus(): RoutineEngineStatus {
    return this.routineEngine.status();
  }

  /** Human-only. Start a run of an approved routine now; it continues in the background. */
  runRoutineNow(id: string): RoutineRunSummary {
    return this.routineEngine.runNow(id);
  }

  /** Human-only. Cancel the routine's running run (no-op when none). */
  cancelRoutineRun(id: string): void {
    this.routineEngine.cancel(id);
  }

  /** Newest first, at most 50 per routine. Agents may read this. */
  listRoutineRuns(id: string): RoutineRunSummary[] {
    return this.routineEngine.listRuns(id);
  }

  /** One run with its log (page-supplied text: untrusted data). Agents may read this. */
  getRoutineRun(id: string, runId: string): RoutineRunDetail | null {
    return this.routineEngine.getRun(id, runId);
  }

  /** Newest first (page-supplied text: untrusted data). Agents may read this. */
  listRoutineNotes(id: string, limit?: number): RoutineNote[] {
    return this.routineEngine.listNotes(id, limit);
  }

  getRoutineMemory(id: string): RoutineMemory {
    return this.routineEngine.getMemory(id);
  }

  /** Human-only. Forget what the routine has seen; notes and run history stay. */
  clearRoutineMemory(id: string): void {
    this.routineEngine.clearMemory(id);
  }

  /** Human-only. On: abort running routines and start nothing until it is turned off. */
  setRoutineKillSwitch(on: boolean): RoutineEngineStatus {
    return this.routineEngine.setKillSwitch(on);
  }

  /** Fires when a run starts, makes progress or ends. Returns an unsubscribe function. */
  onRoutineRunUpdated(listener: (run: RoutineRunSummary) => void): () => void {
    return this.routineEngine.onRunUpdated(listener);
  }

  /** Lets the engine open its own tab, load pages and read them with the fixed page script. */
  private routineBrowser(): RoutineBrowser {
    return {
      openTab: async () => {
        const tab = await this.browser.createTab("about:blank");
        this.ensureSession(tab);
        return tab.id;
      },
      navigate: async (tabId, url) => {
        const session = this.requireSession(tabId);
        session.recordCommand("navigate", { type: "navigate", url }, "completed");
        await session.tab.navigate(url);
        await waitForPageSettled(session.tab.cdp).catch(() => {});
        return { url: session.tab.summary().url || url };
      },
      collect: async (tabId) => (await this.requireSession(tabId).evaluateExpression(PAGE_COLLECTOR_SCRIPT)).value,
      closeTab: async (tabId) => {
        if (this.sessions.has(tabId)) await this.closeTab(tabId);
      }
    };
  }

  /** Full list on every propose / state change / delete; `proposed` names a new proposal. Returns an unsubscribe function. */
  onRoutinesChanged(listener: (routines: RoutineSummary[], proposed?: RoutineSummary) => void): () => void {
    this.routinesChangedListeners.add(listener);
    return () => this.routinesChangedListeners.delete(listener);
  }

  /** Proposals and state changes with the affected summary (for the agent event stream). */
  onRoutineEvent(listener: (event: { type: "proposed" | "changed"; routine: RoutineSummary }) => void): () => void {
    this.routineEventListeners.add(listener);
    return () => this.routineEventListeners.delete(listener);
  }

  private handleRoutineEvent(event: RoutineStoreEvent): void {
    if (event.type === "changed") this.routineEngine.handleRoutineChanged(event.routine);
    else if (event.type === "deleted") this.routineEngine.handleRoutineDeleted(event.routine);
    const list = this.routines.list();
    for (const listener of this.routinesChangedListeners) {
      try { listener(list, event.type === "proposed" ? event.routine : undefined); } catch { /* a listener must not break routine handling */ }
    }
    if (event.type === "deleted") return;
    for (const listener of this.routineEventListeners) {
      try { listener({ type: event.type, routine: event.routine }); } catch { /* ditto */ }
    }
  }

  // ── Human element picks ("Select for agent") ──────────────────────────────

  /**
   * Record an element the human picked in the shell so agents can read it.
   * Cancelled picks are ignored (returns null). Picks an *agent* started via
   * `pickElement` are returned to that agent directly and are not recorded.
   */
  recordHumanPick(tabId: TabId, result: ElementPickResult): HumanElementPick | null {
    if (!this.sessions.has(tabId)) return null;
    const entry = this.humanPicks.record(tabId, result);
    if (!entry) return null;
    for (const listener of this.elementPickedListeners) {
      try { listener(entry); } catch { /* a listener must not break recording */ }
    }
    return entry;
  }

  /** The human's latest pick on a tab, or null. */
  getLatestPick(tabId: TabId): HumanElementPick | null {
    return this.humanPicks.latestFor(tabId);
  }

  /** Recent human picks across tabs, newest first (bounded). */
  listPicks(): HumanElementPick[] {
    return this.humanPicks.list();
  }
}

const TAB_OVERRIDE_KINDS: readonly TabOverrideKind[] = [
  "viewport", "media", "resourceBudget", "location", "networkMock", "recording", "watches"
];

function emptyOverrides(tabId: TabId): TabOverrides {
  return {
    tabId,
    viewport: null,
    media: null,
    resourceBudget: null,
    location: null,
    networkMockRuleCount: 0,
    recording: false,
    watches: { total: 0, passing: 0, failing: 0 }
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  if (!(ms > 0)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e); }
    );
  });
}

/** Short, single-line reason for the report; never a stack. */
function shortReason(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const line = text.split("\n")[0]!.replace(/\s+/g, " ").trim();
  return line.length > 160 ? `${line.slice(0, 159)}…` : line || "failed";
}

/** Plain descriptions of agent-applied overrides; no coordinates or other private values. */
function describeOverrides(o: TabOverrides): string[] {
  const out: string[] = [];
  if (o.viewport) out.push(`Viewport ${o.viewport.width}×${o.viewport.height}${o.viewport.mobile ? " (mobile)" : ""}`);
  if (o.media) {
    const parts = [
      o.media.colorScheme ? `color scheme ${o.media.colorScheme}` : "",
      o.media.reducedMotion ? `reduced motion ${o.media.reducedMotion}` : "",
      o.media.forcedColors ? `forced colors ${o.media.forcedColors}` : "",
      o.media.media ? `media ${o.media.media}` : ""
    ].filter(Boolean);
    out.push(`Media emulation${parts.length ? `: ${parts.join(", ")}` : ""}`);
  }
  if (o.resourceBudget) out.push("Resource budget (CPU/network throttling)");
  if (o.location) out.push("Location override");
  if (o.networkMockRuleCount > 0) out.push(`Network mocks (${o.networkMockRuleCount} rule${o.networkMockRuleCount === 1 ? "" : "s"})`);
  return out;
}

function originFromUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}
