import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "dom",
          include: [
            "packages/perception/test/**/*.test.ts",
            "apps/desktop/test/**/*.test.ts",
            "packages/mcp-server/test/**/*.test.ts",
            "packages/agent-sdk/test/**/*.test.ts",
            "packages/devtools-core/test/**/*.test.ts"
          ],
          // The contract suite drives real HTTP servers (and Chrome): node project below.
          exclude: ["**/node_modules/**", "packages/devtools-core/test/contract/**", "packages/devtools-core/test/agent-runner/local.test.ts"],
          environment: "jsdom",
          setupFiles: ["./packages/perception/test/setup.ts"],
          environmentOptions: {
            jsdom: {
              url: "https://example.com/"
            }
          }
        }
      },
      {
        // Local-model chat backend: real fetch + AbortController against fake loopback
        // servers. jsdom replaces AbortController with one undici rejects, so plain Node.
        test: {
          name: "local-models",
          include: ["packages/devtools-core/test/agent-runner/local.test.ts"],
          environment: "node"
        }
      },
      {
        // Headless daemon: plain Node, no jsdom globals (the jsdom setup file
        // above touches `window`, so it can't run here).
        test: {
          name: "daemon",
          include: ["apps/daemon/test/**/*.test.ts"],
          environment: "node",
          setupFiles: ["./apps/daemon/test/require-chrome.setup.ts"]
        }
      },
      {
        // Agent-API contract suite (packages/devtools-core/test/contract): one
        // HTTP scenario set run against the scripted backend, the real daemon
        // (headless Chrome) and, opt-in, a running desktop instance.
        test: {
          name: "contract",
          include: ["packages/devtools-core/test/contract/**/*.test.ts"],
          environment: "node",
          setupFiles: ["./apps/daemon/test/require-chrome.setup.ts"]
        }
      }
    ]
  }
});
