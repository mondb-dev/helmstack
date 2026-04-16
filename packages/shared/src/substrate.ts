import type { BrowserAction, ProposedEffect } from "./ai.js";
import type { TabId } from "./browser.js";
import type { PageGraph, PageObservation, PerceptionResult } from "./perception.js";

export type SiteCapabilityProviderKind = "dom" | "webmcp";

export type AgentRuntimeKind =
  | "openai-responses"
  | "anthropic"
  | "langgraph"
  | "autogen"
  | "mcp-client"
  | "custom";

export type ToolParameterSchema = {
  type: "object";
  properties: Record<
    string,
    {
      type: "string" | "number" | "boolean" | "object" | "array";
      description?: string;
      enum?: string[];
    }
  >;
  required?: string[];
};

export type SiteToolDescriptor = {
  provider: SiteCapabilityProviderKind;
  name: string;
  title: string;
  description: string;
  parameters: ToolParameterSchema;
  returns?: {
    description: string;
  };
  requiresApproval?: boolean;
};

export type NetworkInterceptRule = {
  /** URL pattern. Use * as wildcard, or wrap in /regex/flags for regular expressions. */
  urlPattern: string;
  /** HTTP method to match (e.g. "GET", "POST"). Omit to match any method. */
  method?: string;
  /** HTTP response status code. Defaults to 200. */
  responseStatus?: number;
  /** Response headers to return. */
  responseHeaders?: Record<string, string>;
  /** Response body. Objects are JSON-serialized automatically. */
  responseBody?: unknown;
};

export type SiteCapabilityManifest = {
  tabId: TabId;
  origin: string;
  provider: SiteCapabilityProviderKind;
  isAvailable: boolean;
  preferred?: boolean;
  discoveredAt: number;
  tools: SiteToolDescriptor[];
  notes: string[];
  validationNotes?: string[];
};

export type BrowserPerceptionPacket = {
  tabId: TabId;
  emittedAt: number;
  observation: PageObservation | null;
  result: PerceptionResult;
  siteCapabilities: SiteCapabilityManifest[];
  preferredProvider?: SiteCapabilityProviderKind;
  sitePatterns?: string[];
  intent?: string;
};

export type PendingApproval = {
  requestId: string;
  tabId: TabId;
  command: BrowserOutputCommand;
  effects: ProposedEffect[];
  summary: string;
  createdAt: number;
};

export type SiteToolInvocation = {
  type: "invoke_site_tool";
  provider: SiteCapabilityProviderKind;
  toolName: string;
  args: Record<string, unknown>;
};

export type BrowserOutputCommand =
  | BrowserAction
  | SiteToolInvocation
  | {
      type: "request_perception_refresh";
      tabId: TabId;
      includeSnapshot?: boolean;
    };

export type HumanHandoffRecord = {
  requestId: string;
  tabId: TabId;
  relatedTabIds: TabId[];
  reason: "captcha" | "2fa" | "payment" | "legal";
  groupId?: string;
  origin?: string;
  title?: string;
  createdAt: number;
};

export type BrowserCommandResult =
  | {
      status: "completed";
      command: BrowserOutputCommand;
      observation?: PageObservation | null;
      graph?: PageGraph;
      effects?: ProposedEffect[];
      /** Arbitrary tool output, e.g. from a WebMCP invocation. */
      result?: unknown;
    }
  | {
      status: "awaiting_approval";
      command: BrowserOutputCommand;
      requestId: string;
      summary: string;
      effects: ProposedEffect[];
    }
  | {
      /** Agent must pause until the human signals they are done. */
      status: "awaiting_human";
      command: BrowserOutputCommand;
      requestId: string;
      reason: "captcha" | "2fa" | "payment" | "legal";
    }
  | {
      status: "blocked";
      command: BrowserOutputCommand;
      reason: string;
    }
  | {
      status: "failed";
      command: BrowserOutputCommand;
      reason: string;
      retryable: boolean;
    };

export type AgentTurnRequest = {
  sessionId: string;
  runtime: AgentRuntimeKind;
  intent: string;
  packet: BrowserPerceptionPacket;
  memory?: {
    completedSteps: string[];
    sitePatterns: string[];
  };
};

export type AgentTurnResponse = {
  reasoningSummary: string;
  commands: BrowserOutputCommand[];
  expectedEffects: ProposedEffect[];
  requiresHumanReview: boolean;
};

export type CognitiveRuntimeAdapter = {
  id: string;
  kind: AgentRuntimeKind;
  name: string;
  supportsStreaming: boolean;
  supportsToolUse: boolean;
  supportsMultimodalInput: boolean;
};

export type BrowserSubstrateApi = {
  getPerceptionPacket(tabId: TabId): Promise<BrowserPerceptionPacket>;
  executeCommand(tabId: TabId, command: BrowserOutputCommand): Promise<BrowserCommandResult>;
  listCapabilityManifests(tabId: TabId): Promise<SiteCapabilityManifest[]>;
};
