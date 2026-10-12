/**
 * Bundles `src/page-inject.ts` (and the extractor it imports) into a single
 * IIFE and writes it as a string export to
 * `src/generated/page-inject-source.ts`.
 *
 * Output is deterministic (paths relative to the package, no timestamps), so
 * the generated file is committed and a test rebuilds it to check it is fresh.
 *
 *   node scripts/build-page-inject.mjs            write the generated file
 *   node scripts/build-page-inject.mjs --stdout   print it instead (used by the freshness test)
 *   node scripts/build-page-inject.mjs --check    exit 1 if the committed file is stale
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFile = path.join(packageDir, "src/generated/page-inject-source.ts");

/** Global name the IIFE assigns its exports to; the injector wraps it in a closure. */
export const PAGE_INJECT_GLOBAL = "__helmstackPerceptionBundle";

export async function renderPageInjectModule() {
  const result = await build({
    absWorkingDir: packageDir,
    entryPoints: ["src/page-inject.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: PAGE_INJECT_GLOBAL,
    platform: "browser",
    target: "es2020",
    charset: "utf8",
    legalComments: "none",
    sourcemap: false,
    minify: false,
    logLevel: "silent"
  });
  const source = result.outputFiles[0].text;
  return [
    "// GENERATED FILE — do not edit. Rebuild with `npm run build -w packages/perception`",
    "// (or `node packages/perception/scripts/build-page-inject.mjs`). Source: src/page-inject.ts.",
    "",
    `/** Global the bundle assigns its exports (\`install\`) to. */`,
    `export const PAGE_INJECT_GLOBAL = ${JSON.stringify(PAGE_INJECT_GLOBAL)};`,
    "",
    "/** IIFE bundle of `page-inject.ts`; defines `var " + PAGE_INJECT_GLOBAL + " = { install }`. */",
    `export const PAGE_INJECT_SOURCE = ${JSON.stringify(source)};`,
    ""
  ].join("\n");
}

/** Regenerates the file if its content changed. Returns true when it was rewritten. */
export async function writePageInjectModule() {
  const rendered = await renderPageInjectModule();
  let current = null;
  try {
    current = readFileSync(outFile, "utf8");
  } catch {}
  if (current === rendered) return false;
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, rendered);
  return true;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const rendered = await renderPageInjectModule();
  if (process.argv.includes("--stdout")) {
    process.stdout.write(rendered);
  } else if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(outFile, "utf8");
    } catch {}
    if (current !== rendered) {
      console.error(`${path.relative(process.cwd(), outFile)} is stale; run: npm run build -w packages/perception`);
      process.exit(1);
    }
  } else {
    await writePageInjectModule();
  }
}
