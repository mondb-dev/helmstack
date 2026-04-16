import type { TabId } from "./browser.js";

export type PageKind = "landing" | "signup" | "login" | "checkout" | "form" | "dashboard";

// ── Dev-tool observation types ────────────────────────────────────────────────

export type ConsoleLogLevel = "log" | "info" | "warn" | "error" | "debug";

export type ConsoleLogEntry = {
  level: ConsoleLogLevel;
  text: string;
  url?: string;
  lineNumber?: number;
  timestamp: number;
};

export type NetworkRequestEntry = {
  requestId: string;
  url: string;
  method: string;
  statusCode?: number;
  statusText?: string;
  mimeType?: string;
  failed: boolean;
  errorText?: string;
  timestamp: number;
};

export type WebSocketFrameEntry = {
  requestId: string;
  url?: string;
  direction: "sent" | "received" | "opened" | "closed";
  opcode?: number;
  payload: string;
  timestamp: number;
};

export type EventSourceMessageEntry = {
  requestId: string;
  url: string;
  eventName: string;
  eventId: string;
  data: string;
  timestamp: number;
};

export type TabLogSnapshot = {
  tabId: TabId;
  consoleLogs: ConsoleLogEntry[];
  networkRequests: NetworkRequestEntry[];
  webSocketFrames: WebSocketFrameEntry[];
  eventSourceEvents: EventSourceMessageEntry[];
  jsErrors: string[];
  capturedAt: number;
};

export type MediaKind = "video" | "audio";

export type MediaReadyState =
  | "have_nothing"
  | "have_metadata"
  | "have_current_data"
  | "have_future_data"
  | "have_enough_data";

export type ObservedMedia = {
  id: string;
  kind: MediaKind;
  src?: string;
  title?: string;
  paused: boolean;
  muted: boolean;
  volume: number;
  currentTime: number;
  duration: number;
  loop: boolean;
  readyState: MediaReadyState;
  selectorHint: string;
};

export type FieldType =
  | "text"
  | "email"
  | "password"
  | "tel"
  | "url"
  | "search"
  | "textarea"
  | "select"
  | "checkbox"
  | "radio"
  | "date"
  | "number"
  | "address-line1";

export type FormPurpose = "signup" | "login" | "auth" | "profile" | "verification" | "generic";

export type ObservedField = {
  id: string;
  label: string;
  name?: string;
  fieldType: FieldType;
  autocomplete?: string;
  placeholder?: string;
  required: boolean;
  selectorHint: string;
};

export type ObservedAction = {
  id: string;
  label: string;
  kind: "button" | "submit" | "link" | "oauth";
  selectorHint: string;
  href?: string;
  provider?: string;
  disabled: boolean;
};

export type ObservedForm = {
  id: string;
  name?: string;
  purpose: FormPurpose;
  selectorHint: string;
  fields: ObservedField[];
  submitActions: ObservedAction[];
};

export type PageObservation = {
  tabId: TabId;
  url: string;
  title: string;
  timestamp: number;
  pageKind: PageKind;
  headings: string[];
  forms: ObservedForm[];
  primaryActions: ObservedAction[];
  alerts: string[];
  media: ObservedMedia[];
};

export type AccessibilitySummary = {
  nodeCount: number;
  roleCounts: Record<string, number>;
  headingTrail: string[];
  interactiveNodes: Array<{
    role: string;
    name?: string;
  }>;
};

export type PageGraph = {
  tabId: TabId;
  url: string;
  title: string;
  kind: PageKind;
  topHeading?: string;
  headings: string[];
  forms: ObservedForm[];
  actions: ObservedAction[];
  alerts: string[];
  media: ObservedMedia[];
  oauthProviders: string[];
  accessibility: AccessibilitySummary;
  signals: {
    documentCount: number;
    accessibilityNodeCount: number;
    formCount: number;
    actionCount: number;
    capturedAt: number;
  };
};

export type PerceptionResult = {
  snapshot: import("./browser.js").PageSnapshot;
  observation: PageObservation | null;
  graph: PageGraph;
};
