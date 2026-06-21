import type { TabId } from "./browser.js";

export type PageKind =
  | "landing"
  | "signup"
  | "login"
  | "checkout"
  | "form"
  | "dashboard"
  | "social-feed"
  | "social-profile"
  | "social-thread"
  | "social-compose"
  | "social-search"
  | "social-messages"
  | "social-notifications";

// ── Dev-tool observation types ────────────────────────────────────────────────

export type ConsoleLogLevel = "log" | "info" | "warn" | "error" | "debug";

export type ConsoleLogEntry = {
  level: ConsoleLogLevel;
  text: string;
  url?: string;
  lineNumber?: number;
  timestamp: number;
};

export type NetworkSecurityDetails = {
  /** TLS protocol version, e.g. "TLS 1.3". */
  protocol: string;
  /** Key exchange algorithm, e.g. "ECDHE_RSA". Empty string when not applicable. */
  keyExchange: string;
  /** Cipher suite, e.g. "AES_128_GCM". */
  cipher: string;
  /** Certificate subject CN / SAN primary name. */
  subjectName: string;
  /** Certificate issuer organisation. */
  issuer: string;
  /** Certificate valid-from (Unix seconds). */
  validFrom: number;
  /** Certificate valid-to (Unix seconds). */
  validTo: number;
  /** SANs listed on the certificate. */
  sanList: string[];
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
  /** Outgoing request headers. */
  requestHeaders?: Record<string, string>;
  /** Response headers (Cache-Control, CSP, HSTS, X-Frame-Options, etc.). */
  responseHeaders?: Record<string, string>;
  /** TLS / SSL details when the connection used HTTPS. */
  securityDetails?: NetworkSecurityDetails;
  /** True when the response was served from the browser disk cache. */
  fromDiskCache?: boolean;
  /** True when the response was served by a Service Worker. */
  fromServiceWorker?: boolean;
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

// ── HAR export (HTTP Archive 1.2) ──────────────────────────────────────────────

export type HarNameValue = { name: string; value: string };

export type HarEntry = {
  startedDateTime: string;
  /** Total elapsed time in ms, or -1 when unknown. */
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: HarNameValue[];
    queryString: HarNameValue[];
    cookies: HarNameValue[];
    headersSize: number;
    bodySize: number;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: HarNameValue[];
    cookies: HarNameValue[];
    content: { size: number; mimeType: string };
    redirectURL: string;
    headersSize: number;
    bodySize: number;
    /** Non-standard: populated when the request failed. */
    _error?: string;
  };
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
  _fromDiskCache?: boolean;
  _fromServiceWorker?: boolean;
};

/** A HAR 1.2 archive — importable into Chrome DevTools, Charles, Insomnia, etc. */
export type HarArchive = {
  log: {
    version: "1.2";
    creator: { name: string; version: string };
    pages: Array<{
      startedDateTime: string;
      id: string;
      title: string;
      pageTimings: { onContentLoad: number; onLoad: number };
    }>;
    entries: HarEntry[];
  };
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

export type SocialPlatformKind =
  | "x"
  | "facebook"
  | "instagram"
  | "linkedin"
  | "tiktok"
  | "reddit"
  | "youtube"
  | "threads"
  | "bluesky"
  | "mastodon"
  | "generic";

export type SocialSurfaceKind =
  | "feed"
  | "profile"
  | "thread"
  | "composer"
  | "search"
  | "messages"
  | "notifications"
  | "unknown";

export type SocialActionKind =
  | "like"
  | "react"
  | "comment"
  | "reply"
  | "share"
  | "repost"
  | "bookmark"
  | "follow"
  | "message"
  | "open_profile"
  | "navigate"
  | "search"
  | "submit_post";

export type ObservedSocialAction = {
  id: string;
  label: string;
  kind: SocialActionKind;
  selectorHint: string;
  href?: string;
  disabled: boolean;
  count?: number;
  targetPostId?: string;
};

export type ObservedSocialPost = {
  id: string;
  author?: string;
  handle?: string;
  text: string;
  timestamp?: string;
  href?: string;
  selectorHint: string;
  media: ObservedMedia[];
  actions: ObservedSocialAction[];
};

export type ObservedSocialComposer = {
  id: string;
  purpose: "post" | "reply" | "comment" | "message";
  label?: string;
  placeholder?: string;
  selectorHint: string;
  textEntrySelectorHint: string;
  submitActions: ObservedSocialAction[];
  hasAttachedMedia: boolean;
};

export type ObservedSocialNavigationItem = {
  id: string;
  label: string;
  destination: "home" | "search" | "notifications" | "messages" | "profile" | "bookmarks" | "settings" | "create" | "unknown";
  selectorHint: string;
  href?: string;
};

export type SocialSurface = {
  platform: SocialPlatformKind;
  kind: SocialSurfaceKind;
  posts: ObservedSocialPost[];
  composers: ObservedSocialComposer[];
  navigation: ObservedSocialNavigationItem[];
  actions: ObservedSocialAction[];
  signals: {
    postCount: number;
    composerCount: number;
    navigationItemCount: number;
    actionCount: number;
  };
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
  social?: SocialSurface;
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
  social?: SocialSurface;
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
