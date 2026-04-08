export type TabId = string;

export type TabStatus = "idle" | "loading" | "error";

export type TabSummary = {
  id: TabId;
  title: string;
  url: string;
  isActive: boolean;
  status: TabStatus;
  statusMessage?: string;
};

export type ViewportRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PageScreenshot = {
  tabId: TabId;
  capturedAt: number;
  /** Base64-encoded PNG. */
  data: string;
  mimeType: "image/png";
  width: number;
  height: number;
};

export type ScreenshotDiff = {
  beforeId: string;
  afterId: string;
  diffPixelCount: number;
  /** Percentage of pixels that differ (0–100, two decimal places). */
  diffPercentage: number;
  totalPixels: number;
  width: number;
  height: number;
  /** Base64-encoded PNG with changed pixels highlighted in red. */
  diffImageData?: string;
  capturedAt: number;
};

// ── Responsive multi-viewport ─────────────────────────────────────────────────

export const VIEWPORT_PRESETS = {
  "mobile-sm":  { width: 375,  height: 667,  mobile: true,  label: "Mobile S (375×667)"    },
  "mobile":     { width: 390,  height: 844,  mobile: true,  label: "Mobile (390×844)"       },
  "mobile-lg":  { width: 430,  height: 932,  mobile: true,  label: "Mobile L (430×932)"     },
  "tablet":     { width: 768,  height: 1024, mobile: false, label: "Tablet (768×1024)"      },
  "tablet-lg":  { width: 1024, height: 1366, mobile: false, label: "Tablet L (1024×1366)"   },
  "laptop":     { width: 1280, height: 800,  mobile: false, label: "Laptop (1280×800)"      },
  "desktop":    { width: 1440, height: 900,  mobile: false, label: "Desktop (1440×900)"     },
  "wide":       { width: 1920, height: 1080, mobile: false, label: "Wide (1920×1080)"       },
} as const;

export type ViewportPresetName = keyof typeof VIEWPORT_PRESETS;

export type ViewportPreset = {
  name: ViewportPresetName;
  width: number;
  height: number;
  mobile: boolean;
  label: string;
};

export type ViewportCapture = {
  preset: ViewportPreset;
  /** snapshotId used in the screenshot cache: `<tabId>__<presetName>__<runId>` */
  snapshotId: string;
  screenshot: PageScreenshot;
};

export type ViewportSuiteReport = {
  tabId: TabId;
  /** Unique run identifier — use to re-reference named screenshots. */
  runId: string;
  captures: ViewportCapture[];
  /** Pairwise diffs between consecutive breakpoints (only when includeDiffs=true). */
  diffs: Array<{ from: ViewportPresetName; to: ViewportPresetName; diff: ScreenshotDiff }>;
  capturedAt: number;
};

export type PageSnapshot = {
  tabId: TabId;
  title: string;
  url: string;
  capturedAt: number;
  dom: {
    documents: unknown[];
    strings?: string[];
  };
  accessibilityTree: {
    nodes: unknown[];
  };
};

// ── Performance metrics ───────────────────────────────────────────────────────

/**
 * Navigation timing values — all times in milliseconds relative to
 * navigationStart (i.e. what you'd get from `performance.timing`).
 */
export type NavigationTiming = {
  /** Time to first byte from server. */
  ttfb: number;
  /** DOM interactive (parser finished). */
  domInteractive: number;
  /** DOMContentLoaded event fired. */
  domContentLoaded: number;
  /** load event fired (all resources). */
  loadEvent: number;
};

/**
 * Core Web Vitals sourced from PerformanceObserver entries already in the
 * browser timeline. Values are in milliseconds unless noted.
 * `null` means the metric had not been emitted yet when the snapshot was taken.
 */
export type CoreWebVitals = {
  /** Largest Contentful Paint — ms. */
  lcp: number | null;
  /** First Contentful Paint — ms. */
  fcp: number | null;
  /** Cumulative Layout Shift — unitless score (×1000 for display). */
  cls: number | null;
  /** Interaction to Next Paint — ms. null if no interactions recorded yet. */
  inp: number | null;
  /** Time to First Byte — ms (mirrors NavigationTiming.ttfb for convenience). */
  ttfb: number | null;
};

export type ResourceTimingEntry = {
  name: string;
  initiatorType: string;
  /** Transfer size in bytes (0 = cache hit). */
  transferSize: number;
  /** Total duration in ms. */
  duration: number;
};

export type PerformanceReport = {
  tabId: TabId;
  url: string;
  capturedAt: number;
  navigation: NavigationTiming | null;
  vitals: CoreWebVitals;
  /** Top 20 slowest resources by duration. */
  slowResources: ResourceTimingEntry[];
  /** Raw CDP Performance.getMetrics values (keyed by metric name). */
  cdpMetrics: Record<string, number>;
};
