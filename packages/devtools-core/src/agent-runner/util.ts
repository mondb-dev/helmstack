import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/** Write a file readable only by the current user. */
export function writePrivateFile(file: string, content: string): void {
  writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // best effort (e.g. Windows)
  }
}

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best effort
  }
}

/** Read a JSON file; null when missing or not valid JSON. Never logs content. */
export function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Strip control characters and clamp length for text shown to the user. */
export function cleanText(value: string, max: number): string {
  const stripped = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return stripped.length > max ? stripped.slice(0, max) : stripped;
}

/**
 * Map CLI failure output to a short, fixed, human-readable sentence. Raw stderr
 * is never surfaced: it can contain paths, prompts or credentials.
 */
export function classifyFailure(stderr: string, code: number | null): string {
  const s = stderr.toLowerCase();
  if (/not logged in|please (run )?.*login|log ?in|unauthenticated|authentication|oauth|api key|401|credential/.test(s)) {
    return "The CLI is not signed in. Sign in with the CLI in a terminal, then try again.";
  }
  if (/rate limit|quota|resource_exhausted|429|usage limit|overloaded|529/.test(s)) {
    return "The model is rate limited or out of quota. Try again later or pick another model.";
  }
  if (/model.*(not found|invalid|unknown|not exist|access)|invalid model|unknown model|404/.test(s)) {
    return "The selected model is not available for this account. Pick another model.";
  }
  if (/enoent|command not found/.test(s)) {
    return "The CLI could not be started.";
  }
  return code === null ? "The agent process ended unexpectedly." : `The agent process exited with an error (code ${code}).`;
}

/** `mcp__helmstack__browser_navigate` / `mcp_helmstack_browser_navigate` → `browser_navigate`. */
export function shortToolName(name: string, server = "helmstack"): { name: string; mcp: boolean } {
  for (const prefix of [`mcp__${server}__`, `mcp_${server}_`]) {
    if (name.startsWith(prefix)) return { name: name.slice(prefix.length), mcp: true };
  }
  return { name, mcp: false };
}

/** A fixed, argument-free description of a tool call. */
export function toolSummary(shortName: string, mcp: boolean): string {
  const words = shortName.replace(/^browser_/, "").replace(/_/g, " ").trim();
  return mcp ? words : `built-in tool (${words})`;
}
