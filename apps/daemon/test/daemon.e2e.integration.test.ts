// @vitest-environment node
/**
 * End-to-end: the daemon CLI serving the agent API over a real headless Chrome,
 * driven through the agent SDK, the raw HTTP API and the unchanged mcp-server.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBrowserClient } from "../../../packages/agent-sdk/src/index.js";
import { tryFindChrome } from "../src/chrome.js";
import { startDaemon, type RunningDaemon } from "../src/main.js";

// Real-Chrome tests flake on the Windows runner ("The browser is already running for …") and the
// daemon is not verified on Windows; set HELMSTACK_TEST_WINDOWS_CHROME=1 to run them there.
const chrome = process.platform === "win32" && process.env.HELMSTACK_TEST_WINDOWS_CHROME !== "1" ? null : tryFindChrome();
const here = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(here, "..");
const repoRoot = path.resolve(daemonDir, "../..");
const mcpEntry = path.join(repoRoot, "packages/mcp-server/dist/index.js");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const FORM_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html lang="en"><title>Contact</title>
<main><h1>Contact us</h1>
<form name="contact">
  <label for="email">Email</label><input id="email" name="email" type="email" required>
  <button type="submit">Send message</button>
</form></main></html>`)}`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

describe.skipIf(!chrome)("daemon end to end (in-process server, agent SDK)", () => {
  let dataDir: string;
  let daemon: RunningDaemon;
  const token = randomBytes(16).toString("hex");

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "helmstack-daemon-e2e-"));
    daemon = await startDaemon({ port: 0, dataDir, headful: false, chromePath: chrome!.path, authToken: token });
  }, 60_000);

  afterAll(async () => {
    await daemon?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("serves the agent API: tabs, perception, screenshot, a11y, 501 slices, health, auth", async () => {
    const api = (p: string, init: RequestInit = {}) =>
      fetch(`${daemon.url}${p}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
    const client = createBrowserClient({ port: daemon.port, authToken: token });

    const health = (await (await api("/api/health")).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ status: "ok", backend: "daemon", capabilities: [] });
    expect((await fetch(`${daemon.url}/api/health`)).status).toBe(401);

    const before = new Set((await client.listTabs()).map((t) => t.id));
    const tabs = await client.openTab(FORM_PAGE);
    const tab = tabs.find((t) => !before.has(t.id))!;
    expect(tab).toBeDefined();

    // Perception: forms come from the CDP-injected observation.
    await expect
      .poll(async () => (await client.getPerception(tab.id)).observation?.forms.length ?? 0, { timeout: 15_000 })
      .toBeGreaterThan(0);
    const packet = await client.getPerception(tab.id);
    expect(packet.tabId).toBe(tab.id);
    expect(packet.observation!.forms[0]!.fields.map((f) => f.name)).toEqual(["email"]);
    expect(packet.result.graph.forms.length).toBeGreaterThan(0);
    expect(packet.result.graph.title).toBe("Contact");

    const shot = await client.getScreenshotBuffer(tab.id);
    expect(shot.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(shot.readUInt32BE(16)).toBe(1280); // launch viewport width

    const audit = await client.auditAccessibility(tab.id);
    expect(typeof audit.score).toBe("number");
    expect(Array.isArray(audit.violations)).toBe(true);

    for (const route of ["/api/accounts", "/api/extensions", `/api/tabs/${tab.id}/pick`]) {
      const res = await api(route);
      expect(res.status, route).toBe(501);
      expect(await res.json()).toMatchObject({ code: "unsupported_on_backend", backend: "daemon" });
    }

    const closed = await api(`/api/tabs/${tab.id}`, { method: "DELETE" });
    expect(closed.ok).toBe(true);
    expect((await client.listTabs()).some((t) => t.id === tab.id)).toBe(false);
  }, 60_000);
});

describe.skipIf(!chrome)("daemon CLI binary (spawned) + unchanged mcp-server", () => {
  let dataDir: string;
  let proc: ChildProcess;
  let output = "";
  let url = "";
  let chromePid = 0;
  const token = randomBytes(16).toString("hex");

  beforeAll(async () => {
    // Build the real bin (dist/main.js) so this exercises what `npx helmstack-daemon` runs.
    // Run tsup's JS entry with node (not node_modules/.bin/tsup, a shell shim that execFile can't run on Windows).
    execFileSync(process.execPath, [path.join(repoRoot, "node_modules/tsup/dist/cli-default.js")], { cwd: daemonDir, stdio: "pipe" });
    dataDir = await mkdtemp(path.join(tmpdir(), "helmstack-daemon-cli-"));
    proc = spawn(process.execPath, [path.join(daemonDir, "dist/main.js"), "--port", "0", "--data-dir", dataDir, "--chrome-path", chrome!.path], {
      env: { ...process.env, HELMSTACK_AUTH_TOKEN: token, HELMSTACK_PORT: "" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    proc.stdout!.on("data", (d: Buffer) => (output += d.toString()));
    proc.stderr!.on("data", (d: Buffer) => (output += d.toString()));
    const ready = await waitUntil(() => /listening on (http:\/\/127\.0\.0\.1:\d+)/.test(output) && /pid \d+/.test(output), 60_000);
    if (!ready) throw new Error(`daemon did not start:\n${output}`);
    url = /listening on (http:\/\/127\.0\.0\.1:\d+) \(backend: daemon/.exec(output)![1]!;
    chromePid = Number(/Chrome: pid (\d+)/.exec(output)![1]);
  }, 120_000);

  afterAll(async () => {
    if (proc && proc.exitCode === null) proc.kill("SIGKILL");
    if (chromePid && isAlive(chromePid)) process.kill(chromePid, "SIGKILL");
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it.skipIf(!existsSync(mcpEntry))("mcp-server (unchanged) lists its tools and drives the daemon", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpEntry],
      // mcp-server skips connecting stdio when VITEST is set (its own tests import it); strip it.
      env: {
        ...(Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST"))) as Record<string, string>),
        HELMSTACK_PORT: new URL(url).port,
        HELMSTACK_AUTH_TOKEN: token
      },
      stderr: "pipe"
    });
    let mcpStderr = "";
    transport.stderr?.on("data", (d: Buffer) => (mcpStderr += d.toString()));
    const mcp = new Client({ name: "daemon-e2e", version: "0.0.0" });
    await mcp.connect(transport).catch((error: Error) => {
      throw new Error(`${error.message}; mcp-server stderr:\n${mcpStderr}`);
    });
    try {
      const { tools } = await mcp.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["browser_health", "browser_open_tab", "browser_get_perception", "browser_a11y_audit"]));

      const health = await mcp.callTool({ name: "browser_health", arguments: {} });
      expect(health.isError).toBeFalsy();
      expect(JSON.stringify(health.content)).toContain("daemon");

      const opened = await mcp.callTool({ name: "browser_open_tab", arguments: { url: FORM_PAGE } });
      expect(opened.isError).toBeFalsy();
      const tabsText = (opened.content as Array<{ text: string }>)[0]!.text;
      const tabId = (JSON.parse(tabsText) as Array<{ id: string; url: string }>).find((t) => t.url.startsWith("data:"))!.id;

      await expect
        .poll(
          async () => {
            const res = await mcp.callTool({ name: "browser_get_perception", arguments: { tabId } });
            const packet = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as { observation?: { forms: unknown[] } };
            return packet.observation?.forms.length ?? 0;
          },
          { timeout: 15_000 }
        )
        .toBeGreaterThan(0);
    } finally {
      await mcp.close();
    }
  }, 60_000);

  // Windows has no POSIX signals: Node's kill("SIGTERM") there is TerminateProcess,
  // so the daemon's graceful-shutdown handler never runs (exit code null, no log line).
  it.skipIf(process.platform === "win32")("SIGTERM shuts down cleanly: exit 0, Chrome gone", async () => {
    expect(isAlive(chromePid)).toBe(true);
    const exited = new Promise<number | null>((resolve) => proc.once("exit", (code) => resolve(code)));
    proc.kill("SIGTERM");
    await expect(exited).resolves.toBe(0);
    expect(output).toMatch(/SIGTERM received, shutting down/);
    expect(await waitUntil(() => !isAlive(chromePid), 10_000)).toBe(true);
  }, 30_000);
});
