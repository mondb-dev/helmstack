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

export type ResourceBudget = {
  cpuThrottlingRate?: number;
  downloadThroughputKbps?: number;
  uploadThroughputKbps?: number;
  latencyMs?: number;
  offline?: boolean;
  maxJsHeapMb?: number;
};

export type LocationOverride = {
  latitude: number;
  longitude: number;
  accuracy?: number;
  timezoneId?: string;
  locale?: string;
};

export type DownloadEntry = {
  id: string;
  tabId: TabId;
  url: string;
  filename: string;
  mimeType?: string;
  totalBytes: number;
  receivedBytes: number;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  startedAt: number;
  finishedAt?: number;
};

export type FileUploadTarget = {
  selector: string;
  files: string[];
};

export type RecordedCommand = {
  at: number;
  source: "command" | "navigate";
  command: unknown;
  outcome: "completed" | "awaiting_approval" | "awaiting_human" | "blocked" | "failed";
};

export type RecordingSession = {
  tabId: TabId;
  startedAt: number;
  commands: RecordedCommand[];
};

export type RecordingStopResult = RecordingSession & {
  script: string;
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

export type DiffRegion = {
  /** Top-left x offset of the changed bounding box (pixels). */
  x: number;
  /** Top-left y offset of the changed bounding box (pixels). */
  y: number;
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
  /**
   * Axis-aligned bounding boxes of changed pixel clusters.
   * Clusters closer than 8px are merged. Useful for pointing AI agents
   * or CI reporters at exactly which parts of the page changed.
   */
  diffRegions: DiffRegion[];
  /**
   * Base64-encoded PNG with changed pixels highlighted as a semi-transparent
   * red tint over the original, so surrounding context remains visible.
   */
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

// ── Accessibility Audit ───────────────────────────────────────────────────

export type A11yImpact = "critical" | "serious" | "moderate" | "minor";

export type A11yWcagPrinciple = "perceivable" | "operable" | "understandable" | "robust";

export type A11yViolation = {
  /** Rule identifier, e.g. "1.1.1-image-alt". */
  rule: string;
  impact: A11yImpact;
  /** WCAG success criterion, e.g. "1.1.1". */
  wcagCriteria: string;
  /** Conformance level: A, AA, or AAA. */
  wcagLevel: "A" | "AA" | "AAA";
  /** Which of the four WCAG principles this falls under. */
  principle: A11yWcagPrinciple;
  /** CSS-style selector hint identifying the offending node. */
  selector: string;
  /** Human-readable explanation of why this is a violation. */
  description: string;
  /** Specific remediation instructions for this violation. */
  remediation: string;
  /** AX role of the node, e.g. "button", "img". */
  role: string;
  /** Accessible name of the node, if present. */
  name?: string;
};

/** Per-rule summary across all violations of that rule. */
export type A11yRuleSummary = {
  ruleId: string;
  wcagCriteria: string;
  wcagLevel: "A" | "AA" | "AAA";
  principle: A11yWcagPrinciple;
  impact: A11yImpact;
  /** Plain English description of the rule. */
  description: string;
  /** Total number of violations for this rule. */
  count: number;
};

export type A11yAuditReport = {
  tabId: TabId;
  url: string;
  capturedAt: number;
  /**
   * Accessibility score 0–100.
   * 100 = zero violations. Weighted by severity:
   * critical × 8, serious × 4, moderate × 2, minor × 1 (capped per tier).
   */
  score: number;
  violations: A11yViolation[];
  /** Violation counts by severity level. */
  violationCounts: {
    critical: number;
    serious: number;
    moderate: number;
    minor: number;
  };
  /** Violation counts grouped by WCAG principle. */
  byPrinciple: Record<A11yWcagPrinciple, number>;
  /** Deduplicated summaries for each rule that produced violations. */
  violatedRules: A11yRuleSummary[];
  /** Ordered list of top-priority plain-English recommendations. */
  recommendations: string[];
  /** Number of checked nodes that passed all applicable rules. */
  passes: number;
  /** Total AX nodes inspected. */
  nodeCount: number;
};

// ── Element Style Inspector ────────────────────────────────────────────────

export type ElementStyleIssueSeverity = "info" | "warning" | "error";

export type ElementStyleIssueKind =
  | "not_visible"
  | "zero_size"
  | "offscreen"
  | "low_contrast"
  | "small_tap_target"
  | "clipped_content"
  | "pointer_events_none"
  | "high_z_index"
  | "fixed_or_sticky";

export type ElementStyleRect = {
  x: number;
  y: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
};

export type ElementBoxEdges = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type ElementStyleIssue = {
  kind: ElementStyleIssueKind;
  severity: ElementStyleIssueSeverity;
  message: string;
  property?: string;
  value?: string | number | boolean;
};

export type ElementContrastInfo = {
  foreground: string;
  background: string;
  ratio: number;
  fontSizePx: number;
  fontWeight: string;
  passesAA: boolean;
  passesLargeTextAA: boolean;
};

export type ElementStyleInspection = {
  index: number;
  selectorHint: string;
  tagName: string;
  id?: string;
  className?: string;
  role?: string;
  ariaLabel?: string;
  text?: string;
  isVisible: boolean;
  inViewport: boolean;
  bounds: ElementStyleRect;
  box: {
    margin: ElementBoxEdges;
    border: ElementBoxEdges;
    padding: ElementBoxEdges;
    content: {
      width: number;
      height: number;
    };
  };
  computed: Record<string, string>;
  contrast?: ElementContrastInfo;
  issues: ElementStyleIssue[];
};

export type ElementStyleInspectionReport = {
  tabId: TabId;
  url: string;
  capturedAt: number;
  selector: string;
  matchedCount: number;
  inspectedCount: number;
  elements: ElementStyleInspection[];
  warnings: string[];
};

export type StyleAssertion = {
  property: string;
  equals?: string | number;
  contains?: string;
  matches?: string;
  not?: string | number;
  min?: number;
  max?: number;
  tolerance?: number;
};

export type StyleAssertionCheck = {
  elementIndex: number;
  selectorHint: string;
  property: string;
  actual?: string;
  expected: string;
  pass: boolean;
  message: string;
};

export type ElementStyleAssertionReport = {
  tabId: TabId;
  url: string;
  capturedAt: number;
  selector: string;
  pass: boolean;
  matchedCount: number;
  checks: StyleAssertionCheck[];
  inspected: ElementStyleInspection[];
  issues: ElementStyleIssue[];
};

// ── Component Tree ────────────────────────────────────────────────────────

export type ComponentFramework = "react" | "vue" | "svelte" | "angular" | "unknown";

export type ComponentNode = {
  name: string;
  /** Stringified props (shallow, truncated to avoid huge payloads). */
  props: Record<string, string>;
  children: ComponentNode[];
};

export type ComponentTreeReport = {
  tabId: TabId;
  url: string;
  capturedAt: number;
  framework: ComponentFramework;
  /** Null when no devtools hook is detected or page hasn't loaded the framework. */
  tree: ComponentNode | null;
  /** Total number of component nodes found. */
  nodeCount: number;
};

// ── "What Broke?" Post-Deploy Perception Diff ────────────────────────────

export type PerceptionChangeKind =
  | "heading_added"    | "heading_removed"
  | "form_added"       | "form_removed"      | "form_changed"
  | "action_added"     | "action_removed"
  | "alert_added"      | "alert_removed"
  | "title_changed"    | "page_kind_changed"
  | "media_added"      | "media_removed";

export type PerceptionChange = {
  kind: PerceptionChangeKind;
  /** Human-readable one-line description of the change. */
  description: string;
  /** Optional before/after values for changed fields. */
  before?: string;
  after?: string;
};

export type PerceptionSnapshotEntry = {
  id: string;
  tabId: string;
  url: string;
  title: string;
  capturedAt: number;
};

export type PerceptionDiff = {
  beforeId: string;
  afterId: string;
  beforeUrl: string;
  afterUrl: string;
  capturedAt: number;
  changes: PerceptionChange[];
  /** One-sentence plain-English summary of the most important changes. */
  summary: string;
  /** True when no structural differences were found. */
  identical: boolean;
};

// ── Three.js Scene Inspector ──────────────────────────────────────────────

export type ThreeObjectType =
  | "Scene" | "Mesh" | "Group" | "Points" | "Line" | "Sprite"
  | "SkinnedMesh" | "InstancedMesh" | "LOD"
  | "DirectionalLight" | "PointLight" | "SpotLight" | "AmbientLight" | "HemisphereLight" | "RectAreaLight"
  | "PerspectiveCamera" | "OrthographicCamera"
  | "Bone" | "Object3D" | "unknown";

export type ThreeVec3 = { x: number; y: number; z: number };
export type ThreeEuler = { x: number; y: number; z: number; order: string };

export type ThreeMaterialInfo = {
  uuid: string;
  type: string;  // e.g. "MeshStandardMaterial"
  name: string;
  color?: string;      // hex string e.g. "#ff0000"
  transparent: boolean;
  opacity: number;
  wireframe: boolean;
  side: number;        // 0=Front, 1=Back, 2=Double
  depthWrite: boolean;
};

export type ThreeGeometryInfo = {
  uuid: string;
  type: string;        // e.g. "BufferGeometry"
  vertexCount: number;
  indexCount: number;
  /** Named attribute names present (position, normal, uv, etc.) */
  attributes: string[];
};

export type ThreeObject = {
  uuid: string;
  name: string;
  type: ThreeObjectType;
  visible: boolean;
  castShadow: boolean;
  receiveShadow: boolean;
  position: ThreeVec3;
  rotation: ThreeEuler;
  scale: ThreeVec3;
  /** Only present on Mesh/SkinnedMesh/InstancedMesh/Points/Line. */
  geometry?: ThreeGeometryInfo;
  /** Only present on Mesh/SkinnedMesh/Points/Sprite. Can be array (multi-material). */
  materials?: ThreeMaterialInfo[];
  /** Only present on lights. */
  lightProps?: {
    intensity: number;
    color: string;
    castShadow: boolean;
    /** Distance for point/spot lights (0 = infinite). */
    distance?: number;
    angle?: number;     // SpotLight cone angle (radians)
  };
  /** Only present on cameras. */
  cameraProps?: {
    fov?: number;        // PerspectiveCamera
    near: number;
    far: number;
    zoom: number;
  };
  /** For InstancedMesh: how many instances. */
  instanceCount?: number;
  children: ThreeObject[];
};

export type ThreeRendererInfo = {
  /** Total WebGL draw calls in the last frame. */
  drawCalls: number;
  /** Total triangles rendered in the last frame. */
  triangles: number;
  /** Total points rendered. */
  points: number;
  /** Total lines rendered. */
  lines: number;
  /** Number of compiled WebGL programs (shaders). */
  programs: number;
  /** Number of geometries currently in GPU memory. */
  geometries: number;
  /** Number of textures currently in GPU memory. */
  textures: number;
};

export type ThreeFpsEstimate = {
  /** Estimated FPS based on a short rAF sample (null if not measurable). */
  fps: number | null;
  /** Number of frames sampled. */
  framesSampled: number;
};

export type ThreeSceneReport = {
  tabId: TabId;
  url: string;
  capturedAt: number;
  /** True when a Three.js renderer/scene was detected on the page. */
  detected: boolean;
  /** Scene graph rooted at the THREE.Scene (depth-limited to 8 levels). */
  scene: ThreeObject | null;
  renderer: ThreeRendererInfo | null;
  fps: ThreeFpsEstimate | null;
  /** All unique materials found in the scene (deduplicated by uuid). */
  materials: ThreeMaterialInfo[];
  /** Summary counts useful for quick AI reasoning. */
  summary: {
    totalObjects: number;
    meshCount: number;
    lightCount: number;
    cameraCount: number;
    materialCount: number;
    uniqueMaterialCount: number;
    totalVertices: number;
    totalTriangles: number;
  };
};

// ── Natural Language Assertions ───────────────────────────────────────────

/** How certain the heuristic evaluator is about the assertion result. */
export type AssertionConfidence = "high" | "medium" | "low";

/**
 * Compact, serialisable summary of the page state used as evidence when
 * evaluating an assertion.  Small enough to paste into an LLM prompt.
 */
export type AssertionEvidence = {
  url: string;
  title: string;
  headings: string[];
  /** Flat list of action labels (button text, link text). */
  actionLabels: string[];
  /** Visible alert / status messages. */
  alertTexts: string[];
  /** One line per form: "<purpose>: field1, field2, …" */
  formSummaries: string[];
  /** Counts for quick quantitative checks. */
  counts: {
    headings: number;
    actions: number;
    forms: number;
    alerts: number;
    fields: number;
    mediaItems: number;
  };
};

export type AssertionResult = {
  tabId: TabId;
  assertion: string;
  /** Whether the assertion is judged to pass. */
  pass: boolean;
  confidence: AssertionConfidence;
  /**
   * Human-readable explanation of why the assertion passed or failed.
   * Suitable for displaying in a test report or feeding back to an AI agent.
   */
  explanation: string;
  /**
   * Compact page-graph summary used as evidence.
   * Feed this to an LLM for a second opinion when `confidence` is "low".
   */
  evidence: AssertionEvidence;
};

// Storage Inspector

export type StorageArea = "local" | "session";

export type StorageEntry = {
  key: string;
  value: string;
  /** Approximate byte size of key + value string. */
  bytes: number;
};

export type CookieEntry = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number | null;    // epoch ms; null = session cookie
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None" | "";
  size: number;
};

export type IndexedDbObjectStore = {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  /** Row count (0 if not available). */
  count: number;
  /** First up to 100 rows, serialised to JSON strings. */
  rows: Array<{ key: string; value: string }>;
};

export type IndexedDbDatabase = {
  name: string;
  version: number;
  objectStores: IndexedDbObjectStore[];
};

export type StorageReport = {
  tabId: TabId;
  url: string;
  capturedAt: number;
  localStorage: StorageEntry[];
  sessionStorage: StorageEntry[];
  cookies: CookieEntry[];
  indexedDb: IndexedDbDatabase[];
  /** Total estimated bytes across all areas. */
  totalBytes: number;
};
