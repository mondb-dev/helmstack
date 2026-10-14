import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PendingApproval } from "../../../packages/shared/src/index.js";
import { describeEffect, effectLines, mountApprovals } from "../src/renderer/panels/approvals.js";
import { approval, flush, loadShellDom } from "./helpers/shell-fixtures.js";

const banner = () => document.getElementById("approval-banner")!;
const announcer = () => document.getElementById("approval-announcer")!;
const modal = () => document.getElementById("approval-modal")!;

function setup(initial: PendingApproval[] = []) {
  let server = [...initial];
  const bridge = {
    listPendingApprovals: vi.fn(async () => server),
    approveCommand: vi.fn(async (requestId: string) => {
      server = server.filter((p) => p.requestId !== requestId);
      return { status: "completed" as const, command: { type: "request_perception_refresh" as const, tabId: "tab-1" } };
    }),
    rejectCommand: vi.fn(async (requestId: string) => {
      server = server.filter((p) => p.requestId !== requestId);
      return { status: "completed" as const, command: { type: "request_perception_refresh" as const, tabId: "tab-1" } };
    }),
  };
  const onLayoutChange = vi.fn();
  const onDialogOpen = vi.fn();
  const onDialogClose = vi.fn();
  const controller = mountApprovals({
    bridge,
    onLayoutChange,
    onDialogOpen,
    onDialogClose,
    tabLabel: () => "localhost:3000",
  });
  return { bridge, controller, onLayoutChange, onDialogOpen, onDialogClose, setServer: (next: PendingApproval[]) => (server = next) };
}

