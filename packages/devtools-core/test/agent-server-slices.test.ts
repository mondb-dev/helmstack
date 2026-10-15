import * as http from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { AccountsApi, AgentApi, ExtensionsApi } from "../src/api.js";
import {
  type AgentServer,
  AgentServerPortInUseError,
  createAgentServer,
  UNSUPPORTED_ON_BACKEND
} from "../src/http/agent-server.js";
import { agentTokenPath, readOrCreateAgentToken } from "../src/http/token.js";

const calls: unknown[][] = [];

/** AgentApi stub with only what these routes touch; `pick` adds the optional picker. */
function stubApi(opts: { pick?: boolean } = {}): AgentApi {
  const api: Record<string, unknown> = {
    onTabsChanged() {},
    onPageObserved() {},
    onApprovalQueued() {},
    onHandoffRequested() {},
    onAssertionTransition() {},
    listTabs() {
      return [{ id: "tab-1", title: "Example", url: "https://example.com", isActive: true, status: "idle", statusMessage: "" }];
    },
    async reload(tabId: string, options: unknown) {
      calls.push(["reload", tabId, options]);
      return [{ id: tabId }];
    },
    async goBack(tabId: string) {
      calls.push(["back", tabId]);
      return [{ id: tabId }];
    },
    async goForward(tabId: string) {
      calls.push(["forward", tabId]);
      return [{ id: tabId }];
    }
  };
  if (opts.pick) api.pickElement = async (tabId: string) => ({ tabId, picked: true });
  return api as unknown as AgentApi;
}

const stubAccounts = {
  listAccounts: () => [{ id: "acc-1" }],
  saveAccount: () => ({ id: "acc-2" }),
  lookupAccounts: () => [],
  updateAccount: () => ({ id: "acc-1" }),
  deleteAccount: () => {},
  generateTotp: () => ({ code: "123456" })
} as unknown as AccountsApi;

const stubExtensions: ExtensionsApi = {
  listExtensions: async () => [{ id: "ext-1", name: "Ext", version: "1.0.0", sourcePath: "/x" }],
  loadExtension: async (p) => ({ id: "ext-2", name: "Ext2", version: "1.0.0", sourcePath: p }),
  removeExtension: async () => {}
};

type Res = { status: number; json: any };

function request(port: number, method: string, urlPath: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: urlPath,
        headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null });
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function startServer(...args: Parameters<typeof createAgentServer>): Promise<[AgentServer, number]> {
  const server = createAgentServer(...args);
  await server.start();
  return [server, server.boundPort!];
}

describe("agent server on a backend without optional slices (daemon)", () => {
  let server: AgentServer;
  let port: number;

  beforeAll(async () => {
    [server, port] = await startServer({ api: stubApi(), backend: "daemon", port: 0, authToken: null });
  });
  afterAll(() => server.stop());

  it("serves reload, back and forward and validates ignoreCache", async () => {
    calls.length = 0;
    expect((await request(port, "POST", "/api/tabs/tab-1/reload", {})).json).toEqual([{ id: "tab-1" }]);
    await request(port, "POST", "/api/tabs/tab-1/reload", { ignoreCache: true });
    expect((await request(port, "POST", "/api/tabs/tab-1/back")).status).toBe(200);
    expect((await request(port, "POST", "/api/tabs/tab-1/forward", {})).status).toBe(200);
    expect((await request(port, "POST", "/api/tabs/tab-1/reload", { ignoreCache: "yes" })).status).toBe(400);
    expect(calls).toEqual([
      ["reload", "tab-1", { ignoreCache: false }],
      ["reload", "tab-1", { ignoreCache: true }],
      ["back", "tab-1"],
      ["forward", "tab-1"]
    ]);
    // GET is not a history route.
    expect((await request(port, "GET", "/api/tabs/tab-1/reload")).status).toBeGreaterThanOrEqual(400);
  });

  it("reports backend and empty capabilities in /api/health", async () => {
    const res = await request(port, "GET", "/api/health");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "ok", tabs: 1, backend: "daemon", capabilities: [] });
  });

  it.each([
    ["GET", "/api/accounts", "accounts"],
    ["POST", "/api/accounts", "accounts"],
    ["GET", "/api/accounts/lookup/https%3A%2F%2Fexample.com", "accounts"],
    ["PATCH", "/api/accounts/acc-1", "accounts"],
    ["DELETE", "/api/accounts/acc-1", "accounts"],
    ["GET", "/api/accounts/acc-1/totp", "accounts"],
    ["GET", "/api/extensions", "extensions"],
    ["POST", "/api/extensions", "extensions"],
    ["DELETE", "/api/extensions/ext-1", "extensions"],
    ["GET", "/api/tabs/tab-1/pick", "pick"]
  ])("%s %s → 501 unsupported_on_backend", async (method, urlPath, feature) => {
    const res = await request(port, method, urlPath, method === "POST" || method === "PATCH" ? {} : undefined);
    expect(res.status).toBe(501);
    expect(res.json).toMatchObject({ code: UNSUPPORTED_ON_BACKEND, backend: "daemon", feature });
    expect(typeof res.json.error).toBe("string");
  });

  it("still 404s unknown routes", async () => {
    const res = await request(port, "GET", "/api/nope");
    expect(res.status).toBe(404);
  });
});

