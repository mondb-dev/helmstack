import assert from "node:assert/strict";
import test from "node:test";

import { anchorsOf, linksOf, slug } from "../check-links.mjs";
import { extractMcpTools, extractRoutes, extractTokens, normalizeRoute } from "../extract.mjs";
import { applyRegions, table } from "../lib.mjs";

test("applyRegions replaces only the marked body and is idempotent", () => {
  const input = "intro\n<!-- generated:start a -->\nold\n<!-- generated:end -->\nmid\n<!-- generated:start b -->\n<!-- generated:end -->\nend\n";
  const once = applyRegions(input, { a: "new A", b: "new B" }).text;
  assert.equal(once, "intro\n<!-- generated:start a -->\nnew A\n<!-- generated:end -->\nmid\n<!-- generated:start b -->\nnew B\n<!-- generated:end -->\nend\n");
  assert.equal(applyRegions(once, { a: "new A", b: "new B" }).text, once);
});

test("applyRegions never swallows a neighbouring region", () => {
  const input = "<!-- generated:start a -->\n<!-- generated:start b -->\nx\n<!-- generated:end -->\n";
  const { used } = applyRegions(input, { a: "A", b: "B" });
  assert.ok(used.has("b"));
});

test("applyRegions rejects unknown region names", () => {
  assert.throws(() => applyRegions("<!-- generated:start nope -->\n<!-- generated:end -->", {}), /unknown generated region/);
});

test("table escapes pipes", () => {
  assert.match(table(["A"], [["x | y"]]), /x \\\| y/);
});

test("slug and anchors follow GitHub rules", () => {
  assert.equal(slug("Known caveat: agent isolation is advisory"), "known-caveat-agent-isolation-is-advisory");
  const anchors = anchorsOf("# T\n## Same\n## Same\n```\n## not a heading\n```\n");
  assert.deepEqual([...anchors].sort(), ["same", "same-1", "t"]);
});

test("linksOf ignores code and images are checked", () => {
  const md = "[a](x.md) `[b](y.md)`\n```\n[c](z.md)\n```\n![img](p.png)";
  assert.deepEqual(linksOf(md), ["x.md", "p.png"]);
});

test("normalizeRoute unifies parameter names", () => {
  assert.equal(normalizeRoute("/api/tabs/:id/watches/:wid"), "/api/tabs/:p/watches/:p");
});

const ROUTE_SOURCE = `
 * REST endpoints
 * --------------
 * GET  /api/health                         → { status }
 * POST /api/tabs/:id/navigate             { url: string }
 * DELETE /api/tabs/:id/logs               clears buffered logs * GET  /api/tabs/:id/mock                 → { rules }
 *
 * SSE stream
 * ----------
 * GET  /api/stream
 * Events: tabs_changed | page_observed
 */
if (p === "/api/health") {}
const a = p.match(/^\\/api\\/tabs\\/([^/]+)\\/navigate$/);
const b = p.match(/^\\/api\\/tabs\\/([^/]+)\\/evaluate$/);
const c = p.match(/^\\/api\\/tabs\\/([^/]+)\\/(reload|back)$/);
`;

test("extractRoutes parses the doc block and finds undocumented routes", () => {
  // The real parser guards against a block with too few entries; relax by padding.
  const pad = Array.from({ length: 60 }, (_, i) => ` * GET  /api/pad${i}\n`).join("");
  const src = ROUTE_SOURCE.replace(" * GET  /api/health", `${pad} * GET  /api/health`);
  const { entries, events, undocumented } = extractRoutes(src);
  assert.ok(entries.some((e) => e.method === "POST" && e.path === "/api/tabs/:id/navigate"));
  assert.ok(entries.some((e) => e.path === "/api/tabs/:id/mock"), "split a merged line");
  assert.deepEqual(events, ["tabs_changed", "page_observed"]);
  assert.ok(undocumented.includes("/api/tabs/:p/evaluate"));
  assert.ok(undocumented.includes("/api/tabs/:p/reload"));
  assert.ok(!undocumented.includes("/api/tabs/:p/navigate"));
});

test("extractMcpTools reads quoted, concatenated and template descriptions", () => {
  const src = `
export const AGENT_SUBSTRATE_TOOLS = [
  "browser_b"
] as const;
full.tool(
  "browser_a",
  "First. " +
    "Second.",
  {},
);
full.tool(
  "browser_b",
  \`Template \\\`text\\\`.\`,
  {},
);`;
  const { full, substrate } = extractMcpTools(src);
  assert.deepEqual(full, [{ name: "browser_a", description: "First. Second." }]);
  assert.equal(substrate[0].name, "browser_b");
  assert.equal(substrate[0].description, "Template `text`.");
});

test("extractMcpTools fails when a substrate tool is not registered", () => {
  assert.throws(() => extractMcpTools('export const AGENT_SUBSTRATE_TOOLS = [ "browser_x" ] as const;\n'), /not registered/);
});

test("extractTokens separates scales and themes", () => {
  const css = `:root { --a: 1; }\n:root,\n:root[data-theme="dark"] { --c: dark; }\n:root[data-theme="light"] { --c: light; }`;
  const t = extractTokens(css);
  assert.equal(t.scale.get("--a"), "1");
  assert.equal(t.dark.get("--c"), "dark");
  assert.equal(t.light.get("--c"), "light");
});
