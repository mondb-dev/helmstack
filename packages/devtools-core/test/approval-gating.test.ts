import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApprovalPolicyStore } from "../src/core/stores/approval-policy-store.js";
import { ApprovalStore } from "../src/core/stores/approval-store.js";
import { HandoffStore } from "../src/core/stores/handoff-store.js";
import { SiteCapabilityRegistry } from "../src/core/commands/site-capability-registry.js";
import { passthroughSecrets, type PageHandle, type SecretResolver } from "../src/core/commands/types.js";
import type { BrowserOutputCommand, CdpTarget, PageGraph, PerceptionResult } from "../../shared/src/index.js";

let dir: string;
let registry: SiteCapabilityRegistry;
let policies: ApprovalPolicyStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "helmstack-approval-"));
  policies = new ApprovalPolicyStore(dir);
  registry = new SiteCapabilityRegistry(
    passthroughSecrets,
    new ApprovalStore(),
    new HandoffStore(),
    policies,
    () => ({ relatedTabIds: ["tab-1"] })
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function graph(overrides: Partial<PageGraph> = {}): PageGraph {
  return {
    tabId: "tab-1", url: "https://example.com/", title: "t", kind: "form",
    headings: [], forms: [], actions: [], alerts: [], media: [], oauthProviders: [],
    accessibility: { nodeCount: 0, roleCounts: {}, headingTrail: [], interactiveNodes: [] },
    signals: { documentCount: 1, accessibilityNodeCount: 0, formCount: 0, actionCount: 0, capturedAt: 0 },
    ...overrides
  };
}

const result = (g: PageGraph): PerceptionResult => ({ snapshot: {} as PerceptionResult["snapshot"], observation: null, graph: g });

type CdpCall = { method: string; params?: Record<string, unknown> };

// A fake page whose CDP target records commands and resolves every node.
function fakePage(calls: CdpCall[] = []): PageHandle & { navigations: string[] } {
  const cdp: CdpTarget = {
    send: async <T>(method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      return (method === "DOM.resolveNode" ? { object: { objectId: "x" } } : {}) as T;
    },
    onEvent: () => () => {},
    evaluate: async <T>() => ({}) as T,
    url: () => "https://example.com/",
    isLoading: () => false,
    waitForLoadStop: async () => {}
  };
  const navigations: string[] = [];
  return { cdp, navigations, navigate: async (url) => { navigations.push(url); } };
}

function newRegistry(secrets: SecretResolver) {
  return new SiteCapabilityRegistry(secrets, new ApprovalStore(), new HandoffStore(), policies, () => ({ relatedTabIds: ["tab-1"] }));
}

const submit: BrowserOutputCommand = { type: "submit", node: { tabId: "tab-1", frameId: "0", backendNodeId: 1, role: "button" } };

describe("SiteCapabilityRegistry approval gating", () => {
  it("queues an approval for a submit under the default 'ask' policy", async () => {
    const out = await registry.executeCommand("tab-1", submit, null, result(graph()), fakePage());
    expect(out.status).toBe("awaiting_approval");
    if (out.status === "awaiting_approval") {
      expect(out.effects[0].type).toBe("share_personal_data");
      expect(out.requestId).toBeTruthy();
    }
  });

  it("blocks a submit when its effect policy is 'block'", async () => {
    policies.updatePolicy("share_personal_data", "block");
    const out = await registry.executeCommand("tab-1", submit, null, result(graph()), fakePage());
    expect(out.status).toBe("blocked");
  });

  it("auto-executes a submit when the policy is 'auto'", async () => {
    policies.updatePolicy("share_personal_data", "auto");
    const out = await registry.executeCommand("tab-1", submit, null, result(graph()), fakePage());
    expect(out.status).toBe("completed");
  });

  it("extracts sensitive field labels for a dom.submit on a credential form", async () => {
    const g = graph({
      forms: [{
        id: "form-1", purpose: "login", selectorHint: "form", submitActions: [],
        fields: [
          { id: "f1", label: "Email", fieldType: "email", required: true, selectorHint: "input" },
          { id: "f2", label: "Password", fieldType: "password", required: true, selectorHint: "input" }
        ]
      }]
    });
    const cmd: BrowserOutputCommand = { type: "invoke_site_tool", provider: "dom", toolName: "dom.submit.form-1", args: {} };
    const out = await registry.executeCommand("tab-1", cmd, null, result(g), fakePage());
    expect(out.status).toBe("awaiting_approval");
    if (out.status === "awaiting_approval") {
      const effect = out.effects[0];
      expect(effect.type).toBe("share_personal_data");
      if (effect.type === "share_personal_data") {
        expect(effect.fields).toEqual(["Email", "Password"]);
      }
    }
  });

  it("navigates through the PageHandle", async () => {
    const page = fakePage();
    const out = await registry.executeCommand("tab-1", { type: "navigate", url: "https://example.com/next" }, null, result(graph()), page);
    expect(out.status).toBe("completed");
    expect(page.navigations).toEqual(["https://example.com/next"]);
  });
});

describe("SiteCapabilityRegistry secret resolution", () => {
  const typeCommand = (value: Extract<BrowserOutputCommand, { type: "type" }>["value"]): BrowserOutputCommand => ({
    type: "type",
    node: { tabId: "tab-1", frameId: "0", backendNodeId: 1, role: "textbox" },
    value
  });
  const typedArgs = (calls: CdpCall[]) =>
    calls.filter((call) => call.method === "Runtime.callFunctionOn").map((call) => (call.params?.arguments as Array<{ value: unknown }>)[0]?.value);

  it("unwraps literal values with passthroughSecrets", async () => {
    const calls: CdpCall[] = [];
    const out = await newRegistry(passthroughSecrets).executeCommand("tab-1", typeCommand({ kind: "literal", value: "hello" }), null, result(graph()), fakePage(calls));
    expect(out.status).toBe("completed");
    expect(typedArgs(calls)).toContain("hello");
  });

  it("routes secret refs through the injected resolver", async () => {
    const calls: CdpCall[] = [];
    const seen: unknown[] = [];
    const secrets: SecretResolver = {
      resolveValue: (value) => {
        seen.push(value);
        return value && typeof value === "object" && "kind" in value && value.kind === "account" ? "s3cret" : value;
      }
    };
    const ref = { kind: "account", accountId: "acct-1", field: "password" } as const;
    const out = await newRegistry(secrets).executeCommand("tab-1", typeCommand(ref), null, result(graph()), fakePage(calls));
    expect(out.status).toBe("completed");
    expect(seen).toContainEqual(ref);
    expect(typedArgs(calls)).toContain("s3cret");
  });
});
