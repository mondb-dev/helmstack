import type { WebContents } from "electron";

import { AccountStore } from "./account-store.js";
import { ApprovalPolicyStore } from "./approval-policy-store.js";
import { executeBrowserAction as runBrowserAction, executeDomTool, waitForPageSettled } from "./dom-actuator.js";
import { ApprovalStore } from "./approval-store.js";
import { HandoffStore } from "./handoff-store.js";
import { VaultStore } from "./vault-store.js";
import type {
  AccountRef,
  BrowserAction,
  BrowserCommandResult,
  BrowserOutputCommand,
  BrowserPerceptionPacket,
  HumanHandoffRecord,
  ObservedAction,
  ObservedField,
  ObservedForm,
  PageObservation,
  PerceptionResult,
  ProposedEffect,
  SiteCapabilityManifest,
  SiteToolDescriptor,
  TabId,
  ToolParameterSchema,
  WebMcpActionMode,
  WebMcpAvailability,
  WebMcpManifest,
  WebMcpToolDescriptor
} from "../../../../packages/shared/src/index.js";

type WebMcpHeuristicProbe = {
  hasNavigatorWebMcp: boolean;
  hasWindowWebMcp: boolean;
  manifestScriptCount: number;
  metaHintCount: number;
};

type HandoffListener = (handoff: HumanHandoffRecord) => void;

export class SiteCapabilityRegistry {
  private readonly handoffListeners = new Set<HandoffListener>();

  constructor(
    private readonly vault: VaultStore,
    private readonly accounts: AccountStore,
    private readonly approvals: ApprovalStore,
    private readonly handoffs: HandoffStore,
    private readonly policies: ApprovalPolicyStore
  ) {}

  onHandoffRequested(listener: HandoffListener) {
    this.handoffListeners.add(listener);
  }

  /**
   * Combined value resolver: handles both vault refs (`{ kind: "vault" }`)
   * and account refs (`{ kind: "account" }`).
   */
  private resolveValue(value: unknown): unknown {
    if (isAccountRef(value)) {
      return this.accounts.resolveRef(value);
    }
    return this.vault.resolveValue(value);
  }

  async buildPerceptionPacket(tabId: TabId, observation: PageObservation | null, result: PerceptionResult, webContents: WebContents) {
    return {
      tabId,
      emittedAt: Date.now(),
      observation,
      result,
      siteCapabilities: await this.listCapabilityManifests(tabId, result, webContents)
    } satisfies BrowserPerceptionPacket;
  }

  async listCapabilityManifests(tabId: TabId, result: PerceptionResult, webContents: WebContents): Promise<SiteCapabilityManifest[]> {
    const [domManifest, webMcpManifest] = await Promise.all([
      Promise.resolve(this.buildDomManifest(tabId, result)),
      this.buildWebMcpManifest(tabId, result, webContents)
    ]);

    return [domManifest, webMcpManifest];
  }

  async executeCommand(
    tabId: TabId,
    command: BrowserOutputCommand,
    observation: PageObservation | null,
    result: PerceptionResult,
    webContents: WebContents,
    options: { skipApproval?: boolean } = {}
  ): Promise<BrowserCommandResult> {
    if (!options.skipApproval) {
      const approval = this.maybeQueueApproval(tabId, command, result);
      if (approval) {
        return approval;
      }
    }

    switch (command.type) {
      case "navigate":
        await webContents.loadURL(command.url);
        return {
          status: "completed",
          command
        };
      case "request_perception_refresh":
        return {
          status: "completed",
          command,
          observation,
          graph: result.graph
        };
      case "invoke_site_tool":
        return this.executeSiteTool(webContents, command, result);
      case "click":
      case "type":
      case "select":
      case "submit":
        return this.executeBrowserAction(webContents, command);
      case "await_human":
        return this.createHandoff(tabId, command);
    }

    const exhaustiveCheck: never = command;
    return {
      status: "failed",
      command: exhaustiveCheck,
      reason: "Unsupported browser substrate command.",
      retryable: false
    };
  }

