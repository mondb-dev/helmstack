#!/usr/bin/env node
// Regenerates the marked regions in README.md and docs/**/*.md from source.
//   node scripts/docs/generate.mjs           write regions
//   node scripts/docs/generate.mjs --check   fail if a region is stale or a link is broken
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { checkLinks } from "./check-links.mjs";
import { envRows, extractLiteTools, extractMcpTools, extractRoutes, extractShortcuts, extractTokens } from "./extract.mjs";
import { ROOT, applyRegions, table, walk } from "./lib.mjs";

const firstSentence = (text) => {
  const m = /^(.+?[.!?])(?=\s+[A-Z`]|$)/s.exec(text.trim());
  return (m ? m[1] : text.trim()).replace(/\s+/g, " ");
};

export async function buildRegions() {
  const routes = extractRoutes();
  const mcp = extractMcpTools();
  const lite = await extractLiteTools();
  const shortcuts = await extractShortcuts();
  const env = envRows();

  const code = (s) => "`" + s + "`";
  const regions = {};

  regions["http-routes"] = table(
    ["Method", "Path", "Body / response"],
    routes.entries.map((e) => [e.method, code(e.path), e.notes || ""])
  );
  regions["http-events"] = routes.events.map((e) => "- " + code(e)).join("\n");
  regions["http-undocumented"] = routes.undocumented.length
    ? routes.undocumented.map((r) => "- " + code(r.replace(/:p/g, ":id"))).join("\n")
    : "_None._";

  regions["mcp-full"] = table(["Tool", "What it does"], mcp.full.map((t) => [code(t.name), firstSentence(t.description)]));
  regions["mcp-substrate"] = table(["Tool", "What it does"], mcp.substrate.map((t) => [code(t.name), firstSentence(t.description)]));
  regions["mcp-lite"] = table(
    ["Verb", "What it does", "Arguments"],
    lite.map((t) => [
      code(t.name),
      t.description,
      t.params.length
        ? t.params.map((p) => `${code(p.name)} (${p.type}${p.required ? "" : ", optional"})`).join(", ")
        : "none"
    ])
  );
  regions["mcp-counts"] =
    `The full toolset registers **${mcp.full.length}** tools by default and **${mcp.full.length + mcp.substrate.length}** ` +
    `when the agent-substrate surface is on. The lite toolset registers **${lite.length}** verbs.`;

  regions["env-vars"] = table(
    ["Variable", "Read by", "Default", "Meaning"],
    env.rows.map((r) => [code(r.name), r.scope, r.default, r.text])
  );

  const shortcutTable = (mac, win) => {
    const lines = [];
    for (let i = 0; i < mac.length; i += 1) {
      const section = mac[i];
      const other = win.find((s) => s.group === section.group);
      lines.push(`### ${section.group}`, "");
      lines.push(
        table(
          ["Action", "macOS", "Windows and Linux"],
          section.rows.map((row) => {
            const w = other?.rows.find((r) => r.id === row.id);
            return [row.label, row.keys.join(", "), w ? w.keys.join(", ") : ""];
          })
        ),
        ""
      );
    }
    return lines.join("\n");
  };
  regions["shortcuts"] = shortcutTable(shortcuts.mac, shortcuts.win);

  const tokens = extractTokens();
  const names = new Set([...tokens.dark.keys(), ...tokens.light.keys()]);
  regions["tokens-semantic"] = table(
    ["Token", "Dark", "Light"],
    [...names].map((n) => [code(n), tokens.dark.has(n) ? code(tokens.dark.get(n)) : "same as dark", tokens.light.has(n) ? code(tokens.light.get(n)) : "same as dark"])
  );
  const group = (prefix) => [...tokens.scale].filter(([n]) => prefix.test(n));
  const scaleTable = (entries) => table(["Token", "Value"], entries.map(([n, v]) => [code(n), code(v)]));
  regions["tokens-scales"] = [
    ["Neutral and status colors", /^--(neutral|white|black|green|amber|red|blue|violet)/],
    ["Spacing", /^--space-/],
    ["Typography", /^--(font|text|leading|weight)-/],
    ["Radius and elevation", /^--(radius|shadow)-/],
    ["Motion", /^--(ease|dur)/],
    ["Layering and sizes", /^--(z-|titlebar|navbar|sidebar|control|tap)/]
  ]
    .map(([title, re]) => `#### ${title}\n\n${scaleTable(group(re))}`)
    .join("\n\n");
  return regions;
}

export function docFiles() {
  return ["README.md", "CONTRIBUTING.md", ...walk("docs", /\.md$/)];
}

export async function run({ check }) {
  const regions = await buildRegions();
  const problems = [];
  const used = new Set();
  let changed = 0;
  for (const rel of docFiles()) {
    const file = path.join(ROOT, rel);
    const before = readFileSync(file, "utf8");
    let result;
    try {
      result = applyRegions(before, regions, rel);
    } catch (error) {
      problems.push(error.message);
      continue;
    }
    result.used.forEach((n) => used.add(n));
    if (result.text !== before) {
      changed += 1;
      if (check) problems.push(`${rel}: generated regions are stale (run npm run docs:generate)`);
      else writeFileSync(file, result.text);
    }
  }
  for (const name of Object.keys(regions)) {
    if (!used.has(name)) problems.push(`generated region "${name}" is not used in any document`);
  }
  if (check) problems.push(...checkLinks(docFiles()));
  return { problems, changed };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const check = process.argv.includes("--check");
  try {
    const { problems, changed } = await run({ check });
    if (problems.length) {
      console.error(problems.map((p) => `docs: ${p}`).join("\n"));
      process.exit(1);
    }
    console.log(check ? "docs: generated regions are current and links resolve" : `docs: regenerated (${changed} file(s) updated)`);
  } catch (error) {
    console.error(`docs: ${error.message}`);
    process.exit(1);
  }
}
