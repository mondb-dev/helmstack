/**
 * `BrowserBackend` — the thin, per-browser half of HelmStack (ADR 0001 §4.1).
 *
 * A backend only owns tab lifecycle and hands out one long-lived `CdpTarget`
 * per tab. Every tool lives once in the shared core on top of it. Implemented
 * by the Electron desktop (`ElectronBackend`) and the headless daemon
 * (`ChromeBackend`).
 */
import type {
  CdpTarget,
  DownloadEntry,
  ElementPickResult,
  PageObservation,
  TabId,
  TabSummary
} from "../../shared/src/index.js";
import type { BackendKind } from "./api.js";

export interface BackendTab {
  readonly id: TabId;
  readonly parentTabId?: TabId;
  /** One long-lived CDP session per tab. */
  readonly cdp: CdpTarget;
  /** Backend-maintained url/title/status. */
  summary(): TabSummary;
  title(): string;
  /** `loadURL` on desktop, `Page.navigate` on the daemon; resolves once loaded. */
  navigate(url: string): Promise<void>;
  /** Reload the page (`ignoreCache` = hard reload); resolves once loaded. Optional: backends without history omit it. */
  reload?(options?: { ignoreCache?: boolean }): Promise<void>;
  /** History back; resolves once loaded. Resolves `false` when there is no earlier entry. */
  goBack?(): Promise<boolean>;
  /** History forward; resolves once loaded. Resolves `false` when there is no later entry. */
  goForward?(): Promise<boolean>;
}

export type TabLifecycleEvent =
  | { type: "created"; tab: BackendTab }
  | { type: "closed"; tabId: TabId }
  /** Main-frame navigation started: the core clears per-tab log buffers. */
  | { type: "main-frame-navigation"; tabId: TabId; url: string }
  /** Load finished: the core re-applies emulation overrides. */
  | { type: "load-finished"; tabId: TabId }
  /** Any tab summary changed: drives the `tabs_changed` SSE event. */
  | { type: "summary-changed" };

export interface BrowserBackend {
  readonly kind: BackendKind;
  /** Desktop: the shell's content rect. Daemon: the launch window size. */
  defaultViewport(): { width: number; height: number };
  listTabs(): BackendTab[];
  getTab(id: TabId): BackendTab | undefined;
  createTab(url: string, opts?: { parentTabId?: TabId }): Promise<BackendTab>;
  closeTab(id: TabId): Promise<void>;
  /** Returns an unsubscribe function. */
  onLifecycle(listener: (event: TabLifecycleEvent) => void): () => void;
  /** Desktop: preload IPC. Daemon: the CDP perception injector. Returns an unsubscribe function. */
  onObservation(listener: (observation: PageObservation) => void): () => void;
  onDownload?(listener: (tabId: TabId, download: DownloadEntry) => void): () => void;
  pickElement?(id: TabId): Promise<ElementPickResult>;
}
