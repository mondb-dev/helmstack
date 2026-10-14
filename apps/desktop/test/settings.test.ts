import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApprovalPolicyRecord } from "../../../packages/shared/src/index.js";
import { mountSettings, settingsEnabled } from "../src/renderer/panels/settings.js";
import { flush, loadShellDom } from "./helpers/shell-fixtures.js";

const policies: ApprovalPolicyRecord[] = [
  { key: "create_account", label: "Create accounts", description: "Sign up on a site", decision: "ask" },
  { key: "submit_payment", label: "Payments", description: "Submit a payment", decision: "block" },
];

function setup() {
  const bridge = {
    listApprovalPolicies: vi.fn(async () => policies),
    updateApprovalPolicy: vi.fn(async (key: string, decision: ApprovalPolicyRecord["decision"]) =>
      policies.map((p) => (p.key === key ? { ...p, decision } : p))
    ),
    listAccounts: vi.fn(async () => []),
    saveAccount: vi.fn(),
    deleteAccount: vi.fn(),
    listVaultSecrets: vi.fn(async () => []),
  };
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const settings = mountSettings({ bridge, onOpen, onClose });
  return { bridge, settings, onOpen, onClose };
}

const gear = () => document.getElementById("settings-button")!;
const sheet = () => document.getElementById("settings-sheet")!;

describe("settings gating", () => {
  beforeEach(() => {
    loadShellDom();
  });

  it("only the agent-substrate and full profiles enable settings", () => {
    expect(settingsEnabled("fe-dev")).toBe(false);
    expect(settingsEnabled("agent-substrate")).toBe(true);
    expect(settingsEnabled("full")).toBe(true);
    expect(settingsEnabled(null)).toBe(false);
  });

  it("hides the gear in fe-dev (and by default) and shows it otherwise", () => {
    const { settings } = setup();
    expect(gear().hidden).toBe(true);
    settings.setProfile("fe-dev");
    expect(gear().hidden).toBe(true);
    settings.setProfile("full");
    expect(gear().hidden).toBe(false);
  });

  it("cannot be opened in fe-dev, and closes if the profile drops to fe-dev", async () => {
    const { settings } = setup();
    settings.setProfile("fe-dev");
    await settings.open();
    expect(sheet().hidden).toBe(true);

    settings.setProfile("agent-substrate");
    gear().click();
    await flush();
    expect(sheet().hidden).toBe(false);
    settings.setProfile("fe-dev");
    expect(sheet().hidden).toBe(true);
  });
});

describe("settings sheet", () => {
  beforeEach(() => {
    loadShellDom();
  });

  it("lists approval policies and updates one via updateApprovalPolicy", async () => {
    const { settings, bridge, onOpen } = setup();
    settings.setProfile("agent-substrate");
    await settings.open();
    expect(onOpen).toHaveBeenCalled();
    const select = document.getElementById("policy-submit_payment") as HTMLSelectElement;
    expect(select.value).toBe("block");
    expect(document.querySelector('label[for="policy-submit_payment"]')!.textContent).toBe("Payments");
    select.value = "ask";
    select.dispatchEvent(new Event("change"));
    await flush();
    expect(bridge.updateApprovalPolicy).toHaveBeenCalledWith("submit_payment", "ask");
    expect((document.getElementById("policy-submit_payment") as HTMLSelectElement).value).toBe("ask");
  });

  it("shows empty states for accounts and vault, and Escape closes", async () => {
    const { settings, onClose } = setup();
    settings.setProfile("full");
    await settings.open();
    expect(document.getElementById("accounts-list")!.textContent).toContain("No accounts yet");
    expect(document.getElementById("vault-list")!.textContent).toContain("Vault is empty");
    sheet().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(sheet().hidden).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });
});
