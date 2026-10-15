import { describe, expect, it } from "vitest";

import {
  buildSeoReport,
  mainDocumentResponse,
  observedBrokenLinks,
  seoCollectorScript,
  seoLinkCheckScript,
  seoRobotsFetchScript,
  seoScore,
  type RawSeoSignals,
  type SeoAuditInputs
} from "../src/core/cdp/seo-audit.js";
import { evaluateRobots, parseRobotsTxt, robotsPatternMatches } from "../src/core/reports/robots-txt.js";
import type { NetworkRequestEntry, SeoIssue } from "../../shared/src/index.js";

const URL_ = "https://example.com/blog/post";

function signals(over: Partial<RawSeoSignals> = {}): RawSeoSignals {
  return {
    url: URL_,
    origin: "https://example.com",
    titles: ["A good page title for testing"],
    descriptions: ["This description is comfortably within the recommended length range for search results snippets."],
    canonicals: [{ href: URL_, resolved: URL_ }],
    lang: "en",
    viewport: "width=device-width, initial-scale=1",
    charset: { meta: "utf-8", httpEquiv: null, document: "UTF-8" },
    hreflang: [],
    robotsMeta: [],
    headings: [
      { level: 1, text: "Main heading", selector: "h1", empty: false },
      { level: 2, text: "Section", selector: "h2", empty: false }
    ],
    images: { total: 1, missingAlt: 0, missingAltSelectors: [] },
    links: [],
    linkTotal: 0,
    wordCount: 800,
    openGraph: {
      "og:title": "T", "og:description": "D", "og:image": "https://example.com/i.png", "og:url": URL_, "og:type": "article"
    },
    twitter: { "twitter:card": "summary_large_image" },
    jsonLd: [],
    microdataItems: 0,
    rdfaItems: 0,
    navigation: { responseStatus: 200, redirectCount: 0 },
    ...over
  };
}

const robotsOk = (text = "User-agent: *\nDisallow:\nSitemap: https://example.com/sitemap.xml\n") =>
  ({ ok: true as const, status: 200, url: "https://example.com/robots.txt", contentType: "text/plain", text });

function inputs(over: Partial<SeoAuditInputs> = {}): SeoAuditInputs {
  return {
    headers: { "content-type": "text/html; charset=utf-8" },
    logStatus: 200,
    robots: robotsOk(),
    linkChecks: null,
    observedBrokenLinks: [],
    options: { checkLinks: false, maxLinks: 25 },
    ...over
  };
}

const run = (s: Partial<RawSeoSignals> = {}, i: Partial<SeoAuditInputs> = {}) => buildSeoReport(signals(s), inputs(i), "t", 1);
const ids = (issues: SeoIssue[]) => issues.map((i) => i.id);
const find = (issues: SeoIssue[], id: string) => issues.find((i) => i.id === id);

describe("buildSeoReport — clean page", () => {
  it("passes with score 100 and no errors or warnings", () => {
    const report = run();
    expect(report.issues.filter((i) => i.severity !== "info")).toEqual([]);
    expect(report.score).toBe(100);
    expect(report.pass).toBe(true);
    expect(report.sections.metadata.data.canonical.status).toBe("self");
    expect(report.sections.indexability.data.robotsTxt).toMatchObject({ fetched: true, allowedForAll: true, allowedForGooglebot: true, sitemaps: ["https://example.com/sitemap.xml"] });
    expect(report.unsupported).toEqual([]);
  });
});

