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

/**
 * Emulated CSS media state for a tab — lets agents test dark mode, reduced
 * motion, forced-colors, and print styles without changing OS settings.
 * Backed by CDP `Emulation.setEmulatedMedia`.
 */
export type MediaEmulation = {
  /** Emulates `prefers-color-scheme`. */
  colorScheme?: "light" | "dark" | "no-preference";
  /** Emulates `prefers-reduced-motion`. */
  reducedMotion?: "reduce" | "no-preference";
  /** Emulates `forced-colors` (high-contrast mode). */
  forcedColors?: "active" | "none";
  /** CSS media type to emulate, e.g. "screen" or "print". */
  media?: string;
};

/**
 * The page's *current* responsive state: resolved media features (color
 * scheme, reduced motion, pointer/hover capability, orientation), the viewport
 * size, and which `@media` rules from the page's stylesheets currently match.
 * Complements `MediaEmulation` (which sets state) — this reads it back.
 */
export type MediaStateReport = {
  tabId: TabId;
  url: string;
  capturedAt: number;
  /** Resolved media features, e.g. `prefers-color-scheme` → `"dark"`. */
  features: Record<string, string>;
  viewport: { width: number; height: number };
  /** Distinct `@media` queries found in stylesheets and whether each currently matches. */
  mediaQueries: Array<{ query: string; matches: boolean }>;
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
  /** A replayable HelmStack SDK script. */
  script: string;
  /** The same flow exported as runnable code for common test frameworks. */
  exports: {
    playwright: string;
    cypress: string;
    testingLibrary: string;
  };
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

/** Options controlling the region a screenshot captures. */
export type ScreenshotOptions = {
  /** Capture the entire scrollable page, not just the current viewport. */
  fullPage?: boolean;
  /**
   * Capture only the first element matching this CSS selector (its full
   * bounding box, even if it is below the fold). Takes precedence over
   * `fullPage`.
   */
  selector?: string;
};

export type DiffRegion = {
  /** Top-left x offset of the changed bounding box (pixels). */
  x: number;
  /** Top-left y offset of the changed bounding box (pixels). */
  y: number;
  width: number;
  height: number;
};

/** A rendered element's on-screen box, used to map pixel diffs to DOM nodes. */
export type ElementBound = {
  selector: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

/** An element that overlaps one or more changed regions in a visual diff. */
export type ChangedElement = {
  selector: string;
  bounds: ElementBound;
  /** How many distinct changed regions this element covers. */
  regions: number;
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
  /** Layout issues detected at this breakpoint (only when includeLayoutIssues=true). */
  layoutIssues?: LayoutIssuesReport;
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

// ── Aggregated page health ────────────────────────────────────────────────────

export type HealthCategoryId = "performance" | "accessibility" | "console" | "network" | "layout";

export type HealthCategory = {
  id: HealthCategoryId;
  label: string;
  /** 0–100. */
  score: number;
  pass: boolean;
  details: string;
};

/**
 * A Lighthouse-style scorecard fusing Core Web Vitals, the WCAG audit, console
 * errors, failed network requests, and layout overflow into one report. `pass`
 * is true only when every category passes — suitable as a CI gate.
 */
export type HealthReport = {
  tabId: TabId;
  url: string;
  capturedAt: number;
  overallScore: number;
  pass: boolean;
  categories: HealthCategory[];
  summary: string;
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

// ── Design tokens ─────────────────────────────────────────────────────────

/** A single observed design value and how many elements use it. */
export type DesignTokenSample = {
  value: string;
  count: number;
};

/**
 * The de-facto design system in use on a page: the actual colors, type scale,
 * spacing, radii, shadows, and z-index layers harvested from computed styles,
 * plus any declared CSS custom properties. Each category is ranked by usage
 * frequency so the dominant tokens surface first.
 */
export type DesignTokensReport = {
  tabId: TabId;
  url: string;
  capturedAt: number;
  /** CSS custom properties declared on :root / html, name → value. */
  cssVariables: Record<string, string>;
  colors: DesignTokenSample[];
  fontFamilies: DesignTokenSample[];
  fontSizes: DesignTokenSample[];
  fontWeights: DesignTokenSample[];
  spacing: DesignTokenSample[];
  radii: DesignTokenSample[];
  shadows: DesignTokenSample[];
  zIndices: DesignTokenSample[];
  /** Number of elements sampled (capped for performance). */
  sampledElements: number;
};

// ── Layout / responsive issues ────────────────────────────────────────────

export type LayoutIssueKind =
  /** The document scrolls horizontally inside the viewport. */
  | "page_overflow"
  /** An element extends past the right edge of the viewport (a likely overflow culprit). */
  | "viewport_overflow"
  /** A child visibly escapes the horizontal bounds of its constrained parent. */
  | "container_escape"
  /** An element with hidden/clip overflow is cutting off its own content. */
  | "clipped_content";

export type LayoutIssue = {
  kind: LayoutIssueKind;
  selector: string;
  detail: string;
  bounds: { x: number; y: number; width: number; height: number };
  /** How far (px) the element overflows, when applicable. */
  overflowPx?: number;
};

/**
 * Per-viewport layout health: whether the page scrolls horizontally and which
 * elements overflow the viewport, escape their container, or clip their own
 * content. Run at each breakpoint to find *why* a responsive layout broke.
 */
export type LayoutIssuesReport = {
  tabId: TabId;
  url: string;
  capturedAt: number;
  viewport: { width: number; height: number };
  hasHorizontalOverflow: boolean;
  documentScrollWidth: number;
  issues: LayoutIssue[];
};

// ── Mutation / re-render timeline ─────────────────────────────────────────

export type MutationKindCounts = {
  childList: number;
  attributes: number;
  characterData: number;
};

/** A DOM subtree that mutated frequently during the sample window. */
export type MutationHotspot = {
  selector: string;
  mutations: number;
  kinds: MutationKindCounts;
};

/**
 * A sample of DOM mutations over a time window — surfaces layout thrash and
 * runaway re-renders by ranking the elements that mutated most.
 */
export type MutationTimelineReport = {
  tabId: TabId;
  url: string;
  capturedAt: number;
  durationMs: number;
  totalMutations: number;
  byKind: MutationKindCounts;
  addedNodes: number;
  removedNodes: number;
  /** Mutating subtrees ranked by mutation count. */
  hotspots: MutationHotspot[];
};

// ── Keyboard / focus-order audit ───────────────────────────────────────────

export type FocusableElement = {
  selector: string;
  /** Resolved tabindex (0 if unset). */
  tabindex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  name?: string;
};

export type FocusOrderIssueKind = "positive_tabindex" | "reading_order_jump";

export type FocusOrderIssue = {
  kind: FocusOrderIssueKind;
  selector: string;
  detail: string;
};

/**
 * Audits keyboard tab order against the page's visual reading order. Flags
 * positive `tabindex` (which hijacks order) and points where tab order jumps
 * backwards relative to top-to-bottom / left-to-right reading.
 */
export type FocusOrderReport = {
  tabId: TabId;
  url: string;
  capturedAt: number;
  focusableCount: number;
  positiveTabindexCount: number;
  issues: FocusOrderIssue[];
  /** Selectors in computed keyboard tab order. */
  order: string[];
};

// ── Element → source mapping (click-to-component) ──────────────────────────

/** A DOM element mapped back to the component + source location that rendered it. */
export type ComponentSource = {
  selector: string;
  component: string;
  framework: "react" | "svelte" | "vue" | "unknown";
  file?: string;
  line?: number;
  column?: number;
};

/** Per-component rollup: where it's defined and how many instances are on the page. */
export type ComponentSourceSummary = {
  component: string;
  file?: string;
  line?: number;
  instances: number;
};

/**
 * Maps rendered DOM nodes back to their authoring component + source `file:line`
 * (React `_debugSource`, Svelte `__svelte_meta`, Vue `__file`). Lets an agent
 * say "the misaligned button is `<PrimaryButton>` at src/ui/Button.tsx:42".
 */
export type ComponentSourceReport = {
  tabId: TabId;
  url: string;
  capturedAt: number;
  framework: "react" | "svelte" | "vue" | "mixed" | "unknown";
  sampledElements: number;
  mappedElements: number;
  components: ComponentSourceSummary[];
  elements: ComponentSource[];
};

// ── Component Tree ────────────────────────────────────────────────────────

export type ComponentFramework = "react" | "vue" | "svelte" | "angular" | "unknown";

export type ComponentNode = {
  name: string;
  /** Stringified props (shallow, truncated to avoid huge payloads). */
  props: Record<string, string>;
  /** Authoring source `file:line` when dev-build metadata is available. */
  source?: string;
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

/** A standing natural-language assertion re-checked on every page observation. */
export type AssertionWatch = {
  id: string;
  tabId: TabId;
  assertion: string;
  /** Latest evaluation result, or null until first evaluated. */
  lastPass: boolean | null;
  createdAt: number;
};

/** Emitted when a watched assertion's pass/fail state changes. */
export type AssertionTransition = {
  watchId: string;
  tabId: TabId;
  assertion: string;
  pass: boolean;
  previousPass: boolean | null;
  explanation: string;
  at: number;
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