describe("approval banner", () => {
  beforeEach(() => {
    loadShellDom();
  });

  it("is hidden while nothing is pending", async () => {
    const { controller } = setup();
    await controller.refresh();
    expect(banner().hidden).toBe(true);
  });

  it("appears with the oldest summary and a +N more count", () => {
    const { controller, onLayoutChange } = setup();
    const a = approval({ summary: "Create account on Acme", createdAt: 10 });
    const b = approval({ summary: "Pay invoice", createdAt: 20 });
    const c = approval({ summary: "Accept terms", createdAt: 30 });
    controller.update([c, a, b]);
    expect(banner().hidden).toBe(false);
    expect(document.getElementById("approval-banner-summary")!.textContent).toBe("Create account on Acme");
    expect(document.getElementById("approval-banner-more")!.textContent).toBe("+2 more");
    expect(onLayoutChange).toHaveBeenCalled();
  });

  it("updates as the list changes and hides when it empties (no auto-dismiss)", () => {
    vi.useFakeTimers();
    try {
      const { controller } = setup();
      const a = approval({ createdAt: 1 });
      const b = approval({ createdAt: 2 });
      controller.update([a, b]);
      vi.advanceTimersByTime(60_000);
      expect(banner().hidden).toBe(false);
      controller.update([b]);
      expect(document.getElementById("approval-banner-summary")!.textContent).toBe(b.summary);
      expect(document.getElementById("approval-banner-more")!.textContent).toBe("");
      controller.update([]);
      expect(banner().hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("announces newly queued approvals in a polite live region", () => {
    const { controller } = setup();
    expect(announcer().getAttribute("role")).toBe("status");
    expect(announcer().getAttribute("aria-live")).toBe("polite");
    const a = approval({ summary: "First" });
    controller.update([a]);
    const b = approval({ summary: "Agent wants to pay" });
    controller.update([a, b]);
    expect(announcer().textContent).toBe("New approval request: Agent wants to pay");
  });

  it("Review opens the dialog with the oldest approval's effects", () => {
    const { controller, onDialogOpen } = setup();
    const a = approval({
      summary: "Sign up",
      createdAt: 1,
      effects: [
        { type: "create_account", label: "Acme" },
        { type: "accept_legal_terms", provider: "Acme" },
      ],
    });
    controller.update([approval({ createdAt: 5 }), a]);
    document.getElementById("approval-review-button")!.click();
    expect(modal().hidden).toBe(false);
    expect(onDialogOpen).toHaveBeenCalled();
    expect(document.getElementById("approval-copy")!.textContent).toBe("Sign up");
    const effects = Array.from(document.querySelectorAll("#approval-effects li")).map((li) => li.textContent);
    expect(effects).toEqual(["Create account: Acme", "Accept legal terms: Acme"]);
    expect(document.getElementById("approval-position")!.textContent).toBe("Approval 1 of 2");
  });

  it("Approve calls approveCommand for the shown request and advances to the next", async () => {
    const a = approval({ createdAt: 1 });
    const b = approval({ createdAt: 2 });
    const { controller, bridge } = setup([a, b]);
    await controller.refresh();
    controller.review();
    document.getElementById("approval-approve-button")!.click();
    await flush();
    expect(bridge.approveCommand).toHaveBeenCalledWith(a.requestId);
    expect(modal().hidden).toBe(false);
    expect(document.getElementById("approval-copy")!.textContent).toBe(b.summary);
  });

  it("Reject on the last approval closes the dialog and hides the banner", async () => {
    const a = approval();
    const { controller, bridge, onDialogClose } = setup([a]);
    await controller.refresh();
    controller.review();
    document.getElementById("approval-reject-button")!.click();
    await flush();
    expect(bridge.rejectCommand).toHaveBeenCalledWith(a.requestId);
    expect(modal().hidden).toBe(true);
    expect(banner().hidden).toBe(true);
    expect(onDialogClose).toHaveBeenCalled();
  });

  it("works for approvals resolved elsewhere (e.g. by an agent) while the dialog is open", () => {
    const { controller } = setup();
    const a = approval({ createdAt: 1 });
    const b = approval({ createdAt: 2 });
    controller.update([a, b]);
    controller.review();
    controller.update([b]);
    expect(document.getElementById("approval-copy")!.textContent).toBe(b.summary);
    controller.update([]);
    expect(modal().hidden).toBe(true);
  });

  it("Decide later closes the dialog but keeps the banner", () => {
    const { controller } = setup();
    controller.update([approval()]);
    controller.review();
    document.getElementById("approval-later-button")!.click();
    expect(modal().hidden).toBe(true);
    expect(banner().hidden).toBe(false);
  });

  it("describes payment effects with amounts", () => {
    expect(describeEffect({ type: "submit_payment", amount: "12.00", currency: "USD" })).toBe("Submit payment: 12.00 USD");
    expect(describeEffect({ type: "submit_payment" })).toBe("Submit payment");
  });
});

describe("approval dialog effects", () => {
  beforeEach(() => {
    loadShellDom();
  });

  it("effectLines drops effects that only repeat the summary, and empty lists", () => {
    expect(effectLines({ summary: "Submit payment", effects: [{ type: "submit_payment" }] })).toEqual([]);
    expect(effectLines({ summary: "  submit   PAYMENT ", effects: [{ type: "submit_payment" }] })).toEqual([]);
    expect(effectLines({ summary: "Pay", effects: [] })).toEqual([]);
    expect(effectLines({ summary: "Sign up", effects: [{ type: "create_account", label: "Acme" }] })).toEqual([
      "Create account: Acme",
    ]);
  });

  it("hides the list when effects are empty or identical to the summary", () => {
    const { controller } = setup();
    controller.update([approval({ summary: "Share personal data: email", effects: [{ type: "share_personal_data", fields: ["email"] }] })]);
    controller.review();
    const list = document.getElementById("approval-effects")!;
    expect(list.hidden).toBe(true);
    expect(list.children).toHaveLength(0);

    controller.update([approval({ summary: "Do it", effects: [] })]);
    expect(document.getElementById("approval-effects")!.hidden).toBe(true);
  });

  it("shows the list when effects add information", () => {
    const { controller } = setup();
    controller.update([approval({ summary: "Submit the form" })]);
    controller.review();
    const list = document.getElementById("approval-effects")!;
    expect(list.hidden).toBe(false);
    expect(list.textContent).toBe("Share personal data: email");
  });
});
