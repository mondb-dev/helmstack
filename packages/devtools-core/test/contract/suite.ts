/**
 * The agent-API contract suite: one scenario set, written once against the
 * HTTP API, run against every backend factory (see `backends.ts`).
 *
 * Scenarios assert response *shapes* and key invariants, never volatile
 * values. Scenarios marked `needsBrowser` read results from in-page collector
 * scripts and are skipped for factories without a real browser.
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BackendFactory, RunningBackend } from "./backends.js";
import { CONSOLE_MARKER, startFixtureServer, type FixtureServer } from "./fixture-server.js";

type Json = any;
type Reply = { status: number; body: Json; contentType: string; bytes: Buffer };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DAY_MS = 24 * 60 * 60 * 1000;
const SLOW = 60_000;
const POLL = { timeout: 15_000, interval: 200 };

const isNumber = expect.any(Number);
const isString = expect.any(String);
const isArray = expect.any(Array);
const isObject = expect.any(Object);

/** Unique per run so scenarios never collide with state on an external instance. */
const runTag = randomBytes(4).toString("hex");
const id = (name: string) => `contract-${runTag}-${name}`;

export function defineContractSuite(factory: BackendFactory): void {
  const needsBrowser = !factory.realBrowser;

  describe.skipIf(factory.skipReason !== null)(`agent API contract — ${factory.name}`, () => {
    let backend: RunningBackend;
    let pages: FixtureServer;
    const openedTabs = new Set<string>();

    async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
      const res = await fetch(`${backend.baseUrl}${path}`, {
        method,
        headers: {
          ...(backend.token ? { authorization: `Bearer ${backend.token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
      const bytes = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get("content-type") ?? "";
      let parsed: Json = null;
      if (contentType.includes("json")) parsed = JSON.parse(bytes.toString("utf8"));
      return { status: res.status, body: parsed, contentType, bytes };
    }

    /** Like `call`, but fails with the response body unless the status is 2xx. */
    async function ok(method: string, path: string, body?: unknown): Promise<Json> {
      const reply = await call(method, path, body);
      if (reply.status < 200 || reply.status > 299) {
        throw new Error(`${method} ${path} → ${reply.status}: ${JSON.stringify(reply.body)}`);
      }
      return reply.body;
    }

    async function openTab(url: string): Promise<string> {
      const before = new Set(((await ok("GET", "/api/tabs")) as Json[]).map((t) => t.id));
      const tabs = (await ok("POST", "/api/tabs", { url })) as Json[];
      const tab = tabs.find((t) => !before.has(t.id));
      expect(tab, "POST /api/tabs returns the new tab").toBeDefined();
      openedTabs.add(tab.id);
      return tab.id;
    }

    async function closeTab(tabId: string): Promise<void> {
      openedTabs.delete(tabId);
      await call("DELETE", `/api/tabs/${tabId}`);
    }

    async function withTab(url: string, fn: (tabId: string) => Promise<void>): Promise<void> {
      const tabId = await openTab(url);
      try {
        await fn(tabId);
      } finally {
        await closeTab(tabId);
      }
    }

    /** Polls perception until `until(packet)` holds (real pages load asynchronously). */
    async function perceive(tabId: string, until: (packet: Json) => boolean = () => true): Promise<Json> {
      let last: Json = null;
      await expect
        .poll(async () => {
          last = await ok("GET", `/api/tabs/${tabId}/perception`);
          return until(last);
        }, POLL)
        .toBe(true);
      return last;
    }

    const hasForm = (packet: Json) => (packet.observation?.forms?.length ?? 0) > 0;

    beforeAll(async () => {
      pages = await startFixtureServer();
      backend = await factory.start();
    }, SLOW);

    afterAll(async () => {
      for (const tabId of [...openedTabs]) await closeTab(tabId).catch(() => {});
      await backend?.close();
      await pages?.close();
    }, SLOW);

    // ── Server ──────────────────────────────────────────────────────────────

    it("GET /api/health reports status, backend kind and capabilities; auth is enforced", async () => {
      const health = await ok("GET", "/api/health");
      expect(health).toMatchObject({ status: "ok", tabs: isNumber, connectedAgents: isNumber, capabilities: isArray });
      expect(["desktop", "daemon"]).toContain(health.backend);
      for (const cap of health.capabilities) expect(["accounts", "extensions", "pick"]).toContain(cap);

      if (backend.token) {
        const anon = await fetch(`${backend.baseUrl}/api/health`);
        expect(anon.status).toBe(401);
      }
      expect((await call("GET", "/api/definitely-not-a-route")).status).toBe(404);
    });

    it("desktop-only slices the backend lacks answer 501 unsupported_on_backend", async () => {
      const health = await ok("GET", "/api/health");
      const missing = ["accounts", "extensions", "pick"].filter((c) => !health.capabilities.includes(c));
      if (missing.length === 0) return; // full desktop: nothing to check (pick would wait for a human)
      await withTab(pages.blank, async (tabId) => {
        const routes: Record<string, string> = { accounts: "/api/accounts", extensions: "/api/extensions", pick: `/api/tabs/${tabId}/pick` };
        for (const slice of missing) {
          const reply = await call("GET", routes[slice]!);
          expect(reply.status, routes[slice]).toBe(501);
          expect(reply.body).toMatchObject({ code: "unsupported_on_backend", backend: health.backend });
        }
      });
    });

    // ── Tabs ────────────────────────────────────────────────────────────────

    it("tabs: open, list, navigate, close", async () => {
      const tabId = await openTab(pages.blank);
      const listed = (await ok("GET", "/api/tabs")) as Json[];
      const tab = listed.find((t) => t.id === tabId);
      expect(tab).toMatchObject({ id: tabId, url: isString, title: isString, isActive: expect.any(Boolean) });

      const afterNav = (await ok("POST", `/api/tabs/${tabId}/navigate`, { url: pages.contactForm })) as Json[];
      expect(afterNav).toEqual(expect.arrayContaining([expect.objectContaining({ id: tabId })]));
      await expect
        .poll(async () => ((await ok("GET", "/api/tabs")) as Json[]).find((t) => t.id === tabId)?.url, POLL)
        .toBe(pages.contactForm);

      expect((await call("POST", `/api/tabs/${tabId}/navigate`, {})).status).toBe(400);

      const remaining = (await ok("DELETE", `/api/tabs/${tabId}`)) as Json[];
      openedTabs.delete(tabId);
      expect(remaining.some((t) => t.id === tabId)).toBe(false);
      expect(((await ok("GET", "/api/tabs")) as Json[]).some((t) => t.id === tabId)).toBe(false);
    }, SLOW);

    it("tabs: back, forward and reload move through history and wait for the load", async () => {
      await withTab(pages.counter, async (tabId) => {
        const tabState = async (): Promise<Json> => ((await ok("GET", "/api/tabs")) as Json[]).find((t) => t.id === tabId);
        const titleOf = async (): Promise<string> => (await tabState()).title;
        await expect.poll(async () => (await tabState()).url, POLL).toBe(pages.counter);

        // Two pages, then back / forward across them.
        await ok("POST", `/api/tabs/${tabId}/navigate`, { url: pages.blank });
        await expect.poll(async () => (await tabState()).url, POLL).toBe(pages.blank);

        const back = (await ok("POST", `/api/tabs/${tabId}/back`, {})) as Json[];
        expect(back).toEqual(expect.arrayContaining([expect.objectContaining({ id: tabId })]));
        await expect.poll(async () => (await tabState()).url, POLL).toBe(pages.counter);

        const forward = (await ok("POST", `/api/tabs/${tabId}/forward`, {})) as Json[];
        expect(forward).toEqual(expect.arrayContaining([expect.objectContaining({ id: tabId })]));
        await expect.poll(async () => (await tabState()).url, POLL).toBe(pages.blank);

        // No later entry: unchanged, not an error.
        await ok("POST", `/api/tabs/${tabId}/forward`, {});
        expect((await tabState()).url).toBe(pages.blank);

        // Reload: the served counter page changes content on every request.
        await ok("POST", `/api/tabs/${tabId}/back`, {});
        await expect.poll(async () => (await tabState()).url, POLL).toBe(pages.counter);
        const before = await titleOf();
        await ok("POST", `/api/tabs/${tabId}/reload`, {});
        await ok("POST", `/api/tabs/${tabId}/reload`, { ignoreCache: true });
        if (!needsBrowser) {
          // Real browsers only: the scripted backend has no network to re-request.
          await expect.poll(titleOf, POLL).not.toBe(before);
        }

        expect((await call("POST", `/api/tabs/${tabId}/reload`, { ignoreCache: "yes" })).status).toBe(400);
      });
    }, SLOW);

    // ── Perception ──────────────────────────────────────────────────────────

    it("perception packet, named snapshots and perception diff", async () => {
      await withTab(pages.contactForm, async (tabId) => {
        const packet = await perceive(tabId, hasForm);
        expect(packet).toMatchObject({ tabId, emittedAt: isNumber, siteCapabilities: isArray });
        expect(packet.observation.forms[0].fields.map((f: Json) => f.name)).toEqual(expect.arrayContaining(["name", "email", "message"]));
        expect(packet.result.graph).toMatchObject({ tabId, url: pages.contactForm, title: isString, forms: isArray, actions: isArray });
        expect(packet.result.graph.forms.length).toBeGreaterThan(0);

        const before = await ok("POST", `/api/tabs/${tabId}/perception/named`, { snapshotId: id("before") });
        expect(before).toMatchObject({ id: id("before"), tabId, url: pages.contactForm, title: isString, capturedAt: isNumber });

        await ok("POST", `/api/tabs/${tabId}/navigate`, { url: pages.styled });
        await perceive(tabId, (p) => p.result.graph.url === pages.styled && !hasForm(p));
        await ok("POST", `/api/tabs/${tabId}/perception/named`, { snapshotId: id("after") });

        const listed = (await ok("GET", "/api/perception")) as Json[];
        expect(listed.map((e) => e.id)).toEqual(expect.arrayContaining([id("before"), id("after")]));

        const diff = await ok("POST", "/api/perception/diff", { beforeId: id("before"), afterId: id("after") });
        expect(diff).toMatchObject({ beforeId: id("before"), afterId: id("after"), changes: isArray, summary: isString, identical: false });
        expect(diff.changes.length).toBeGreaterThan(0);
        const same = await ok("POST", "/api/perception/diff", { beforeId: id("before"), afterId: id("before") });
        expect(same).toMatchObject({ identical: true, changes: [] });

        expect((await call("POST", "/api/perception/diff", { beforeId: id("before") })).status).toBe(400);
        for (const snap of ["before", "after"]) await ok("DELETE", `/api/perception/${id(snap)}`);
        expect((await call("DELETE", `/api/perception/${id("before")}`)).status).toBe(404);
      });
    }, SLOW);

    // ── Screenshots ─────────────────────────────────────────────────────────

    it("screenshot (JSON + raw PNG), viewport emulation, named screenshots and identical diff", async () => {
      await withTab(pages.contactForm, async (tabId) => {
        await perceive(tabId, hasForm);
        const shot = await ok("GET", `/api/tabs/${tabId}/screenshot`);
        expect(shot).toMatchObject({ tabId, mimeType: "image/png", data: isString, width: isNumber, height: isNumber, capturedAt: isNumber });
        expect(Buffer.from(shot.data, "base64").subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
        expect(shot.width).toBeGreaterThan(0);

        const raw = await call("GET", `/api/tabs/${tabId}/screenshot`, undefined, { accept: "image/png" });
        expect(raw.status).toBe(200);
        expect(raw.contentType).toBe("image/png");
        expect(raw.bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);

        expect(await ok("POST", `/api/tabs/${tabId}/viewport`, { width: 375, height: 667, mobile: true })).toEqual({ ok: true, width: 375, height: 667, mobile: true });
        const mobileShot = await ok("GET", `/api/tabs/${tabId}/screenshot`);
        expect([mobileShot.width, mobileShot.height]).toEqual([375, 667]);
        expect((await call("POST", `/api/tabs/${tabId}/viewport`, { width: -1 })).status).toBe(400);
        await ok("POST", `/api/tabs/${tabId}/viewport`, { width: 1280, height: 800, mobile: false });

        const a = await ok("POST", `/api/tabs/${tabId}/screenshot/named`, { snapshotId: id("shot-a") });
        await ok("POST", `/api/tabs/${tabId}/screenshot/named`, { snapshotId: id("shot-b") });
        expect(a).toMatchObject({ tabId, mimeType: "image/png", width: 1280, height: 800 });

        const listed = (await ok("GET", "/api/screenshots")) as Json[];
        expect(listed.find((s) => s.id === id("shot-a"))).toMatchObject({ tabId, url: isString, width: 1280, height: 800, capturedAt: isNumber });

        const diff = await ok("POST", "/api/screenshots/diff", { beforeId: id("shot-a"), afterId: id("shot-b") });
        expect(diff).toMatchObject({ beforeId: id("shot-a"), afterId: id("shot-b"), diffPixelCount: 0, diffPercentage: 0, diffRegions: [], width: 1280, height: 800 });
        expect(diff.totalPixels).toBe(1280 * 800);

        expect((await call("POST", "/api/screenshots/diff", { beforeId: id("shot-a") })).status).toBe(400);
        for (const s of ["shot-a", "shot-b"]) await ok("DELETE", `/api/screenshots/${id(s)}`);
        expect((await call("DELETE", `/api/screenshots/${id("shot-a")}`)).status).toBe(404);
      });
    }, SLOW);

    it("viewport suite captures each requested preset and restores the viewport", async () => {
      await withTab(pages.contactForm, async (tabId) => {
        await perceive(tabId, hasForm);
        const suite = await ok("POST", `/api/tabs/${tabId}/viewport-suite`, { presets: ["mobile-sm", "tablet"], includeDiffs: true });
        expect(suite).toMatchObject({ tabId, runId: isString, captures: isArray, diffs: isArray, capturedAt: isNumber });
        expect(suite.captures.map((c: Json) => c.preset.name)).toEqual(["mobile-sm", "tablet"]);
        expect(suite.captures.map((c: Json) => [c.screenshot.width, c.screenshot.height])).toEqual([[375, 667], [768, 1024]]);
        expect(suite.diffs).toEqual([expect.objectContaining({ from: "mobile-sm", to: "tablet", diff: expect.objectContaining({ diffPixelCount: isNumber }) })]);
        for (const c of suite.captures) await call("DELETE", `/api/screenshots/${encodeURIComponent(c.snapshotId)}`);

        const after = await ok("GET", `/api/tabs/${tabId}/screenshot`);
        expect([after.width, after.height]).toEqual([1280, 800]);
      });
    }, SLOW);

    // ── Page audits (in-page collectors → real browser only) ────────────────

    it.skipIf(needsBrowser)("a11y audit returns a score and categorized violations", async () => {
      await withTab(pages.contactForm, async (tabId) => {
        await perceive(tabId, hasForm);
        const audit = await ok("GET", `/api/tabs/${tabId}/a11y`);
        expect(audit).toMatchObject({
          tabId,
          url: pages.contactForm,
          score: isNumber,
          violations: isArray,
          violationCounts: { critical: isNumber, serious: isNumber, moderate: isNumber, minor: isNumber }
        });
        expect(audit.score).toBeGreaterThanOrEqual(0);
        expect(audit.score).toBeLessThanOrEqual(100);
      });
    }, SLOW);

    // SEO audit: the fixture pages are served by the local fixture server; the
    // scripted backend answers the collector with equivalent signals.
    it("seo audit: a clean page passes and reports section summaries", async () => {
      await withTab(pages.seoGood, async (tabId) => {
        await perceive(tabId, (p) => p.result.graph.url === pages.seoGood);
        const seo = await ok("GET", `/api/tabs/${tabId}/seo`);
        expect(seo).toMatchObject({
          tabId, url: pages.seoGood, capturedAt: isNumber, score: isNumber, pass: true,
          issues: isArray, counts: { error: 0, warning: isNumber, info: isNumber },
          skipped: isArray, unsupported: isArray, truncated: false,
          options: { checkLinks: false, maxLinks: 25 },
          sections: {
            metadata: { status: isString, counts: isObject, data: { canonical: { status: "self" } } },
            indexability: { data: { indexable: true, robotsTxt: { fetched: true, allowedForAll: true, allowedForGooglebot: true } } },
            content: { data: { h1Count: 1 } },
            social: { data: { openGraph: expect.objectContaining({ "og:title": isString }) } },
            structuredData: { data: { types: ["Organization"] } },
            links: { data: { checked: null } }
          }
        });
        expect(seo.counts.warning).toBe(0);
        expect(seo.score).toBe(100);
        expect(seo.sections.indexability.data.robotsTxt.sitemaps).toEqual([`${pages.origin}/sitemap.xml`]);
      });
    }, SLOW);

    it("seo audit: a problem page fails with actionable issues and is blocked by robots.txt", async () => {
      await withTab(pages.seoBad, async (tabId) => {
        await perceive(tabId, (p) => p.result.graph.url === pages.seoBad);
        const seo = await ok("GET", `/api/tabs/${tabId}/seo`);
        const byId = (id: string): Json => seo.issues.find((i: Json) => i.id === id);
        expect(seo.pass).toBe(false);
        for (const id of ["title-missing", "noindex", "h1-multiple", "jsonld-parse-error", "robots-txt-disallowed", "image-alt-missing", "link-text-generic-ambiguous"]) {
          expect(byId(id), id).toMatchObject({ section: isString, severity: isString, message: isString, fix: isString });
        }
        expect(byId("title-missing").severity).toBe("error");
        expect(byId("noindex").severity).toBe("error");
        expect(byId("jsonld-parse-error").message).toContain("block 0");
        expect(seo.sections.indexability.data.robotsTxt).toMatchObject({ allowedForAll: false, allowedForGooglebot: false });
        expect(seo.counts.error).toBe(3);
        expect(seo.score).toBeLessThan(60);
        // Opt-in only: a default audit never actively checks links.
        expect(seo.sections.links.data.checked).toBeNull();
      });
    }, SLOW);

    it("seo audit: X-Robots-Tag comes from the network log and only allowlisted headers are exposed", async () => {
      await withTab(pages.seoHeaderNoindex, async (tabId) => {
        await perceive(tabId, (p) => p.result.graph.url === pages.seoHeaderNoindex);
        let seo: Json = null;
        await expect
          .poll(async () => {
            seo = await ok("GET", `/api/tabs/${tabId}/seo`);
            return seo.sections.indexability.data.xRobotsTag;
          }, POLL)
          .toBe("noindex");
        const noindex = seo.issues.find((i: Json) => i.id === "noindex");
        expect(noindex.evidence).toContain("X-Robots-Tag");
        expect(seo.sections.indexability.data.indexable).toBe(false);
        const headerNames = Object.keys(seo.sections.indexability.data.headers);
        for (const name of headerNames) expect(["x-robots-tag", "content-type", "link", "location"]).toContain(name);
        expect(JSON.stringify(seo)).not.toContain("contract-secret");
      });
    }, SLOW);

    it("seo audit: validates maxLinks", async () => {
      await withTab(pages.seoGood, async (tabId) => {
        expect((await call("GET", `/api/tabs/${tabId}/seo?maxLinks=0`)).status).toBe(400);
        expect((await call("GET", `/api/tabs/${tabId}/seo?maxLinks=101`)).status).toBe(400);
        expect((await call("GET", `/api/tabs/${tabId}/seo?maxLinks=abc`)).status).toBe(400);
      });
    }, SLOW);

    it.skipIf(needsBrowser)("seo audit: checkLinks reports broken same-origin links through the page", async () => {
      await withTab(pages.seoBad, async (tabId) => {
        await perceive(tabId, (p) => p.result.graph.url === pages.seoBad);
        const seo = await ok("GET", `/api/tabs/${tabId}/seo?checkLinks=true&maxLinks=5`);
        expect(seo.options).toEqual({ checkLinks: true, maxLinks: 5 });
        const checked: Json[] = seo.sections.links.data.checked;
        expect(checked.length).toBeLessThanOrEqual(5);
        expect(checked.find((c) => c.url === `${pages.origin}/missing.html`)).toMatchObject({ status: 404 });
        expect(checked.find((c) => c.url === `${pages.origin}/blank.html`)).toMatchObject({ status: 200 });
        expect(seo.issues.find((i: Json) => i.id === "link-broken-4xx")).toMatchObject({ severity: "error" });
      });
    }, SLOW);

    it.skipIf(needsBrowser)("element styles: inspect and assert (pass + fail)", async () => {
      await withTab(pages.styled, async (tabId) => {
        await perceive(tabId, (p) => p.result.graph.url === pages.styled);
        const inspected = await ok("POST", `/api/tabs/${tabId}/styles/inspect`, { selector: "#cta" });
        expect(inspected).toMatchObject({ tabId, selector: "#cta", matchedCount: 1, inspectedCount: 1, elements: isArray, warnings: isArray });

        const pass = await ok("POST", `/api/tabs/${tabId}/styles/assert`, {
          selector: "#cta",
          assertions: [{ property: "color", equals: "rgb(255, 255, 255)" }, { property: "background-color", equals: "rgb(29, 127, 90)" }]
        });
        expect(pass).toMatchObject({ selector: "#cta", pass: true, matchedCount: 1, checks: isArray, issues: [] });

        const fail = await ok("POST", `/api/tabs/${tabId}/styles/assert`, { selector: "#cta", assertions: [{ property: "color", equals: "rgb(0, 0, 0)" }] });
        expect(fail.pass).toBe(false);
        expect(fail.checks).toEqual([expect.objectContaining({ property: "color", actual: "rgb(255, 255, 255)", pass: false, message: isString })]);

        expect((await call("POST", `/api/tabs/${tabId}/styles/inspect`, { selector: " " })).status).toBe(400);
        expect((await call("POST", `/api/tabs/${tabId}/styles/assert`, { selector: "#cta" })).status).toBe(400);
      });
    }, SLOW);

    it.skipIf(needsBrowser)("layout issues flag horizontal overflow", async () => {
      await withTab(pages.styled, async (tabId) => {
        await perceive(tabId, (p) => p.result.graph.url === pages.styled);
        const report = await ok("GET", `/api/tabs/${tabId}/layout-issues`);
        expect(report).toMatchObject({ tabId, viewport: { width: isNumber, height: isNumber }, documentScrollWidth: isNumber, issues: isArray, hasHorizontalOverflow: true });
        expect(report.documentScrollWidth).toBeGreaterThan(report.viewport.width);
      });
    }, SLOW);

    it.skipIf(needsBrowser)("design tokens include :root custom properties and sampled values", async () => {
      await withTab(pages.styled, async (tabId) => {
        await perceive(tabId, (p) => p.result.graph.url === pages.styled);
        const tokens = await ok("GET", `/api/tabs/${tabId}/design-tokens`);
        expect(tokens).toMatchObject({ tabId, cssVariables: expect.objectContaining({ "--brand": expect.stringContaining("29") }), sampledElements: isNumber });
        for (const key of ["colors", "fontFamilies", "fontSizes", "fontWeights", "spacing", "radii", "shadows", "zIndices"]) {
          expect(tokens[key], key).toEqual(isArray);
        }
        expect(tokens.sampledElements).toBeGreaterThan(0);
      });
    }, SLOW);

    it.skipIf(needsBrowser)("focus order lists focusable elements in tab order", async () => {
      await withTab(pages.styled, async (tabId) => {
        await perceive(tabId, (p) => p.result.graph.url === pages.styled);
        const report = await ok("GET", `/api/tabs/${tabId}/focus-order`);
        expect(report).toMatchObject({ tabId, focusableCount: isNumber, positiveTabindexCount: 0, issues: isArray, order: isArray });
        expect(report.focusableCount).toBeGreaterThanOrEqual(3);
        expect(report.order.length).toBe(report.focusableCount);
      });
    }, SLOW);

    it.skipIf(needsBrowser)("CSS and JS coverage report per-resource usage", async () => {
      await withTab(pages.styled, async (tabId) => {
        await perceive(tabId, (p) => p.result.graph.url === pages.styled);
        const css = await ok("GET", `/api/tabs/${tabId}/css-coverage`);
        expect(css).toMatchObject({
          tabId,
          stylesheets: isArray,
          summary: { stylesheetCount: isNumber, ruleCount: isNumber, usedRuleCount: isNumber, unusedRuleCount: isNumber, usedPercent: isNumber }
        });
        expect(css.stylesheets.map((s: Json) => s.sourceURL)).toContain(`${pages.origin}/fixture.css`);
        expect(css.summary.ruleCount).toBeGreaterThan(0);

        const js = await ok("GET", `/api/tabs/${tabId}/js-coverage`);
        expect(js).toMatchObject({ tabId, scripts: isArray, summary: { scriptCount: isNumber, usedBytes: isNumber, unusedBytes: isNumber, usedPercent: isNumber } });
        const script = js.scripts.find((s: Json) => s.url === `${pages.origin}/fixture.js`);
        expect(script, JSON.stringify(js.scripts.map((s: Json) => s.url))).toBeDefined();
        expect(js.summary.unusedBytes, "neverCalled() is dead code").toBeGreaterThan(0);
        expect(js.summary.usedPercent).toBeGreaterThan(0);
        expect(js.summary.usedPercent).toBeLessThan(100);
      });
    }, SLOW);

    // Current Chrome's CSS.stopRuleUsageTracking lists only *used* rules; the
    // report must still count fixture.css's 2 never-matching rules as unused.
    it.skipIf(needsBrowser)("CSS coverage counts rules that never matched as unused", async () => {
      await withTab(pages.styled, async (tabId) => {
        await perceive(tabId, (p) => p.result.graph.url === pages.styled);
        const css = await ok("GET", `/api/tabs/${tabId}/css-coverage`);
        const sheet = css.stylesheets.find((s: Json) => s.sourceURL === `${pages.origin}/fixture.css`);
        expect(sheet, JSON.stringify(css.stylesheets.map((s: Json) => s.sourceURL))).toBeDefined();
        expect(sheet).toMatchObject({ status: "measured", ruleCount: 5, usedRuleCount: 3, unusedRuleCount: 2 });
        expect(sheet.usedPercent).toBeGreaterThan(0);
        expect(sheet.usedPercent).toBeLessThan(100);
        expect(sheet.unusedRules.map((r: Json) => r.selector)).toEqual([".never-used-rule", ".also-never-used > span"]);
      });
    }, SLOW);

    // ── Network: mock, logs, HAR ────────────────────────────────────────────

    it("network mock: enable, get, (fulfil a fetch), disable", async () => {
      await withTab(pages.blank, async (tabId) => {
        await perceive(tabId, (p) => p.result.graph.url === pages.blank);
        const fetchData = `fetch(${JSON.stringify(pages.dataEndpoint)}).then((r) => r.json())`;

        expect(await ok("GET", `/api/tabs/${tabId}/mock`)).toEqual({ rules: null });
        const rules = [{ urlPattern: "*/api/data.json", responseStatus: 200, responseBody: { source: "mock" } }];
        expect(await ok("POST", `/api/tabs/${tabId}/mock`, { rules })).toEqual({ ok: true, rulesCount: 1 });
        expect((await ok("GET", `/api/tabs/${tabId}/mock`)).rules).toEqual([expect.objectContaining({ urlPattern: "*/api/data.json" })]);
        if (factory.realBrowser) {
          expect(await ok("POST", `/api/tabs/${tabId}/evaluate`, { expression: fetchData })).toEqual({ value: { source: "mock" } });
        }

        expect(await ok("DELETE", `/api/tabs/${tabId}/mock`)).toEqual({ ok: true });
        expect(await ok("GET", `/api/tabs/${tabId}/mock`)).toEqual({ rules: null });
        if (factory.realBrowser) {
          expect(await ok("POST", `/api/tabs/${tabId}/evaluate`, { expression: fetchData })).toEqual({ value: { source: "server" } });
        }
        expect((await call("POST", `/api/tabs/${tabId}/mock`, { rules: "nope" })).status).toBe(400);
      });
    }, SLOW);

    it("tab logs + HAR: the document request is captured with a real wall-clock date", async () => {
      await withTab(pages.contactForm, async (tabId) => {
        await perceive(tabId, hasForm);
        const started = Date.now();
        let logs: Json = null;
        await expect
          .poll(async () => {
            logs = await ok("GET", `/api/tabs/${tabId}/logs`);
            return logs.networkRequests.some((r: Json) => r.url === pages.contactForm && r.statusCode === 200);
          }, POLL)
          .toBe(true);
        expect(logs).toMatchObject({ tabId, consoleLogs: isArray, networkRequests: isArray, webSocketFrames: isArray, eventSourceEvents: isArray, jsErrors: isArray, capturedAt: isNumber });

        const har = await ok("GET", `/api/tabs/${tabId}/har`);
        expect(har.log).toMatchObject({ version: "1.2", creator: { name: isString, version: isString }, pages: isArray, entries: isArray });
        const entry = har.log.entries.find((e: Json) => e.request.url === pages.contactForm);
        expect(entry, "HAR contains the document request").toBeDefined();
        expect(entry).toMatchObject({ startedDateTime: isString, time: isNumber, request: { method: "GET" }, response: { status: 200 } });
        const when = Date.parse(entry.startedDateTime);
        expect(Number.isNaN(when)).toBe(false);
        expect(Math.abs(when - started), `startedDateTime ${entry.startedDateTime} is a real date`).toBeLessThan(DAY_MS);

        expect(await ok("DELETE", `/api/tabs/${tabId}/logs`)).toEqual({ ok: true });
        const cleared = await ok("GET", `/api/tabs/${tabId}/logs`);
        expect(cleared.networkRequests).toEqual([]);
      });
    }, SLOW);

    it.skipIf(needsBrowser)("tab logs capture page console output", async () => {
      await withTab(pages.styled, async (tabId) => {
        await expect
          .poll(async () => {
            const logs = await ok("GET", `/api/tabs/${tabId}/logs`);
            return logs.consoleLogs.some((l: Json) => String(l.text ?? l.message ?? "").includes(CONSOLE_MARKER));
          }, POLL)
          .toBe(true);
      });
    }, SLOW);

    // ── Storage + cookies ───────────────────────────────────────────────────

    it.skipIf(needsBrowser)("storage: set, read, snapshot, clear (local + session)", async () => {
      await withTab(pages.blank, async (tabId) => {
        await perceive(tabId, (p) => p.result.graph.url === pages.blank);
        for (const area of ["local", "session"]) {
          await ok("POST", `/api/tabs/${tabId}/storage/${area}`, { entries: { [id("key")]: "v1" } });
          const entries = (await ok("GET", `/api/tabs/${tabId}/storage/${area}?key=${id("key")}`)) as Json[];
          expect(entries).toEqual([expect.objectContaining({ key: id("key"), value: "v1" })]);
        }
        const snapshot = await ok("GET", `/api/tabs/${tabId}/storage`);
        expect(snapshot).toMatchObject({ tabId, localStorage: isArray, sessionStorage: isArray, cookies: isArray, indexedDb: isArray, totalBytes: isNumber });
        expect(snapshot.localStorage.map((e: Json) => e.key)).toContain(id("key"));

        for (const area of ["local", "session"]) {
          await ok("DELETE", `/api/tabs/${tabId}/storage/${area}`, { keys: [id("key")] });
          expect(await ok("GET", `/api/tabs/${tabId}/storage/${area}?key=${id("key")}`)).toEqual([]);
        }
        expect((await call("POST", `/api/tabs/${tabId}/storage/local`, {})).status).toBe(400);
      });
    }, SLOW);

    it.skipIf(needsBrowser)("cookies: set, list, delete one, clear", async () => {
      await withTab(pages.blank, async (tabId) => {
        await perceive(tabId, (p) => p.result.graph.url === pages.blank);
        const name = id("cookie");
        await ok("POST", `/api/tabs/${tabId}/cookies`, { name, value: "c1", url: pages.origin });
        const cookies = (await ok("GET", `/api/tabs/${tabId}/cookies`)) as Json[];
        expect(cookies.find((c) => c.name === name)).toMatchObject({ name, value: "c1", domain: isString, path: isString, httpOnly: false, secure: false });

        await ok("DELETE", `/api/tabs/${tabId}/cookies/${name}?url=${encodeURIComponent(pages.origin)}`);
        expect(((await ok("GET", `/api/tabs/${tabId}/cookies`)) as Json[]).some((c) => c.name === name)).toBe(false);

        await ok("POST", `/api/tabs/${tabId}/cookies`, { name, value: "c2", url: pages.origin });
        await ok("DELETE", `/api/tabs/${tabId}/cookies`);
        expect(((await ok("GET", `/api/tabs/${tabId}/cookies`)) as Json[]).some((c) => c.name === name)).toBe(false);
        expect((await call("POST", `/api/tabs/${tabId}/cookies`, { name })).status).toBe(400);
      });
    }, SLOW);

    // ── Assertions + commands ───────────────────────────────────────────────

    it("assertions: one-shot assert and a standing watch evaluated on perception", async () => {
      await withTab(pages.contactForm, async (tabId) => {
        await perceive(tabId, hasForm);
        const result = await ok("POST", `/api/tabs/${tabId}/assert`, { assertion: "at least 1 form" });
        expect(result).toMatchObject({ tabId, assertion: "at least 1 form", pass: true, confidence: isString, explanation: isString });
        expect((await call("POST", `/api/tabs/${tabId}/assert`, { assertion: "" })).status).toBe(400);

        const watch = await ok("POST", `/api/tabs/${tabId}/watches`, { assertion: "at least 1 form" });
        expect(watch).toMatchObject({ id: isString, tabId, assertion: "at least 1 form", lastPass: null, createdAt: isNumber });
        await ok("GET", `/api/tabs/${tabId}/perception`);
        const watches = (await ok("GET", `/api/tabs/${tabId}/watches`)) as Json[];
        expect(watches.find((w) => w.id === watch.id)).toMatchObject({ lastPass: true });

        expect(await ok("DELETE", `/api/tabs/${tabId}/watches/${watch.id}`)).toEqual({ removed: true });
        expect(((await ok("GET", `/api/tabs/${tabId}/watches`)) as Json[]).some((w) => w.id === watch.id)).toBe(false);
      });
    }, SLOW);

    it("commands: a read completes; a form submit and a personal-data fill are queued for approval and can be rejected", async () => {
      await withTab(pages.contactForm, async (tabId) => {
        const packet = await perceive(tabId, hasForm);
        const read = await ok("POST", `/api/tabs/${tabId}/command`, {
          command: { type: "invoke_site_tool", provider: "dom", toolName: "dom.read_page_state", args: {} }
        });
        expect(read).toMatchObject({ status: "completed", graph: expect.objectContaining({ tabId }) });

        const formId = packet.result.graph.forms[0].id;
        const submit = { type: "invoke_site_tool", provider: "dom", toolName: `dom.submit.${formId}`, args: {} };
        const queued = await ok("POST", `/api/tabs/${tabId}/command`, { command: submit });
        expect(queued).toMatchObject({ status: "awaiting_approval", requestId: isString, summary: isString, effects: isArray });
        expect(queued.effects[0]).toMatchObject({ type: "share_personal_data" });

        const pending = (await ok("GET", "/api/approvals")) as Json[];
        expect(pending.find((a) => a.requestId === queued.requestId)).toMatchObject({ tabId, command: submit, effects: isArray, createdAt: isNumber });

        const rejected = await ok("POST", `/api/approvals/${queued.requestId}/reject`);
        expect(rejected).toMatchObject({ status: "blocked", reason: expect.stringContaining("rejected") });
        expect(((await ok("GET", "/api/approvals")) as Json[]).some((a) => a.requestId === queued.requestId)).toBe(false);

        // Filling a personal field is gated too: it leaks to the page before any submit.
        const emailField = (packet.result.graph.forms[0].fields as Json[]).find((f) => f.fieldType === "email");
        expect(emailField).toBeTruthy();
        const fill = { type: "invoke_site_tool", provider: "dom", toolName: `dom.fill.${formId}`, args: { [emailField.id]: { kind: "literal", value: "qa@example.com" } } };
        const fillQueued = await ok("POST", `/api/tabs/${tabId}/command`, { command: fill });
        expect(fillQueued).toMatchObject({ status: "awaiting_approval", requestId: isString, effects: [expect.objectContaining({ type: "share_personal_data" })] });
        await ok("POST", `/api/approvals/${fillQueued.requestId}/reject`);

        expect((await call("POST", `/api/tabs/${tabId}/command`, {})).status).toBe(400);
      });
    }, SLOW);

    it("commands: navigating away cancels a pending approval; approving it later does not run it", async () => {
      await withTab(pages.contactForm, async (tabId) => {
        const packet = await perceive(tabId, hasForm);
        const form = packet.result.graph.forms[0];
        const emailField = (form.fields as Json[]).find((f) => f.fieldType === "email");
        const fill = { type: "invoke_site_tool", provider: "dom", toolName: `dom.fill.${form.id}`, args: { [emailField.id]: { kind: "literal", value: "qa@example.com" } } };
        const queued = await ok("POST", `/api/tabs/${tabId}/command`, { command: fill });
        expect(queued).toMatchObject({ status: "awaiting_approval", requestId: isString });
        const pending = (await ok("GET", "/api/approvals")) as Json[];
        expect(pending.find((a) => a.requestId === queued.requestId)).toMatchObject({ url: pages.contactForm, origin: pages.origin });

        await ok("POST", `/api/tabs/${tabId}/navigate`, { url: pages.styled });
        await perceive(tabId, (p) => p.result.graph.url === pages.styled);

        expect(((await ok("GET", "/api/approvals")) as Json[]).some((a) => a.requestId === queued.requestId)).toBe(false);
        const late = await ok("POST", `/api/approvals/${queued.requestId}/approve`);
        expect(late).toMatchObject({ status: "blocked", reason: expect.stringContaining("Page changed before approval") });
      });
    }, SLOW);
  });
}
