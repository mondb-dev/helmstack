/**
 * `TabState` — the portable half of the desktop's old `TabRecord` (ADR 0001
 * §4.3): everything the shared core keeps per tab. Backends keep only their
 * own bits (`view`, `pendingUrl`, `summary`, `parentTabId`); they must not
 * re-declare any of this.
 */
import type {
  DownloadEntry,
  LocationOverride,
  MediaEmulation,
  PageObservation,
  RecordingSession,
  ResourceBudget
} from "../../../shared/src/index.js";
import type { CdpEventState } from "./cdp/cdp-events.js";

export type EmulatedViewport = { width: number; height: number; mobile: boolean };

export type TabState = CdpEventState & {
  /** Latest pushed (preload IPC / CDP binding) or pulled observation. */
  lastObservation: PageObservation | null;
  /** Active `setEmulatedViewport` override; re-applied after screenshots. */
  emulatedViewport?: EmulatedViewport;
  /** Runtime/Log/Network/Performance domains enabled on the tab's session. */
  cdpLoggingEnabled: boolean;
  downloads: DownloadEntry[];
  recording: RecordingSession | null;
  resourceBudget: ResourceBudget | null;
  locationOverride: LocationOverride | null;
  mediaEmulation: MediaEmulation | null;
};

export function createTabState(): TabState {
  return {
    lastObservation: null,
    cdpLoggingEnabled: false,
    consoleLogs: [],
    networkRequests: new Map(),
    webSocketUrls: new Map(),
    webSocketFrames: [],
    eventSourceEvents: [],
    jsErrors: [],
    downloads: [],
    recording: null,
    resourceBudget: null,
    locationOverride: null,
    mediaEmulation: null,
    networkMockRules: null
  };
}

/** Drops buffered console/network/WebSocket/EventSource/JS-error entries. */
export function clearLogBuffers(state: CdpEventState): void {
  state.consoleLogs = [];
  state.networkRequests = new Map();
  state.webSocketUrls = new Map();
  state.webSocketFrames = [];
  state.eventSourceEvents = [];
  state.jsErrors = [];
}