  async approveCommand(
    requestId: string,
    observation: PageObservation | null,
    result: PerceptionResult,
    webContents: WebContents
  ): Promise<BrowserCommandResult> {
    const pending = this.approvals.take(requestId);
    if (!pending) {
      return {
        status: "failed",
        command: {
          type: "request_perception_refresh",
          tabId: result.graph.tabId
        },
        reason: `Approval request ${requestId} was not found.`,
        retryable: false
      };
    }

    return this.executeCommand(pending.tabId, pending.command, observation, result, webContents, { skipApproval: true });
  }

  rejectCommand(requestId: string): BrowserCommandResult {
    const pending = this.approvals.reject(requestId);
    const command =
      pending?.command ??
      ({
        type: "request_perception_refresh",
        tabId: "unknown"
      } as BrowserOutputCommand);

    return {
      status: "blocked",
      command,
      reason: pending ? `Approval rejected: ${pending.summary}` : `Approval request ${requestId} was not found.`
    };
  }

  listHandoffs(): HumanHandoffRecord[] {
    return this.handoffs.list();
  }

  resolveHandoff(requestId: string): BrowserCommandResult {
    const record = this.handoffs.take(requestId);
    const command: BrowserOutputCommand = { type: "request_perception_refresh", tabId: record?.tabId ?? "unknown" };
    if (!record) {
      return { status: "failed", command, reason: `Handoff ${requestId} was not found.`, retryable: false };
    }
    return { status: "completed", command };
  }

  cancelHandoff(requestId: string): BrowserCommandResult {
    const record = this.handoffs.take(requestId);
    const command: BrowserOutputCommand = { type: "request_perception_refresh", tabId: record?.tabId ?? "unknown" };
    return { status: "blocked", command, reason: record ? `Human handoff cancelled (${record.reason}).` : `Handoff ${requestId} was not found.` };
  }

  private createHandoff(tabId: TabId, command: Extract<BrowserOutputCommand, { type: "await_human" }>): BrowserCommandResult {
    const record = this.handoffs.create(tabId, command.reason);
    for (const listener of this.handoffListeners) {
      listener(record);
    }
    return { status: "awaiting_human", command, requestId: record.requestId, reason: command.reason };
  }

  private buildDomManifest(tabId: TabId, result: PerceptionResult): SiteCapabilityManifest {
    const { graph } = result;
    const tools: SiteToolDescriptor[] = [
      {
        provider: "dom",
        name: "dom.read_page_state",
        title: "Read current page state",
        description: "Return the current semantic page graph derived from DOM and accessibility data.",
        parameters: {
          type: "object",
          properties: {}
        },
        returns: {
          description: "A semantic graph of forms, actions, alerts, and accessibility signals."
        }
      },
      ...graph.actions.map((action) => this.buildActionTool(action)),
      ...graph.forms.flatMap((form) => this.buildFormTools(form))
    ];

    return {
      tabId,
      origin: originFromUrl(graph.url),
      provider: "dom",
      isAvailable: true,
      discoveredAt: Date.now(),
      tools,
      notes: [
        "Generated from the browser-owned DOM and accessibility perception layer.",
        "These tools are grounded to the current page state and may change after navigation or mutation."
      ]
    };
  }

  private async buildWebMcpManifest(tabId: TabId, result: PerceptionResult, webContents: WebContents): Promise<WebMcpManifest> {
    const probe = await this.probeWebMcp(webContents);
    const hasSignals = probe.hasNavigatorWebMcp || probe.hasWindowWebMcp || probe.manifestScriptCount > 0 || probe.metaHintCount > 0;

    if (!hasSignals) {
      return {
        tabId,
        origin: originFromUrl(result.graph.url),
        provider: "webmcp",
        isAvailable: false,
        availability: "not_exposed",
        discoveredAt: Date.now(),
        tools: [],
        notes: [
          "No WebMCP exposure signals were detected on this page.",
          "The browser is ready to host a WebMCP adapter when site detection and invocation are implemented."
        ]
      };
    }

    const tools = await this.extractWebMcpTools(webContents);
    const availability: WebMcpAvailability = tools.length > 0 ? "ready" : "unknown";

    return {
      tabId,
      origin: originFromUrl(result.graph.url),
      provider: "webmcp",
      isAvailable: availability === "ready",
      availability,
      discoveredAt: Date.now(),
      tools,
      notes:
        tools.length > 0
          ? [`${tools.length} WebMCP tool${tools.length !== 1 ? "s" : ""} discovered on this page.`]
          : [
              "WebMCP signals were detected but no tools could be enumerated.",
              "The site may require interaction before exposing its tool manifest."
            ]
    };
  }

