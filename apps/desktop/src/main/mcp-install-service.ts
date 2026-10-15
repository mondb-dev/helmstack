/**
 * "Connect an agent" — detection and execution around the pure core in
 * `mcp-install.ts`. Electron-free: everything environment-specific (home,
 * PATH, platform, the bundled entry, the live connection) is injected.
 *
 * The renderer only names a client + action + allowlisted options. Every
 * command, path and argument is built here.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type {
  McpClientId,
  McpClientKind,
  McpClientStatus,
  McpCommandSource,
  McpCommandSourceId,
  McpInstallOverview,
  McpInstallPreview,
  McpInstallRequest,
  McpInstallResult
} from "../../../../packages/shared/src/mcp-install.js";
import {
  NPM_PACKAGE,
  SERVER_NAME,
  assessEntry,
  buildServerSpec,
  claudeAddArgv,
  claudeGetArgv,
  claudeRemoveArgv,
  codexAddArgv,
  codexGetArgv,
  codexRemoveArgv,
  displayCommand,
  entryDiff,
  geminiAddArgv,
  geminiListArgv,
  geminiRemoveArgv,
  jsonEntry,
  jsonSnippet,
  mergeServer,
  parseClaudeGet,
  parseCodexGet,
  parseGeminiList,
  parseInstallRequest,
  planId,
  readEntry,
  removeServer,
  sanitizeOutput,
  scrubbedEnv,
  writeConfigAtomic,
  type FoundEntry,
  type LaunchSource,
  type ServerSpec
} from "./mcp-install.js";

export type ConnectionInfo = { port: number | null; tokenFile: string | null; profile: string };

export type McpInstallDeps = {
  homedir: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Executable running HelmStack (Electron binary, or node for the daemon). */
  execPath: string;
  /** True under Electron: the executable needs ELECTRON_RUN_AS_NODE=1. */
  electron: boolean;
  /** Absolute path of the bundled `helmstack-mcp.mjs`, or null when missing. */
  mcpEntry: string | null;
  isPackaged: boolean;
  getConnection(): ConnectionInfo | null;
  /** true = published, false = 404, null = could not check. Default hits the npm registry. */
  checkNpmPublished?: () => Promise<boolean | null>;
  /** Extra directories searched after PATH (GUI apps get a minimal PATH on macOS). */
  extraPathDirs?: string[];
  execTimeoutMs?: number;
  now?: () => Date;
};

type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: string };

const MAX_OUTPUT = 64 * 1024;

const LABELS: Record<McpClientId, string> = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  "gemini-cli": "Gemini CLI",
  "codex-cli": "Codex CLI",
  antigravity: "Antigravity",
  cursor: "Cursor",
  generic: "Other client (copy JSON)",
  chatgpt: "ChatGPT"
};
const KINDS: Record<McpClientId, McpClientKind> = {
  "claude-code": "cli",
  "claude-desktop": "json-file",
  "gemini-cli": "cli",
  "codex-cli": "cli",
  antigravity: "json-file",
  cursor: "json-file",
  generic: "copy-only",
  chatgpt: "explainer"
};
const CLI_BINARY: Partial<Record<McpClientId, string>> = { "claude-code": "claude", "gemini-cli": "gemini", "codex-cli": "codex" };
/** Clients whose CLI behaviour was exercised against a real binary in development. */
const VERIFIED_CLI = new Set<McpClientId>(["claude-code", "gemini-cli"]);
export const ORDERED_CLIENTS: McpClientId[] = ["claude-code", "claude-desktop", "gemini-cli", "codex-cli", "antigravity", "cursor", "generic", "chatgpt"];

export const CHATGPT_EXPLAINER =
  "ChatGPT only accepts remote MCP connectors on a public HTTPS URL, so a local server can't be installed there. " +
  "Using it would mean exposing HelmStack's agent API through a tunnel, which gives anyone with the URL a path to your browser. " +
  "That is a security decision HelmStack won't make for you.";

