/**
 * Release graph guard. multi-semantic-release decides which packages to release from
 * the dependencies declared in package.json. Several packages import another
 * workspace package's *source* by relative path (and the tsup bundles inline it), which
 * the tool cannot see. If that import is not also declared, a change in the imported
 * package would not release the importer: the published daemon would silently go stale.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../..");

type Pkg = { dir: string; name: string; declared: Set<string> };

function loadPackages(): Pkg[] {
  const dirs: string[] = [];
  for (const group of ["packages", "apps"]) {
    const base = path.join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const dir = path.join(base, entry);
      if (existsSync(path.join(dir, "package.json"))) dirs.push(dir);
    }
  }
  return dirs.map((dir) => {
    const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    const declared = new Set<string>();
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const name of Object.keys(manifest[section] ?? {})) declared.add(name);
    }
    return { dir, name: manifest.name as string, declared };
  });
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = path.join(d, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules" || entry === "dist" || entry === "generated") continue;
        walk(full);
      } else if (/\.(ts|tsx|mts|cts)$/.test(entry) && !/\.d\.ts$/.test(entry)) {
        out.push(full);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+|require\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

describe("release graph", () => {
  const packages = loadPackages();

  it("finds the workspace packages", () => {
    expect(packages.map((p) => p.name)).toEqual(expect.arrayContaining(["@helmstack/daemon", "@helmstack/devtools-core", "@helmstack/shared"]));
  });

  /** Published packages plus everything they (transitively) declare: what a release can inline. */
  function relevantPackages(): Set<Pkg> {
    const byName = new Map(packages.map((p) => [p.name, p]));
    const isPublished = (p: Pkg) => JSON.parse(readFileSync(path.join(p.dir, "package.json"), "utf8")).private !== true;
    const relevant = new Set<Pkg>();
    const visit = (p: Pkg) => {
      if (relevant.has(p)) return;
      relevant.add(p);
      for (const dep of p.declared) {
        const next = byName.get(dep);
        if (next) visit(next);
      }
    };
    packages.filter(isPublished).forEach(visit);
    return relevant;
  }

  it("every workspace package whose source is imported by relative path is declared", () => {
    const missing: string[] = [];
    const relevant = relevantPackages();
    for (const pkg of packages) {
      // The private desktop app is not inlined into anything that is published.
      if (!relevant.has(pkg)) continue;
      const imported = new Set<string>();
      for (const file of sourceFiles(path.join(pkg.dir, "src"))) {
        const text = readFileSync(file, "utf8");
        for (const m of text.matchAll(IMPORT)) {
          const resolved = path.resolve(path.dirname(file), m[1]);
          for (const other of packages) {
            if (other === pkg) continue;
            const otherSrc = path.join(other.dir, "src") + path.sep;
            if (resolved === path.join(other.dir, "src") || resolved.startsWith(otherSrc)) imported.add(other.name);
          }
        }
      }
      for (const name of imported) {
        if (!pkg.declared.has(name)) missing.push(`${pkg.name} imports ${name} source by relative path but does not declare it`);
      }
    }
    expect(missing, `Declare these as devDependencies ("*") so a change releases the importer:\n${missing.join("\n")}`).toEqual([]);
  });

  it("a published package never lists an unpublished workspace package as a runtime dependency", () => {
    const published = new Map<string, boolean>();
    const manifests = new Map<string, any>();
    for (const pkg of packages) {
      const manifest = JSON.parse(readFileSync(path.join(pkg.dir, "package.json"), "utf8"));
      manifests.set(pkg.name, manifest);
      published.set(pkg.name, manifest.private !== true);
    }
    const bad: string[] = [];
    for (const [name, manifest] of manifests) {
      if (!published.get(name)) continue;
      for (const dep of Object.keys(manifest.dependencies ?? {})) {
        if (published.has(dep) && published.get(dep) === false) bad.push(`${name} depends on private ${dep}`);
      }
    }
    expect(bad, "Move private workspace packages to devDependencies; npm users could not install them").toEqual([]);
  });
});