describe("metadata", () => {
  it("flags missing, empty, short, long and multiple titles", () => {
    expect(ids(run({ titles: [] }).issues)).toContain("title-missing");
    expect(find(run({ titles: [""] }).issues, "title-empty")?.severity).toBe("error");
    expect(ids(run({ titles: ["Short"] }).issues)).toContain("title-short");
    expect(ids(run({ titles: ["x".repeat(61)] }).issues)).toContain("title-long");
    expect(ids(run({ titles: ["x".repeat(60)] }).issues)).not.toContain("title-long");
    expect(ids(run({ titles: ["Title one is fine", "Another title"] }).issues)).toContain("title-multiple");
  });

  it("reports a title identical to the h1 as info only", () => {
    const report = run({
      titles: ["Main heading here"],
      headings: [{ level: 1, text: "main heading here", selector: "h1", empty: false }]
    });
    expect(find(report.issues, "title-duplicates-h1")?.severity).toBe("info");
  });

  it("checks meta description length bounds", () => {
    expect(ids(run({ descriptions: [] }).issues)).toContain("description-missing");
    expect(ids(run({ descriptions: ["too short"] }).issues)).toContain("description-short");
    expect(ids(run({ descriptions: ["y".repeat(161)] }).issues)).toContain("description-long");
    expect(ids(run({ descriptions: ["y".repeat(160)] }).issues)).not.toContain("description-long");
  });

  it("classifies canonicals: missing, relative, different, off-domain, conflicting", () => {
    expect(find(run({ canonicals: [] }).issues, "canonical-missing")?.severity).toBe("warning");
    const rel = run({ canonicals: [{ href: "/blog/post", resolved: URL_ }] });
    expect(rel.sections.metadata.data.canonical.status).toBe("relative");
    expect(ids(rel.issues)).toContain("canonical-relative");

    const diff = run({ canonicals: [{ href: "https://example.com/blog/", resolved: "https://example.com/blog/" }] });
    expect(diff.sections.metadata.data.canonical.status).toBe("different");
    expect(find(diff.issues, "canonical-different")?.severity).toBe("info");

    const off = run({ canonicals: [{ href: "https://other.org/x", resolved: "https://other.org/x" }] });
    expect(ids(off.issues)).toContain("canonical-offdomain");

    const multi = run({ canonicals: [
      { href: URL_, resolved: URL_ },
      { href: "https://example.com/other", resolved: "https://example.com/other" }
    ] });
    expect(find(multi.issues, "canonical-multiple")?.severity).toBe("error");
    expect(multi.sections.metadata.data.canonical.status).toBe("multiple");
  });

  it("ignores URL fragments when deciding self-canonical and treats www as the same host", () => {
    const hashed = run({ url: `${URL_}#top`, canonicals: [{ href: URL_, resolved: URL_ }] });
    expect(hashed.sections.metadata.data.canonical.status).toBe("self");
    const www = run({ canonicals: [{ href: "https://www.example.com/x", resolved: "https://www.example.com/x" }] });
    expect(ids(www.issues)).not.toContain("canonical-offdomain");
  });

  it("validates lang, viewport and charset", () => {
    expect(ids(run({ lang: null }).issues)).toContain("lang-missing");
    expect(ids(run({ lang: "english_us" }).issues)).toContain("lang-invalid");
    expect(ids(run({ lang: "zh-Hant-TW" }).issues)).not.toContain("lang-invalid");
    expect(ids(run({ viewport: null }).issues)).toContain("viewport-missing");
    expect(ids(run({ viewport: "initial-scale=1" }).issues)).toContain("viewport-not-responsive");
    expect(ids(run({ charset: { meta: null, httpEquiv: null, document: "UTF-8" } }, { headers: {} }).issues)).toContain("charset-missing");
    // A Content-Type header charset satisfies the declaration.
    expect(ids(run({ charset: { meta: null, httpEquiv: null, document: "UTF-8" } }).issues)).not.toContain("charset-missing");
  });

  it("checks hreflang self-reference and validity, and says reciprocity is unverifiable", () => {
    const good = run({ hreflang: [
      { hreflang: "en", href: URL_, resolved: URL_ },
      { hreflang: "x-default", href: "https://example.com/", resolved: "https://example.com/" }
    ] });
    expect(ids(good.issues)).toContain("hreflang-reciprocal-unverified");
    expect(ids(good.issues)).not.toContain("hreflang-no-self-reference");
    expect(good.unsupported.map((u) => u.check)).toContain("hreflang reciprocal links");

    const bad = run({ hreflang: [
      { hreflang: "english", href: "/en", resolved: "https://example.com/en" },
      { hreflang: "english", href: "https://example.com/en2", resolved: "https://example.com/en2" }
    ] });
    expect(ids(bad.issues)).toEqual(expect.arrayContaining(["hreflang-invalid", "hreflang-duplicate", "hreflang-relative", "hreflang-no-self-reference"]));
  });
});