async function defaultNpmCheck(): Promise<boolean | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE.replace("/", "%2F")}`, {
      method: "GET",
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(4000)
    });
    if (res.status === 404) return false;
    if (res.ok) return true;
    return null;
  } catch {
    return null;
  }
}

export class McpInstallService {
  private npmCache: { at: number; value: boolean | null } | null = null;

  constructor(private readonly deps: McpInstallDeps) {}

  // ── environment helpers ───────────────────────────────────────────────────

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** Resolves an executable name against PATH (+ extra dirs); null when absent. */
  which(name: string): string | null {
    const dirs = [...(this.deps.env.PATH ?? "").split(path.delimiter), ...(this.deps.extraPathDirs ?? [])].filter(Boolean);
    const exts = this.deps.platform === "win32" ? (this.deps.env.PATHEXT ?? ".EXE;.CMD").split(";").map((e) => e.toLowerCase()) : [""];
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = path.join(dir, name + ext);
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
          // keep looking
        }
      }
    }
    return null;
  }

  private run(binary: string, argv: readonly string[]): Promise<RunResult> {
    const timeout = this.deps.execTimeoutMs ?? 15_000;
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const finish = (result: RunResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      let child;
      try {
        child = spawn(binary, [...argv], {
          shell: false,
          env: scrubbedEnv(this.deps.env),
          cwd: this.deps.homedir,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true
        });
      } catch (error) {
        finish({ code: null, stdout, stderr, timedOut: false, spawnError: error instanceof Error ? error.message : String(error) });
        return;
      }
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeout);
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_OUTPUT) stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        finish({ code: null, stdout, stderr, timedOut, spawnError: error.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        finish({ code, stdout, stderr, timedOut });
      });
    });
  }

  private async npmPublished(): Promise<boolean | null> {
    const ttl = 10 * 60 * 1000;
    if (this.npmCache && Date.now() - this.npmCache.at < ttl) return this.npmCache.value;
    const value = await (this.deps.checkNpmPublished ?? defaultNpmCheck)();
    this.npmCache = { at: Date.now(), value };
    return value;
  }

  // ── command sources ───────────────────────────────────────────────────────

  private async resolveSources(): Promise<Array<{ info: McpCommandSource; launch: LaunchSource | null }>> {
    const { deps } = this;
    const out: Array<{ info: McpCommandSource; launch: LaunchSource | null }> = [];

    // 1. Bundled server.
    const entry = deps.mcpEntry;
    if (!entry || !fs.existsSync(entry)) {
      out.push({
        info: { id: "bundled", label: "HelmStack's bundled MCP server", available: false, reason: "The MCP server bundle is missing from this build.", warnings: [] },
        launch: null
      });
    } else {
      const warnings: string[] = [];
      let launch: LaunchSource;
      const inAsar = /\.asar([\\/]|$)/.test(entry);
      const nodePath = inAsar ? null : this.which("node");
      let nodeOk = false;
      if (nodePath) {
        const version = await this.run(nodePath, ["--version"]);
        const major = Number(/^v(\d+)\./.exec(version.stdout.trim())?.[1] ?? 0);
        nodeOk = major >= 18;
      }
      if (nodePath && nodeOk) {
        launch = { command: nodePath, args: [entry], env: {} };
        if (/[\\/](\.nvm|\.fnm|\.volta|\.asdf|fnm_multishells)[\\/]/.test(nodePath)) {
          warnings.push("This node comes from a version manager; if you switch Node versions the path may stop working. Update the connection if it does.");
        }
      } else {
        launch = { command: deps.execPath, args: [entry], env: deps.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {} };
        warnings.push(
          nodePath || !this.which("node")
            ? "Node 18 or newer wasn't found on PATH, so the server runs through the HelmStack executable. HelmStack must stay installed where it is."
            : "Runs through the HelmStack executable."
        );
      }
      if (/\.app[\\/]/.test(entry) || /\.app[\\/]/.test(launch.command) || /[\\/]Program Files/i.test(entry) || /\.AppImage|[\\/]\.mount_/.test(entry)) {
        warnings.push("The server file lives inside the HelmStack app bundle. Moving or updating the app can break this connection; use Update afterwards.");
      }
      if (!deps.isPackaged) warnings.push("Development build: this points into your working copy.");
      out.push({
        info: {
          id: "bundled",
          label: "HelmStack's bundled MCP server",
          available: true,
          commandLine: displayCommand(launch.command, launch.args),
          warnings
        },
        launch
      });
    }

    // 2. npx @helmstack/mcp-server — only when it exists on npm.
    const npx = this.which("npx");
    const published = await this.npmPublished();
    if (npx && published === true) {
      const launch: LaunchSource = { command: npx, args: ["-y", NPM_PACKAGE], env: {} };
      out.push({
        info: { id: "npx", label: `npx ${NPM_PACKAGE}`, available: true, commandLine: displayCommand(npx, launch.args), warnings: ["Downloads the package from npm the first time an agent starts it."] },
        launch
      });
    } else {
      const reason =
        published === false ? "Package not published yet." : published === null ? "Couldn't check whether the package is published." : "npx isn't on PATH.";
      out.push({ info: { id: "npx", label: `npx ${NPM_PACKAGE}`, available: false, reason, warnings: [] }, launch: null });
    }
    return out;
  }

  // ── connection / spec ─────────────────────────────────────────────────────

  private blockedReason(): string | null {
    const connection = this.deps.getConnection();
    if (!connection || connection.port === null) {
      return "The agent API isn't listening, so there's no port to point an agent at. Fix that first (see the connection details) and try again.";
    }
    if (!connection.tokenFile) {
      return "This HelmStack takes its token from HELMSTACK_AUTH_TOKEN, not a token file. Connect an agent never copies the token into another app's config; restart HelmStack without that variable.";
    }
    if (!fs.existsSync(connection.tokenFile)) return "The agent token file doesn't exist yet.";
    return null;
  }

  private buildSpec(launch: LaunchSource, toolset: "full" | "lite"): ServerSpec {
    const connection = this.deps.getConnection();
    if (!connection || connection.port === null || !connection.tokenFile) throw new Error("The agent API isn't ready.");
    return buildServerSpec({ source: launch, port: connection.port, tokenFile: connection.tokenFile, toolset, profile: connection.profile });
  }

  // ── client targets ────────────────────────────────────────────────────────

  private jsonTarget(id: McpClientId): { file: string | null; fileExists: boolean; dirExists: boolean; candidates: string[] } | null {
    const { homedir, platform, env } = this.deps;
    const exists = (p: string): boolean => fs.existsSync(p);
    if (id === "claude-desktop") {
      const dir =
        platform === "darwin"
          ? path.join(homedir, "Library", "Application Support", "Claude")
          : platform === "win32"
            ? path.join(env.APPDATA ?? path.join(homedir, "AppData", "Roaming"), "Claude")
            : path.join(homedir, ".config", "Claude");
      const file = path.join(dir, "claude_desktop_config.json");
      return { file, fileExists: exists(file), dirExists: exists(dir), candidates: [file] };
    }
    if (id === "cursor") {
      const file = path.join(homedir, ".cursor", "mcp.json");
      return { file, fileExists: exists(file), dirExists: exists(path.dirname(file)), candidates: [file] };
    }
    if (id === "antigravity") {
      const candidates = [
        path.join(homedir, ".gemini", "antigravity", "mcp_config.json"),
        path.join(homedir, ".gemini", "config", "mcp_config.json")
      ];
      const existing = candidates.find(exists) ?? null;
      return { file: existing, fileExists: existing !== null, dirExists: false, candidates };
    }
    return null;
  }

  private readText(file: string): string | null {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }

  private cliArgv(id: McpClientId): { add(spec: ServerSpec): string[]; remove: string[]; query: string[] } {
    switch (id) {
      case "claude-code":
        return { add: claudeAddArgv, remove: claudeRemoveArgv(), query: claudeGetArgv() };
      case "gemini-cli":
        return { add: geminiAddArgv, remove: geminiRemoveArgv(), query: geminiListArgv() };
      case "codex-cli":
        return { add: codexAddArgv, remove: codexRemoveArgv(), query: codexGetArgv() };
      default:
        throw new Error("Not a CLI client.");
    }
  }

  /** Reads the registered entry of a CLI client (running its own list/get command). */
  private async readCliEntry(id: McpClientId, binary: string): Promise<{ entry: FoundEntry; error?: string }> {
    const argv = this.cliArgv(id).query;
    const result = await this.run(binary, argv);
    if (result.spawnError) return { entry: { registered: false, env: {} }, error: sanitizeOutput(result.spawnError) };
    if (result.timedOut) return { entry: { registered: false, env: {} }, error: "The command timed out." };
    let entry: FoundEntry;
    // Gemini prints its server list to stderr when not attached to a terminal.
    const text = `${result.stdout}\n${result.stderr}`;
    if (id === "claude-code") entry = parseClaudeGet(text, result.code ?? 1);
    else if (id === "codex-cli") entry = parseCodexGet(text, result.code ?? 1);
    else {
      entry = parseGeminiList(text);
      // Env isn't printed by `gemini mcp list`; read it from the user settings it reports on.
      if (entry.registered) {
        const settings = this.readText(path.join(this.deps.homedir, ".gemini", "settings.json"));
        const raw = readEntry(settings) as { env?: Record<string, unknown> } | undefined;
        if (raw?.env && typeof raw.env === "object") {
          for (const [k, v] of Object.entries(raw.env)) if (typeof v === "string") entry.env[k] = v;
        }
      }
    }
    return { entry };
  }

  // ── status ────────────────────────────────────────────────────────────────

  private async clientStatus(id: McpClientId, expected: ServerSpec | null, blocked: string | null): Promise<McpClientStatus> {
    const base: McpClientStatus = {
      id,
      label: LABELS[id],
      kind: KINDS[id],
      detected: false,
      installed: false,
      needsAttention: false,
      canInstall: false,
      provenance: VERIFIED_CLI.has(id) ? "verified-cli" : "docs-only"
    };
    if (id === "chatgpt") return { ...base, note: CHATGPT_EXPLAINER };
    if (id === "generic") return { ...base, detected: true, note: "Paste this into any MCP client that takes an mcpServers JSON config." };

    const exists = (p: string): boolean => fs.existsSync(p);
    const issuesFor = (found: FoundEntry): { needsAttention: boolean; note?: string } => {
      if (!expected) return { needsAttention: false };
      const assessment = assessEntry(found, expected, exists);
      return assessment.matches ? { needsAttention: false } : { needsAttention: true, note: assessment.issues.join(" ") };
    };

    const cli = CLI_BINARY[id];
    if (cli) {
      const binary = this.which(cli);
      const configHint =
        id === "claude-code"
          ? exists(path.join(this.deps.homedir, ".claude.json")) || exists(path.join(this.deps.homedir, ".claude"))
          : id === "codex-cli"
            ? exists(this.deps.env.CODEX_HOME ?? path.join(this.deps.homedir, ".codex"))
            : false;
      // A leftover config folder is not an installed client: Verify and Install need the command.
      base.detected = binary !== null;
      if (this.deps.platform === "win32" && binary && /\.(cmd|bat)$/i.test(binary)) {
        return { ...base, binaryPath: binary, note: "Installed as a .cmd shim, which HelmStack can't run safely. Use Copy config and run it in a terminal." };
      }
      if (!binary) {
        return { ...base, note: configHint ? `${LABELS[id]} has a config folder but its command isn't on PATH. Use Copy config.` : undefined };
      }
      const version = await this.run(binary, ["--version"]);
      const read = await this.readCliEntry(id, binary);
      const attention = read.entry.registered ? issuesFor(read.entry) : { needsAttention: false };
      return {
        ...base,
        binaryPath: binary,
        version: version.code === 0 ? sanitizeOutput(version.stdout.split("\n")[0] ?? "", 60) : undefined,
        installed: read.entry.registered,
        needsAttention: attention.needsAttention,
        note: read.error ? `Couldn't read ${LABELS[id]}'s servers: ${read.error}` : attention.note,
        canInstall: blocked === null
      };
    }

    const target = this.jsonTarget(id);
    if (!target) return base;
    const appPresent =
      id === "cursor" ? this.which("cursor") !== null : false;
    base.detected = target.fileExists || target.dirExists || appPresent || target.candidates.some(exists);
    base.configPath = target.file ?? target.candidates[0];
    if (target.fileExists && target.file) {
      const text = this.readText(target.file);
      const parsed = readEntry(text);
      base.installed = parsed !== undefined;
      if (text !== null && mergeServer(text, expected ?? dummySpec).ok === false) {
        return { ...base, note: "The config file isn't valid JSON, so HelmStack won't touch it. Use Copy config." };
      }
      if (parsed !== undefined && typeof parsed === "object" && parsed) {
        const e = parsed as { command?: unknown; args?: unknown; env?: Record<string, unknown> };
        const found: FoundEntry = {
          registered: true,
          command: typeof e.command === "string" ? e.command : undefined,
          argsText: Array.isArray(e.args) ? e.args.map(String).join(" ") : undefined,
          env: Object.fromEntries(Object.entries(e.env ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>
        };
        const attention = issuesFor(found);
        base.needsAttention = attention.needsAttention;
        base.note = attention.note;
      }
    }
    if (id === "antigravity" && !target.fileExists) {
      return {
        ...base,
        detected: false,
        note: "No Antigravity MCP config found. Its docs list two possible paths, so HelmStack won't guess; use Copy config."
      };
    }
    base.canInstall = blocked === null && (target.fileExists || target.dirExists);
    if (!base.canInstall && !base.note && !target.dirExists && !target.fileExists) base.note = "Not found on this computer.";
    return base;
  }

  async overview(): Promise<McpInstallOverview> {
    const blocked = this.blockedReason();
    const connection = this.deps.getConnection();
    const sources = await this.resolveSources();
    const first = sources.find((s) => s.launch) ?? null;
    let expected: ServerSpec | null = null;
    if (blocked === null && first?.launch) {
      try {
        expected = this.buildSpec(first.launch, "full");
      } catch {
        expected = null;
      }
    }
    const clients = await Promise.all(ORDERED_CLIENTS.map((id) => this.clientStatus(id, expected, blocked)));
    return {
      ready: blocked === null,
      blockedReason: blocked ?? undefined,
      port: connection?.port ?? null,
      tokenFile: connection?.tokenFile ?? null,
      profile: connection?.profile ?? "fe-dev",
      sources: sources.map((s) => s.info),
      clients
    };
  }

  // ── actions ───────────────────────────────────────────────────────────────

  /** Entry point for IPC: validates the raw payload, then runs it. Throws on invalid input. */
  async handle(raw: unknown): Promise<McpInstallResult> {
    return this.run_(parseInstallRequest(raw));
  }

  private fail(request: McpInstallRequest, message: string, extra: Partial<McpInstallResult> = {}): McpInstallResult {
    return { ok: false, clientId: request.clientId, action: request.action, message, ...extra };
  }

  private async statusOf(id: McpClientId): Promise<McpClientStatus> {
    const sources = await this.resolveSources();
    const first = sources.find((s) => s.launch);
    const blocked = this.blockedReason();
    let expected: ServerSpec | null = null;
    if (blocked === null && first?.launch) {
      try {
        expected = this.buildSpec(first.launch, "full");
      } catch {
        expected = null;
      }
    }
    return this.clientStatus(id, expected, blocked);
  }

  /** A path for messages: the user's home directory shown as ~ so results stay short. */
  private shortPath(file: string): string {
    const home = this.deps.homedir;
    if (home && (file === home || file.startsWith(home + path.sep) || file.startsWith(`${home}/`))) return `~${file.slice(home.length)}`;
    return file;
  }

  private async run_(request: McpInstallRequest): Promise<McpInstallResult> {
    const { clientId, action } = request;
    const options = request.options ?? {};
    if (clientId === "chatgpt") return this.fail(request, CHATGPT_EXPLAINER);
    if (clientId === "generic" && (action === "install" || action === "remove" || action === "verify")) {
      return this.fail(request, "Copy the config and paste it into your client; HelmStack can't install into an unknown client.");
    }
    const blocked = this.blockedReason();
    if (blocked && action !== "remove" && action !== "verify") return this.fail(request, blocked);

    // Resolve the launch source (needed for preview/install; remove/verify use the first available for assessment only).
    const sources = await this.resolveSources();
    const wanted: McpCommandSourceId | undefined = options.source;
    const picked = wanted ? sources.find((s) => s.info.id === wanted) : sources.find((s) => s.launch);
    if (action === "preview" || action === "install") {
      if (!picked || !picked.launch) {
        return this.fail(request, picked?.info.reason ? `That command source isn't available: ${picked.info.reason}` : "No command source is available.");
      }
    }
    let spec: ServerSpec | null = null;
    if (picked?.launch && blocked === null) {
      try {
        spec = this.buildSpec(picked.launch, options.toolset ?? "full");
      } catch (error) {
        return this.fail(request, error instanceof Error ? error.message : "Couldn't build the server entry.");
      }
    }

    const kind = KINDS[clientId];
    if (kind === "cli") return this.runCli(request, spec, picked?.info.warnings ?? []);
    if (kind === "json-file") return this.runJson(request, spec, picked?.info.warnings ?? []);
    // generic preview
    if (!spec) return this.fail(request, blocked ?? "Not ready.");
    const preview: McpInstallPreview = {
      previewId: planId({ clientId, spec }),
      kind: "file",
      change: "add",
      copyText: jsonSnippet(spec),
      diff: entryDiff(undefined, jsonEntry(spec)),
      warnings: picked?.info.warnings ?? []
    };
    return { ok: true, clientId, action, message: "Ready to copy.", preview };
  }

  private async runJson(request: McpInstallRequest, spec: ServerSpec | null, sourceWarnings: string[]): Promise<McpInstallResult> {
    const { clientId, action } = request;
    const target = this.jsonTarget(clientId);
    if (!target) return this.fail(request, "Unknown client.");
    if (!target.file || (!target.fileExists && !target.dirExists)) {
      if (action === "preview" && spec) {
        // Copy config still works without a file to edit.
        const preview: McpInstallPreview = {
          previewId: planId({ clientId, spec }),
          kind: "file",
          change: "add",
          copyText: jsonSnippet(spec),
          diff: entryDiff(undefined, jsonEntry(spec)),
          warnings: sourceWarnings
        };
        return { ok: true, clientId, action, message: "Ready to copy.", preview };
      }
      return this.fail(request, "No config file for this client was found, so HelmStack won't create one. Use Copy config.");
    }
    const file = target.file;
    const text = target.fileExists ? this.readText(file) : null;
    if (target.fileExists && text === null) return this.fail(request, "Couldn't read the config file.");

    if (action === "verify") {
      const entry = readEntry(text);
      const registered = entry !== undefined;
      return {
        ok: true,
        clientId,
        action,
        registered,
        message: registered ? `helmstack is registered in ${file}.` : `helmstack is not registered in ${file}.`,
        status: await this.statusOf(clientId)
      };
    }

    const merged = action === "remove" ? removeServer(text) : spec ? mergeServer(text, spec) : null;
    if (!merged) return this.fail(request, "Not ready.");
    if (!merged.ok) return this.fail(request, merged.error);

    const copyText = spec ? jsonSnippet(spec) : "";
    const warnings = [...(action === "remove" ? [] : sourceWarnings)];
    if (clientId === "claude-desktop" || clientId === "cursor") warnings.push(`Restart ${LABELS[clientId]} to pick up the change.`);
    const preview: McpInstallPreview = {
      previewId: planId({ clientId, action, file, text: merged.text, change: merged.change }),
      kind: "file",
      change: merged.change,
      filePath: file,
      diff: entryDiff(merged.before, merged.after, file),
      copyText,
      warnings
    };
    if (action === "preview" || request.options?.confirm === undefined) {
      return { ok: true, clientId, action, message: "Review the change.", preview, needsConfirmation: action !== "preview" };
    }
    if (request.options.confirm !== preview.previewId) {
      return this.fail(request, "The file changed since you reviewed it. Review the change again.", { preview, needsConfirmation: true });
    }
    if (merged.change === "none") {
      return { ok: true, clientId, action, message: action === "remove" ? "Already removed." : "Already up to date.", preview, status: await this.statusOf(clientId) };
    }
    try {
      const { backupPath } = writeConfigAtomic(file, merged.text, this.now());
      return {
        ok: true,
        clientId,
        action,
        message: action === "remove" ? `Removed helmstack from ${this.shortPath(file)}.` : `${merged.change === "add" ? "Installed" : "Updated"} helmstack in ${this.shortPath(file)}.`,
        backupPath,
        preview,
        status: await this.statusOf(clientId)
      };
    } catch (error) {
      return this.fail(request, `Couldn't write the config file: ${sanitizeOutput(error instanceof Error ? error.message : String(error))}`);
    }
  }

  private async runCli(request: McpInstallRequest, spec: ServerSpec | null, sourceWarnings: string[]): Promise<McpInstallResult> {
    const { clientId, action } = request;
    const binaryName = CLI_BINARY[clientId] as string;
    const binary = this.which(binaryName);
    if (!binary) return this.fail(request, `${LABELS[clientId]}'s command (${binaryName}) isn't on PATH. Use Copy config instead.`);
    if (this.deps.platform === "win32" && /\.(cmd|bat)$/i.test(binary)) {
      return this.fail(request, `${LABELS[clientId]} is a .cmd shim, which HelmStack won't run. Use Copy config.`);
    }
    const argv = this.cliArgv(clientId);
    const current = await this.readCliEntry(clientId, binary);

    if (action === "verify") {
      if (current.error) return this.fail(request, `Couldn't ask ${LABELS[clientId]}: ${current.error}`);
      const registered = current.entry.registered;
      let message = registered ? `helmstack is registered in ${LABELS[clientId]}.` : `helmstack is not registered in ${LABELS[clientId]}.`;
      if (registered && current.entry.status) {
        message += ` Reported status: ${sanitizeOutput(current.entry.status, 80)}.`;
        if (clientId === "gemini-cli" && /disabled/i.test(current.entry.status)) {
          message += " Gemini lists user servers as disabled when asked from an untrusted folder.";
        }
      }
      return { ok: true, clientId, action, registered, message, status: await this.statusOf(clientId) };
    }

    const registered = current.entry.registered;
    let steps: Array<{ argv: string[]; ignoreFailure: boolean }> = [];
    let change: McpInstallPreview["change"];
    if (action === "remove") {
      change = registered ? "remove" : "none";
      if (registered) steps = [{ argv: argv.remove, ignoreFailure: false }];
    } else {
      if (!spec) return this.fail(request, "Not ready.");
      // Env/args can't always be read back (Codex), so an entry that can't be proven equal is rewritten.
      const provablyCurrent =
        registered &&
        current.entry.command !== undefined &&
        current.entry.argsText !== undefined &&
        Object.keys(current.entry.env).length > 0 &&
        assessEntry(current.entry, spec, (p) => fs.existsSync(p), true).matches;
      change = !registered ? "add" : provablyCurrent ? "none" : "update";
      if (change !== "none") {
        // Claude/Codex refuse to add an existing name; Gemini's add updates in place.
        if (registered && clientId !== "gemini-cli") steps.push({ argv: argv.remove, ignoreFailure: false });
        steps.push({ argv: argv.add(spec), ignoreFailure: false });
      }
    }

    const shown = steps.map((s) => displayCommand(binary, s.argv));
    const before = registered ? foundToEntry(current.entry) : undefined;
    const after = action === "remove" || !spec ? undefined : jsonEntry(spec);
    const preview: McpInstallPreview = {
      previewId: planId({ clientId, action, binary, steps, change }),
      kind: "command",
      change,
      commandLine: shown.length > 0 ? shown.join("\n") : displayCommand(binary, spec ? argv.add(spec) : argv.remove),
      diff: entryDiff(before, after),
      copyText: spec ? displayCommand(binary, argv.add(spec)) : "",
      warnings: action === "remove" ? [] : [...sourceWarnings, ...(change === "update" && clientId !== "gemini-cli" ? [`${LABELS[clientId]} has no update command, so the entry is removed and added again.`] : [])]
    };
    if (action === "preview" || request.options?.confirm === undefined) {
      return { ok: true, clientId, action, message: "Review the command.", preview, needsConfirmation: action !== "preview" };
    }
    if (request.options.confirm !== preview.previewId) {
      return this.fail(request, `Things changed since you reviewed it. Review the command again.`, { preview, needsConfirmation: true });
    }
    if (change === "none") {
      return { ok: true, clientId, action, message: action === "remove" ? "Already removed." : "Already up to date.", preview, status: await this.statusOf(clientId) };
    }
    for (const step of steps) {
      const result = await this.run(binary, step.argv);
      const detail = sanitizeOutput(result.stderr || result.stdout);
      if (result.spawnError || result.timedOut || result.code !== 0) {
        const why = result.timedOut ? "timed out after 15 seconds" : result.spawnError ? sanitizeOutput(result.spawnError) : detail || `exit code ${result.code}`;
        const partial = steps.length > 1 && step !== steps[0] ? " The previous entry was already removed; run Install again." : "";
        return this.fail(request, `${LABELS[clientId]} reported an error: ${why}.${partial}`, { status: await this.statusOf(clientId) });
      }
    }
    return {
      ok: true,
      clientId,
      action,
      message: action === "remove" ? `Removed helmstack from ${LABELS[clientId]}.` : `${change === "add" ? "Installed" : "Updated"} helmstack in ${LABELS[clientId]}.`,
      preview,
      status: await this.statusOf(clientId)
    };
  }
}

const dummySpec: ServerSpec = { command: "node", args: ["x"], env: {} };

function foundToEntry(found: FoundEntry): unknown {
  return {
    ...(found.command !== undefined ? { command: found.command } : {}),
    ...(found.argsText !== undefined ? { args: found.argsText === "" ? [] : found.argsText.split(" ") } : {}),
    ...(Object.keys(found.env).length > 0 ? { env: found.env } : {})
  };
}

/**
 * IPC handler bodies, kept Electron-free so the sender check and request
 * validation are testable. `isShellSender` is true only for the shell
 * window's own webContents.
 */
export function createMcpInstallIpc(service: McpInstallService, isShellSender: (sender: unknown) => boolean) {
  const guard = (sender: unknown): void => {
    if (!isShellSender(sender)) throw new Error("Connecting an agent is only available from the HelmStack window.");
  };
  return {
    overview: (sender: unknown) => {
      guard(sender);
      return service.overview();
    },
    run: (sender: unknown, raw: unknown) => {
      guard(sender);
      return service.handle(raw);
    }
  };
}

export { SERVER_NAME };
