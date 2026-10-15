import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", lite: "src/lite/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
});
