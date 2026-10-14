import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApprovalPolicyStore } from "../src/core/stores/approval-policy-store.js";
import { APPROVAL_GRANT_TTL_MS, ApprovalGrantStore } from "../src/core/stores/approval-grant-store.js";
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

describe("SiteCapabilityRegistry fill / type gating", () => {
  const contactForm = (purpose: "generic" | "signup" = "generic") => ({
    id: "form-1", purpose, name: "contact", selectorHint: "form",
    submitActions: [{ id: "a1", label: "Send", kind: "submit" as const, selectorHint: "button", disabled: false }],
    fields: [
      { id: "f-email", label: "Email", fieldType: "email" as const, required: true, selectorHint: "#email" },
      { id: "f-name", label: "Full name", fieldType: "text" as const, autocomplete: "name", required: true, selectorHint: "#name" },
      { id: "f-msg", label: "Message", fieldType: "textarea" as const, required: false, selectorHint: "#msg" }
    ]
  });
  const formGraph = (purpose: "generic" | "signup" = "generic", url = "https://example.com/") => graph({ url, forms: [contactForm(purpose)] });
  const fill = (args: Record<string, unknown>): BrowserOutputCommand => ({ type: "invoke_site_tool", provider: "dom", toolName: "dom.fill.form-1", args });
  const domSubmit: BrowserOutputCommand = { type: "invoke_site_tool", provider: "dom", toolName: "dom.submit.form-1", args: {} };
  const typeInto = (name: string | undefined, value: Extract<BrowserOutputCommand, { type: "type" }>["value"] = { kind: "literal", value: "x" }): BrowserOutputCommand => ({
    type: "type", node: { tabId: "tab-1", frameId: "0", backendNodeId: 7, role: "textbox", ...(name ? { name } : {}) }, value
  });

  async function approveFill(g = formGraph()) {
    const queued = await registry.executeCommand("tab-1", fill({ "f-email": { kind: "literal", value: "a@b.c" } }), null, result(g), fakePage());
    expect(queued.status).toBe("awaiting_approval");
    if (queued.status !== "awaiting_approval") throw new Error("not queued");
    const approved = await registry.approveCommand(queued.requestId, null, result(g), fakePage());
    expect(approved.status).toBe("completed");
  }

  it("queues a fill of personal fields under 'ask', and nothing reaches the page", async () => {
    const calls: CdpCall[] = [];
    const out = await registry.executeCommand("tab-1", fill({ "f-email": { kind: "literal", value: "a@b.c" }, "f-msg": { kind: "literal", value: "hi" } }), null, result(formGraph()), fakePage(calls));
    expect(out.status).toBe("awaiting_approval");
    if (out.status === "awaiting_approval") expect(out.effects).toEqual([{ type: "share_personal_data", fields: ["Email"] }]);
    expect(calls).toEqual([]);
  });

  it("blocks a personal fill under 'block' and runs it under 'auto'", async () => {
    policies.updatePolicy("share_personal_data", "block");
    expect((await registry.executeCommand("tab-1", fill({ "f-email": { kind: "literal", value: "a" } }), null, result(formGraph()), fakePage())).status).toBe("blocked");
    policies.updatePolicy("share_personal_data", "auto");
    expect((await registry.executeCommand("tab-1", fill({ "f-email": { kind: "literal", value: "a" } }), null, result(formGraph()), fakePage())).status).toBe("completed");
  });

  it("does not gate a fill that only touches non-personal fields", async () => {
    const out = await registry.executeCommand("tab-1", fill({ "f-msg": { kind: "literal", value: "hi" } }), null, result(formGraph()), fakePage());
    expect(out.status).toBe("completed");
  });

  it("treats autocomplete hints and vault/account refs as personal", async () => {
    const byAutocomplete = await registry.executeCommand("tab-1", fill({ "f-name": { kind: "literal", value: "Ada" } }), null, result(formGraph()), fakePage());
    expect(byAutocomplete.status).toBe("awaiting_approval");
    const byRef = await registry.executeCommand("tab-1", fill({ "f-msg": { kind: "vault", id: "vault.identity.bio" } }), null, result(formGraph()), fakePage());
    expect(byRef.status).toBe("awaiting_approval");
  });

  it("an approved fill lets the next submit of the same form run without a second prompt, once", async () => {
    await approveFill();
    expect((await registry.executeCommand("tab-1", domSubmit, null, result(formGraph()), fakePage())).status).toBe("completed");
    // Single use: a second submit asks again.
    expect((await registry.executeCommand("tab-1", domSubmit, null, result(formGraph()), fakePage())).status).toBe("awaiting_approval");
  });

  it("the grant does not cover another tab, another form, or extra effect kinds", async () => {
    await approveFill();
    expect((await registry.executeCommand("tab-2", domSubmit, null, result(formGraph()), fakePage())).status).toBe("awaiting_approval");

    const signup = formGraph("signup");
    await approveFill(signup);
    const out = await registry.executeCommand("tab-1", domSubmit, null, result(signup), fakePage());
    expect(out.status).toBe("awaiting_approval");
    if (out.status === "awaiting_approval") expect(out.effects.map((e) => e.type)).toEqual(["share_personal_data", "create_account"]);
  });

  it("a block policy still wins over a grant", async () => {
    await approveFill();
    policies.updatePolicy("share_personal_data", "block");
    expect((await registry.executeCommand("tab-1", domSubmit, null, result(formGraph()), fakePage())).status).toBe("blocked");
  });

  it("navigation voids the grant (explicit reset or a different document URL)", async () => {
    await approveFill();
    registry.clearApprovalGrants("tab-1");
    expect((await registry.executeCommand("tab-1", domSubmit, null, result(formGraph()), fakePage())).status).toBe("awaiting_approval");

    await approveFill();
    const moved = formGraph("generic", "https://example.com/step-2");
    expect((await registry.executeCommand("tab-1", domSubmit, null, result(moved), fakePage())).status).toBe("awaiting_approval");
  });

  it("the grant expires after the window", async () => {
    let now = 1_000;
    const store = new ApprovalGrantStore(() => now);
    const reg = new SiteCapabilityRegistry(passthroughSecrets, new ApprovalStore(), new HandoffStore(), policies, () => ({ relatedTabIds: ["tab-1"] }), store);
    const g = formGraph();
    const queued = await reg.executeCommand("tab-1", fill({ "f-email": { kind: "literal", value: "a" } }), null, result(g), fakePage());
    if (queued.status !== "awaiting_approval") throw new Error("not queued");
    await reg.approveCommand(queued.requestId, null, result(g), fakePage());
    now += APPROVAL_GRANT_TTL_MS + 1;
    expect((await reg.executeCommand("tab-1", domSubmit, null, result(g), fakePage())).status).toBe("awaiting_approval");
  });

  it("a rejected fill grants nothing", async () => {
    const queued = await registry.executeCommand("tab-1", fill({ "f-email": { kind: "literal", value: "a" } }), null, result(formGraph()), fakePage());
    if (queued.status !== "awaiting_approval") throw new Error("not queued");
    registry.rejectCommand(queued.requestId);
    expect((await registry.executeCommand("tab-1", domSubmit, null, result(formGraph()), fakePage())).status).toBe("awaiting_approval");
  });

  it("gates a type into an observed personal field and grants the raw submit of that form", async () => {
    const g = formGraph();
    const queued = await registry.executeCommand("tab-1", typeInto("Email"), null, result(g), fakePage());
    expect(queued.status).toBe("awaiting_approval");
    if (queued.status !== "awaiting_approval") throw new Error("not queued");
    expect(queued.effects).toEqual([{ type: "share_personal_data", fields: ["Email"] }]);
    expect((await registry.approveCommand(queued.requestId, null, result(g), fakePage())).status).toBe("completed");

    const rawSubmit: BrowserOutputCommand = { type: "submit", node: { tabId: "tab-1", frameId: "0", backendNodeId: 9, role: "button", name: "Send" } };
    expect((await registry.executeCommand("tab-1", rawSubmit, null, result(g), fakePage())).status).toBe("completed");
  });

  it("gates a type into an unobserved field by its live type/autocomplete attributes", async () => {
    const page = fakePage();
    const send = page.cdp.send;
    page.cdp.send = (async (method: string, params?: Record<string, unknown>) =>
      method === "DOM.describeNode" ? { node: { attributes: ["type", "tel", "name", "phone"] } } : send(method, params)) as typeof send;
    const out = await registry.executeCommand("tab-1", typeInto(undefined), null, result(graph()), page);
    expect(out.status).toBe("awaiting_approval");
    if (out.status === "awaiting_approval") expect(out.effects).toEqual([{ type: "share_personal_data", fields: ["phone"] }]);
  });

  it("does not gate a type into a non-personal field", async () => {
    expect((await registry.executeCommand("tab-1", typeInto("Message"), null, result(formGraph()), fakePage())).status).toBe("completed");
  });

  it("fires approvals-changed for a queued fill", async () => {
    const store = new ApprovalStore();
    const seen: number[] = [];
    store.onChanged((pending) => seen.push(pending.length));
    const reg = new SiteCapabilityRegistry(passthroughSecrets, store, new HandoffStore(), policies, () => ({ relatedTabIds: ["tab-1"] }));
    await reg.executeCommand("tab-1", fill({ "f-email": { kind: "literal", value: "a" } }), null, result(formGraph()), fakePage());
    expect(seen).toEqual([1]);
    expect(store.list()[0]).toMatchObject({ tabId: "tab-1", summary: "Share personal data: Email" });
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
    // Typing an account ref shares personal data; allow it so the type runs.
    policies.updatePolicy("share_personal_data", "auto");
    const out = await newRegistry(secrets).executeCommand("tab-1", typeCommand(ref), null, result(graph()), fakePage(calls));
    expect(out.status).toBe("completed");
    expect(seen).toContainEqual(ref);
    expect(typedArgs(calls)).toContain("s3cret");
  });
});
