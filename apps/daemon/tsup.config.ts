import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/main.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  tsconfig: "tsconfig.json",
  // devtools-core's CommonJS deps (pngjs) are bundled into this ESM output and
  // call require() for Node builtins; give them a real require.
  banner: {
    js: 'import { createRequire as __helmstackCreateRequire } from "node:module"; const require = __helmstackCreateRequire(import.meta.url);'
  },
});
