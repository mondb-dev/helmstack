import { ApprovalPolicyStore } from "../stores/approval-policy-store.js";
import {
  collectFormFillEffects,
  executeBrowserAction as runBrowserAction,
  executeDomTool,
  isPersonalField,
  isPersonalInputAttributes,
  isSecretRefValue,
  waitForPageSettled
} from "../cdp/dom-actuator.js";
import { ApprovalGrantStore } from "../stores/approval-grant-store.js";
import { ApprovalStore, PAGE_CHANGED_REASON, isSameApprovalPage } from "../stores/approval-store.js";
import { HandoffStore } from "../stores/handoff-store.js";
import type { PageHandle, SecretResolver } from "./types.js";
import type {
  BrowserAction,
  BrowserCommandResult,
  BrowserOutputCommand,
  BrowserPerceptionPacket,
  HumanHandoffRecord,
  NodeRef,
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
  WebMcpValidationIssue,
  WebMcpToolDescriptor
} from "../../../../shared/src/index.js";

type WebMcpHeuristicProbe = {
  hasNavigatorWebMcp: boolean;
  hasWindowWebMcp: boolean;
  manifestScriptCount: number;
  metaHintCount: number;
};

type HandoffListener = (handoff: HumanHandoffRecord) => void;

/**
 * What a command would do, decided before it runs. `formId` is set when the
 * command can be tied to an observed form (used for fill → submit grants).
 */
type ApprovalPlan = {
  kind: "fill" | "submit" | "other";
  effects: ProposedEffect[];
  formId?: string;
};

const PERSONAL_SUBMIT_FIELD_TYPES = ["email", "tel", "address-line1", "password", "date"];

export class SiteCapabilityRegistry {
  private readonly handoffListeners = new Set<HandoffListener>();

  constructor(
    private readonly secrets: SecretResolver,
    private readonly approvals: ApprovalStore,
    private readonly handoffs: HandoffStore,
    private readonly policies: ApprovalPolicyStore,
    private readonly getHandoffContext: (tabId: TabId) => Pick<HumanHandoffRecord, "relatedTabIds" | "groupId" | "origin" | "title">,
    private readonly grants: ApprovalGrantStore = new ApprovalGrantStore()
  ) {}

  /** Void fill → submit grants for a tab (call on main-frame navigation and close). */
  clearApprovalGrants(tabId: TabId) {
    this.grants.clearTab(tabId);
  }

  onHandoffRequested(listener: HandoffListener) {
    this.handoffListeners.add(listener);
  }

  /**
   * Unwraps `{ kind: "literal" }` values here so every backend agrees on them
   * (a passthrough resolver would otherwise hand the wrapper to the actuator);
   * secret refs go to the injected resolver.
   */
  private resolveValue(value: unknown): unknown {
    return isLiteralValue(value) ? value.value : this.secrets.resolveValue(value);
  }

  async buildPerceptionPacket(tabId: TabId, observation: PageObservation | null, result: PerceptionResult, page: PageHandle) {
    const manifests = await this.listCapabilityManifests(tabId, result, page);
    const preferred = manifests.find((manifest) => manifest.preferred)?.provider;
    return {
      tabId,
      emittedAt: Date.now(),
      observation,
      result,
      siteCapabilities: manifests,
      preferredProvider: preferred
    } satisfies BrowserPerceptionPacket;
  }

  async listCapabilityManifests(tabId: TabId, result: PerceptionResult, page: PageHandle): Promise<SiteCapabilityManifest[]> {
    const [domManifest, webMcpManifest] = await Promise.all([
      Promise.resolve(this.buildDomManifest(tabId, result)),
      this.buildWebMcpManifest(tabId, result, page)
    ]);

    const preferredProvider = pickPreferredProvider(domManifest, webMcpManifest);
    domManifest.preferred = preferredProvider === "dom";
    webMcpManifest.preferred = preferredProvider === "webmcp";

    return preferredProvider === "webmcp" ? [webMcpManifest, domManifest] : [domManifest, webMcpManifest];
  }

