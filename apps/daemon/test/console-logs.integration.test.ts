// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ConsoleLogEntry, TabId } from "@helmstack/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HelmstackCore } from "../../../packages/devtools-core/src/core/helmstack-core.js";
import { PERCEPTION_WORLD_NAME } from "../../../packages/devtools-core/src/perception/injector.js";
import { ChromeBackend } from "../src/chrome-backend.js";
import { tryFindChrome } from "../src/chrome.js";

const chrome = tryFindChrome();

const PAGE = `<!doctype html><title>Console</title><main><h1>Console test</h1><button>Go</button></main>`;

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error(`Condition not met in ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.skipIf(!chrome)("page console capture against real headless Chrome", () => {
  let server: http.Server;
  let base: string;
  let dataDir: string;
  let backend: ChromeBackend;
  let core: HelmstackCore;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dataDir = await mkdtemp(path.join(tmpdir(), "helmstack-console-it-"));
    backend = await ChromeBackend.launch({ dataDir, chrome: { executablePath: chrome!.path } });
    core = new HelmstackCore(backend, { dataDir });
  }, 60_000);

  afterAll(async () => {
    core?.dispose();
    await backend?.close();
    await new Promise((resolve) => server?.close(resolve));
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("records page console.* exactly once and ignores the helmstack isolated world", async () => {
    const tabs = await core.createTab(`${base}/`);
    const tabId = tabs.find((t) => t.url.startsWith(base))!.id as TabId;
    const cdp = backend.getTab(tabId)!.cdp;

    // Perception injector is live (pull goes through the helmstack world).
    await waitUntil(async () => (await core.capturePerception(tabId).catch(() => null)) !== null);
    core.clearTabLogs(tabId);

    await core.evaluateExpression(tabId, `console.log("hello", 42); console.error("boom"); 1`);

    // Our own code in the injector's isolated world must not show up as page logs.
    const { frameTree } = await cdp.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
    const { executionContextId } = await cdp.send<{ executionContextId: number }>("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: PERCEPTION_WORLD_NAME
    });
    await cdp.send("Runtime.evaluate", { expression: `console.log("from-helmstack-world")`, contextId: executionContextId });
    // More injector activity: a pulled observation.
    await core.capturePerception(tabId);

    const logs = (): ConsoleLogEntry[] => core.getTabLogs(tabId).consoleLogs;
    await waitUntil(() => logs().length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 300)); // let any duplicate arrive

    const before = Date.now();
    expect(logs().map((e) => [e.level, e.text])).toEqual([
      ["log", "hello 42"],
      ["error", "boom"]
    ]);
    for (const entry of logs()) {
      // Epoch milliseconds, recent — not CDP's monotonic clock.
      expect(entry.timestamp).toBeGreaterThan(before - 60_000);
      expect(entry.timestamp).toBeLessThanOrEqual(before);
    }

    await core.closeTab(tabId);
  }, 60_000);
});
