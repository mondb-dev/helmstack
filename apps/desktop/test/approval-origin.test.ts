import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PendingApproval } from "../../../packages/shared/src/index.js";
import { mountApprovals, requestSite } from "../src/renderer/panels/approvals.js";
import { approval, flush, loadShellDom } from "./helpers/shell-fixtures.js";

const el = (id: string) => document.getElementById(id)!;

function setup(initial: PendingApproval[], tabUrl?: () => string | undefined) {
  let server = [...initial];
  const done = async (requestId: string) => {
    server = server.filter((p) => p.requestId !== requestId);
    return { status: "completed" as const, command: { type: "request_perception_refresh" as const, tabId: "tab-1" } };
  };
  const bridge = {
    listPendingApprovals: vi.fn(async () => server),
    approveCommand: vi.fn(done),
    rejectCommand: vi.fn(done),
  };
  const fallback = document.getElementById("activity-panel") as HTMLElement;
  const controller = mountApprovals({ bridge, tabUrl, fallbackFocus: () => fallback });
  return { controller, bridge, fallback };
}

describe("requestSite", () => {
  it("uses the request's origin and truncates the path, dropping query and fragment", () => {
    const long = `/${"a".repeat(80)}`;
    const site = requestSite({ origin: "https://shop.test", url: `https://shop.test${long}?token=1#x` });
    expect(site?.origin).toBe("https://shop.test");
    expect(site?.fullPath).toBe(long);
    expect(site?.path.length).toBeLessThanOrEqual(40);
    expect(site?.path).toContain("…");
    expect(site?.movedTo).toBeNull();
  });

  it("degrades when fields are absent", () => {
    expect(requestSite({})).toBeNull();
    expect(requestSite({ url: "https://a.test/x" })?.origin).toBe("https://a.test");
    expect(requestSite({ origin: "https://a.test" }, "not a url")?.movedTo).toBeNull();
  });

  it("flags a tab that has moved to another origin", () => {
    expect(requestSite({ origin: "https://a.test" }, "https://evil.test/x")?.movedTo).toBe("https://evil.test");
    expect(requestSite({ origin: "https://a.test" }, "https://a.test/other")?.movedTo).toBeNull();
  });
});

describe("approval dialog origin and focus", () => {
  beforeEach(() => {
    loadShellDom();
  });

  it("shows the request's origin in banner and dialog, not the tab's", () => {
    const a = approval({ origin: "https://shop.test", url: "https://shop.test/cart/checkout" });
    const { controller } = setup([], () => "https://shop.test/after");
    controller.update([a]);
    expect(el("approval-banner-site").textContent).toBe("https://shop.test/cart/checkout");
    controller.review();
    expect(el("approval-site").hidden).toBe(false);
    expect(el("approval-site-origin").textContent).toBe("https://shop.test");
    expect(el("approval-site-path").textContent).toBe("/cart/checkout");
    expect(el("approval-moved").hidden).toBe(true);
    expect((el("approval-approve-button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("hides site rows when the approval has no origin", () => {
    const { controller } = setup([]);
    controller.update([approval()]);
    controller.review();
    expect(el("approval-banner-site").hidden).toBe(true);
    expect(el("approval-site").hidden).toBe(true);
  });

  it("disables Approve with a danger notice when the tab has moved", async () => {
    const a = approval({ origin: "https://shop.test", url: "https://shop.test/pay" });
    const { controller, bridge } = setup([], () => "https://other.test/");
    controller.update([a]);
    controller.review();
    const approve = el("approval-approve-button") as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(el("approval-moved").hidden).toBe(false);
    expect(el("approval-moved").textContent).toBe("This tab has moved to https://other.test. Approving is disabled.");
    approve.click();
    await flush();
    expect(bridge.approveCommand).not.toHaveBeenCalled();
  });

  it("returns focus to the Review button after a decision when the banner remains", async () => {
    const a = approval({ createdAt: 1 });
    const b = approval({ createdAt: 2 });
    const { controller } = setup([a, b]);
    await controller.refresh();
    const review = el("approval-review-button") as HTMLButtonElement;
    review.focus();
    review.click();
    el("approval-later-button").click();
    expect(document.activeElement).toBe(review);
  });

  it("falls back to the activity panel, never the address bar, when the banner is gone", async () => {
    const { controller, fallback } = setup([approval()]);
    await controller.refresh();
    const review = el("approval-review-button") as HTMLButtonElement;
    review.focus();
    review.click();
    el("approval-reject-button").click();
    await flush();
    expect(el("approval-banner").hidden).toBe(true);
    expect(document.activeElement).toBe(fallback);
    expect(document.activeElement).not.toBe(document.getElementById("address-input"));
  });
});
