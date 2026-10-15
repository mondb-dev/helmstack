/**
 * Environment handed to agent CLI child processes. HelmStack's own variables
 * (notably `HELMSTACK_AUTH_TOKEN`) and Electron/Node injection hooks are
 * removed so the agent can never read the agent-server token from its env; the
 * MCP server receives only the token *file path*.
 */
const BLOCKED_PREFIXES = ["HELMSTACK_", "ELECTRON_"];
const BLOCKED_NAMES = new Set(["NODE_OPTIONS", "NODE_PATH", "MCP_CONNECTION_NONBLOCKING"]);

export function scrubbedEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (BLOCKED_NAMES.has(key)) continue;
    if (BLOCKED_PREFIXES.some((p) => key.startsWith(p))) continue;
    out[key] = value;
  }
  return out;
}
