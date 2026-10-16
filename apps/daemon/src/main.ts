#!/usr/bin/env node
/**
 * `helmstack-daemon`: serves the HelmStack agent HTTP+SSE API (the same one as
 * the desktop app, so `@helmstack/mcp-server` works unchanged) on top of a
 * plain Chrome driven over CDP (ADR 0001, WP-F).
 */
import { readFileSync, realpathSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { HelmstackCore } from "../../../packages/devtools-core/src/core/helmstack-core.js";
import {
  AgentServerPortInUseError,
  DEFAULT_AGENT_PORT,
  agentTokenPath,
  createAgentServer,
  readOrCreateAgentToken,
  type AgentServer
} from "../../../packages/devtools-core/src/http/index.js";
import { ChromeBackend, DEFAULT_VIEWPORT, defaultDataDir } from "./chrome-backend.js";
import { ChromeNotFoundError } from "./chrome.js";

/**
 * The daemon's own version, from its package.json (one level above both src/ and dist/).
 * Used on generated reports. Undefined when it cannot be read; never throws.
 */
export function daemonVersion(): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

export const USAGE = `Usage: helmstack-daemon [options]

Serves the HelmStack agent API on 127.0.0.1, driving a plain Chrome over CDP.

Options:
  --port <n>              Port to listen on (default: $HELMSTACK_PORT or ${DEFAULT_AGENT_PORT}; 0 = any free port)
  --data-dir <dir>        State directory: token, baselines, downloads (default: ~/.helmstack/daemon)
  --chrome-path <file>    Chrome/Chromium executable (default: $HELMSTACK_CHROME_PATH, then auto-detect)
  --headful               Show the browser window (default: headless)
  --connect <browserURL>  Use an already-running Chrome, e.g. http://127.0.0.1:9222, instead of launching one
  -h, --help              Show this help

Auth: requests need the token from $HELMSTACK_AUTH_TOKEN, or else the one stored in
<data-dir>/helmstack-agent-token (created on first run).`;

export type DaemonConfig = {
  port: number;
  dataDir: string;
  chromePath?: string;
  headful: boolean;
  connect?: string;
  /** Explicit token; `null` disables auth (tests only). Default: $HELMSTACK_AUTH_TOKEN, else the persisted token. */
  authToken?: string | null;
};

/** Thrown for bad command-line input; `main` prints it with the usage text. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

/** Parses argv (without node/script). Returns `"help"` for -h/--help. */
export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): DaemonConfig | "help" {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        port: { type: "string" },
        "data-dir": { type: "string" },
        "chrome-path": { type: "string" },
        headful: { type: "boolean" },
        connect: { type: "string" },
        help: { type: "boolean", short: "h" }
      }
    }));
  } catch (error) {
    throw new CliUsageError((error as Error).message);
  }
  if (values.help) return "help";

  const rawPort = values.port ?? env.HELMSTACK_PORT?.trim() ?? String(DEFAULT_AGENT_PORT);
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliUsageError(`Invalid port "${rawPort}" (from ${values.port !== undefined ? "--port" : "HELMSTACK_PORT"}); expected 0-65535.`);
  }
  if (values.connect !== undefined) {
    let url: URL;
    try {
      url = new URL(values.connect);
    } catch {
      throw new CliUsageError(`Invalid --connect URL "${values.connect}"; expected e.g. http://127.0.0.1:9222`);
    }
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
      throw new CliUsageError(`Invalid --connect URL "${values.connect}"; expected an http(s):// browser URL or ws(s):// endpoint`);
    }
    if (values["chrome-path"] || values.headful) {
      throw new CliUsageError("--connect cannot be combined with --chrome-path or --headful (the browser is already running).");
    }
  }

  const config: DaemonConfig = {
    port,
    dataDir: values["data-dir"] ?? defaultDataDir(),
    headful: values.headful ?? false
  };
  if (values["chrome-path"]) config.chromePath = values["chrome-path"];
  if (values.connect) config.connect = values.connect;
  return config;
}

export type RunningDaemon = {
  server: AgentServer;
  core: HelmstackCore;
  backend: ChromeBackend;
  /** Actual bound port (differs from config when started with port 0). */
  port: number;
  url: string;
  authToken: string | null;
  /** Stops the server, disposes the core and closes (launched) or disconnects from (connected) Chrome. Idempotent. */
  close(): Promise<void>;
};

