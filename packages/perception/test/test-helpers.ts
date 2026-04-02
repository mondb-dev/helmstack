import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadPage(html: string, options?: { url?: string; title?: string }) {
  const { url = "https://example.com/", title = "Test Page" } = options || {};

  document.body.innerHTML = html;
  document.title = title;
  history.replaceState({}, "", url);
}

export function loadFixture(name: string, options?: { url?: string; title?: string }) {
  loadPage(readFixtureText(`fixtures/${name}.html`), options);

  const initPath = path.join(__dirname, `fixtures/${name}.init.js`);
  if (existsSync(initPath)) {
    const init = readFileSync(initPath, "utf8");
    window.eval(init);
  }
}

export function readFixtureText(relativePath: string): string {
  return readFileSync(path.join(__dirname, relativePath), "utf8");
}

export function readFixtureJson<T>(relativePath: string): T {
  return JSON.parse(readFixtureText(relativePath)) as T;
}
