import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  LITE_TOOL_NAMES,
  LITE_TOOL_SCHEMAS,
  createLiteSession,
  liteToolCallGbnf,
  liteToolCallJsonSchema,
  resolveLiteMaxChars
} from "../../src/lite/index.js";
import { contactSource, fakeBrowser, manyLinks, SECRET } from "./fixtures.js";

function setup(source = contactSource(), options: Parameters<typeof createLiteSession>[1] = {}) {
  const fake = fakeBrowser({ source });
  const session = createLiteSession(fake.browser, { settleMs: 0, screenshotDir: mkdtempSync(path.join(tmpdir(), "lite-test-")), ...options });
  return { fake, session };
}

const executes = (fake: ReturnType<typeof fakeBrowser>) => fake.calls.filter((c) => c.method === "execute").map((c) => c.args[1]);

describe("lite session: numbering", () => {
  it("look bumps the view counter and click maps the number to a DOM tool", async () => {
    const { fake, session } = setup();
    expect(await session.call("look")).toContain("· view 1");
    expect(await session.call("look")).toContain("· view 2");
    const out = await session.call("click", { n: 5 });
    expect(out).toContain('OK: Clicked [5] button "Send message".');
    expect(executes(fake)).toEqual([{ type: "invoke_site_tool", provider: "dom", toolName: "dom.submit.form-1", args: {} }]);
  });

  it("non-submit buttons and links use dom.activate", async () => {
    const { fake, session } = setup();
    await session.call("look");
    await session.call("click", { n: 7 });
    expect(executes(fake)).toEqual([{ type: "invoke_site_tool", provider: "dom", toolName: "dom.activate.act-docs", args: {} }]);
  });

  it("clicking a checkbox toggles it through dom.fill", async () => {
    const { fake, session } = setup();
    await session.call("look");
    await session.call("click", { n: 4 });
    expect(executes(fake)).toEqual([{ type: "invoke_site_tool", provider: "dom", toolName: "dom.fill.form-1", args: { "field-consent": true } }]);
  });

  it("type fills the field and can submit; the typed text is never echoed", async () => {
    const { fake, session } = setup();
    await session.call("look");
    const out = await session.call("type", { n: 2, text: SECRET, submit: true });
    expect(out).not.toContain(SECRET);
    expect(out).toContain("submitted the form");
    expect(executes(fake)).toEqual([
      { type: "invoke_site_tool", provider: "dom", toolName: "dom.fill.form-1", args: { "field-email": SECRET } },
      { type: "invoke_site_tool", provider: "dom", toolName: "dom.submit.form-1", args: {} }
    ]);
  });

  it("accepts numbers sent as strings", async () => {
    const { fake, session } = setup();
    await session.call("look");
    await session.call("type", { n: "1", text: "Ada" });
    expect(executes(fake)).toHaveLength(1);
  });

  it("an unknown number or a call before look returns the stale instruction", async () => {
    const { session } = setup();
    expect(await session.call("click", { n: 1 })).toBe("ERROR: That element number is from an older view. NEXT: look");
    await session.call("look");
    expect(await session.call("click", { n: 99 })).toBe("ERROR: That element number is from an older view. NEXT: look");
  });

  it("navigation invalidates numbers", async () => {
    const { fake, session } = setup();
    await session.call("look");
    // The page navigated on its own between look and click.
    (fake.browser as unknown as { navigate: (id: string, url: string) => Promise<unknown> }).navigate("tab-1", "http://127.0.0.1:4177/other.html");
    expect(await session.call("click", { n: 5 })).toContain("older view");
  });

  it("a number whose element vanished is stale, not a wrong click", async () => {
    const source = contactSource();
    const { fake, session } = setup(source);
    await session.call("look");
    source.actions = [];
    source.forms[0]!.submitActions = [];
    expect(await session.call("click", { n: 5 })).toContain("older view");
    expect(executes(fake)).toEqual([]);
  });

  it("wrong element kind gets a plain NEXT", async () => {
    const { session } = setup();
    await session.call("look");
    expect(await session.call("click", { n: 1 })).toBe('ERROR: [1] textbox "Full name" is a text field. NEXT: type 1 "your text"');
    expect(await session.call("type", { n: 4, text: "x" })).toBe('ERROR: [4] checkbox "I agree to be contacted" is a checkbox. NEXT: click 4');
    expect(await session.call("select", { n: 1, option: "x" })).toContain("NEXT: type 1");
  });
});

