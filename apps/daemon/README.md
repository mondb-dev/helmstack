# @helmstack/daemon

Headless HelmStack runtime. It drives a plain Chrome over the Chrome DevTools Protocol, so HelmStack's inspection tools can run without the Electron desktop app: locally through `npx` and in CI.

## Running the daemon

```sh
npm run build -w @helmstack/daemon
node apps/daemon/dist/main.js                      # 127.0.0.1:7070, headless, data in ~/.helmstack/daemon
node apps/daemon/dist/main.js --port 7171 --headful
node apps/daemon/dist/main.js --connect http://127.0.0.1:9222   # drive a Chrome you started yourself
```

The package declares a `helmstack-daemon` bin, so `npx helmstack-daemon` also works once npm has linked it (after the next `npm install` in this repo, or from the published package).

The daemon serves the same agent HTTP+SSE API as the desktop app, so you can point `@helmstack/mcp-server` (`HELMSTACK_PORT`, `HELMSTACK_AUTH_TOKEN`) or the agent SDK at it without changes. `/api/health` reports `backend: "daemon"`. The accounts, extensions and element-pick routes are desktop-only and answer `501 unsupported_on_backend`.

Options: `--port` (default `$HELMSTACK_PORT` or 7070), `--data-dir`, `--chrome-path`, `--headful`, `--connect <browserURL>`.

The auth token comes from `$HELMSTACK_AUTH_TOKEN`. If that is unset, the daemon reads `<data-dir>/helmstack-agent-token`, creating it on first run.

If the port is in use, the daemon exits with status 1 and a message before it launches Chrome. On SIGINT or SIGTERM it stops the server and closes Chrome.

## Library

- `launchChrome()` finds and launches Chrome (headless by default, with a throwaway profile), or connects to a Chrome that is already running.
- `ChromeTabs` is a tab registry with stable `tab-N` ids. It covers open, list, navigate, close, viewport, screenshot and change notifications.
- `ChromeCdpTarget` implements the shared `CdpTarget` contract from `@helmstack/shared` on top of one puppeteer CDP session per tab.
- `ChromeBackend` implements devtools-core's `BrowserBackend` (`kind: "daemon"`). It emits tab lifecycle events, injects perception into every tab over CDP, and saves downloads to `<dataDir>/downloads`. The default data dir is `~/.helmstack/daemon`. `ChromeBackend.launch()` starts Chrome over a pipe, so no debugging port is opened. Each tab's content area is sized to 1280×800.

```ts
import { ChromeTabs, launchChrome } from "@helmstack/daemon";

const chrome = await launchChrome(); // { headless: false } opens a visible window
const tabs = await ChromeTabs.create(chrome.browser);
const tab = await tabs.open("https://example.com");
const target = tabs.get(tab.id); // CdpTarget
console.log(await target.evaluate("document.title"));
await chrome.close();
```

## Pointing it at Chrome

The daemon uses the first executable it finds, in this order:

1. **`HELMSTACK_CHROME_PATH`**: an explicit path to a Chrome or Chromium executable. If this variable is set but nothing exists at that path, startup fails with an error. It does not fall back to the next option.
2. **A system install** in a standard location:
   - macOS: `/Applications` and `~/Applications`. This covers Google Chrome, Chrome for Testing, Chromium, Beta, Dev and Canary.
   - Windows: `%PROGRAMFILES%`, `%PROGRAMFILES(X86)%` and `%LOCALAPPDATA%`.
   - Linux: `/opt/google/chrome`, `/usr/bin`, `/snap/bin`, then `google-chrome`, `chromium` and similar names on `PATH`.
3. **Chrome for Testing** installed by `@puppeteer/browsers`. The daemon looks in `./chrome` and in `~/.cache/puppeteer/chrome` (or `$PUPPETEER_CACHE_DIR/chrome`) and picks the newest build.

If none of these exist (common on a CI runner), install Chrome with:

```sh
npx @puppeteer/browsers install chrome@stable
```

### Using a Chrome that is already running

Start Chrome with remote debugging turned on, then connect to it:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir=/tmp/hs-profile
```

```ts
await launchChrome({ browserURL: "http://127.0.0.1:9222" }); // or { wsEndpoint: "ws://…" }
```

Calling `close()` on a connected browser only disconnects from it. On a launched browser, `close()` kills Chrome and deletes the temporary profile.

## Tests

```sh
npx vitest run --project daemon
```

The integration test (`test/chrome.integration.test.ts`) launches a real headless Chrome. It is skipped when no Chrome can be found.
