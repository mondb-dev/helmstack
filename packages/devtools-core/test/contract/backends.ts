/**
 * Backend factories for the agent-API contract suite. Every factory yields a
 * running agent HTTP server; the scenarios only talk HTTP to it.
 *
 * - `daemonBackend`   real headless Chrome: ChromeBackend + HelmstackCore + createAgentServer (port 0).
 * - `scriptedBackend` HelmstackCore over the scripted in-memory backend (no browser; subset of scenarios).
 * - `externalBackend` an already-running instance (e.g. the desktop app), opt-in via
 *                     HELMSTACK_CONTRACT_URL + HELMSTACK_CONTRACT_TOKEN. Never defaults to 7070.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ChromeBackend, DEFAULT_VIEWPORT } from "../../../../apps/daemon/src/chrome-backend.js";
import { tryFindChrome } from "../../../../apps/daemon/src/chrome.js";
import { HelmstackCore } from "../../src/core/helmstack-core.js";
import { createAgentServer } from "../../src/http/index.js";
import { ScriptedBackend } from "./scripted-backend.js";

export type RunningBackend = {
  baseUrl: string;
  /** Bearer token, or null when the server runs without auth. */
  token: string | null;
  close(): Promise<void>;
};

export type BackendFactory = {
  name: string;
  /** False → scenarios marked `needsBrowser` are skipped (the backend has no real page). */
  realBrowser: boolean;
  /** Why the whole suite is skipped for this factory, or null when it can run. */
  skipReason: string | null;
  start(): Promise<RunningBackend>;
};

async function serveCore(core: HelmstackCore, onClose: () => Promise<void>): Promise<RunningBackend> {
  const token = randomBytes(16).toString("hex");
  const server = createAgentServer({ api: core, authToken: token, port: 0 });
  try {
    await server.start();
  } catch (error) {
    core.dispose();
    await onClose();
    throw error;
  }
  return {
    baseUrl: `http://127.0.0.1:${server.boundPort}`,
    token,
    async close() {
      await server.stop().catch(() => {});
      core.dispose();
      await onClose();
    }
  };
}

const chrome = tryFindChrome();

export const daemonBackend: BackendFactory = {
  name: "daemon (headless Chrome)",
  realBrowser: true,
  // CI_REQUIRE_CHROME=1 turns "no Chrome" into a failure (see the vitest setup file), never a skip.
  skipReason: chrome || process.env.CI_REQUIRE_CHROME === "1" ? null : "no Chrome found (set HELMSTACK_CHROME_PATH)",
  async start() {
    if (!chrome) throw new Error("daemon contract backend needs Chrome: set HELMSTACK_CHROME_PATH or install chrome@stable");
    const dataDir = await mkdtemp(path.join(tmpdir(), "helmstack-contract-daemon-"));
    const backend = await ChromeBackend.launch({
      dataDir,
      viewport: DEFAULT_VIEWPORT,
      chrome: { executablePath: chrome.path, headless: true }
    });
    const core = new HelmstackCore(backend, { dataDir });
    return serveCore(core, async () => {
      await backend.close();
      await rm(dataDir, { recursive: true, force: true });
    });
  }
};

export const scriptedBackend: BackendFactory = {
  name: "core + scripted backend",
  realBrowser: false,
  skipReason: null,
  async start() {
    const dataDir = await mkdtemp(path.join(tmpdir(), "helmstack-contract-scripted-"));
    const core = new HelmstackCore(new ScriptedBackend(), { dataDir });
    return serveCore(core, () => rm(dataDir, { recursive: true, force: true }));
  }
};

const externalUrl = process.env.HELMSTACK_CONTRACT_URL?.trim();

export const externalBackend: BackendFactory = {
  name: `external instance (${externalUrl ?? "HELMSTACK_CONTRACT_URL unset"})`,
  realBrowser: true,
  skipReason: externalUrl ? null : "set HELMSTACK_CONTRACT_URL (+ HELMSTACK_CONTRACT_TOKEN) to run against a running desktop/daemon",
  async start() {
    if (!externalUrl) throw new Error("HELMSTACK_CONTRACT_URL is not set");
    // Leaves the instance running; the scenarios close every tab they open.
    return {
      baseUrl: externalUrl.replace(/\/+$/, ""),
      token: process.env.HELMSTACK_CONTRACT_TOKEN?.trim() || null,
      close: async () => {}
    };
  }
};