  private async extractWebMcpTools(webContents: WebContents): Promise<WebMcpToolDescriptor[]> {
    try {
      const raw: unknown = await webContents.executeJavaScript(
        `(async () => {
          if (typeof navigator !== "undefined" && navigator.webMcp) {
            if (Array.isArray(navigator.webMcp.tools)) return navigator.webMcp.tools;
            if (typeof navigator.webMcp.getManifest === "function") {
              const m = await navigator.webMcp.getManifest();
              if (Array.isArray(m?.tools)) return m.tools;
            }
            if (typeof navigator.webMcp.listTools === "function") {
              const t = await navigator.webMcp.listTools();
              if (Array.isArray(t)) return t;
            }
          }
          const webMcp = (typeof window !== "undefined") && (window.WebMCP || window.__WEB_MCP__);
          if (webMcp) {
            if (Array.isArray(webMcp.tools)) return webMcp.tools;
            if (typeof webMcp.getManifest === "function") {
              const m = await webMcp.getManifest();
              if (Array.isArray(m?.tools)) return m.tools;
            }
          }
          const scriptEl = document.querySelector('script[type="application/webmcp+json"]');
          if (scriptEl) {
            const manifest = JSON.parse(scriptEl.textContent || "{}");
            if (Array.isArray(manifest.tools)) return manifest.tools;
          }
          return [];
        })()`,
        true
      );
      return this.normalizeWebMcpTools(raw);
    } catch {
      return [];
    }
  }

  private normalizeWebMcpTools(raw: unknown): WebMcpToolDescriptor[] {
    if (!Array.isArray(raw)) return [];

    return raw.flatMap((item: unknown): WebMcpToolDescriptor[] => {
      if (!item || typeof item !== "object" || !("name" in item)) return [];

      const tool = item as Record<string, unknown>;
      const rawParams =
        tool.parameters && typeof tool.parameters === "object" ? (tool.parameters as Record<string, unknown>) : null;
      const rawProps =
        rawParams?.properties && typeof rawParams.properties === "object"
          ? (rawParams.properties as Record<string, unknown>)
          : {};

      const properties: ToolParameterSchema["properties"] = {};
      for (const [key, val] of Object.entries(rawProps)) {
        if (val && typeof val === "object") {
          const prop = val as Record<string, unknown>;
          const propType = String(prop.type || "string");
          properties[key] = {
            type: (["string", "number", "boolean", "object", "array"].includes(propType)
              ? propType
              : "string") as ToolParameterSchema["properties"][string]["type"],
            ...(prop.description ? { description: String(prop.description) } : {}),
            ...(Array.isArray(prop.enum) ? { enum: prop.enum.map(String) } : {})
          };
        }
      }

      const required = Array.isArray(rawParams?.required) ? (rawParams.required as unknown[]).map(String) : undefined;
      const mode: WebMcpActionMode = tool.mode === "imperative" ? "imperative" : "declarative";
      const invocationHint = tool.invocationHint ?? tool.endpoint;

      return [
        {
          provider: "webmcp",
          name: String(tool.name),
          title: String(tool.title ?? tool.name),
          description: String(tool.description ?? ""),
          parameters: { type: "object", properties, ...(required ? { required } : {}) },
          mode,
          ...(invocationHint ? { invocationHint: String(invocationHint) } : {})
        }
      ];
    });
  }

