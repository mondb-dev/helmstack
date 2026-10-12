import { defineConfig } from "tsup";

// @ts-expect-error -- plain .mjs build helper, no type declarations
import { writePageInjectModule } from "./scripts/build-page-inject.mjs";

export default defineConfig(async () => {
  // Regenerate the page-injectable perception bundle (src/generated/page-inject-source.ts)
  // before building, so it never drifts from src/page-inject.ts + dom-extractor.ts.
  await writePageInjectModule();
  return {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    splitting: false,
    sourcemap: true
  };
});
