import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PAGE_INJECT_GLOBAL, PAGE_INJECT_SOURCE } from "../src/generated/page-inject-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "../scripts/build-page-inject.mjs");
const generated = path.join(here, "../src/generated/page-inject-source.ts");

describe("generated page-inject source", () => {
  it("is up to date with src/page-inject.ts (rebuild: npm run build -w packages/perception)", () => {
    // esbuild runs in a child process: it refuses to run under jsdom's TextEncoder.
    const fresh = execFileSync(process.execPath, [script, "--stdout"], { encoding: "utf8" });
    expect(readFileSync(generated, "utf8")).toBe(fresh);
  }, 30_000);

  it("is a self-contained IIFE exposing install/extractOnceJson", () => {
    const bundle = new Function(`${PAGE_INJECT_SOURCE}\nreturn ${PAGE_INJECT_GLOBAL};`)() as Record<string, unknown>;
    expect(typeof bundle.install).toBe("function");
    expect(typeof bundle.extractOnceJson).toBe("function");
    expect(PAGE_INJECT_SOURCE).not.toMatch(/\brequire\(|\bimport\s/);
  });

  it("extracts forms in the page world", () => {
    document.body.innerHTML = `<form name="contact"><label for="e">Email</label><input id="e" name="email" type="email"><button type="submit">Send</button></form>`;
    const bundle = new Function(`${PAGE_INJECT_SOURCE}\nreturn ${PAGE_INJECT_GLOBAL};`)() as {
      extractOnceJson(config: { includeSocial?: boolean }): string;
    };
    const observation = JSON.parse(bundle.extractOnceJson({}));
    expect(observation.tabId).toBe("");
    expect(observation.forms).toHaveLength(1);
    expect(observation.forms[0].fields[0].name).toBe("email");
  });
});