  private async invokeWebMcpTool(webContents: WebContents, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const nameJson = JSON.stringify(toolName);
    const argsJson = JSON.stringify(args);

    return webContents.executeJavaScript(
      `(async () => {
        const name = ${nameJson};
        const args = ${argsJson};

        if (typeof navigator !== "undefined" && navigator.webMcp) {
          if (typeof navigator.webMcp.invoke === "function") return await navigator.webMcp.invoke(name, args);
          if (typeof navigator.webMcp.call === "function") return await navigator.webMcp.call(name, args);
          if (typeof navigator.webMcp.run === "function") return await navigator.webMcp.run(name, args);
        }

        const webMcp = (typeof window !== "undefined") && (window.WebMCP || window.__WEB_MCP__);
        if (webMcp) {
          if (typeof webMcp.invoke === "function") return await webMcp.invoke(name, args);
          if (typeof webMcp.call === "function") return await webMcp.call(name, args);
        }

        const scriptEl = document.querySelector('script[type="application/webmcp+json"]');
        if (scriptEl) {
          const manifest = JSON.parse(scriptEl.textContent || "{}");
          const tool = (manifest.tools || []).find((t) => t.name === name);
          if (tool && tool.endpoint) {
            const res = await fetch(tool.endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(args)
            });
            if (!res.ok) throw new Error("WebMCP endpoint returned " + res.status + " " + res.statusText);
            const ct = res.headers.get("content-type") || "";
            return ct.includes("application/json") ? await res.json() : await res.text();
          }
        }

        throw new Error("No WebMCP invocation method available for tool: " + name);
      })()`,
      true
    );
  }

  private async probeWebMcp(webContents: WebContents): Promise<WebMcpHeuristicProbe> {
    try {
      return await webContents.executeJavaScript(
        `(() => ({
          hasNavigatorWebMcp: typeof navigator !== "undefined" && "webMcp" in navigator,
          hasWindowWebMcp: typeof window !== "undefined" && ("WebMCP" in window || "__WEB_MCP__" in window),
          manifestScriptCount: document.querySelectorAll('script[type="application/webmcp+json"]').length,
          metaHintCount: document.querySelectorAll('meta[name="webmcp"], meta[name="web-mcp"]').length
        }))()`,
        true
      );
    } catch {
      return {
        hasNavigatorWebMcp: false,
        hasWindowWebMcp: false,
        manifestScriptCount: 0,
        metaHintCount: 0
      };
    }
  }

  private buildActionTool(action: ObservedAction): SiteToolDescriptor {
    return {
      provider: "dom",
      name: `dom.activate.${action.id}`,
      title: `Activate ${action.label}`,
      description: `Trigger the currently observed ${action.kind} action labeled "${action.label}".`,
      parameters: {
        type: "object",
        properties: {}
      },
      requiresApproval: action.kind === "oauth"
    };
  }

  private buildFormTools(form: ObservedForm): SiteToolDescriptor[] {
    return [
      {
        provider: "dom",
        name: `dom.fill.${form.id}`,
        title: `Fill ${form.name || form.purpose} form`,
        description: `Fill the observed ${form.purpose} form with field values grounded to the current page.`,
        parameters: {
          type: "object",
          properties: Object.fromEntries(form.fields.map((field) => [field.id, this.buildFieldSchema(field)])),
          required: form.fields.filter((field) => field.required).map((field) => field.id)
        }
      },
      {
        provider: "dom",
        name: `dom.submit.${form.id}`,
        title: `Submit ${form.name || form.purpose} form`,
        description: `Submit the currently observed ${form.purpose} form after it has been filled.`,
        parameters: {
          type: "object",
          properties: {}
        },
        requiresApproval: form.purpose === "signup"
      }
    ];
  }

  private buildFieldSchema(field: ObservedField) {
    return {
      type: field.fieldType === "checkbox" ? "boolean" : "string",
      description: `${field.label}${field.required ? " (required)" : ""}`
    } as const;
  }

  private async executeSiteTool(
    webContents: WebContents,
    command: Extract<BrowserOutputCommand, { type: "invoke_site_tool" }>,
    result: PerceptionResult
  ): Promise<BrowserCommandResult> {
    if (command.provider === "dom" && command.toolName === "dom.read_page_state") {
      return {
        status: "completed",
        command,
        graph: result.graph
      };
    }

    if (command.provider === "dom") {
      const execution = await withDomRetry(
        () => executeDomTool(webContents, command, result.graph.forms, result.graph.actions, (value) => this.resolveValue(value)),
        webContents
      );
      return {
        status: "completed",
        command,
        effects: execution.effects
      };
    }

    if (command.provider === "webmcp") {
      try {
        const invocationResult = await this.invokeWebMcpTool(webContents, command.toolName, command.args ?? {});
        return {
          status: "completed",
          command,
          ...(invocationResult !== undefined ? { result: invocationResult } : {})
        };
      } catch (error) {
        return {
          status: "failed",
          command,
          reason: error instanceof Error ? error.message : "WebMCP invocation failed.",
          retryable: true
        };
      }
    }

    return {
      status: "failed",
      command,
      reason: `Site tool ${command.toolName} is not executable yet. DOM-grounded actuation will be wired in the executor layer.`,
      retryable: false
    };
  }