describe("indexability", () => {
  it("errors on noindex via meta robots, googlebot meta, or none; ignores other bots", () => {
    expect(find(run({ robotsMeta: [{ name: "robots", content: "noindex, follow" }] }).issues, "noindex")?.severity).toBe("error");
    expect(ids(run({ robotsMeta: [{ name: "googlebot", content: "NOINDEX" }] }).issues)).toContain("noindex");
    const none = run({ robotsMeta: [{ name: "robots", content: "none" }] });
    expect(ids(none.issues)).toEqual(expect.arrayContaining(["noindex", "nofollow"]));
    const bing = run({ robotsMeta: [{ name: "bingbot", content: "noindex" }] });
    expect(ids(bing.issues)).not.toContain("noindex");
    expect(bing.sections.indexability.data.indexable).toBe(true);
  });

  it("reads X-Robots-Tag, including agent-prefixed values", () => {
    const plain = run({}, { headers: { "x-robots-tag": "noindex, nofollow" } });
    expect(ids(plain.issues)).toEqual(expect.arrayContaining(["noindex", "nofollow"]));
    expect(plain.sections.indexability.data.indexable).toBe(false);
    expect(plain.sections.indexability.data.xRobotsTag).toBe("noindex, nofollow");

    const google = run({}, { headers: { "x-robots-tag": "googlebot: noindex" } });
    expect(ids(google.issues)).toContain("noindex");
    const other = run({}, { headers: { "x-robots-tag": "otherbot: noindex" } });
    expect(ids(other.issues)).not.toContain("noindex");
    const unavailable = run({}, { headers: { "x-robots-tag": "unavailable_after: 25 Jun 2030 15:00:00 PST" } });
    expect(ids(unavailable.issues)).not.toContain("noindex");
  });

  it("flags non-200 statuses and notes redirects; skips status when unknown", () => {
    expect(find(run({}, { logStatus: 404 }).issues, "http-error-status")?.severity).toBe("error");
    expect(find(run({}, { logStatus: 301 }).issues, "http-redirect-status")?.severity).toBe("warning");
    expect(ids(run({}, { logStatus: 204 }).issues)).toContain("http-nonstandard-status");
    expect(ids(run({ navigation: { responseStatus: 200, redirectCount: 2 } }).issues)).toContain("redirected");
    const unknown = run({ navigation: { responseStatus: null, redirectCount: null } }, { logStatus: null });
    expect(unknown.skipped.map((s) => s.check)).toContain("HTTP status");
  });

  it("notes when the header source was not observed", () => {
    expect(run({}, { headers: null }).skipped.map((s) => s.check)).toContain("X-Robots-Tag header");
  });

  it("evaluates robots.txt for * and Googlebot, and treats fetch failures as info", () => {
    const blocked = run({}, { robots: robotsOk("User-agent: *\nDisallow: /blog/\n") });
    expect(find(blocked.issues, "robots-txt-disallowed")?.severity).toBe("warning");
    expect(blocked.sections.indexability.data.robotsTxt.allowedForAll).toBe(false);

    const googleOnly = run({}, { robots: robotsOk("User-agent: *\nAllow: /\nUser-agent: Googlebot\nDisallow: /blog\n") });
    expect(googleOnly.sections.indexability.data.robotsTxt).toMatchObject({ allowedForAll: true, allowedForGooglebot: false });

    const failed = run({}, { robots: { ok: false, error: "timeout" } });
    expect(find(failed.issues, "robots-txt-unreachable")?.severity).toBe("info");
    expect(failed.skipped.map((s) => s.check)).toContain("robots.txt");
    expect(failed.pass).toBe(true);

    expect(find(run({}, { robots: { ...robotsOk(), status: 404, text: "" } }).issues, "robots-txt-missing")?.severity).toBe("info");
    expect(find(run({}, { robots: { ...robotsOk(), status: 503, text: "" } }).issues, "robots-txt-server-error")?.severity).toBe("warning");
    expect(ids(run({}, { robots: { ...robotsOk(), contentType: "text/html", text: "<html>" } }).issues)).toContain("robots-txt-not-text");
    expect(ids(run({}, { robots: robotsOk("User-agent: *\nDisallow:\n") }).issues)).toContain("sitemap-not-declared");
  });
});

