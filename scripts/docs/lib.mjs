// Shared helpers for the docs generators. Plain Node ESM, no dependencies
// beyond the `typescript` package that is already installed for the repo.
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

/**
 * Import a dependency-free TypeScript source file by transpiling it in memory.
 * Works on any supported Node version (no --experimental-strip-types needed).
 */
export async function importTs(rel) {
  const ts = createRequire(import.meta.url)("typescript");
  const out = ts.transpileModule(read(rel), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  });
  const url = "data:text/javascript;base64," + Buffer.from(out.outputText).toString("base64");
  return import(url);
}

export const START = /<!--\s*generated:start\s+([a-z0-9-]+)\s*-->/g;
export const END = "<!-- generated:end -->";

/** Replace the body of every generated region found in `text` using `regions[name]`. */
export function applyRegions(text, regions, file = "") {
  const used = new Set();
  const result = text.replace(
    /(<!--\s*generated:start\s+([a-z0-9-]+)\s*-->)\n(?:(?!<!--\s*generated:start)[\s\S])*?(<!-- generated:end -->)/g,
    (_m, open, name, close) => {
      if (!(name in regions)) throw new Error(`${file}: unknown generated region "${name}"`);
      used.add(name);
      return `${open}\n${regions[name].trimEnd()}\n${close}`;
    }
  );
  return { text: result, used };
}

export function escapeCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function table(headers, rows) {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  return [head, sep, ...rows.map((r) => `| ${r.map(escapeCell).join(" | ")} |`)].join("\n");
}

/** All files under `dir` (relative to ROOT) whose name matches `re`. */
export function walk(dir, re, out = []) {
  const abs = path.join(ROOT, dir);
  for (const name of readdirSync(abs)) {
    const rel = path.join(dir, name);
    if (statSync(path.join(ROOT, rel)).isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      walk(rel, re, out);
    } else if (re.test(name)) out.push(rel);
  }
  return out;
}

export { pathToFileURL };
