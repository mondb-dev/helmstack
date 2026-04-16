import type { SiteCapabilityManifest, SiteToolDescriptor } from "./substrate.js";

export type WebMcpAvailability = "ready" | "unsupported" | "not_exposed" | "unknown" | "invalid";

export type WebMcpActionMode = "declarative" | "imperative";

export type WebMcpValidationIssue = {
  path: string;
  message: string;
  severity: "error" | "warning";
};

export type WebMcpToolDescriptor = SiteToolDescriptor & {
  provider: "webmcp";
  mode: WebMcpActionMode;
  invocationHint?: string;
};

export type WebMcpManifest = SiteCapabilityManifest & {
  provider: "webmcp";
  availability: WebMcpAvailability;
  tools: WebMcpToolDescriptor[];
  version?: string;
  validationIssues: WebMcpValidationIssue[];
};
