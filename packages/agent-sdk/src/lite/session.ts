/**
 * The stateful half of the lite toolset. A LiteSession drives a BrowserClient
 * (or any {@link LiteBrowser}) and remembers just enough, per process, that
 * the model needs no history: the last numbered view per tab, the last audit
 * digest, and which tab is current. Every method returns plain text.
 *
 * Usable by the MCP server and by a future in-process agent loop alike.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { BrowserCommandResult, BrowserOutputCommand, PageGraph, TabSummary } from "../../../shared/src/index.js";
import { digestAudit } from "./digest.js";
import { LITE_TOOL_NAMES } from "./schemas.js";
import { liteError, plainErrorMessage, q, renderCommandResult, renderTabs, STALE_ELEMENT_MESSAGE } from "./text.js";
import {
  DEFAULT_DIGEST_ITEMS,
  DEFAULT_VIEW_CHARS,
  LITE_AUDIT_KINDS,
  type LiteAuditKind,
  type LiteBrowser,
  type LiteDigest,
  type LiteElement,
  type LitePageSource
} from "./types.js";
import { collectLiteElements, describePage, renderPageView } from "./view.js";

export type LiteEnv = Record<string, string | undefined>;

/** `HELMSTACK_LITE_MAX_CHARS`: page-view character cap (400-20000, default 2400). */
export function resolveLiteMaxChars(env: LiteEnv = {}): number {
  const raw = Number((env.HELMSTACK_LITE_MAX_CHARS ?? "").trim());
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_VIEW_CHARS;
  return Math.min(20_000, Math.max(400, Math.floor(raw)));
}

export type LiteSessionOptions = {
  /** Page-view cap in characters. Default from `env`, else 2400. */
  maxChars?: number;
  env?: LiteEnv;
  /** Pause after an action before re-reading the page. Default 300ms. */
  settleMs?: number;
  /** Where screenshots are saved. Default `<tmp>/helmstack-lite` (or `HELMSTACK_LITE_SCREENSHOT_DIR`). */
  screenshotDir?: string;
  maxDigestItems?: number;
  now?: () => number;
};

export type LiteSession = {
  /** Run one lite tool. Always resolves to plain text; never throws. */
  call(tool: string, args?: Record<string, unknown>): Promise<string>;
  /** Stop background listeners (approval events). */
  close(): void;
  /** Read-only snapshot, for tests and debugging. */
  readonly state: { view: number; tabId: string | null; hasDigest: boolean; knownElements: number };
};

type TabView = { view: number; url: string; elements: LiteElement[]; fingerprint: string };

const VIEWPORTS = {
  mobile: { width: 390, height: 844, mobile: true },
  tablet: { width: 768, height: 1024, mobile: false },
  desktop: { width: 1440, height: 900, mobile: false }
} as const;

const norm = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
const sleep = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

function asInt(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value.replace(/^\[|\]$/g, "")) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : null;
}
function asBool(value: unknown): boolean {
  return value === true || (typeof value === "string" && ["true", "yes", "1", "submit"].includes(value.trim().toLowerCase()));
}
function asText(value: unknown): string | null {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : null;
}

function sourceOf(packet: Awaited<ReturnType<LiteBrowser["getPerception"]>>): LitePageSource | null {
  const graph: PageGraph | undefined = packet.result?.graph;
  if (graph) return graph;
  const obs = packet.observation;
  return obs ? { url: obs.url, title: obs.title, headings: obs.headings, forms: obs.forms, alerts: obs.alerts, alertDetails: obs.alertDetails, primaryActions: obs.primaryActions } : null;
}