describe("lite session: protocol", () => {
  it("approval gates become NEEDS APPROVAL and there is no approve tool", async () => {
    const { fake, session } = setup();
    fake.setExecuteResult({ status: "awaiting_approval", requestId: "r1", summary: "Share personal data: Work email", effects: [], command: {} });
    await session.call("look");
    const out = await session.call("type", { n: 2, text: SECRET });
    expect(out).toBe("NEEDS APPROVAL: Share personal data: Work email. The user must approve in the HelmStack window; then call look.");
    expect(LITE_TOOL_NAMES.some((n) => /approv/i.test(n))).toBe(false);
  });

  it("blocked and expired approvals use the same plain shape", async () => {
    const { fake, session } = setup();
    await session.call("look");
    fake.setExecuteResult({ status: "blocked", reason: "Blocked by approval policy: Submit payment", command: {} });
    expect(await session.call("click", { n: 5 })).toMatch(/^ERROR: Blocked by the user's approval policy .* NEXT: look/);
    fake.setExecuteResult({ status: "awaiting_approval", requestId: "r2", summary: "Share personal data: Full name", effects: [], command: {} });
    await session.call("type", { n: 1, text: "Ada" });
    expect(fake.streaming).toBe(true);
    fake.emitApproval({ requestId: "r2", outcome: "expired" });
    const next = await session.call("look");
    expect(next.split("\n")[0]).toBe('ERROR: The approval for "Share personal data: Full name" expired before the user answered. NEXT: repeat the action if it is still needed, or ask the user');
    expect(next).toContain("· view");
    expect(fake.streaming).toBe(false);
  });

  it("failures are plain ERROR/NEXT lines, never JSON or stack traces", async () => {
    const { fake, session } = setup();
    await session.call("look");
    fake.setExecuteThrows(Object.assign(new Error('HTTP 500 POST /api/tabs/tab-1/command: {"error":"Observed field could not be resolved"}'), { status: 500, body: '{"error":"Observed field could not be resolved"}' }));
    const out = await session.call("click", { n: 5 });
    expect(out).toBe("ERROR: That did not work (Observed field could not be resolved). NEXT: look");
    fake.setExecuteThrows(new Error("connect ECONNREFUSED 127.0.0.1:7070"));
    expect(await session.call("click", { n: 5 })).toContain("HelmStack is not reachable");
    expect(await session.call("bogus")).toBe('ERROR: There is no tool called "bogus". NEXT: look');
  });

  it("auto-looks after an action and says when nothing changed", async () => {
    const { session } = setup();
    await session.call("look");
    const out = await session.call("click", { n: 6 });
    expect(out).toContain("Page unchanged");
    expect(out).toContain("still view 1");
  });

  it("look includes visible page prose fetched separately from perception", async () => {
    const fake = fakeBrowser({ source: contactSource({ alerts: [], alertDetails: undefined }), pageText: "Contact HelmStack\nOur office is open 9 to 5." });
    const session = createLiteSession(fake.browser, { settleMs: 0 });
    expect(await session.call("look")).toContain('Text: "Our office is open 9 to 5."');
  });

  it("go navigates, invalidates and returns the new view", async () => {
    const { fake, session } = setup();
    const out = await session.call("go", { url: "127.0.0.1:4177/other.html" });
    expect(out.split("\n")[0]).toBe("OK: opened https://127.0.0.1:4177/other.html.");
    expect(fake.calls.find((c) => c.method === "navigate")!.args).toEqual(["tab-1", "https://127.0.0.1:4177/other.html"]);
    expect(await session.call("go", { url: "javascript:alert(1)" })).toContain("is not a web address");
  });

  it("honours the character budget env", async () => {
    expect(resolveLiteMaxChars({})).toBe(2400);
    expect(resolveLiteMaxChars({ HELMSTACK_LITE_MAX_CHARS: "1000" })).toBe(1000);
    expect(resolveLiteMaxChars({ HELMSTACK_LITE_MAX_CHARS: "5" })).toBe(400);
    expect(resolveLiteMaxChars({ HELMSTACK_LITE_MAX_CHARS: "nope" })).toBe(2400);
    const { session } = setup(manyLinks(80), { env: { HELMSTACK_LITE_MAX_CHARS: "800" }, maxChars: undefined });
    expect((await session.call("look")).length).toBeLessThanOrEqual(800);
    expect(await session.call("look", { all: true })).not.toContain("(look all)");
  });
});

describe("lite session: audits, tabs, screenshot", () => {
  it("details needs an audit first, then expands items", async () => {
    const { fake, session } = setup();
    expect(await session.call("details", { n: 1 })).toBe("ERROR: No audit has been run yet. NEXT: audit accessibility");
    (fake.browser as unknown as { seoAudit: () => Promise<unknown> }).seoAudit = async () => ({
      url: "http://x/", score: 88, issues: [{ id: "title-missing", section: "metadata", severity: "error", message: "Missing title", fix: "Add a title." }], counts: { error: 1, warning: 0, info: 0 }
    });
    const digest = await session.call("audit", { kind: "seo" });
    expect(digest).toContain("1) [error] Missing title");
    expect(await session.call("details", { n: 1 })).toContain("Fix: Add a title.");
    expect(await session.call("details", { n: 4 })).toBe("ERROR: There is no item 4; the last audit has 1. NEXT: details 1");
    expect(await session.call("audit", { kind: "chaos" })).toContain("NEXT: audit accessibility");
  });

  it("lists numbered tabs and switches", async () => {
    const fake = fakeBrowser({
      source: contactSource(),
      tabs: [
        { id: "tab-1", title: "One", url: "http://a/", isActive: true, status: "idle" },
        { id: "tab-2", title: "Two", url: "http://b/", isActive: false, status: "idle" }
      ]
    });
    const session = createLiteSession(fake.browser, { settleMs: 0 });
    expect(await session.call("tabs")).toBe(["Tabs (2, * = current):", "[1] * One (http://a/)", "[2] Two (http://b/)", "Say tabs N to switch."].join("\n"));
    expect(await session.call("tabs", { n: 2 })).toContain("OK: switched to tab 2.");
    expect(fake.calls.filter((c) => c.method === "getPerception").at(-1)!.args).toEqual(["tab-2"]);
    expect(await session.call("tabs", { n: 9 })).toBe("ERROR: There is no tab 9 (2 open). NEXT: tabs");
  });

  it("screenshot saves a file and describes the page in one line", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lite-shot-"));
    const { session } = setup(contactSource(), { screenshotDir: dir });
    const out = await session.call("screenshot");
    const file = /saved screenshot to (\S+) \(800x600\)/.exec(out)![1]!;
    expect(file.startsWith(dir)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("PNG");
    expect(out).toContain("On screen: A page titled");
  });

  it("viewport presets and reset restore the original size", async () => {
    const { fake, session } = setup();
    await session.call("viewport", { size: "mobile" });
    await session.call("viewport", { size: "reset" });
    const sets = fake.calls.filter((c) => c.method === "setViewport").map((c) => c.args.slice(1));
    expect(sets).toEqual([[390, 844, true], [1280, 800, false]]);
    expect(await session.call("viewport", { size: "huge" })).toContain("NEXT: viewport mobile");
  });

  it("scroll reports position", async () => {
    const { session } = setup();
    expect(await session.call("scroll", { direction: "down" })).toBe("OK: scrolled down; now at 80% of the page.");
    expect(await session.call("scroll", { direction: "sideways" })).toContain("NEXT: scroll down");
  });
});

describe("lite schemas", () => {
  it("is the exact, small action set", () => {
    expect([...LITE_TOOL_NAMES]).toEqual(["look", "click", "type", "select", "go", "back", "forward", "reload", "scroll", "tabs", "audit", "details", "viewport", "screenshot"]);
    expect(LITE_TOOL_SCHEMAS.map((t) => t.name)).toEqual([...LITE_TOOL_NAMES]);
    expect(LITE_TOOL_SCHEMAS.length).toBeLessThanOrEqual(14);
    for (const tool of LITE_TOOL_SCHEMAS) {
      expect(tool.params.length).toBeLessThanOrEqual(3);
      expect(tool.description.split(/(?<=[.!?])\s/).length).toBe(1);
    }
  });

  it("exposes enums and decoding grammars", () => {
    const audit = LITE_TOOL_SCHEMAS.find((t) => t.name === "audit")!;
    expect(audit.params[0]!.enum).toEqual(["accessibility", "seo", "layout", "performance", "health"]);
    const schema = liteToolCallJsonSchema() as { oneOf: Array<{ title: string; required: string[] }> };
    expect(schema.oneOf).toHaveLength(14);
    expect(schema.oneOf.find((s) => s.title === "type")!.required).toEqual(["tool", "n", "text"]);
    const gbnf = liteToolCallGbnf();
    expect(gbnf).toContain("root ::= call-look | call-click");
    expect(gbnf).toContain('call-scroll ::= "{\\"tool\\":\\"scroll\\"" ",\\"direction\\":" ("\\"up\\"" | "\\"down\\"") "}"');
    expect(gbnf).toContain("integer ::=");
  });
});
