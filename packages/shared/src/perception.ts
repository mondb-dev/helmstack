import type { TabId } from "./browser.js";

export type PageKind = "landing" | "signup" | "login" | "checkout" | "form" | "dashboard";

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