describe("content", () => {
  it("handles h1 count, level skips and empty headings", () => {
    expect(find(run({ headings: [] }).issues, "h1-missing")?.severity).toBe("error");
    const many = run({ headings: [
      { level: 1, text: "A", selector: "h1.a", empty: false },
      { level: 1, text: "B", selector: "h1.b", empty: false }
    ] });
    expect(find(many.issues, "h1-multiple")).toMatchObject({ severity: "warning", selectors: ["h1.a", "h1.b"] });

    const skip = run({ headings: [
      { level: 1, text: "A", selector: "h1", empty: false },
      { level: 3, text: "C", selector: "h3", empty: false },
      { level: 5, text: "", selector: "h5", empty: true }
    ] });
    expect(find(skip.issues, "heading-level-skip")?.selectors).toEqual(["h3", "h5"]);
    expect(find(skip.issues, "heading-empty")?.selectors).toEqual(["h5"]);
  });

  it("caps image selector lists at 50 and flags truncation", () => {
    const selectors = Array.from({ length: 80 }, (_, i) => `img:nth-of-type(${i})`);
    const report = run({ images: { total: 90, missingAlt: 80, missingAltSelectors: selectors } });
    const issue = find(report.issues, "image-alt-missing")!;
    expect(issue.selectors).toHaveLength(50);
    expect(issue.count).toBe(80);
    expect(issue.truncated).toBe(true);
    expect(report.truncated).toBe(true);
  });

  it("flags generic link text pointing at different URLs, no-href and javascript: links", () => {
    const link = (text: string, href: string | null, selector: string, rel = "") => ({
      text, href, rel, selector, abs: href ? new URL(href, URL_).href : null
    });
    const report = run({
      links: [
        link("Read more", "/a", "a.one"),
        link("read more", "/b", "a.two", "nofollow"),
        link("Pricing", "/pricing", "a.three"),
        link("Learn more", "/c", "a.four"),
        link("Go", null, "a.five"),
        link("Do", "javascript:void(0)", "a.six")
      ],
      linkTotal: 6
    });
    expect(find(report.issues, "link-text-generic-ambiguous")).toMatchObject({ severity: "warning", selectors: ["a.one", "a.two"] });
    expect(find(report.issues, "link-text-generic")?.selectors).toEqual(["a.four"]);
    expect(find(report.issues, "link-no-href")?.selectors).toEqual(["a.five"]);
    expect(find(report.issues, "link-javascript-href")?.selectors).toEqual(["a.six"]);
    expect(find(report.issues, "link-nofollow-count")?.message).toMatch(/^1 link/);
    expect(report.sections.links.data).toMatchObject({ total: 6, nofollow: 1, internal: 4 });
  });

  it("treats thin content as info and never as a failure", () => {
    const report = run({ wordCount: 12 });
    expect(find(report.issues, "thin-content")?.severity).toBe("info");
    expect(report.score).toBe(100);
  });
});

