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

export type FixtureServer = {
  origin: string;
  /** `apps/desktop/test-pages/contact-form.html` */
  contactForm: string;
  styled: string;
  blank: string;
  /** A JSON endpoint the network-mock scenario intercepts (the real one returns `{ source: "server" }`). */
  dataEndpoint: string;
  close(): Promise<void>;
};

export async function startFixtureServer(): Promise<FixtureServer> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, type: string, body: string | Buffer) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    switch (url.pathname) {
      case "/styled.html":
        return send(200, "text/html; charset=utf-8", STYLED_HTML);
      case "/blank.html":
        return send(200, "text/html; charset=utf-8", BLANK_HTML);
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
    dataEndpoint: `${origin}/api/data.json`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}
