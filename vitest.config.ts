import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/perception/test/**/*.test.ts", "apps/desktop/test/**/*.test.ts", "packages/mcp-server/test/**/*.test.ts"],
    environment: "jsdom",
    setupFiles: ["./packages/perception/test/setup.ts"],
    environmentOptions: {
      jsdom: {
        url: "https://example.com/"
      }
    }
  }
});
