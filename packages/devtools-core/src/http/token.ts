import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** File name of the persisted agent auth token inside a data directory. */
export const AGENT_TOKEN_FILE = "helmstack-agent-token";

/** Absolute path of the agent token file for a data directory. */
export function agentTokenPath(dataDir: string): string {
  return path.join(dataDir, AGENT_TOKEN_FILE);
}

/**
 * Read the persisted agent auth token, or generate and store one (0600) on
 * first launch. Local agents can read this file to authenticate without the
 * user having to set HELMSTACK_AUTH_TOKEN by hand.
 */
export function readOrCreateAgentToken(dataDir: string): string {
  const tokenPath = agentTokenPath(dataDir);
  try {
    if (existsSync(tokenPath)) {
      const existing = readFileSync(tokenPath, "utf8").trim();
      if (existing) return existing;
    }
  } catch {
    // fall through to regenerate
  }

  const token = randomBytes(32).toString("hex");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  return token;
}
