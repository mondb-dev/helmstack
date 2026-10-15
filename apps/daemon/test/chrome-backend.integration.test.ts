// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import type { DownloadEntry, PageObservation, TabId } from "@helmstack/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TabLifecycleEvent } from "../../../packages/devtools-core/src/backend.js";
import { ChromeBackend } from "../src/chrome-backend.js";
import { tryFindChrome } from "../src/chrome.js";

// Real-Chrome tests flake on the Windows runner ("The browser is already running for …") and the
// daemon is not verified on Windows; set HELMSTACK_TEST_WINDOWS_CHROME=1 to run them there.
const chrome = process.platform === "win32" && process.env.HELMSTACK_TEST_WINDOWS_CHROME !== "1" ? null : tryFindChrome();

const FORM_PAGE = `<!doctype html><title>Contact</title>
<main>
  <h1>Contact us</h1>
  <form name="contact">
    <label for="email">Email</label><input id="email" name="email" type="email" required>
    <button type="submit">Send message</button>
  </form>
  <a id="dl" href="/file" download>Download</a>
</main>`;

describe.skipIf(!chrome)("ChromeBackend against real headless Chrome", () => {
  let server: http.Server;
  let base: string;
  let dataDir: string;
  let backend: ChromeBackend;
  const events: TabLifecycleEvent[] = [];
  const observations: PageObservation[] = [];
  const downloads: DownloadEntry[] = [];
  const errors: Error[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/file") {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": "attachment; filename=hello.txt",
          "content-length": "5"
        });
        res.end("hello");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(req.url === "/second" ? "<!doctype html><title>Second</title><p>two</p>" : FORM_PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dataDir = await mkdtemp(path.join(tmpdir(), "helmstack-daemon-it-"));
    backend = await ChromeBackend.launch({
      dataDir,
      chrome: { executablePath: chrome!.path },
      onError: (e) => errors.push(e)
    });
    backend.onLifecycle((e) => events.push(e));
    backend.onObservation((o) => observations.push(o));
    backend.onDownload((_tabId, d) => {
      if (!downloads.includes(d)) downloads.push(d);
    });
  }, 60_000);

  afterAll(async () => {
    await backend?.close();
    await new Promise((resolve) => server?.close(resolve));
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("create → navigate → lifecycle → observation → title change → download → popup → close", async () => {
    const tab = await backend.createTab(`${base}/`);
    const id = tab.id;

    // created first, then navigation start, then load.
    const forTab = () => events.filter((e) => e.type === "created" || ("tabId" in e && e.tabId === id));
    expect(forTab()[0]).toEqual({ type: "created", tab });
    expect(forTab()).toContainEqual({ type: "main-frame-navigation", tabId: id, url: `${base}/` });
    expect(forTab()).toContainEqual({ type: "load-finished", tabId: id });
    expect(events.some((e) => e.type === "summary-changed")).toBe(true);
    expect(tab.summary()).toMatchObject({ id, url: `${base}/`, title: "Contact", status: "idle", isActive: true });
    expect(backend.listTabs()).toContain(tab);

    // Viewport: the content area is the launch size (headless --window-size alone leaves it ~87px short).
    expect(backend.defaultViewport()).toEqual({ width: 1280, height: 800 });
    await expect(tab.cdp.evaluate("[innerWidth, innerHeight]")).resolves.toEqual([1280, 800]);

    // Observation with the form arrives, tab id stamped.
    await expect.poll(() => observations.find((o) => o.tabId === id && o.forms.length > 0), { timeout: 10_000 }).toBeTruthy();
    const observed = observations.find((o) => o.tabId === id && o.forms.length > 0)!;
    expect(observed.forms[0]!.fields.map((f) => f.name)).toEqual(["email"]);

    // Title change (Chrome sends no target-info event for this) → summary-changed.
    events.length = 0;
    await tab.cdp.evaluate("document.title = 'Renamed'");
    await expect.poll(() => tab.title(), { timeout: 10_000 }).toBe("Renamed");
    expect(events).toContainEqual({ type: "summary-changed" });

    // main-frame-navigation fires before the document request reaches the network log.
    await tab.cdp.send("Network.enable");
    const order: string[] = [];
    const offLife = backend.onLifecycle((e) => {
      if (e.type === "main-frame-navigation" && e.tabId === id) order.push(`nav:${e.url}`);
    });
    const offCdp = tab.cdp.onEvent((method, params) => {
      if (method === "Network.requestWillBeSent" && params.type === "Document") order.push("document-request");
    });
    events.length = 0;
    await tab.navigate(`${base}/second`);
    offLife();
    offCdp();
    expect(order).toEqual([`nav:${base}/second`, "document-request"]);
    expect(events.filter((e) => e.type === "main-frame-navigation")).toHaveLength(1);
    expect(events).toContainEqual({ type: "load-finished", tabId: id });
    expect(tab.summary()).toMatchObject({ title: "Second", url: `${base}/second` });

    // Same-document navigation updates the summary but is not a main-frame navigation.
    events.length = 0;
    await tab.cdp.evaluate("history.pushState({}, '', '/second#more')");
    await expect.poll(() => tab.summary().url, { timeout: 5_000 }).toBe(`${base}/second#more`);
    expect(events.filter((e) => e.type === "main-frame-navigation")).toEqual([]);

    // Download into <dataDir>/downloads.
    await tab.navigate(`${base}/`);
    await tab.cdp.evaluate("document.getElementById('dl').click()", { userGesture: true });
    await expect.poll(() => downloads.find((d) => d.tabId === id)?.state, { timeout: 10_000 }).toBe("completed");
    const download = downloads.find((d) => d.tabId === id)!;
    expect(download).toMatchObject({ url: `${base}/file`, filename: "hello.txt", receivedBytes: 5, totalBytes: 5 });
    const file = path.join(dataDir, "downloads", "hello.txt");
    await expect.poll(() => existsSync(file), { timeout: 5_000 }).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("hello");

    // Popup opened by the page: adopted with its opener as parent, perception included.
    await tab.cdp.evaluate(`void window.open(${JSON.stringify(`${base}/`)}, "_blank")`, { userGesture: true });
    await expect.poll(() => backend.listTabs().find((t) => t.parentTabId === id), { timeout: 10_000 }).toBeTruthy();
    const popup = backend.listTabs().find((t) => t.parentTabId === id)!;
    expect(events).toContainEqual({ type: "created", tab: popup });
    await expect
      .poll(() => observations.some((o) => o.tabId === popup.id && o.forms.length > 0), { timeout: 10_000 })
      .toBe(true);

    // Close.
    events.length = 0;
    await backend.closeTab(popup.id);
    await backend.closeTab(id);
    expect(events).toContainEqual({ type: "closed", tabId: popup.id });
    expect(events).toContainEqual({ type: "closed", tabId: id });
    expect(backend.getTab(id)).toBeUndefined();
    await expect(backend.closeTab(id)).rejects.toThrow(/No tab/);
    expect(errors).toEqual([]);
  }, 60_000);

  it("explicit parentTabId; a failed load leaves the tab in status error", async () => {
    const parent = await backend.createTab("about:blank");
    const child = await backend.createTab("http://127.0.0.1:1/", { parentTabId: parent.id as TabId });
    expect(child.parentTabId).toBe(parent.id);
    expect(child.summary().status).toBe("error");
    expect(child.summary().statusMessage).toMatch(/ERR_/);
    await backend.closeTab(child.id);
    await backend.closeTab(parent.id);
  }, 60_000);
});
