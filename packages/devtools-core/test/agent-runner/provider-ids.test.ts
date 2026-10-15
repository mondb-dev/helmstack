/**
 * Every provider the runner can report must be startable through the shell's IPC
 * handler. This once broke: the handler hard-coded "claude" | "gemini", so local
 * models were listed in the dropdown but "Unknown agent CLI" on Send.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AGENT_CLI_IDS } from "../../../shared/src/agent-chat.js";
import { BUILTIN_ADAPTERS } from "../../src/agent-runner/adapters/index.js";
import { parseEndpoints } from "../../src/agent-runner/local/detect.js";

describe("agent provider ids", () => {
  it("the shared id list covers every CLI adapter and every local endpoint kind", () => {
    const reportable = new Set<string>([
      ...BUILTIN_ADAPTERS.map((a) => a.id),
      ...parseEndpoints(undefined).endpoints.map((e) => e.kind)
    ]);
    for (const id of reportable) expect(AGENT_CLI_IDS as readonly string[], id).toContain(id);
  });

  it("the desktop IPC handler validates against the shared list, not a hard-coded pair", () => {
    const main = readFileSync(path.resolve(__dirname, "../../../../apps/desktop/src/main/main.ts"), "utf8");
    expect(main).toContain("AGENT_CLI_IDS");
    expect(main).not.toMatch(/cliId\s*!==\s*"claude"/);
  });
});
