/**
 * Local fixture pages for the agent-API contract suite. Serves the repo's
 * `apps/desktop/test-pages` (the contact form) plus a few small pages that
 * exercise styles, coverage, console output and fetch — never external sites.
 */
import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const testPagesDir = path.resolve(here, "../../../../apps/desktop/test-pages");

/** Text the "styled" page logs to the console on load. */
export const CONSOLE_MARKER = "helmstack-contract-console-marker";

const STYLED_CSS = `:root { --brand: rgb(29, 127, 90); --space-md: 16px; }
body { margin: 0; font-family: sans-serif; }
.cta { color: rgb(255, 255, 255); background: var(--brand); padding: var(--space-md); border-radius: 8px; }
.never-used-rule { color: rgb(1, 2, 3); }
.also-never-used > span { outline: 3px dotted red; }
`;

const STYLED_JS = `function usedOnLoad() { document.body.dataset.ready = "true"; }
function neverCalled() { return Array.from({ length: 10 }, (_, i) => i * 2).join(","); }
usedOnLoad();
console.log(${JSON.stringify(CONSOLE_MARKER)});
`;

const STYLED_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Styled fixture</title>
<link rel="stylesheet" href="/fixture.css"></head>
<body>
<main>
  <h1>Styled fixture</h1>
  <a class="cta" id="cta" href="#next">Get started</a>
  <button id="second" type="button">Second</button>
  <input id="name" aria-label="Name">
  <div id="too-wide" style="width: 4000px; height: 10px"></div>
</main>
<script src="/fixture.js"></script>
</body></html>`;

/** A page whose only job is to be a same-origin context for `fetch()` calls. */
const BLANK_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Blank fixture</title></head><body><p>blank</p></body></html>`;

/**
 * SEO fixtures. `seoGood` is deliberately clean; `seoBad` (served under
 * /private/, which robots.txt disallows) has deliberate problems. Both are
 * built per request so absolute URLs use the fixture server's own origin.
 */
function seoGoodHtml(origin: string): string {
  const url = `${origin}/seo-good.html`;
  const words = Array.from({ length: 320 }, (_, i) => `word${i}`).join(" ");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Clean SEO fixture page for contract tests</title>
<meta name="description" content="A deliberately clean fixture page whose metadata, headings and structured data are all valid.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="${url}">
<meta property="og:title" content="Clean SEO fixture">
<meta property="og:description" content="Clean fixture description">
<meta property="og:image" content="${origin}/og.png">
<meta property="og:url" content="${url}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Organization", name: "Fixture Co", url: origin, logo: `${origin}/logo.png` })}</script>
</head><body>
<main><h1>Clean SEO fixture</h1><h2>Details</h2><p>${words}</p>
<img src="/logo.png" alt="Fixture logo">
<a href="/blank.html">Blank fixture page</a>
</main></body></html>`;
}

const SEO_BAD_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="robots" content="noindex, nofollow">
<script type="application/ld+json">{ "@type": "Product", </script>
</head><body>
<h1>First</h1><h1>Second</h1><h4>Skipped</h4>
<img src="/logo.png">
<a href="/blank.html">Read more</a><a href="/seo-good.html">Read more</a>
<a href="/missing.html">Gone page</a>
</body></html>`;

export type FixtureServer = {
  origin: string;
  /** `apps/desktop/test-pages/contact-form.html` */
  contactForm: string;
  styled: string;
  blank: string;
  /** Title is "Counter N", N incrementing on every request: reload shows a new number. */
  counter: string;
  /** Clean SEO page: no errors expected. */
  seoGood: string;
  /** SEO page with deliberate problems; under /private/ (disallowed by robots.txt). */
  seoBad: string;
  /** Clean page served with `X-Robots-Tag: noindex`. */
  seoHeaderNoindex: string;
  /** A JSON endpoint the network-mock scenario intercepts (the real one returns `{ source: "server" }`). */
  dataEndpoint: string;
  close(): Promise<void>;
};

export async function startFixtureServer(): Promise<FixtureServer> {
  let counterHits = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, type: string, body: string | Buffer) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    const origin = `http://${req.headers.host ?? "127.0.0.1"}`;
    switch (url.pathname) {
      case "/seo-good.html":
        return send(200, "text/html; charset=utf-8", seoGoodHtml(origin));
      case "/private/seo-bad.html":
        return send(200, "text/html; charset=utf-8", SEO_BAD_HTML);
      case "/seo-header-noindex.html":
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" });
        res.end(seoGoodHtml(origin));
        return;
      case "/robots.txt":
        return send(200, "text/plain", `User-agent: *\nDisallow: /private/\nSitemap: ${origin}/sitemap.xml\n`);
      case "/styled.html":
        return send(200, "text/html; charset=utf-8", STYLED_HTML);
      case "/blank.html":
        return send(200, "text/html; charset=utf-8", BLANK_HTML);
      case "/counter.html": {
        counterHits += 1;
        return send(
          200,
          "text/html; charset=utf-8",
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Counter ${counterHits}</title></head><body><p>hits ${counterHits}</p></body></html>`
        );
      }
      case "/fixture.css":
        return send(200, "text/css; charset=utf-8", STYLED_CSS);
      case "/fixture.js":
        return send(200, "text/javascript; charset=utf-8", STYLED_JS);
      case "/api/data.json":
        return send(200, "application/json", JSON.stringify({ source: "server" }));
      case "/contact-form.html":
        readFile(path.join(testPagesDir, "contact-form.html")).then(
          (body) => send(200, "text/html; charset=utf-8", body),
          (error: Error) => send(500, "text/plain", error.message)
        );
        return;
      default:
        return send(404, "text/plain", "not found");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    contactForm: `${origin}/contact-form.html`,
    styled: `${origin}/styled.html`,
    blank: `${origin}/blank.html`,
    counter: `${origin}/counter.html`,
    seoGood: `${origin}/seo-good.html`,
    seoBad: `${origin}/private/seo-bad.html`,
    seoHeaderNoindex: `${origin}/seo-header-noindex.html`,
    dataEndpoint: `${origin}/api/data.json`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}
