import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const httpDir = path.resolve(__dirname, "../../src/http");

describe("agent server exposes no agent-chat surface", () => {
  it("never references the runner, conversations or the chat channels", () => {
    for (const file of readdirSync(httpDir)) {
      const src = readFileSync(path.join(httpDir, file), "utf8");
      expect(src, file).not.toMatch(/agent-runner|AgentRunner|AgentConversation|startAgentConversation|\/api\/(agent-)?(chat|conversations?)/i);
    }
  });

  it("the daemon does not construct a runner", () => {
    const daemon = path.resolve(__dirname, "../../../../apps/daemon/src");
    for (const file of readdirSync(daemon)) {
      if (!file.endsWith(".ts")) continue;
      expect(readFileSync(path.join(daemon, file), "utf8"), file).not.toMatch(/AgentRunner|agent-runner/);
    }
  });
});