describe("agent server on a backend with every optional slice (desktop)", () => {
  let server: AgentServer;
  let port: number;

  beforeAll(async () => {
    [server, port] = await startServer({
      api: stubApi({ pick: true }),
      backend: "desktop",
      accounts: stubAccounts,
      extensions: stubExtensions,
      port: 0,
      authToken: null
    });
  });
  afterAll(() => server.stop());

  it("lists every optional capability in /api/health", async () => {
    const res = await request(port, "GET", "/api/health");
    expect(res.json).toMatchObject({ backend: "desktop", capabilities: ["accounts", "extensions", "pick"] });
  });

  it("routes accounts to the accounts slice", async () => {
    expect((await request(port, "GET", "/api/accounts")).json).toEqual([{ id: "acc-1" }]);
    expect((await request(port, "GET", "/api/accounts/acc-1/totp")).json).toEqual({ code: "123456" });
    expect((await request(port, "DELETE", "/api/accounts/acc-1")).json).toEqual({ deleted: "acc-1" });
  });

  it("routes extensions to the extensions slice", async () => {
    const list = await request(port, "GET", "/api/extensions");
    expect(list.status).toBe(200);
    expect(list.json[0].id).toBe("ext-1");
    const loaded = await request(port, "POST", "/api/extensions", { path: "/tmp/ext" });
    expect(loaded.json.sourcePath).toBe("/tmp/ext");
    expect((await request(port, "DELETE", "/api/extensions/ext-1")).json).toEqual({ removed: "ext-1" });
  });

  it("routes pick to api.pickElement", async () => {
    const res = await request(port, "GET", "/api/tabs/tab-1/pick");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ tabId: "tab-1", picked: true });
  });
});

describe("createAgentServer options", () => {
  it("takes backend from api.backend when no option is given", async () => {
    const api = Object.assign(stubApi(), { backend: "daemon" as const });
    const [server, port] = await startServer({ api, port: 0, authToken: null });
    try {
      expect((await request(port, "GET", "/api/health")).json.backend).toBe("daemon");
    } finally {
      await server.stop();
    }
  });

  it("requires a backend", () => {
    expect(() => createAgentServer({ api: stubApi(), port: 0, authToken: null })).toThrow(/backend/);
  });

  it("fails fast with a clear error when the port is already in use", async () => {
    const [first, port] = await startServer({ api: stubApi(), backend: "desktop", port: 0, authToken: null });
    try {
      const second = createAgentServer({ api: stubApi(), backend: "daemon", port, authToken: null });
      const err = await second.start().then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(AgentServerPortInUseError);
      expect((err as AgentServerPortInUseError).code).toBe("EADDRINUSE");
      expect((err as Error).message).toContain(`127.0.0.1:${port}`);
      expect((err as Error).message).toMatch(/already in use/);
    } finally {
      await first.stop();
    }
  });
});

describe("readOrCreateAgentToken", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("creates a 0600 token on first call and reuses it afterwards", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "helmstack-token-"));
    dirs.push(dir);
    const dataDir = path.join(dir, "nested");
    const token = readOrCreateAgentToken(dataDir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(agentTokenPath(dataDir), "utf8")).toBe(token);
    if (process.platform !== "win32") {
      expect(statSync(agentTokenPath(dataDir)).mode & 0o777).toBe(0o600);
    }
    expect(readOrCreateAgentToken(dataDir)).toBe(token);
  });
});
