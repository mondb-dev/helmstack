/**
 * "Connect an agent": installing HelmStack's MCP server into the AI clients
 * the human already uses. The renderer only ever names a client, an action
 * and a few allowlisted options; the main process builds every command and
 * path itself. Nothing here carries the agent token (only the token FILE path
 * ever reaches another app's config).
 */

export const MCP_CLIENT_IDS = ["claude-code", "claude-desktop", "gemini-cli", "codex-cli", "antigravity", "cursor", "generic", "chatgpt"] as const;
export type McpClientId = (typeof MCP_CLIENT_IDS)[number];

export const MCP_INSTALL_ACTIONS = ["preview", "install", "remove", "verify"] as const;
export type McpInstallAction = (typeof MCP_INSTALL_ACTIONS)[number];

/** Where the launched MCP server comes from. */
export type McpCommandSourceId = "bundled" | "npx";
export type McpToolset = "full" | "lite";

export type McpInstallOptions = {
  /** `lite` sets HELMSTACK_TOOLSET=lite (compact tools for small models). Default `full`. */
  toolset?: McpToolset;
  /** CLI clients only. `user` (default) is the only scope offered. */
  scope?: "user";
  /** Command source; default is the first available (bundled). */
  source?: McpCommandSourceId;
  /**
   * `install` / `remove` only: the `previewId` of the preview the human just
   * confirmed. Main re-derives the plan and refuses if it no longer matches.
   */
  confirm?: string;
};

export type McpInstallRequest = {
  clientId: McpClientId;
  action: McpInstallAction;
  options?: McpInstallOptions;
};

export type McpClientKind = "cli" | "json-file" | "copy-only" | "explainer";

export type McpClientStatus = {
  id: McpClientId;
  label: string;
  kind: McpClientKind;
  /** Binary on PATH and/or its config directory exists. */
  detected: boolean;
  /** Our `helmstack` entry is registered. */
  installed: boolean;
  /** Entry exists but is stale: different port, missing file, wrong command. */
  needsAttention: boolean;
  /** Why attention is needed, or why install is unavailable. */
  note?: string;
  version?: string;
  binaryPath?: string;
  /** Config file this client's install would write (JSON clients). */
  configPath?: string;
  /** False when HelmStack cannot install into this client right now (see `note`). */
  canInstall: boolean;
  /** How `configPath` / the CLI behaviour was established. */
  provenance: "verified-cli" | "docs-only";
};

export type McpCommandSource = {
  id: McpCommandSourceId;
  label: string;
  available: boolean;
  /** Why it is unavailable, e.g. "Package not published yet". */
  reason?: string;
  /** Exact command line this source would register. */
  commandLine?: string;
  warnings: string[];
};

export type McpInstallOverview = {
  /** False while the agent API is not listening or has no token file. */
  ready: boolean;
  /** Why installs are blocked, when `ready` is false. */
  blockedReason?: string;
  port: number | null;
  tokenFile: string | null;
  profile: string;
  sources: McpCommandSource[];
  clients: McpClientStatus[];
};

export type McpInstallPreview = {
  /** Echo this in `options.confirm` to install / remove. */
  previewId: string;
  kind: "command" | "file";
  /** What would change: add, update an existing entry, remove, or nothing. */
  change: "add" | "update" | "remove" | "none";
  /** Exact command line (CLI clients). */
  commandLine?: string;
  filePath?: string;
  /** Line diff of the file (JSON clients) or of the entry (CLI clients). */
  diff?: string;
  /** Text for the clipboard: the JSON snippet. */
  copyText: string;
  warnings: string[];
};

export type McpInstallResult = {
  ok: boolean;
  clientId: McpClientId;
  action: McpInstallAction;
  message: string;
  preview?: McpInstallPreview;
  /** `install` / `remove` without a matching `confirm`: nothing ran; show `preview` and ask. */
  needsConfirmation?: boolean;
  /** Verify: whether `helmstack` is registered in the client. */
  registered?: boolean;
  backupPath?: string;
  status?: McpClientStatus;
};