/** Fails fast (before launching Chrome) when the port is already bound. */
function assertPortFree(port: number, host: string): Promise<void> {
  if (port === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "EADDRINUSE" ? new AgentServerPortInUseError(host, port, error) : error)
    );
    probe.listen(port, host, () => probe.close(() => resolve()));
  });
}

/** Starts Chrome, the shared core and the agent server. */
export async function startDaemon(config: DaemonConfig, env: NodeJS.ProcessEnv = process.env): Promise<RunningDaemon> {
  const host = "127.0.0.1" as const;
  await assertPortFree(config.port, host);

  const authToken =
    config.authToken !== undefined ? config.authToken : env.HELMSTACK_AUTH_TOKEN?.trim() || readOrCreateAgentToken(config.dataDir);

  const backend = await ChromeBackend.launch({
    dataDir: config.dataDir,
    viewport: DEFAULT_VIEWPORT,
    chrome: config.connect
      ? /^wss?:/.test(config.connect)
        ? { wsEndpoint: config.connect }
        : { browserURL: config.connect }
      : { executablePath: config.chromePath, headless: !config.headful }
  });
  const core = new HelmstackCore(backend, { dataDir: config.dataDir, helmstackVersion: daemonVersion() });
  // Headless: there is no human window, so the agent (token holder) approves.
  const server = createAgentServer({ api: core, backend: "daemon", authToken, port: config.port, host, approvals: "agent" });
  try {
    await server.start();
  } catch (error) {
    core.dispose();
    await backend.close();
    throw error;
  }

  const port = server.boundPort ?? config.port;
  let closing: Promise<void> | null = null;
  return {
    server,
    core,
    backend,
    port,
    url: `http://${host}:${port}`,
    authToken,
    close() {
      closing ??= (async () => {
        await server.stop().catch(() => {});
        core.dispose();
        await backend.close();
      })();
      return closing;
    }
  };
}

type MainIo = {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Registers shutdown signal handlers. Default: SIGINT/SIGTERM on `process`. */
  onSignal?: (handler: (signal: NodeJS.Signals) => void) => void;
};

/**
 * CLI entry. Resolves to the exit code for startup failures and `--help`;
 * otherwise runs until SIGINT/SIGTERM, then shuts down cleanly and resolves 0.
 */
export async function main(argv: string[] = process.argv.slice(2), io: MainIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const log = io.log ?? ((line: string) => console.log(line));
  const error = io.error ?? ((line: string) => console.error(line));

  let config: DaemonConfig | "help";
  try {
    config = parseCliArgs(argv, env);
  } catch (err) {
    error(`helmstack-daemon: ${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (config === "help") {
    log(USAGE);
    return 0;
  }

  let daemon: RunningDaemon;
  try {
    daemon = await startDaemon(config, env);
  } catch (err) {
    if (err instanceof AgentServerPortInUseError || err instanceof ChromeNotFoundError) {
      error(`helmstack-daemon: ${err.message}`);
    } else {
      error(`helmstack-daemon: failed to start: ${(err as Error).stack ?? String(err)}`);
    }
    return 1;
  }

  log(`HelmStack daemon listening on ${daemon.url} (backend: daemon, data dir: ${config.dataDir})`);
  const chromePid = daemon.backend.browserProcessId;
  log(config.connect ? `Chrome: connected to ${config.connect}` : `Chrome: pid ${chromePid ?? "unknown"}${config.headful ? " (headful)" : " (headless)"}`);
  if (daemon.authToken && !env.HELMSTACK_AUTH_TOKEN?.trim()) log(`Auth token: ${agentTokenPath(config.dataDir)}`);

  return new Promise<number>((resolve) => {
    let stopping = false;
    const onSignal =
      io.onSignal ??
      ((handler: (signal: NodeJS.Signals) => void) => {
        process.on("SIGINT", handler);
        process.on("SIGTERM", handler);
      });
    onSignal((signal) => {
      if (stopping) {
        error(`helmstack-daemon: ${signal} again, exiting immediately`);
        resolve(130);
        return;
      }
      stopping = true;
      log(`helmstack-daemon: ${signal} received, shutting down`);
      daemon.close().then(
        () => resolve(0),
        (err: unknown) => {
          error(`helmstack-daemon: shutdown failed: ${(err as Error).message}`);
          resolve(1);
        }
      );
    });
  });
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  void main().then((code) => process.exit(code));
}
