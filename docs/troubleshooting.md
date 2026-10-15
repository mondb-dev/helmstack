# Troubleshooting

Symptoms, causes and fixes. Every message quoted here is produced by the code; if you see something else, it is not covered yet.

**Prerequisites:** none.

## Connecting to the API

| Symptom | Cause | Fix |
| --- | --- | --- |
| `{"error":"Unauthorized"}` (HTTP 401), or an SDK error starting `HTTP 401` | Missing or wrong token | Send `X-HelmStack-Token` or `Authorization: Bearer`. Read the token from the file shown in the connection popover (desktop) or `<data-dir>/helmstack-agent-token` (daemon), or use the `HELMSTACK_AUTH_TOKEN` the app was started with. |
| MCP tools fail with HTTP 401 | The MCP server has no token or an old one | Set `HELMSTACK_TOKEN_FILE` (or `HELMSTACK_AUTH_TOKEN`) in the client's `env`. The server reads the token file when it starts, so restart the client after the token file changes; **Update** in Connect agents fixes a changed path or port. |
| `Forbidden: non-loopback Host header` (403) | Request used a non-loopback `Host`, for example through a proxy or a rebinding hostname | Call `127.0.0.1` or `localhost` directly |
| `Forbidden: cross-origin request rejected` (403) | A browser page on a non-loopback origin called the API | Intended. Call from a server-side client. |
| Connection refused | No HelmStack on that port | Check the port in the chip or the daemon's start line; set `HELMSTACK_PORT` in the client |
| Daemon exits, or the desktop popover shows "Not listening", with "HelmStack agent server cannot listen on 127.0.0.1:7070: the port is already in use. Another HelmStack instance (desktop app or daemon) is probably running — stop it, or pick a different port (the daemon honours HELMSTACK_PORT / --port)." | Another instance owns the port | Stop it or set `HELMSTACK_PORT` (and `HELMSTACK_USER_DATA_DIR` for a second desktop instance) |
| Desktop warns `Ignoring invalid HELMSTACK_PORT="…"; using 7070` | The value is not an integer from 1 to 65535 | Fix the value |
| Daemon: `Invalid port "abc" (from --port); expected 0-65535.` | Bad `--port` or `HELMSTACK_PORT` | Fix the value |

## Approvals

| Symptom | Cause | Fix |
| --- | --- | --- |
| `403` with `"code":"requires_human"` | Agents cannot approve on the desktop | Approve in the HelmStack window (banner, then **Review**). For unattended runs use the daemon, or start the desktop with `HELMSTACK_AGENT_APPROVALS=1`. |
| `blocked`: "Page changed before approval — ask again." | The tab navigated or closed, or the approval expired | Re-issue the command on the current page |
| `approval belongs to another agent` / `tab is owned by another agent` (403) | `X-Agent-ID` does not match the tab's owner | Use the same agent id, or omit it |
| An action is refused with no prompt | The policy for that effect is `block` (payments by default) | Change the policy; see [Approvals](approvals.md) |

## Daemon and Chrome

| Symptom | Cause | Fix |
| --- | --- | --- |
| `No Chrome executable found. Install one with: npx @puppeteer/browsers install chrome@stable or set HELMSTACK_CHROME_PATH …` | Discovery found nothing | Install Chrome for Testing as shown, or set `HELMSTACK_CHROME_PATH` |
| `HELMSTACK_CHROME_PATH is set to "…", but no file exists there.` | The override points at a missing file | Fix or unset it; the daemon will not fall back |
| `--connect cannot be combined with --chrome-path or --headful (the browser is already running).` | Conflicting flags | Drop one |
| Launch hangs ("Target.setDiscoverTargets timed out") or "No usable sandbox" on Linux CI | Unprivileged user namespaces are restricted (Ubuntu 23.10+) | `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`; see [CI](ci.md) |
| `unsupported_on_backend` (501) for accounts, extensions or picking | The daemon has no such feature | Use the desktop app |

## Agent chat

| Symptom | Cause | Fix |
| --- | --- | --- |
| "No agent CLI found" | No CLI on `PATH` and no local server running | Install Claude Code or Gemini CLI, or start Ollama or LM Studio, then **Refresh** |
| "Ollama is installed but not running. Start it, then refresh." | Ollama's server is down | Start Ollama |
| "Ollama is running but has no models. Pull one (for example `ollama pull llama3.2`), then refresh." | Nothing installed | Pull a tool-capable model |
| "No tool-calling support" (model disabled) | The model's capabilities lack `tools` | Choose another model |
| "Couldn't reach the local model server. Is it still running?" | The server went away mid-turn | Restart it, start a new conversation |
| "The local model stopped responding." | No data for 120 seconds | Check the server; large models can be slow to load |
| "The model used all 12 steps without finishing. Ask again with a narrower request." | Step limit | Narrow the request |
| "In-window agent chat with CLIs isn't supported on Windows yet." | Windows CLIs install as `.cmd` shims | Use a local model, or run the agent in your own terminal through MCP |
| "The HelmStack MCP server bundle is missing from this build, so agent chat is unavailable." | The build lacks `dist/mcp/helmstack-mcp.mjs` | Rebuild with `npm run build` |
| "At most 4 agent conversations can be open at once. Close one first." | Conversation limit | Close one |
| Local model not detected on a custom port | Only default ports are probed | Set `HELMSTACK_LOCAL_ENDPOINTS` (loopback only) |

## Connect an agent dialog

| Symptom | Cause | Fix |
| --- | --- | --- |
| "The agent API isn't listening, so there's no port to point an agent at. Fix that first (see the connection details) and try again." | The server failed to start | Resolve the port conflict |
| "This HelmStack takes its token from HELMSTACK_AUTH_TOKEN, not a token file. Connect an agent never copies the token into another app's config; restart HelmStack without that variable." | Env-token mode | Restart without `HELMSTACK_AUTH_TOKEN` |
| "Package not published yet." for the npx source | `@helmstack/mcp-server` is not on npm | Use the bundled server |
| "Installed as a .cmd shim, which HelmStack can't run safely. Use Copy config and run it in a terminal." | Windows CLI shim | **Copy config** |

## Verify it worked

Re-run the failing call. For connection problems, `GET /api/health` with the token should return `{"status":"ok",...}`.
