import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  platform: "node",
  target: "node22",
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  tsconfig: "tsconfig.json",
});
