import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
}));

import { AccountStore } from "../src/main/account-store.js";
import { ApprovalPolicyStore } from "../src/main/approval-policy-store.js";
import { ApprovalStore } from "../src/main/approval-store.js";
import { HandoffStore } from "../src/main/handoff-store.js";
import { SiteCapabilityRegistry } from "../src/main/site-capability-registry.js";
import { VaultStore } from "../src/main/vault-store.js";
import type { BrowserOutputCommand, PageGraph, PerceptionResult } from "../../../packages/shared/src/index.js";

let dir: string;
let registry: SiteCapabilityRegistry;
let policies: ApprovalPolicyStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "helmstack-approval-"));
  policies = new ApprovalPolicyStore(dir);
  registry = new SiteCapabilityRegistry(
    new VaultStore(dir),
    new AccountStore(dir),
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

// A WebContents that records actuation calls; used only for the "auto" path.
function fakeWebContents() {
  return {
    debugger: {
      isAttached: () => true,
      attach: () => {},
      sendCommand: async (method: string) => (method === "DOM.resolveNode" ? { object: { objectId: "x" } } : {})
    },
    isLoading: () => false,
    on: () => {},
    removeListener: () => {}
  } as unknown as Electron.WebContents;
}

const submit: BrowserOutputCommand = { type: "submit", node: { tabId: "tab-1", frameId: "0", backendNodeId: 1, role: "button" } };

describe("SiteCapabilityRegistry approval gating", () => {
  it("queues an approval for a submit under the default 'ask' policy", async () => {
    const out = await registry.executeCommand("tab-1", submit, null, result(graph()), fakeWebContents());
    expect(out.status).toBe("awaiting_approval");
    if (out.status === "awaiting_approval") {
      expect(out.effects[0].type).toBe("share_personal_data");
      expect(out.requestId).toBeTruthy();
    }
  });

  it("blocks a submit when its effect policy is 'block'", async () => {
    policies.updatePolicy("share_personal_data", "block");
    const out = await registry.executeCommand("tab-1", submit, null, result(graph()), fakeWebContents());
    expect(out.status).toBe("blocked");
  });

  it("auto-executes a submit when the policy is 'auto'", async () => {
    policies.updatePolicy("share_personal_data", "auto");
    const out = await registry.executeCommand("tab-1", submit, null, result(graph()), fakeWebContents());
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
    const out = await registry.executeCommand("tab-1", cmd, null, result(g), fakeWebContents());
    expect(out.status).toBe("awaiting_approval");
    if (out.status === "awaiting_approval") {
      const effect = out.effects[0];
      expect(effect.type).toBe("share_personal_data");
      if (effect.type === "share_personal_data") {
        expect(effect.fields).toEqual(["Email", "Password"]);
      }
    }
  });
});
