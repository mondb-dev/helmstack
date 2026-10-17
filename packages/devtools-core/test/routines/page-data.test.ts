import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PAGE_COLLECTOR_SCRIPT, sanitizePageData } from "../../src/core/routines/page-data.js";
import { coerce, keyOf, rateDelayMs } from "../../src/core/routines/executor.js";

// jsdom has no layout, so every rect is empty; pretend elements are visible.
const realRect = Element.prototype.getBoundingClientRect;
beforeEach(() => {
  Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON() {} }) as DOMRect;
});
afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect;
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

function collect(): ReturnType<typeof sanitizePageData> {
  const raw = (window as unknown as { eval(s: string): unknown }).eval(PAGE_COLLECTOR_SCRIPT);
  return sanitizePageData(JSON.parse(JSON.stringify(raw)), "https://example.com/");
}

describe("page collector", () => {
  it("finds repeating blocks that sit directly under <body>", () => {
    document.body.innerHTML = [1, 2, 3]
      .map((n) => `<article><h2>Update number ${n}</h2><time datetime="2026-10-0${n}">Oct ${n}</time><p>Summary ${n}</p><a href="/u/${n}">read</a></article>`)
      .join("");
    const data = collect();
    expect(data.blocks[0]?.items.map((i) => i.title)).toEqual(["Update number 1", "Update number 2", "Update number 3"]);
  });

  it("reads items from JSON-LD item lists and articles", () => {
    document.head.innerHTML = `<title>Site news</title>
      <meta name="description" content="All the news">
      <script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "WebSite", name: "Site" },
          {
            "@type": "ItemList",
            itemListElement: [
              { "@type": "ListItem", position: 1, item: { "@type": "NewsArticle", headline: "First", url: "https://example.com/1", datePublished: "2026-01-05" } },
              { "@type": "ListItem", position: 2, url: "https://example.com/2", name: "Second" }
            ]
          }
        ]
      })}</script>`;
    const data = collect();
    expect(data.structured.map((i) => [i.title, i.url])).toEqual([
      ["First", "https://example.com/1"],
      ["Second", "https://example.com/2"]
    ]);
    expect(data.structured[0]!.date).toBe("2026-01-05");
    expect(data.page.summary).toBe("All the news");
  });

  it("finds repeating blocks with links and dates, and ignores navigation", () => {
    document.body.innerHTML = `
      <nav><ul><li><a href="/home">Home page link</a></li><li><a href="/about">About us link text</a></li><li><a href="/contact">Contact us link text</a></li></ul></nav>
      <main><div class="list">
        ${[1, 2, 3, 4]
          .map(
            (n) => `<div class="card"><h3><a href="/news/${n}">Headline number ${n}</a></h3><time datetime="2026-01-0${n}">Jan ${n}</time><p>Summary for story ${n} goes here.</p></div>`
          )
          .join("")}
      </div></main>`;
    const data = collect();
    expect(data.blocks).toHaveLength(1);
    const [group] = data.blocks;
    expect(group!.items).toHaveLength(4);
    expect(group!.items[0]).toMatchObject({ title: "Headline number 1", date: "2026-01-01" });
    expect(group!.items[0]!.url).toMatch(/\/news\/1$/);
    expect(group!.confidence).toBeGreaterThanOrEqual(0.6);
    expect(group!.confidence).toBeLessThanOrEqual(0.85);
  });

  it("does not make up a list from blocks without links", () => {
    document.body.innerHTML = `<div>${[1, 2, 3, 4].map((n) => `<p class="x">Paragraph ${n} with enough words to count</p>`).join("")}</div>`;
    expect(collect().blocks).toEqual([]);
  });

  it("only returns http(s) urls", () => {
    document.head.innerHTML = `<script type="application/ld+json">${JSON.stringify([{ "@type": "Article", name: "Bad", url: "javascript:alert(1)" }, { "@type": "Article", name: "Mail", url: "mailto:a@b.c" }])}</script>`;
    const data = collect();
    for (const item of data.structured) expect(item.url ?? "").toBe("");
  });
});

describe("page data sanitizing", () => {
  it("drops control characters, odd keys, empty items and oversized values", () => {
    const data = sanitizePageData(
      {
        url: "https://x.example/",
        structured: [{ title: "A\u0000B\u0007C", "Bad Key": "x", url: "u".repeat(5000), "__proto__": "p" }, {}, "nope", { title: "" }],
        blocks: [{ confidence: 7, items: [{ title: "ok" }] }, { confidence: "high", items: [{ title: "ok" }] }, { items: [] }],
        page: { title: "T" }
      },
      "https://fallback.example/"
    );
    expect(data.structured).toHaveLength(1);
    expect(data.structured[0]!.title).toBe("A B C");
    expect(Object.keys(data.structured[0]!)).not.toContain("Bad Key");
    expect(data.structured[0]!.url!.length).toBe(2000);
    expect(data.blocks.map((b) => b.confidence)).toEqual([1, 0]);
    expect(sanitizePageData(null, "https://fallback.example/").url).toBe("https://fallback.example/");
  });
});

describe("extract helpers", () => {
  it("coerces field types", () => {
    expect(coerce("  Hello   world ", "text<=5")).toBe("Hello");
    expect(coerce("/a/b", "url", "https://x.example/p")).toBe("https://x.example/a/b");
    expect(coerce("javascript:alert(1)", "url")).toBeUndefined();
    expect(coerce("Jan 5, 2026", "date")).toBe("2026-01-05");
    expect(coerce("not a date", "date")).toBeUndefined();
    expect(coerce("$1,299.50 each", "number")).toBe("1299.50");
    expect(coerce("Yes", "bool")).toBe("true");
    expect(coerce("maybe", "bool")).toBeUndefined();
    expect(coerce("", "text")).toBeUndefined();
  });

  it("builds stable keys and parses the rate", () => {
    expect(keyOf({ url: "https://a/1", title: "T" }, ["url"])).toBe("https://a/1");
    expect(keyOf({ link: "https://a/1" }, ["url"])).toBe("https://a/1"); // aliases
    expect(keyOf({ title: "T" }, ["url"])).toBeNull();
    expect(keyOf({ url: "x".repeat(500) }, ["url"])!.length).toBeLessThan(60);
    expect(rateDelayMs("1 request / 2s")).toBe(2000);
    expect(rateDelayMs("5 requests / 1s")).toBe(200);
    expect(rateDelayMs("nonsense")).toBeUndefined();
  });
});
