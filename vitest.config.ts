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
            "packages/mcp-server/test/**/*.test.ts"
          ],
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
        // Headless daemon: plain Node, no jsdom globals (the jsdom setup file
        // above touches `window`, so it can't run here).
        test: {
          name: "daemon",
          include: ["apps/daemon/test/**/*.test.ts"],
          environment: "node"
        }
      }
    ]
  }
});