  async executeCommand(
    tabId: TabId,
    command: BrowserOutputCommand,
    observation: PageObservation | null,
    result: PerceptionResult,
    page: PageHandle,
    options: { skipApproval?: boolean } = {}
  ): Promise<BrowserCommandResult> {
    if (!options.skipApproval) {
      const approval = await this.maybeQueueApproval(tabId, command, result, page);
      if (approval) {
        return approval;
      }
    }

    switch (command.type) {
      case "navigate":
        await page.navigate(command.url);
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
        return this.executeSiteTool(page, command, result);
      case "click":
      case "type":
      case "select":
      case "submit":
        return this.executeBrowserAction(page, command);
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
    page: PageHandle
  ): Promise<BrowserCommandResult> {
    const waiting = this.approvals.get(requestId);
    if (!waiting) {
      return this.describeSettledApproval(requestId, result.graph.tabId);
    }

    // Defense in depth: navigation already cancels a tab's approvals, but never
    // run one against a page other than the one the human was shown.
    const mismatch = approvalPageMismatch(waiting.url, [result.graph.url, page.cdp.url()]);
    if (mismatch) {
      const reason = `${PAGE_CHANGED_REASON} (approved on ${waiting.url ?? "an unknown page"}, tab is now on ${mismatch})`;
      this.approvals.cancel(requestId, reason);
      return { status: "blocked", command: waiting.command, reason };
    }

    const pending = this.approvals.take(requestId);
    if (!pending) {
      return this.describeSettledApproval(requestId, result.graph.tabId);
    }

    // Plan before executing: a fill changes the page the plan is read from.
    let execution: BrowserCommandResult;
    try {
      const plan = await this.planApproval(pending.command, result, page);
      execution = await this.executeCommand(pending.tabId, pending.command, observation, result, page, { skipApproval: true });
      if (execution.status === "completed" && plan.kind === "fill" && plan.formId) {
        this.grants.record(
          pending.tabId,
          plan.formId,
          result.graph.url,
          pending.effects.map((effect) => effect.type)
        );
      }
    } catch (error) {
      this.approvals.settle(pending, "approved", { status: "failed", reason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    this.approvals.settle(pending, "approved", {
      status: execution.status,
      ...("reason" in execution && typeof execution.reason === "string" ? { reason: execution.reason } : {})
    });
    return execution;
  }

  rejectCommand(requestId: string): BrowserCommandResult {
    const pending = this.approvals.reject(requestId);
    if (!pending) {
      if (this.approvals.resolution(requestId)) return this.describeSettledApproval(requestId, "unknown");
      return {
        status: "blocked",
        command: { type: "request_perception_refresh", tabId: "unknown" },
        reason: `Approval request ${requestId} was not found.`
      };
    }
    return {
      status: "blocked",
      command: pending.command,
      reason: `Approval rejected: ${pending.summary}`
    };
  }

  /**
   * Answer for a request that is no longer pending: `blocked` with the reason
   * when it was cancelled or expired (so the agent knows to ask again), else
   * `failed` / not found.
   */
  describeSettledApproval(requestId: string, tabId: TabId): BrowserCommandResult {
    const command: BrowserOutputCommand = { type: "request_perception_refresh", tabId };
    const settled = this.approvals.resolution(requestId);
    if (settled && (settled.outcome === "cancelled" || settled.outcome === "expired")) {
      return {
        status: "blocked",
        command: { type: "request_perception_refresh", tabId: settled.tabId },
        reason: `Approval request ${requestId} ${settled.outcome}: ${settled.reason ?? PAGE_CHANGED_REASON}`
      };
    }
    if (settled) {
      return {
        status: "failed",
        command: { type: "request_perception_refresh", tabId: settled.tabId },
        reason: `Approval request ${requestId} was already ${settled.outcome}.`,
        retryable: false
      };
    }
    return { status: "failed", command, reason: `Approval request ${requestId} was not found.`, retryable: false };
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
    const record = this.handoffs.create(tabId, command.reason, this.getHandoffContext(tabId));
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

  private async buildWebMcpManifest(tabId: TabId, result: PerceptionResult, page: PageHandle): Promise<WebMcpManifest> {
    const probe = await this.probeWebMcp(page);
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
        validationIssues: [],
        notes: [
          "No WebMCP exposure signals were detected on this page.",
          "The browser is ready to host a WebMCP adapter when site detection and invocation are implemented."
        ],
        validationNotes: []
      };
    }

    const extracted = await this.extractWebMcpManifestData(page);
    const validationIssues = validateWebMcpManifest(extracted);
    const tools = this.normalizeWebMcpTools(extracted.tools, validationIssues);
    const hasErrors = validationIssues.some((issue) => issue.severity === "error");
    const availability: WebMcpAvailability = hasErrors
      ? "invalid"
      : tools.length > 0
        ? "ready"
        : "unknown";

    const notes = tools.length > 0
      ? [`${tools.length} WebMCP tool${tools.length !== 1 ? "s" : ""} discovered on this page.`]
      : [
          "WebMCP signals were detected but no tools could be enumerated.",
          "The site may require interaction before exposing its tool manifest."
        ];

    if (hasErrors) {
      notes.unshift("WebMCP manifest exposure was detected, but schema validation failed.");
    }

    return {
      tabId,
      origin: originFromUrl(result.graph.url),
      provider: "webmcp",
      isAvailable: availability === "ready",
      availability,
      discoveredAt: Date.now(),
      tools,
      version: extracted.version,
      validationIssues,
      notes,
      validationNotes: validationIssues.map((issue) => `${issue.path}: ${issue.message}`)
    };
  }

  private async extractWebMcpManifestData(page: PageHandle): Promise<{ version?: string; tools: unknown[] }> {
    try {
      const raw: unknown = await page.cdp.evaluate(
        `(async () => {
          if (typeof navigator !== "undefined" && navigator.webMcp) {
            if (Array.isArray(navigator.webMcp.tools)) return { version: navigator.webMcp.version, tools: navigator.webMcp.tools };
            if (typeof navigator.webMcp.getManifest === "function") {
              const m = await navigator.webMcp.getManifest();
              if (Array.isArray(m?.tools)) return { version: m.version, tools: m.tools };
            }
            if (typeof navigator.webMcp.listTools === "function") {
              const t = await navigator.webMcp.listTools();
              if (Array.isArray(t)) return { version: navigator.webMcp.version, tools: t };
            }
          }
          const webMcp = (typeof window !== "undefined") && (window.WebMCP || window.__WEB_MCP__);
          if (webMcp) {
            if (Array.isArray(webMcp.tools)) return { version: webMcp.version, tools: webMcp.tools };
            if (typeof webMcp.getManifest === "function") {
              const m = await webMcp.getManifest();
              if (Array.isArray(m?.tools)) return { version: m.version, tools: m.tools };
            }
          }
          const scriptEl = document.querySelector('script[type="application/webmcp+json"]');
          if (scriptEl) {
            const manifest = JSON.parse(scriptEl.textContent || "{}");
            if (Array.isArray(manifest.tools)) return { version: manifest.version, tools: manifest.tools };
          }
          return { tools: [] };
        })()`,
        { userGesture: true }
      );
      if (!raw || typeof raw !== "object") return { tools: [] };
      const manifest = raw as { version?: unknown; tools?: unknown[] };
      return {
        ...(typeof manifest.version === "string" ? { version: manifest.version } : {}),
        tools: Array.isArray(manifest.tools) ? manifest.tools : []
      };
    } catch {
      return { tools: [] };
    }
  }

  private normalizeWebMcpTools(raw: unknown[], validationIssues: WebMcpValidationIssue[]): WebMcpToolDescriptor[] {
    if (!Array.isArray(raw)) return [];

    return raw.flatMap((item: unknown): WebMcpToolDescriptor[] => {
      if (!item || typeof item !== "object" || !("name" in item)) return [];

      const tool = item as Record<string, unknown>;
      if (typeof tool.name !== "string" || tool.name.trim().length === 0) return [];
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

      if (!tool.description) {
        validationIssues.push({ path: `tools.${tool.name}.description`, message: "Tool description is missing.", severity: "warning" });
      }

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

  private async invokeWebMcpTool(page: PageHandle, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const nameJson = JSON.stringify(toolName);
    const argsJson = JSON.stringify(args);

    return page.cdp.evaluate(
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
      { userGesture: true }
    );
  }

  private async probeWebMcp(page: PageHandle): Promise<WebMcpHeuristicProbe> {
    try {
      return await page.cdp.evaluate(
        `(() => ({
          hasNavigatorWebMcp: typeof navigator !== "undefined" && "webMcp" in navigator,
          hasWindowWebMcp: typeof window !== "undefined" && ("WebMCP" in window || "__WEB_MCP__" in window),
          manifestScriptCount: document.querySelectorAll('script[type="application/webmcp+json"]').length,
          metaHintCount: document.querySelectorAll('meta[name="webmcp"], meta[name="web-mcp"]').length
        }))()`,
        { userGesture: true }
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
    page: PageHandle,
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
        () => executeDomTool(page.cdp, command, result.graph.forms, result.graph.actions, (value) => this.resolveValue(value)),
        page
      );
      return {
        status: "completed",
        command,
        effects: execution.effects
      };
    }

    if (command.provider === "webmcp") {
      try {
        const invocationResult = await this.invokeWebMcpTool(page, command.toolName, command.args ?? {});
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

  private async executeBrowserAction(page: PageHandle, command: BrowserAction): Promise<BrowserCommandResult> {
    await withDomRetry(() => runBrowserAction(page.cdp, command, (value) => this.resolveValue(value)), page);
    return {
      status: "completed",
      command
    };
  }

  private async maybeQueueApproval(
    tabId: TabId,
    command: BrowserOutputCommand,
    result: PerceptionResult,
    page: PageHandle
  ): Promise<BrowserCommandResult | null> {
    const plan = await this.planApproval(command, result, page);
    const { effects } = plan;
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

    // An approved fill of this form already covered these effect kinds.
    if (
      plan.kind === "submit" &&
      plan.formId &&
      this.grants.consume(tabId, plan.formId, result.graph.url, effects.map((effect) => effect.type))
    ) {
      return null;
    }

    const summary = summarizeEffects(effects);
    // Bind the approval to the page it was asked on: navigating away cancels it.
    const pending = this.approvals.create(tabId, command, effects, summary, { url: result.graph.url || page.cdp.url() });
    return {
      status: "awaiting_approval",
      command,
      requestId: pending.requestId,
      summary,
      effects
    };
  }

  private async planApproval(command: BrowserOutputCommand, result: PerceptionResult, page: PageHandle): Promise<ApprovalPlan> {
    const forms = result.graph.forms;

    if (command.type === "submit") {
      const form = resolveSubmitForm(command.node, forms);
      return form
        ? { kind: "submit", formId: form.id, effects: submitEffects(form) }
        : { kind: "submit", effects: [{ type: "share_personal_data", fields: ["form submission"] }] };
    }

    if (command.type === "type") {
      return this.planTypeApproval(command, forms, page);
    }

    if (command.type !== "invoke_site_tool" || command.provider !== "dom") {
      return { kind: "other", effects: [] };
    }

    if (command.toolName.startsWith("dom.submit.")) {
      const formId = command.toolName.slice("dom.submit.".length);
      const form = forms.find((entry) => entry.id === formId);
      if (!form) {
        return { kind: "submit", effects: [{ type: "share_personal_data", fields: ["form submission"] }] };
      }
      return { kind: "submit", formId, effects: submitEffects(form) };
    }

    if (command.toolName.startsWith("dom.fill.")) {
      const formId = command.toolName.slice("dom.fill.".length);
      const form = forms.find((entry) => entry.id === formId);
      // Unknown form: the actuator rejects it, nothing is typed.
      if (!form) {
        return { kind: "fill", effects: [] };
      }
      return { kind: "fill", formId, effects: collectFormFillEffects(form, command.args ?? {}) ?? [] };
    }

    return { kind: "other", effects: [] };
  }

  /**
   * A `type` shares personal data when the target is a personal field (matched
   * to an observed field by accessible name, else by its live `type` /
   * `autocomplete` attributes) or when the value is a vault/account ref.
   */
  private async planTypeApproval(
    command: Extract<BrowserOutputCommand, { type: "type" }>,
    forms: ObservedForm[],
    page: PageHandle
  ): Promise<ApprovalPlan> {
    const match = resolveObservedField(command.node, forms);
    let personal = isSecretRefValue(command.value) || (match ? isPersonalField(match.field) : false);
    let attributeLabel: string | undefined;
    if (!personal) {
      const attributes = await describeNodeAttributes(page, command.node.backendNodeId);
      personal = isPersonalInputAttributes(attributes);
      attributeLabel = attributes["aria-label"] || attributes.name || attributes.id;
    }
    if (!personal) {
      return { kind: "fill", effects: [] };
    }
    const label = match?.field.label || command.node.name || attributeLabel || "text field";
    return {
      kind: "fill",
      ...(match ? { formId: match.form.id } : {}),
      effects: [{ type: "share_personal_data", fields: [label] }]
    };
  }
}

function submitEffects(form: ObservedForm): ProposedEffect[] {
  const sensitiveFields = form.fields
    .filter((field) => PERSONAL_SUBMIT_FIELD_TYPES.includes(field.fieldType) || isPersonalField(field))
    .map((field) => field.label);
  const effects: ProposedEffect[] = [
    {
      type: "share_personal_data",
      fields: sensitiveFields.length > 0 ? sensitiveFields : form.fields.map((field) => field.label)
    }
  ];
  if (form.purpose === "signup") {
    effects.push({ type: "create_account", label: form.name || form.purpose });
  }
  return effects;
}

function normalizeLabel(value: string | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function resolveObservedField(node: NodeRef, forms: ObservedForm[]): { form: ObservedForm; field: ObservedField } | null {
  const name = normalizeLabel(node.name);
  if (!name) return null;
  for (const form of forms) {
    const field = form.fields.find((entry) => normalizeLabel(entry.label) === name);
    if (field) return { form, field };
  }
  return null;
}

/** The form a raw `submit` targets: by submit-button label, else the page's only form. */
function resolveSubmitForm(node: NodeRef, forms: ObservedForm[]): ObservedForm | null {
  const name = normalizeLabel(node.name);
  if (name) {
    const byAction = forms.find((form) => form.submitActions.some((action) => normalizeLabel(action.label) === name));
    if (byAction) return byAction;
  }
  return forms.length === 1 ? forms[0] : null;
}

async function describeNodeAttributes(page: PageHandle, backendNodeId: number): Promise<Record<string, string>> {
  try {
    const described = await page.cdp.send<{ node?: { attributes?: string[] } }>("DOM.describeNode", { backendNodeId });
    const flat = described?.node?.attributes ?? [];
    const attributes: Record<string, string> = {};
    for (let i = 0; i + 1 < flat.length; i += 2) attributes[flat[i].toLowerCase()] = flat[i + 1];
    return attributes;
  } catch {
    return {};
  }
}

// ── DOM retry helper ─────────────────────────────────────────────────────────

const RETRYABLE_DOM_PATTERNS = [
  "could not be resolved on the live page",
  "Unable to resolve backend node",
  "Resolved backend node is not"
] as const;

async function withDomRetry<T>(fn: () => Promise<T>, page: PageHandle, maxAttempts = 3): Promise<T> {
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
      await waitForPageSettled(page.cdp, 1500);
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

function isLiteralValue(value: unknown): value is { kind: "literal"; value: unknown } {
  return Boolean(value && typeof value === "object" && "kind" in value && "value" in value && value.kind === "literal");
}

function validateWebMcpManifest(manifest: { version?: string; tools: unknown[] }): WebMcpValidationIssue[] {
  const issues: WebMcpValidationIssue[] = [];

  if (manifest.version && !/^\d+(\.\d+){0,2}$/.test(manifest.version)) {
    issues.push({ path: "version", message: "Version should be a simple semver-like string.", severity: "warning" });
  }

  const seenNames = new Set<string>();
  for (const [index, item] of manifest.tools.entries()) {
    if (!item || typeof item !== "object") {
      issues.push({ path: `tools[${index}]`, message: "Tool entry must be an object.", severity: "error" });
      continue;
    }

    const tool = item as Record<string, unknown>;
    if (typeof tool.name !== "string" || tool.name.trim().length === 0) {
      issues.push({ path: `tools[${index}].name`, message: "Tool name must be a non-empty string.", severity: "error" });
      continue;
    }
    if (seenNames.has(tool.name)) {
      issues.push({ path: `tools[${index}].name`, message: `Duplicate tool name "${tool.name}".`, severity: "error" });
    }
    seenNames.add(tool.name);

    if (tool.parameters && typeof tool.parameters !== "object") {
      issues.push({ path: `tools[${index}].parameters`, message: "Tool parameters must be an object schema.", severity: "error" });
    }
  }

  return issues;
}

function pickPreferredProvider(domManifest: SiteCapabilityManifest, webMcpManifest: WebMcpManifest): "dom" | "webmcp" {
  if (
    webMcpManifest.availability === "ready" &&
    webMcpManifest.tools.length > 0 &&
    !webMcpManifest.validationIssues.some((issue) => issue.severity === "error")
  ) {
    return "webmcp";
  }

  return domManifest.tools.length > 0 ? "dom" : "webmcp";
}

/**
 * The first live URL (non-empty) that is not the approval's page, or null when
 * every known URL matches (fragment ignored). An approval without a recorded
 * URL is not checked (legacy records; every new one has a URL).
 */
function approvalPageMismatch(approvalUrl: string | undefined, liveUrls: Array<string | undefined>): string | null {
  if (!approvalUrl) return null;
  for (const live of liveUrls) {
    if (live && !isSameApprovalPage(approvalUrl, live)) return live;
  }
  return null;
}
