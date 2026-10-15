// @vitest-environment node
import { existsSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchChrome, tryFindChrome, type ChromeHandle } from "../src/chrome.js";
import { ChromeTabs } from "../src/tabs.js";

// Real-Chrome tests flake on the Windows runner ("The browser is already running for …") and the
// daemon is not verified on Windows; set HELMSTACK_TEST_WINDOWS_CHROME=1 to run them there.
const chrome = process.platform === "win32" && process.env.HELMSTACK_TEST_WINDOWS_CHROME !== "1" ? null : tryFindChrome();
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function dataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

describe.skipIf(!chrome)("ChromeTabs against real headless Chrome", () => {
  let handle: ChromeHandle;
  let tabs: ChromeTabs;

  beforeAll(async () => {
    handle = await launchChrome({ executablePath: chrome!.path });
    tabs = await ChromeTabs.create(handle.browser);
  }, 60_000);

  afterAll(async () => {
    tabs?.dispose();
    await handle?.close();
  });

  it("opens, inspects, navigates, screenshots and closes a tab", async () => {
    let changes = 0;
    const offChanged = tabs.onTabsChanged(() => changes++);

    const tab = await tabs.open(dataUrl("<title>Hello HelmStack</title><main><h1>Hi</h1><button>Go</button></main>"));
    expect(tab.id).toMatch(/^tab-\d+$/);
    expect(tab.status).toBe("idle");
    expect(tab.isActive).toBe(true);

    const target = tabs.get(tab.id);
    expect(target.url()).toMatch(/^data:text\/html/);
    expect(target.isLoading()).toBe(false);

    const ax = await target.send<{ nodes: Array<{ role?: { value?: string }; name?: { value?: string } }> }>(
      "Accessibility.getFullAXTree"
    );
    expect(ax.nodes.some((n) => n.role?.value === "button" && n.name?.value === "Go")).toBe(true);

    await expect(target.evaluate<string>("document.title")).resolves.toBe("Hello HelmStack");
    await expect(target.evaluate("Promise.resolve(41).then((n) => n + 1)")).resolves.toBe(42);
    await expect(target.evaluate("(() => { throw new TypeError('kaboom') })()")).rejects.toThrow(/TypeError: kaboom/);

    // "*" wildcard capture sees protocol events from our session.
    const events: string[] = [];
    const offEvent = target.onEvent((method) => events.push(method));
    await tabs.navigate(tab.id, dataUrl("<title>Second</title><div style='height:3000px'>tall</div>"));
    offEvent();
    expect(events).toContain("Page.frameNavigated");
    expect(events).toContain("Page.frameStoppedLoading");
    await expect(target.evaluate("document.title")).resolves.toBe("Second");
    expect(target.url()).toContain("Second");

    const listed = await tabs.list();
    const summary = listed.find((t) => t.id === tab.id);
    expect(summary).toMatchObject({ title: "Second", status: "idle", isActive: true });

    await tabs.setViewport(tab.id, 400, 300, 2);
    await expect(target.evaluate("[innerWidth, innerHeight, devicePixelRatio]")).resolves.toEqual([400, 300, 2]);

    const shot = await tabs.screenshot(tab.id);
    expect(shot.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(shot.readUInt32BE(16)).toBe(800); // IHDR width = 400 css px * dpr 2

    const full = await tabs.screenshot(tab.id, { fullPage: true });
    expect(full.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(full.readUInt32BE(20)).toBeGreaterThan(shot.readUInt32BE(20)); // taller than the viewport

    await tabs.close(tab.id);
    expect(tabs.has(tab.id)).toBe(false);
    expect(() => tabs.get(tab.id)).toThrow(/No tab/);
    expect(changes).toBeGreaterThan(0);
    offChanged();
  }, 60_000);

  it("reports navigation errors as tab status", async () => {
    const tab = await tabs.open();
    await expect(tabs.navigate(tab.id, "http://127.0.0.1:1/")).rejects.toThrow(/ERR_/);
    const summary = (await tabs.list()).find((t) => t.id === tab.id);
    expect(summary?.status).toBe("error");
    expect(summary?.statusMessage).toMatch(/ERR_/);
    await tabs.close(tab.id);
  }, 60_000);

  it("adopts tabs opened by the page (window.open)", async () => {
    const tab = await tabs.open(dataUrl("<title>opener</title>"));
    const before = (await tabs.list()).length;
    await tabs.get(tab.id).evaluate("void window.open('about:blank', '_blank')", { userGesture: true });
    await expect.poll(async () => (await tabs.list()).length, { timeout: 10_000 }).toBe(before + 1);
    await tabs.close(tab.id);
  }, 60_000);

  it("removes the temp profile on close", async () => {
    const other = await launchChrome({ executablePath: chrome!.path });
    const dir = other.userDataDir!;
    expect(existsSync(dir)).toBe(true);
    await other.close();
    await other.close(); // idempotent
    expect(existsSync(dir)).toBe(false);
  }, 60_000);
});
