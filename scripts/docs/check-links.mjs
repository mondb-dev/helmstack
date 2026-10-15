// Verifies relative links and heading anchors in Markdown files.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { ROOT } from "./lib.mjs";

/** GitHub-style heading slug. */
export function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

export function anchorsOf(markdown) {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, "");
  const seen = new Map();
  const anchors = new Set();
  for (const m of withoutCode.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = slug(m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"));
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

export function linksOf(markdown) {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  return [...withoutCode.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? m[2]);
}

export function checkLinks(files) {
  const problems = [];
  const anchorCache = new Map();
  const anchorsFor = (abs) => {
    if (!anchorCache.has(abs)) anchorCache.set(abs, anchorsOf(readFileSync(abs, "utf8")));
    return anchorCache.get(abs);
  };
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    const text = readFileSync(abs, "utf8");
    for (const link of linksOf(text)) {
      if (/^(https?:|mailto:|#?$)/.test(link) && !link.startsWith("#")) continue;
      const [target, hash] = link.split("#");
      const dest = target ? path.resolve(path.dirname(abs), decodeURI(target)) : abs;
      if (!dest.startsWith(ROOT)) {
        problems.push(`${rel}: link leaves the repository: ${link}`);
        continue;
      }
      if (!existsSync(dest)) {
        problems.push(`${rel}: broken link ${link}`);
        continue;
      }
      if (hash && statSync(dest).isFile() && dest.endsWith(".md") && !anchorsFor(dest).has(hash.toLowerCase())) {
        problems.push(`${rel}: missing anchor ${link}`);
      }
    }
  }
  return problems;
}
