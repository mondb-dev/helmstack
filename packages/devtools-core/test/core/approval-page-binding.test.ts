/**
 * A pending approval is bound to the page it was asked on: main-frame
 * navigation (cross- or same-origin), tab close, an approve-time URL mismatch
 * and the approval timeout all cancel it; fragment-only changes do not.
 */
import { mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApprovalResolution, PendingApproval, TabId } from "../../../shared/src/index.js";
import { HelmstackCore } from "../../src/core/helmstack-core.js";
import { ApprovalStore, DEFAULT_APPROVAL_TTL_MS, isSameApprovalPage } from "../../src/core/stores/approval-store.js";
import { createAgentServer, type AgentServer } from "../../src/http/agent-server.js";
import { FakeBackend } from "./fakes.js";

let dataDir: string;
let backend: FakeBackend;
let core: HelmstackCore;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "helmstack-approval-binding-"));
  backend = new FakeBackend();
  core = new HelmstackCore(backend, { dataDir });
});

afterEach(() => {
  vi.useRealTimers();
  core.dispose();
  rmSync(dataDir, { recursive: true, force: true });
});

const store = () => (core as unknown as { approvals: ApprovalStore }).approvals;

async function openTab(url = "https://a.test/form"): Promise<TabId> {
  return (await core.createTab(url)).at(-1)!.id;
}

function queue(tabId: TabId, url: string | undefined): PendingApproval {
  return store().create(
    tabId,
    { type: "submit", node: { tabId, frameId: "0", backendNodeId: 1, role: "button" } },
    [],
    "Submit form",
    url ? { url } : {}
  );
}

function navigate(tabId: TabId, url: string): void {
  const tab = backend.tabs.get(tabId)!;
  tab.url = url;
  tab.cdp.currentUrl = url;
  backend.emit({ type: "main-frame-navigation", tabId, url });
}

const PAGE_CHANGED = /Page changed before approval — ask again/;

