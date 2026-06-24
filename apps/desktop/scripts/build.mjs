import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const outDir = path.join(appRoot, "dist");

mkdirSync(outDir, { recursive: true });
mkdirSync(path.join(outDir, "renderer"), { recursive: true });

cpSync(path.join(appRoot, "src/renderer/index.html"), path.join(outDir, "renderer/index.html"));
cpSync(path.join(appRoot, "src/renderer/styles"), path.join(outDir, "renderer/styles"), { recursive: true });

await Promise.all([
  build({
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    tsconfig: path.join(appRoot, "tsconfig.json"),
    outfile: path.join(outDir, "main/main.cjs"),
    entryPoints: [path.join(appRoot, "src/main/main.ts")],
    external: ["electron"]
  }),
  build({
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    tsconfig: path.join(appRoot, "tsconfig.json"),
    outfile: path.join(outDir, "preload/shell-preload.cjs"),
    entryPoints: [path.join(appRoot, "src/preload/shell-preload.ts")],
    external: ["electron"]
  }),
  build({
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    tsconfig: path.join(appRoot, "tsconfig.json"),
    outfile: path.join(outDir, "preload/page-preload.cjs"),
    entryPoints: [path.join(appRoot, "src/preload/page-preload.ts")],
    external: ["electron"]
  }),
  build({
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "chrome138",
    tsconfig: path.join(appRoot, "tsconfig.json"),
    outfile: path.join(outDir, "renderer/shell.js"),
    entryPoints: [path.join(appRoot, "src/renderer/shell.ts")]
  })
]);
