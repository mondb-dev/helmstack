# Run HelmStack headless (daemon and CI)

You will run `helmstack-daemon`, which serves the same agent API as the desktop app on top of a plain Chrome, and use it from a script or CI job.

**Prerequisites:** Node 20 or newer; Chrome or Chromium (or the ability to install Chrome for Testing).

## Build and start

The daemon is not published to npm yet. Build it from a clone:

```bash
npm install
npm run build:packages
node apps/daemon/dist/main.js --help
```

`build:packages` also builds the daemon (`apps/daemon` is in its list). `npm run build -w @helmstack/daemon` rebuilds only it.

Output of `--help`:

```text
Usage: helmstack-daemon [options]

Serves the HelmStack agent API on 127.0.0.1, driving a plain Chrome over CDP.

Options:
  --port <n>              Port to listen on (default: $HELMSTACK_PORT or 7070; 0 = any free port)
  --data-dir <dir>        State directory: token, baselines, downloads (default: ~/.helmstack/daemon)
  --chrome-path <file>    Chrome/Chromium executable (default: $HELMSTACK_CHROME_PATH, then auto-detect)
  --headful               Show the browser window (default: headless)
  --connect <browserURL>  Use an already-running Chrome, e.g. http://127.0.0.1:9222, instead of launching one
  -h, --help              Show this help

Auth: requests need the token from $HELMSTACK_AUTH_TOKEN, or else the one stored in
<data-dir>/helmstack-agent-token (created on first run).
```

Start it:

```bash
HELMSTACK_AUTH_TOKEN=ci-token node apps/daemon/dist/main.js --port 7171
```

On start it prints the URL, the data directory and the Chrome process id. `SIGINT` or `SIGTERM` closes the server and Chrome; a second signal exits immediately with status 130.

`--connect` cannot be combined with `--chrome-path` or `--headful`. `--connect` accepts an `http(s)://` browser URL or a `ws(s)://` DevTools endpoint.

## How Chrome is found

In order:

1. `HELMSTACK_CHROME_PATH` (or `--chrome-path`). If it points at a missing file, startup fails; it does not fall back.
2. A system Chrome or Chromium in a standard location for your platform.
3. A Chrome for Testing install made by `@puppeteer/browsers`, looked up in `./chrome` and in `~/.cache/puppeteer/chrome` (or `$PUPPETEER_CACHE_DIR/chrome`).

If nothing is found the daemon exits with status 1 and prints:

```text
No Chrome executable found. Install one with:
  npx @puppeteer/browsers install chrome@stable
or set HELMSTACK_CHROME_PATH to the path of a Chrome/Chromium executable.
```

More on library use and `--connect`: [apps/daemon/README.md](../apps/daemon/README.md).

## Differences from the desktop app

| Behavior | Desktop | Daemon |
| --- | --- | --- |
| Who approves queued actions | Only the human in the window (agents get `403 requires_human`) | Any token holder, since there is no window |
| `GET /api/health` `backend` | `desktop` | `daemon` |
| Accounts and TOTP routes | Available | `501 unsupported_on_backend` |
| Element pick by a human ("Select for agent") | Available | None; reading picks returns `no_pick` |
| Token location | App user-data directory | `<data-dir>/helmstack-agent-token` |
| Chat panel, Connect an agent | Available | Not applicable |

Because the daemon lets the caller approve its own actions, use `block` policies for effects that must never happen unattended. See [Approvals](approvals.md).

## Use it from CI

The repository's `daemon-headless` CI job is a working example. In outline:

```bash
npx --no-install @puppeteer/browsers install chrome@stable --path "$RUNNER_TEMP/chrome"
export HELMSTACK_CHROME_PATH=<path printed by the command above>
npm run build:packages
node apps/daemon/dist/main.js --port 7171 &
# wait for /api/health, then drive it over HTTP or with the MCP server
```

On Ubuntu 23.10 and later the runner may need unprivileged user namespaces for Chrome's sandbox; the CI job sets `kernel.apparmor_restrict_unprivileged_userns=0` for this. See [CI](ci.md).

The contract suite (`packages/devtools-core/test/contract`) runs one set of HTTP scenarios against a scripted backend and against this daemon. See [Testing](testing.md).

## Verify it worked

```bash
curl -H "X-HelmStack-Token: ci-token" http://127.0.0.1:7171/api/health
```

```json
{"status":"ok","connectedAgents":0,"tabs":1,"backend":"daemon","capabilities":[]}
```

## Troubleshooting

- `the port is already in use`: another HelmStack instance owns the port. Use `--port`. See [Troubleshooting](troubleshooting.md).
- `Unauthorized`: the token header is missing or wrong.