  private async executeBrowserAction(webContents: WebContents, command: BrowserAction): Promise<BrowserCommandResult> {
    await withDomRetry(() => runBrowserAction(webContents, command, (value) => this.vault.resolveValue(value)), webContents);
    return {
      status: "completed",
      command
    };
  }

  private maybeQueueApproval(tabId: TabId, command: BrowserOutputCommand, result: PerceptionResult): BrowserCommandResult | null {
    const effects = this.collectEffectsForCommand(command, result);
    if (effects.length === 0) {
      return null;
    }

    const decisions = effects.map((effect) => this.policies.getDecision(effect.type));
    if (decisions.includes("block")) {
      return {
        status: "blocked",
        command,
        reason: `Blocked by approval policy: ${summarizeEffects(effects)}`
      };
    }

    if (decisions.every((decision) => decision === "auto")) {
      return null;
    }

    const summary = summarizeEffects(effects);
    const pending = this.approvals.create(tabId, command, effects, summary);
    return {
      status: "awaiting_approval",
      command,
      requestId: pending.requestId,
      summary,
      effects
    };
  }

  private collectEffectsForCommand(command: BrowserOutputCommand, result: PerceptionResult): ProposedEffect[] {
    if (command.type === "submit") {
      return [{ type: "share_personal_data", fields: ["form submission"] }];
    }

    if (command.type !== "invoke_site_tool" || command.provider !== "dom") {
      return [];
    }

    if (command.toolName.startsWith("dom.submit.")) {
      const formId = command.toolName.slice("dom.submit.".length);
      const form = result.graph.forms.find((entry) => entry.id === formId);
      if (!form) {
        return [{ type: "share_personal_data", fields: ["form submission"] }];
      }

      const sensitiveFields = form.fields
        .filter((field) => ["email", "tel", "address-line1", "password", "date"].includes(field.fieldType))
        .map((field) => field.label);

      return [
        {
          type: "share_personal_data",
          fields: sensitiveFields.length > 0 ? sensitiveFields : form.fields.map((field) => field.label)
        }
      ];
    }

    return [];
  }
}

// ── DOM retry helper ─────────────────────────────────────────────────────────

const RETRYABLE_DOM_PATTERNS = [
  "could not be resolved on the live page",
  "Unable to resolve backend node",
  "Resolved backend node is not"
] as const;

async function withDomRetry<T>(fn: () => Promise<T>, webContents: WebContents, maxAttempts = 3): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const retryable = RETRYABLE_DOM_PATTERNS.some((pattern) => message.includes(pattern));

      if (!retryable || attempt === maxAttempts - 1) {
        throw error;
      }

      // Wait for the page to settle (navigation / SPA re-render) then back off.
      await waitForPageSettled(webContents, 1500);
      await delay(300 * 2 ** attempt);
    }
  }

  throw lastError;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ── Utilities ────────────────────────────────────────────────────────────────

function summarizeEffects(effects: ProposedEffect[]) {
  return effects
    .map((effect) => {
      switch (effect.type) {
        case "create_account":
          return `Create account: ${effect.label}`;
        case "share_personal_data":
          return `Share personal data: ${effect.fields.join(", ")}`;
        case "accept_legal_terms":
          return `Accept legal terms from ${effect.provider}`;
        case "submit_payment":
          return `Submit payment${effect.amount ? ` ${effect.amount}` : ""}${effect.currency ? ` ${effect.currency}` : ""}`;
      }
    })
    .join(" • ");
}

function originFromUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}

function isAccountRef(value: unknown): value is AccountRef {
  return Boolean(value && typeof value === "object" && "kind" in value && "accountId" in value && value.kind === "account");
}
