/**
 * In-memory `CdpTarget` and `BrowserBackend` fakes for core unit tests.
 */
import type { CdpTarget, PageObservation, TabId, TabSummary } from "../../../shared/src/index.js";
import type { BackendTab, BrowserBackend, TabLifecycleEvent } from "../../src/backend.js";

export type CdpCall = { method: string; params?: Record<string, unknown> };
type Handler = (params: Record<string, unknown> | undefined) => unknown;
type EventListener = (method: string, params: Record<string, unknown>) => void;

export class FakeCdpTarget implements CdpTarget {
  readonly calls: CdpCall[] = [];
  /** Per-method responses; a throwing handler rejects the `send`. */
  readonly handlers = new Map<string, Handler>();
  readonly listeners = new Set<EventListener>();
  currentUrl = "https://example.com/";

  async send<T = any>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    const handler = this.handlers.get(method);
    return (handler ? handler(params) : {}) as T;
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(method: string, params: Record<string, unknown> = {}): void {
    for (const listener of [...this.listeners]) listener(method, params);
  }

  async evaluate<T = unknown>(): Promise<T> {
    return undefined as T;
  }

  url(): string {
    return this.currentUrl;
  }

  isLoading(): boolean {
    return false;
  }

  async waitForLoadStop(): Promise<void> {}

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }
}

export class FakeTab implements BackendTab {
  readonly cdp = new FakeCdpTarget();
  readonly navigations: string[] = [];
  isActive = false;

  constructor(readonly id: TabId, public url = "https://example.com/", readonly parentTabId?: TabId) {
    this.cdp.currentUrl = url;
  }

  summary(): TabSummary {
    return { id: this.id, title: this.title(), url: this.url, isActive: this.isActive, status: "idle" };
  }

  title(): string {
    return `Title of ${this.url}`;
  }

  async navigate(url: string): Promise<void> {
    this.navigations.push(url);
    this.url = url;
    this.cdp.currentUrl = url;
  }
}

export class FakeBackend implements BrowserBackend {
  readonly kind = "daemon" as const;
  readonly tabs = new Map<TabId, FakeTab>();
  private readonly lifecycle = new Set<(event: TabLifecycleEvent) => void>();
  private readonly observations = new Set<(observation: PageObservation) => void>();
  private nextId = 1;

  defaultViewport() {
    return { width: 1280, height: 800 };
  }

  listTabs(): BackendTab[] {
    return [...this.tabs.values()];
  }

  getTab(id: TabId): BackendTab | undefined {
    return this.tabs.get(id);
  }

  /** Adds a tab without emitting `created` (e.g. existed before the core). */
  addTab(url = "https://example.com/", parentTabId?: TabId): FakeTab {
    const tab = new FakeTab(`tab-${this.nextId++}` as TabId, url, parentTabId);
    this.tabs.set(tab.id, tab);
    return tab;
  }

  async createTab(url: string, opts?: { parentTabId?: TabId }): Promise<BackendTab> {
    const tab = this.addTab(url, opts?.parentTabId);
    this.emit({ type: "created", tab });
    return tab;
  }

  async closeTab(id: TabId): Promise<void> {
    this.tabs.delete(id);
    this.emit({ type: "closed", tabId: id });
  }

  onLifecycle(listener: (event: TabLifecycleEvent) => void): () => void {
    this.lifecycle.add(listener);
    return () => this.lifecycle.delete(listener);
  }

  onObservation(listener: (observation: PageObservation) => void): () => void {
    this.observations.add(listener);
    return () => this.observations.delete(listener);
  }

  emit(event: TabLifecycleEvent): void {
    for (const listener of [...this.lifecycle]) listener(event);
  }

  observe(observation: PageObservation): void {
    for (const listener of [...this.observations]) listener(observation);
  }
}

export function makeObservation(tabId: TabId, overrides: Partial<PageObservation> = {}): PageObservation {
  return {
    tabId,
    url: "https://example.com/",
    title: "Example",
    timestamp: 1,
    pageKind: "generic" as PageObservation["pageKind"],
    headings: [],
    forms: [],
    primaryActions: [],
    alerts: [],
    media: [],
    ...overrides
  };
}