export function createLiteSession(browser: LiteBrowser, options: LiteSessionOptions = {}): LiteSession {
  const env = options.env ?? {};
  const maxChars = options.maxChars ?? resolveLiteMaxChars(env);
  const settleMs = options.settleMs ?? 300;
  const maxItems = options.maxDigestItems ?? DEFAULT_DIGEST_ITEMS;
  const now = options.now ?? Date.now;
  const shotDir = options.screenshotDir ?? env.HELMSTACK_LITE_SCREENSHOT_DIR ?? path.join(tmpdir(), "helmstack-lite");

  let viewCounter = 0;
  let pinnedTab: string | undefined;
  let digest: LiteDigest | undefined;
  let originalViewport: { width: number; height: number } | undefined;
  let viewportChanged = false;
  let shotCounter = 0;
  const views = new Map<string, TabView>();
  const pending = new Map<string, string>();
  const notes: string[] = [];
  let stream: { close(): void } | undefined;

  // ── approvals ──────────────────────────────────────────────────────────────
  function watchApproval(requestId: string, summary: string): void {
    pending.set(requestId, summary);
    if (stream || !browser.stream) return;
    try {
      stream = browser.stream({
        onApprovalResolved: (resolution) => {
          const what = pending.get(resolution.requestId);
          if (what === undefined) return;
          pending.delete(resolution.requestId);
          if (resolution.outcome === "approved") notes.push(`NOTE: the user approved ${q(what, 80)}; it ran. Call look to see the result.`);
          else {
            const word = resolution.outcome === "rejected" ? "was rejected by the user" : resolution.outcome === "expired" ? "expired before the user answered" : "was cancelled because the page changed";
            notes.push(liteError(`The approval for ${q(what, 80)} ${word}`, "repeat the action if it is still needed, or ask the user"));
          }
          if (pending.size === 0) {
            stream?.close();
            stream = undefined;
          }
        }
      });
    } catch {
      stream = undefined;
    }
  }

  // ── tabs ───────────────────────────────────────────────────────────────────
  async function currentTab(): Promise<{ id: string; tab: TabSummary } | null> {
    const tabs = await browser.listTabs();
    const pinned = pinnedTab ? tabs.find((t) => t.id === pinnedTab) : undefined;
    const tab = pinned ?? tabs.find((t) => t.isActive) ?? tabs[0];
    return tab ? { id: tab.id, tab } : null;
  }
  const NO_TAB = liteError("No tab is open", 'go "https://example.com"');

  // ── page view ──────────────────────────────────────────────────────────────
  async function lookTab(tabId: string, opts: { all?: boolean; quietIfSame?: boolean } = {}): Promise<{ text: string; changed: boolean }> {
    const packet = await browser.getPerception(tabId);
    const base = sourceOf(packet);
    if (!base) return { text: liteError("The page has not finished loading", "look"), changed: false };
    const source: LitePageSource = { ...base, text: await visibleText(tabId) };
    const previous = views.get(tabId);
    const view = viewCounter + 1;
    const rendered = renderPageView(source, { view, maxChars, all: opts.all === true });
    if (opts.quietIfSame && previous && previous.fingerprint === rendered.fingerprint && previous.url === source.url) {
      return { text: `Page unchanged (still view ${previous.view}; the same numbers apply).`, changed: false };
    }
    viewCounter = view;
    views.set(tabId, { view, url: source.url, elements: rendered.elements, fingerprint: rendered.fingerprint });
    return { text: rendered.text, changed: true };
  }

  /** Best-effort visible text; perception carries structure only. Never throws. */
  async function visibleText(tabId: string): Promise<string | undefined> {
    try {
      const text = await browser.evaluate<unknown>(tabId, "(document.body&&document.body.innerText||'').slice(0,6000)");
      return typeof text === "string" ? text : undefined;
    } catch {
      return undefined;
    }
  }

  async function afterAction(tabId: string, lead: string): Promise<string> {
    await sleep(settleMs);
    const look = await lookTab(tabId, { quietIfSame: true });
    return `${lead}\n${look.text}`;
  }

  async function locate(tabId: string, n: number): Promise<{ el: LiteElement; graph: PageGraph } | string> {
    const view = views.get(tabId);
    const known = view?.elements.find((e) => e.n === n);
    if (!view || !known) return STALE_ELEMENT_MESSAGE;
    const packet = await browser.getPerception(tabId);
    const graph = packet.result?.graph;
    if (!graph || graph.url !== view.url) {
      views.delete(tabId);
      return STALE_ELEMENT_MESSAGE;
    }
    const fresh = collectLiteElements(graph);
    const same = (e: Omit<LiteElement, "n">) => e.kind === known.kind && e.role === known.role && norm(e.label) === norm(known.label);
    const found = fresh.find((e) => same(e) && e.selectorHint === known.selectorHint) ?? fresh.find(same);
    if (!found) {
      views.delete(tabId);
      return STALE_ELEMENT_MESSAGE;
    }
    return { el: { ...found, n }, graph };
  }

  async function run(tabId: string, command: BrowserOutputCommand, phrase: string): Promise<{ kind: string; text: string; result: BrowserCommandResult }> {
    const result = await browser.execute(tabId, command);
    const rendered = renderCommandResult(result, phrase);
    if (result.status === "awaiting_approval") watchApproval(result.requestId, result.summary);
    return { ...rendered, result };
  }

  const domTool = (toolName: string, args: Record<string, unknown> = {}): BrowserOutputCommand => ({
    type: "invoke_site_tool",
    provider: "dom",
    toolName,
    args
  });

  async function selectOptions(tabId: string, selectorHint: string): Promise<string[]> {
    try {
      const out = await browser.evaluate<string[] | null>(
        tabId,
        `(()=>{const s=document.querySelector(${JSON.stringify(selectorHint)});return s&&s.options?[...s.options].map(o=>o.text.trim()).filter(Boolean):null})()`
      );
      return Array.isArray(out) ? out.slice(0, 12) : [];
    } catch {
      return [];
    }
  }

  // ── tools ──────────────────────────────────────────────────────────────────
  const tools: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
    async look(args) {
      const tab = await currentTab();
      if (!tab) return NO_TAB;
      return (await lookTab(tab.id, { all: asBool(args.all) || args.all === "all" })).text;
    },

    async click(args) {
      const n = asInt(args.n);
      if (n === null) return liteError("click needs an item number", "click 1");
      const tab = await currentTab();
      if (!tab) return NO_TAB;
      const found = await locate(tab.id, n);
      if (typeof found === "string") return found;
      const { el } = found;
      const label = `[${n}] ${el.role} ${q(el.label)}`;
      if (el.kind === "field") {
        if (el.role === "checkbox" || el.role === "radio") {
          const target = el.role === "radio" ? true : !(el.filled === true);
          const out = await run(tab.id, domTool(`dom.fill.${el.formId}`, { [el.id]: target }), `${target ? "Checked" : "Unchecked"} ${label}`);
          return out.kind === "ok" ? afterAction(tab.id, out.text) : out.text;
        }
        if (el.role === "combobox") return liteError(`${label} is a dropdown`, `select ${n} "option text"`);
        return liteError(`${label} is a text field`, `type ${n} "your text"`);
      }
      const command = el.submitsFormId ? domTool(`dom.submit.${el.submitsFormId}`) : domTool(`dom.activate.${el.id}`);
      const out = await run(tab.id, command, `Clicked ${label}`);
      return out.kind === "ok" ? afterAction(tab.id, out.text) : out.text;
    },

    async type(args) {
      const n = asInt(args.n);
      const text = asText(args.text);
      if (n === null || text === null) return liteError("type needs an item number and the text", 'type 1 "hello"');
      const tab = await currentTab();
      if (!tab) return NO_TAB;
      const found = await locate(tab.id, n);
      if (typeof found === "string") return found;
      const { el } = found;
      const label = `[${n}] ${el.role} ${q(el.label)}`;
      if (el.kind !== "field") return liteError(`${label} is not a text field`, `click ${n}`);
      if (el.role === "checkbox" || el.role === "radio") return liteError(`${label} is a checkbox`, `click ${n}`);
      if (el.role === "combobox") return liteError(`${label} is a dropdown`, `select ${n} "option text"`);
      const filled = await run(tab.id, domTool(`dom.fill.${el.formId}`, { [el.id]: text }), `Typed into ${label}`);
      if (filled.kind !== "ok") return filled.text;
      if (!asBool(args.submit)) return afterAction(tab.id, filled.text);
      const submitted = await run(tab.id, domTool(`dom.submit.${el.formId}`), `Typed into ${label} and submitted the form`);
      return submitted.kind === "ok" ? afterAction(tab.id, submitted.text) : `${filled.text}\n${submitted.text}`;
    },

    async select(args) {
      const n = asInt(args.n);
      const option = asText(args.option);
      if (n === null || option === null) return liteError("select needs an item number and an option", 'select 1 "option text"');
      const tab = await currentTab();
      if (!tab) return NO_TAB;
      const found = await locate(tab.id, n);
      if (typeof found === "string") return found;
      const { el } = found;
      const label = `[${n}] ${el.role} ${q(el.label)}`;
      if (el.role !== "combobox") {
        return liteError(`${label} is not a dropdown`, el.kind === "field" && el.role !== "checkbox" && el.role !== "radio" ? `type ${n} "your text"` : `click ${n}`);
      }
      try {
        const out = await run(tab.id, domTool(`dom.fill.${el.formId}`, { [el.id]: option }), `Selected ${q(option)} in ${label}`);
        return out.kind === "ok" ? afterAction(tab.id, out.text) : out.text;
      } catch (error) {
        if (/option not found/i.test(error instanceof Error ? error.message : String(error))) {
          const options = await selectOptions(tab.id, el.selectorHint);
          return liteError(
            `${label} has no option ${q(option)}${options.length ? `. Options: ${options.map((o) => q(o, 40)).join(", ")}` : ""}`,
            options.length ? `select ${n} ${q(options[0]!, 40)}` : "look"
          );
        }
        throw error;
      }
    },

    async go(args) {
      const raw = asText(args.url)?.trim();
      if (!raw) return liteError("go needs a web address", 'go "https://example.com"');
      let url: string;
      try {
        url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`).toString();
        if (!/^https?:/i.test(url)) throw new Error("scheme");
      } catch {
        return liteError(`${q(raw, 80)} is not a web address`, 'go "https://example.com"');
      }
      const tab = await currentTab();
      let tabs: TabSummary[];
      let tabId: string | undefined;
      if (tab) {
        tabs = await browser.navigate(tab.id, url);
        tabId = tab.id;
      } else {
        tabs = await browser.openTab(url);
        tabId = (tabs.find((t) => t.isActive) ?? tabs[tabs.length - 1])?.id;
      }
      if (!tabId) return liteError("The page could not be opened", "look");
      views.delete(tabId);
      const landed = tabs.find((t) => t.id === tabId);
      if (landed?.status === "error") {
        return liteError(`The page failed to load${landed.statusMessage ? ` (${landed.statusMessage})` : ""}`, "go with another address");
      }
      return afterAction(tabId, `OK: opened ${url}.`);
    },

    async back() {
      return history("back");
    },
    async forward() {
      return history("forward");
    },
    async reload() {
      const tab = await currentTab();
      if (!tab) return NO_TAB;
      await browser.reload(tab.id);
      views.delete(tab.id);
      return afterAction(tab.id, "OK: reloaded the page.");
    },

    async scroll(args) {
      const dir = asText(args.direction)?.trim().toLowerCase();
      if (dir !== "up" && dir !== "down") return liteError('scroll needs a direction, "up" or "down"', "scroll down");
      const tab = await currentTab();
      if (!tab) return NO_TAB;
      const sign = dir === "down" ? 1 : -1;
      const out = await browser.evaluate<{ moved: boolean; pct: number }>(
        tab.id,
        `(()=>{const y=window.scrollY;window.scrollBy(0,${sign}*Math.round(window.innerHeight*0.8));const h=document.documentElement.scrollHeight||1;return {moved:window.scrollY!==y,pct:Math.min(100,Math.round(100*(window.scrollY+window.innerHeight)/h))}})()`
      );
      if (!out?.moved) return `OK: already at the ${dir === "down" ? "bottom" : "top"} of the page.`;
      return `OK: scrolled ${dir}; now at ${out.pct}% of the page.`;
    },

    async tabs(args) {
      const tabs = await browser.listTabs();
      const requested = args.n === undefined || args.n === null || args.n === "" ? null : asInt(args.n);
      if (requested === null && args.n !== undefined && args.n !== null && args.n !== "") {
        return liteError("tabs takes a tab number or nothing", "tabs");
      }
      if (requested === null) {
        const current = await currentTab();
        return renderTabs(tabs, current?.id);
      }
      const target = tabs[requested - 1];
      if (!target) return liteError(`There is no tab ${requested} (${tabs.length} open)`, "tabs");
      pinnedTab = target.id;
      return afterAction(target.id, `OK: switched to tab ${requested}.`);
    },

    async audit(args) {
      const kind = asText(args.kind)?.trim().toLowerCase() as LiteAuditKind | undefined;
      if (!kind || !LITE_AUDIT_KINDS.includes(kind)) {
        return liteError(`audit needs one of: ${LITE_AUDIT_KINDS.join(", ")}`, "audit accessibility");
      }
      const tab = await currentTab();
      if (!tab) return NO_TAB;
      let built: LiteDigest;
      const opts = { maxItems };
      switch (kind) {
        case "accessibility":
          built = digestAudit(kind, await browser.auditAccessibility(tab.id), opts);
          break;
        case "seo":
          built = digestAudit(kind, await browser.seoAudit(tab.id), opts);
          break;
        case "layout":
          built = digestAudit(kind, await browser.detectLayoutIssues(tab.id), opts);
          break;
        case "performance":
          built = digestAudit(kind, await browser.getPerformanceMetrics(tab.id), opts);
          break;
        case "health":
          built = digestAudit(kind, await browser.getHealthReport(tab.id), opts);
          break;
      }
      digest = built;
      return built.text;
    },

    async details(args) {
      if (!digest) return liteError("No audit has been run yet", "audit accessibility");
      const n = asInt(args.n);
      if (n === null) return liteError("details needs an item number", "details 1");
      const item = digest.items[n - 1];
      if (!item) {
        return liteError(digest.items.length ? `There is no item ${n}; the last audit has ${digest.items.length}` : "The last audit found nothing to detail", digest.items.length ? "details 1" : "look");
      }
      return `Item ${n} [${item.severity}] of the ${digest.kind} audit:\n${item.detail}`;
    },

    async viewport(args) {
      const size = asText(args.size)?.trim().toLowerCase();
      if (size !== "mobile" && size !== "tablet" && size !== "desktop" && size !== "reset") {
        return liteError('viewport needs "mobile", "tablet", "desktop" or "reset"', "viewport mobile");
      }
      const tab = await currentTab();
      if (!tab) return NO_TAB;
      if (!originalViewport) {
        try {
          const dims = await browser.evaluate<{ w: number; h: number }>(tab.id, "({w:window.innerWidth,h:window.innerHeight})");
          if (dims && dims.w > 0 && dims.h > 0) originalViewport = { width: dims.w, height: dims.h };
        } catch {
          /* fall back to the desktop preset on reset */
        }
      }
      if (size === "reset") {
        if (!viewportChanged) return "OK: the viewport was not changed.";
        const base = originalViewport ?? VIEWPORTS.desktop;
        await browser.setViewport(tab.id, base.width, base.height, false);
        viewportChanged = false;
        return afterAction(tab.id, `OK: viewport reset to ${base.width}x${base.height}.`);
      }
      const preset = VIEWPORTS[size];
      await browser.setViewport(tab.id, preset.width, preset.height, preset.mobile);
      viewportChanged = true;
      return afterAction(tab.id, `OK: viewport set to ${size} (${preset.width}x${preset.height}).`);
    },

    async screenshot() {
      const tab = await currentTab();
      if (!tab) return NO_TAB;
      const shot = await browser.getScreenshot(tab.id);
      mkdirSync(shotDir, { recursive: true, mode: 0o700 });
      shotCounter += 1;
      const file = path.join(shotDir, `helmstack-${tab.id}-${now()}-${shotCounter}.png`);
      writeFileSync(file, Buffer.from(shot.data, "base64"), { mode: 0o600 });
      let seen = "";
      try {
        const source = sourceOf(await browser.getPerception(tab.id));
        if (source) seen = `\nOn screen: ${describePage(source)}`;
      } catch {
        /* the path alone is still useful */
      }
      return `OK: saved screenshot to ${file} (${shot.width}x${shot.height}).${seen}`;
    }
  };

  async function history(direction: "back" | "forward"): Promise<string> {
    const tab = await currentTab();
    if (!tab) return NO_TAB;
    const before = tab.tab.url;
    const can = direction === "back" ? tab.tab.canGoBack : tab.tab.canGoForward;
    if (can === false) return liteError(`There is no ${direction === "back" ? "earlier" : "later"} page`, "look");
    const tabs = direction === "back" ? await browser.goBack(tab.id) : await browser.goForward(tab.id);
    const after = tabs.find((t) => t.id === tab.id)?.url ?? before;
    if (after === before) return liteError(`There is no ${direction === "back" ? "earlier" : "later"} page`, "look");
    views.delete(tab.id);
    return afterAction(tab.id, `OK: went ${direction} to ${after}.`);
  }

  return {
    async call(tool, args = {}) {
      let body: string;
      try {
        const handler = (LITE_TOOL_NAMES as readonly string[]).includes(tool) ? tools[tool] : undefined;
        body = handler ? await handler(args ?? {}) : liteError(`There is no tool called ${q(tool, 40)}`, "look");
      } catch (error) {
        body = plainErrorMessage(error);
      }
      if (notes.length === 0) return body;
      return `${notes.splice(0).join("\n")}\n${body}`;
    },
    close() {
      stream?.close();
      stream = undefined;
    },
    get state() {
      const tabId = pinnedTab ?? null;
      const v = tabId ? views.get(tabId) : [...views.values()].at(-1);
      return { view: viewCounter, tabId, hasDigest: digest !== undefined, knownElements: v?.elements.length ?? 0 };
    }
  };
}

