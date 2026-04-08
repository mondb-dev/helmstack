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