describe("approval page binding", () => {
  it("records url and origin at queue time", async () => {
    const tabId = await openTab();
    expect(queue(tabId, "https://a.test/form?x=1#top")).toMatchObject({ url: "https://a.test/form?x=1#top", origin: "https://a.test" });
  });

  it("cancels on cross-origin navigation, tells the agent, and fires approvals-changed", async () => {
    const tabId = await openTab();
    const approval = queue(tabId, "https://a.test/form");
    const lists: PendingApproval[][] = [];
    const resolutions: ApprovalResolution[] = [];
    core.onApprovalsChanged((l) => lists.push(l));
    core.onApprovalResolved((r) => resolutions.push(r));

    navigate(tabId, "https://evil.test/search");

    expect(core.listPendingApprovals()).toEqual([]);
    expect(lists.at(-1)).toEqual([]);
    expect(resolutions).toEqual([expect.objectContaining({ requestId: approval.requestId, tabId, outcome: "cancelled", reason: expect.stringMatching(PAGE_CHANGED) })]);

    const late = await core.approveCommand(approval.requestId);
    expect(late).toMatchObject({ status: "blocked", reason: expect.stringMatching(PAGE_CHANGED) });
  });

  it("cancels on same-origin navigation to another page or query", async () => {
    const tabId = await openTab();
    const a = queue(tabId, "https://a.test/form");
    navigate(tabId, "https://a.test/other");
    expect(core.listPendingApprovals()).toEqual([]);
    const b = queue(tabId, "https://a.test/other?id=1");
    navigate(tabId, "https://a.test/other?id=2");
    expect(core.listPendingApprovals()).toEqual([]);
    expect(store().resolution(a.requestId)?.outcome).toBe("cancelled");
    expect(store().resolution(b.requestId)?.outcome).toBe("cancelled");
  });

  it("keeps the approval across a fragment-only change", async () => {
    const tabId = await openTab();
    const approval = queue(tabId, "https://a.test/form?x=1");
    navigate(tabId, "https://a.test/form?x=1#section");
    expect(core.listPendingApprovals().map((a) => a.requestId)).toEqual([approval.requestId]);
    expect(isSameApprovalPage("https://a.test/p#a", "https://a.test/p#b")).toBe(true);
    expect(isSameApprovalPage("https://a.test/p?a=1", "https://a.test/p?a=2")).toBe(false);
  });

  it("only cancels the navigating tab's approvals, and cancels on tab close", async () => {
    const t1 = await openTab();
    const t2 = await openTab("https://b.test/");
    queue(t1, "https://a.test/form");
    const other = queue(t2, "https://b.test/");
    navigate(t1, "https://a.test/next");
    expect(core.listPendingApprovals().map((a) => a.requestId)).toEqual([other.requestId]);
    const resolutions: ApprovalResolution[] = [];
    core.onApprovalResolved((r) => resolutions.push(r));
    await core.closeTab(t2);
    expect(core.listPendingApprovals()).toEqual([]);
    expect(resolutions[0]).toMatchObject({ requestId: other.requestId, outcome: "cancelled" });
  });

  it("refuses and cancels at approve time when the tab URL differs from the approval's", async () => {
    const tabId = await openTab();
    const approval = queue(tabId, "https://a.test/form");
    // Navigation event missed (e.g. backend only updated its summary).
    backend.tabs.get(tabId)!.url = "https://elsewhere.test/";
    const out = await core.approveCommand(approval.requestId);
    expect(out).toMatchObject({ status: "blocked", reason: expect.stringMatching(PAGE_CHANGED) });
    expect(core.listPendingApprovals()).toEqual([]);
    expect(store().resolution(approval.requestId)?.outcome).toBe("cancelled");
  });

  it("expires after the timeout through the same path", async () => {
    vi.useFakeTimers();
    const local = new ApprovalStore({ ttlMs: 1000 });
    const resolutions: ApprovalResolution[] = [];
    const changed: number[] = [];
    local.onResolved((r) => resolutions.push(r));
    local.onChanged((l) => changed.push(l.length));
    const rec = local.create("t1", { type: "request_perception_refresh", tabId: "t1" }, [], "x", { url: "https://a.test/" });
    expect(rec.expiresAt).toBe(rec.createdAt + 1000);
    await vi.advanceTimersByTimeAsync(1001);
    expect(local.list()).toEqual([]);
    expect(changed.at(-1)).toBe(0);
    expect(resolutions).toEqual([expect.objectContaining({ outcome: "expired", requestId: rec.requestId })]);
    expect(DEFAULT_APPROVAL_TTL_MS).toBe(10 * 60_000);
  });

  it("honours approvalTtlMs on the core", async () => {
    vi.useFakeTimers();
    const c = new HelmstackCore(backend, { dataDir, approvalTtlMs: 5000 });
    const s = (c as unknown as { approvals: ApprovalStore }).approvals;
    s.create("t", { type: "request_perception_refresh", tabId: "t" }, [], "x");
    await vi.advanceTimersByTimeAsync(5001);
    expect(c.listPendingApprovals()).toEqual([]);
    c.dispose();
  });
});

describe("approval_resolved SSE event", () => {
  let server: AgentServer;
  afterEach(async () => {
    await server?.stop();
  });

  it("streams a cancellation to agents", async () => {
    const tabId = await openTab();
    server = createAgentServer({ api: core, backend: "desktop", port: 0, authToken: null });
    await server.start();
    let text = "";
    const req = http.request({ host: "127.0.0.1", port: server.boundPort!, path: "/api/stream" }, (res) => {
      res.on("data", (c: Buffer) => (text += c.toString("utf8")));
    });
    req.on("error", () => {});
    req.end();
    const wait = async (check: () => boolean) => {
      for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(check()).toBe(true);
    };
    await wait(() => server.getConnectionStatus().sseClients === 1);
    const approval = queue(tabId, "https://a.test/form");
    navigate(tabId, "https://x.test/");
    await wait(() => text.includes("approval_resolved"));
    req.destroy();
    expect(text).toContain(approval.requestId);
    expect(text).toContain("cancelled");
  });
});