describe("social and structured data", () => {
  it("flags missing and relative Open Graph tags and invalid twitter cards", () => {
    const none = run({ openGraph: {} });
    expect(ids(none.issues)).toContain("og-missing");
    const partial = run({ openGraph: { "og:title": "T", "og:image": "/img.png" } });
    expect(ids(partial.issues)).toEqual(expect.arrayContaining(["og-description-missing", "og-url-missing", "og-type-missing", "og-image-relative"]));
    expect(find(partial.issues, "og-url-missing")?.severity).toBe("info");
    expect(ids(run({ twitter: { "twitter:card": "huge" } }).issues)).toContain("twitter-card-invalid");
    expect(ids(run({ twitter: {} }).issues)).toContain("twitter-card-missing");
    expect(ids(run({ twitter: { "twitter:card": "summary", "twitter:image": "x.png" } }).issues)).toContain("twitter-image-relative");
  });

  it("reports JSON-LD parse errors with the block index and lists @types", () => {
    const report = run({ jsonLd: [
      JSON.stringify({ "@context": "https://schema.org", "@type": "Organization", name: "Acme", url: "https://example.com", logo: "https://example.com/l.png" }),
      "{ not json"
    ] });
    const err = find(report.issues, "jsonld-parse-error")!;
    expect(err.severity).toBe("error");
    expect(err.message).toContain("block 1");
    expect(report.pass).toBe(false);
    expect(report.sections.structuredData.data.types).toEqual(["Organization"]);
    expect(report.sections.structuredData.data.jsonLd).toEqual([
      { index: 0, valid: true, types: ["Organization"] },
      expect.objectContaining({ index: 1, valid: false })
    ]);
  });

  it("checks required properties for the vetted types, including @graph", () => {
    const report = run({ jsonLd: [
      JSON.stringify({ "@context": "https://schema.org", "@graph": [
        { "@type": "Product", description: "x" },
        { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home" }, { "@type": "ListItem", position: 2, name: "Post" }] },
        { "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "Q?" }] },
        { "@type": "WebSite", name: "Acme" },
        { "@type": "Article", headline: "H" }
      ] })
    ] });
    const required = report.issues.filter((i) => i.id === "jsonld-required-missing");
    const text = required.map((i) => `${i.message} ${i.evidence}`).join("\n");
    expect(text).toMatch(/Product.*name/s);
    expect(text).toMatch(/one of review\/aggregateRating\/offers/);
    expect(text).toMatch(/BreadcrumbList[\s\S]*itemListElement\[0\] missing item/);
    expect(text).toMatch(/FAQPage[\s\S]*acceptedAnswer\.text/);
    expect(text).toMatch(/WebSite[\s\S]*url/);
    const rec = report.issues.filter((i) => i.id === "jsonld-recommended-missing");
    expect(rec.some((i) => i.message.startsWith("Article"))).toBe(true);
    expect(rec.every((i) => i.severity === "info")).toBe(true);
  });

  it("accepts complete markup and requires a schema.org context", () => {
    const ok = run({ jsonLd: [JSON.stringify({
      "@context": "https://schema.org", "@type": "Product", name: "Widget", offers: { "@type": "Offer", price: "1", priceCurrency: "USD" }, image: "i", description: "d"
    })] });
    expect(ids(ok.issues).filter((i) => i.startsWith("jsonld"))).toEqual([]);
    const noCtx = run({ jsonLd: [JSON.stringify({ "@type": "Organization", name: "A", url: "u", logo: "l" })] });
    expect(ids(noCtx.issues)).toContain("jsonld-context-missing");
  });

  it("reports microdata/RDFa as counts only and notes when no structured data exists", () => {
    const report = run({ microdataItems: 2, rdfaItems: 3 });
    expect(report.sections.structuredData.data).toMatchObject({ microdataItems: 2, rdfaItems: 3 });
    expect(ids(report.issues)).not.toContain("structured-data-none");
    expect(ids(run().issues)).toContain("structured-data-none");
  });
});

describe("links", () => {
  it("reports observed and actively checked broken links and redirects", () => {
    const report = run(
      { links: [
        { href: "/a", abs: "https://example.com/a", text: "A", rel: "", selector: "a" },
        { href: "https://elsewhere.org/", abs: "https://elsewhere.org/", text: "E", rel: "", selector: "a.e" }
      ], linkTotal: 2 },
      {
        observedBrokenLinks: [{ url: "https://example.com/gone", status: 404 }],
        linkChecks: [
          { url: "https://example.com/a", status: 200 },
          { url: "https://example.com/b", status: 404 },
          { url: "https://example.com/c", status: 503 },
          { url: "https://example.com/d", status: 200, redirectedTo: "https://example.com/d2" },
          { url: "https://example.com/e", status: null, error: "timeout" }
        ],
        options: { checkLinks: true, maxLinks: 5 },
        linkCheckTruncated: true
      }
    );
    expect(find(report.issues, "link-broken-observed")?.severity).toBe("error");
    expect(find(report.issues, "link-broken-4xx")?.severity).toBe("error");
    expect(find(report.issues, "link-broken-5xx")?.severity).toBe("warning");
    expect(find(report.issues, "link-redirected")?.evidence).toContain("d2");
    expect(ids(report.issues)).toEqual(expect.arrayContaining(["link-check-failed", "link-check-capped"]));
    expect(report.sections.links).toMatchObject({ status: "fail", data: { internal: 1, external: 1, checked: expect.any(Array) } });
    expect(report.options).toEqual({ checkLinks: true, maxLinks: 5 });
  });

  it("leaves `checked` null when the opt-in link check did not run", () => {
    expect(run().sections.links.data.checked).toBeNull();
  });
});

describe("scoring", () => {
  it("is 100 - 12/error - 4/warning, floors at 0 and is monotonic", () => {
    expect(seoScore({ error: 0, warning: 0, info: 9 })).toBe(100);
    expect(seoScore({ error: 1, warning: 2, info: 0 })).toBe(80);
    expect(seoScore({ error: 20, warning: 20, info: 0 })).toBe(0);
    let prev = 101;
    for (let e = 0; e < 10; e++) for (let w = 0; w < 10; w++) {
      const s = seoScore({ error: e, warning: w, info: 0 });
      expect(s).toBeLessThanOrEqual(seoScore({ error: e, warning: Math.max(0, w - 1), info: 0 }));
      expect(s).toBeLessThanOrEqual(seoScore({ error: Math.max(0, e - 1), warning: w, info: 0 }));
      prev = Math.min(prev, s);
    }
    expect(prev).toBe(0);
  });

  it("counts each issue once and sets pass from error count", () => {
    const report = run({ titles: [], descriptions: [], lang: null });
    expect(report.counts).toEqual({ error: 1, warning: 2, info: expect.any(Number) });
    expect(report.score).toBe(100 - 12 - 8);
    expect(report.pass).toBe(false);
    expect(report.issues[0].severity).toBe("error");
    expect(report.sections.metadata.status).toBe("fail");
    expect(report.sections.social.status).toBe("pass");
  });
});

describe("network log helpers", () => {
  const entry = (over: Partial<NetworkRequestEntry>): NetworkRequestEntry => ({
    requestId: "1", url: URL_, method: "GET", failed: false, timestamp: 1, statusCode: 200, mimeType: "text/html", ...over
  });

  it("returns only allowlisted headers of the main document — never cookies or auth", () => {
    const doc = mainDocumentResponse([
      entry({
        responseHeaders: {
          "X-Robots-Tag": "noindex",
          "Content-Type": "text/html",
          "Set-Cookie": "session=secret",
          Authorization: "Bearer x",
          Link: "<https://example.com/c>; rel=\"canonical\"",
          Location: "/elsewhere",
          "Cache-Control": "no-store"
        }
      })
    ], `${URL_}#frag`);
    expect(doc?.status).toBe(200);
    expect(Object.keys(doc!.headers).sort()).toEqual(["content-type", "link", "location", "x-robots-tag"]);
    expect(JSON.stringify(doc)).not.toMatch(/secret|Bearer/);
  });

  it("prefers the latest document response and ignores subresources", () => {
    const doc = mainDocumentResponse([
      entry({ timestamp: 1, statusCode: 301 }),
      entry({ requestId: "2", timestamp: 2, statusCode: 200, responseHeaders: { "x-robots-tag": "noarchive" } }),
      entry({ requestId: "3", url: "https://example.com/app.js", mimeType: "text/javascript", timestamp: 3 })
    ], URL_);
    expect(doc).toEqual({ status: 200, headers: { "x-robots-tag": "noarchive" } });
    expect(mainDocumentResponse([], URL_)).toBeNull();
  });

  it("finds linked URLs that already failed in the log", () => {
    const broken = observedBrokenLinks([
      entry({ requestId: "a", url: "https://example.com/gone", statusCode: 404 }),
      entry({ requestId: "b", url: "https://example.com/fine", statusCode: 200 }),
      entry({ requestId: "c", url: "https://example.com/unlinked", statusCode: 500 })
    ], ["https://example.com/gone", "https://example.com/fine"], URL_);
    expect(broken).toEqual([{ url: "https://example.com/gone", status: 404 }]);
  });
});

describe("robots.txt matcher", () => {
  const allowed = (txt: string, agent: string, path: string) => evaluateRobots(parseRobotsTxt(txt), agent, path).allowed;

  it("applies longest match with Allow winning ties", () => {
    const txt = "User-agent: *\nDisallow: /private/\nAllow: /private/public/\nDisallow: /tie\nAllow: /tie\n";
    expect(allowed(txt, "*", "/private/x")).toBe(false);
    expect(allowed(txt, "*", "/private/public/page")).toBe(true);
    expect(allowed(txt, "*", "/tie")).toBe(true);
    expect(allowed(txt, "*", "/open")).toBe(true);
  });

  it("supports * wildcards and $ anchors", () => {
    expect(robotsPatternMatches("/*.pdf$", "/files/a.pdf")).toBe(true);
    expect(robotsPatternMatches("/*.pdf$", "/files/a.pdf?x=1")).toBe(false);
    expect(robotsPatternMatches("/a*b*c", "/aXXbYYc/tail")).toBe(true);
    expect(robotsPatternMatches("/exact$", "/exact")).toBe(true);
    expect(robotsPatternMatches("/exact$", "/exact/more")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /*?session=", "*", "/p?session=1")).toBe(false);
  });

  it("selects the named group over * and merges repeated groups", () => {
    const txt = "User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nDisallow: /nogoogle\n\nUser-agent: googlebot\nDisallow: /more\n";
    expect(allowed(txt, "googlebot", "/page")).toBe(true);
    expect(allowed(txt, "googlebot", "/nogoogle/x")).toBe(false);
    expect(allowed(txt, "googlebot", "/more")).toBe(false);
    expect(allowed(txt, "*", "/page")).toBe(false);
    expect(allowed(txt, "bingbot", "/page")).toBe(false);
  });

  it("treats stacked user-agent lines as one group, ignores comments and empty Disallow", () => {
    const txt = "# hi\nUser-agent: a\nUser-agent: googlebot # inline\nDisallow: /x # c\nSitemap: https://e.com/s.xml\n\nUser-agent: *\nDisallow:\n";
    const parsed = parseRobotsTxt(txt);
    expect(parsed.sitemaps).toEqual(["https://e.com/s.xml"]);
    expect(evaluateRobots(parsed, "googlebot", "/x/y").allowed).toBe(false);
    expect(evaluateRobots(parsed, "*", "/anything").allowed).toBe(true);
  });

  it("is permissive with no matching group", () => {
    expect(allowed("", "*", "/")).toBe(true);
    expect(allowed("User-agent: other\nDisallow: /", "*", "/")).toBe(true);
  });
});

describe("page-side scripts", () => {
  type Collected = RawSeoSignals;
  const collect = () => eval(seoCollectorScript()) as Collected;

  it("are syntactically valid JavaScript", () => {
    expect(() => new Function(`return ${seoCollectorScript()};`)).not.toThrow();
    expect(() => new Function(`return ${seoRobotsFetchScript(1000)};`)).not.toThrow();
    expect(() => new Function(`return ${seoLinkCheckScript(["https://example.com/a?x=\"1\""], 500, 2)};`)).not.toThrow();
  });

  it("collects metadata, headings, images, links, social and structured data under jsdom", () => {
    document.documentElement.setAttribute("lang", "en-GB");
    document.head.innerHTML = `
      <meta charset="utf-8">
      <title>  Jsdom   Title </title>
      <meta name="description" content="A description">
      <meta name="viewport" content="width=device-width">
      <meta name="robots" content="noindex, follow">
      <meta name="googlebot" content="nofollow">
      <meta property="og:title" content="OG T">
      <meta property="og:image" content="/rel.png">
      <meta name="twitter:card" content="summary">
      <link rel="canonical" href="/canon">
      <link rel="alternate" hreflang="fr" href="https://example.com/fr">
      <script type="application/ld+json">{"@type":"Thing"}</script>
      <script type="application/ld+json">{bad</script>`;
    document.body.innerHTML = `
      <h1 id="top">Hello</h1><h3></h3>
      <p>one two three four</p>
      <img src="a.png"><img src="b.png" alt=""><img src="c.png" alt="c">
      <a href="/internal" rel="nofollow">Read more</a>
      <a href="https://other.org/x">Other site</a>
      <a>No href</a>
      <div itemscope></div><div typeof="Person"></div>
      <script>var ignored = "should not count";</script>`;
    const s = collect();
    expect(s.titles).toEqual(["Jsdom Title"]);
    expect(s.descriptions).toEqual(["A description"]);
    expect(s.lang).toBe("en-GB");
    expect(s.viewport).toBe("width=device-width");
    expect(s.charset.meta).toBe("utf-8");
    expect(s.canonicals).toEqual([{ href: "/canon", resolved: "https://example.com/canon" }]);
    expect(s.hreflang).toEqual([{ hreflang: "fr", href: "https://example.com/fr", resolved: "https://example.com/fr" }]);
    expect(s.robotsMeta).toEqual([{ name: "robots", content: "noindex, follow" }, { name: "googlebot", content: "nofollow" }]);
    expect(s.openGraph).toEqual({ "og:title": "OG T", "og:image": "/rel.png" });
    expect(s.twitter).toEqual({ "twitter:card": "summary" });
    expect(s.headings.map((h) => [h.level, h.empty])).toEqual([[1, false], [3, true]]);
    expect(s.images).toMatchObject({ total: 3, missingAlt: 1 });
    expect(s.images.missingAltSelectors).toHaveLength(1);
    expect(s.links.map((l) => [l.href, l.abs, l.rel])).toEqual([
      ["/internal", "https://example.com/internal", "nofollow"],
      ["https://other.org/x", "https://other.org/x", ""],
      [null, null, ""]
    ]);
    expect(s.linkTotal).toBe(3);
    expect(s.jsonLd).toHaveLength(2);
    expect(s.microdataItems).toBe(1);
    expect(s.rdfaItems).toBe(1);
    expect(s.wordCount).toBeGreaterThanOrEqual(4);
    expect(s.wordCount).toBeLessThan(15); // script text excluded
    expect(s.origin).toBe("https://example.com");
  });

  it("feeds the evaluator end to end", () => {
    document.head.innerHTML = `<title>Hi</title>`;
    document.body.innerHTML = `<p>tiny</p>`;
    const report = buildSeoReport(collect(), inputs({ robots: null }), "t", 5);
    expect(report.pass).toBe(false);
    expect(ids(report.issues)).toEqual(expect.arrayContaining(["title-short", "h1-missing", "canonical-missing"]));
    expect(report.capturedAt).toBe(5);
  });
});
