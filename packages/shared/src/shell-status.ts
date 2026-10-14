/**
 * What the desktop shell shows the human about agent activity: overrides an
 * agent applied to a tab, the agent API connection, and a feed of agent calls.
 */
import type { LocationOverride, MediaEmulation, ResourceBudget, TabId } from "./browser.js";

/** A viewport override set via the agent API (`setEmulatedViewport`). */
export type ViewportOverride = { width: number; height: number; mobile: boolean };

/** Override kinds the shell can show as chips and clear individually. */
export type TabOverrideKind = "viewport" | "media" | "resourceBudget" | "location" | "networkMock" | "recording" | "watches";

/**
 * Every agent-applied state on a tab that makes the page look or behave
 * differently from a plain visit. `null` / zero means not active.
 */
export type TabOverrides = {
  tabId: TabId;
  viewport: ViewportOverride | null;
  media: MediaEmulation | null;
  resourceBudget: ResourceBudget | null;
  location: LocationOverride | null;
  networkMockRuleCount: number;
  recording: boolean;
  watches: { total: number; passing: number; failing: number };
};

/** One agent API call, recorded by the agent server as it is handled. */
export type AgentActivityEntry = {
  id: string;
  /** Epoch ms when the request arrived. */
  at: number;
  durationMs: number;
  /** HTTP method and route pattern, e.g. "POST /api/tabs/:id/a11y". */
  method: string;
  route: string;
  /** Short human label, e.g. "Accessibility audit". */
  label: string;
  tabId?: TabId;
  /** Value of the agent id header, when the agent sent one. */
  agentId?: string;
  status: number;
  ok: boolean;
  /** One-line result summary when the route has one, e.g. "4 issues". */
  summary?: string;
};

export type AgentProfile = "fe-dev" | "agent-substrate" | "full";

/** State of the local agent API, for the shell's connection indicator. */
export type AgentConnectionStatus = {
  listening: boolean;
  port: number | null;
  /** Why the server isn't listening, e.g. the port is taken. */
  error?: string;
  /** Open SSE streams. */
  sseClients: number;
  /** Distinct agent ids seen on recent requests. */
  agentIds: string[];
  /** Where local agents read the auth token from, if file-based. */
  tokenPath: string | null;
  /** SSE clients subscribed to `intent_changed`; the intent box is hidden when 0. */
  intentListeners: number;
  profile: AgentProfile;
};
