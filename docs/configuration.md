# Configuration reference

Environment variables, ports and data files.

**Prerequisites:** none.

## Environment variables

The table is generated: the generator scans the source for environment reads and merges in the descriptions kept in `scripts/docs/env-descriptions.mjs`. A variable that appears in code without a description fails `npm run docs:generate`. Boolean flags accept `1`, `true`, `on` or `yes` (case-insensitive).

<!-- generated:start env-vars -->
| Variable | Read by | Default | Meaning |
| --- | --- | --- | --- |
| `CI_REQUIRE_CHROME` | real-Chrome tests | unset | `1` turns a missing Chrome into a test failure instead of a skip. Set by the `daemon-headless` CI job. |
| `ELECTRON_RUN_AS_NODE` | desktop (bundled MCP server launch) | unset | Set to `1` in client configs written by "Connect an agent" so the bundled MCP server runs on the app's own Node. `npm run dev` unsets it when it starts Electron. |
| `GOOGLE_APPLICATION_CREDENTIALS` | apps/agent-example (llm) | unset | Standard Google credentials file path read by the Vertex example agent. |
| `HELMSTACK_AGENT_APPROVALS` | desktop | off | `1` lets a token holder approve queued actions over the API (the desktop is otherwise human-only). The daemon always allows it. |
| `HELMSTACK_AGENT_ID` | MCP server | unset | Sent as the `X-Agent-ID` header so activity and tab badges are attributed to a named agent. Advisory, not authentication. |
| `HELMSTACK_AGENT_SUBSTRATE` | MCP server | unset (follows the profile) | Explicit on/off (`1`, `true`, `on`, `yes`) for the MCP approval, handoff, account, TOTP and intent tools. Wins over the profile. |
| `HELMSTACK_APPROVAL_TTL_MS` | core (desktop and daemon) | 600000 (10 minutes) | How long an unanswered approval waits before it is cancelled as expired. `0` disables expiry. A non-numeric value falls back to the default. |
| `HELMSTACK_AUTH_TOKEN` | desktop, daemon, MCP server, SDK | unset | Agent API token. On the servers it replaces the generated token file; in the MCP server and SDK it is the token to send. Stripped from the environment of agent CLIs started by the chat. |
| `HELMSTACK_CHROME_PATH` | daemon, real-Chrome tests | auto-detect | Chrome or Chromium executable for the daemon. If set but the file is missing, startup fails; it does not fall back to detection. The `--chrome-path` flag wins. |
| `HELMSTACK_CONTRACT_TOKEN` | contract test suite | unset | Token for `HELMSTACK_CONTRACT_URL`. |
| `HELMSTACK_CONTRACT_URL` | contract test suite | unset (suite skipped) | Base URL of an already-running instance for the opt-in external contract run. Found in test sources only. |
| `HELMSTACK_HOST` | MCP server, chat runner (passed to the MCP server it launches) | 127.0.0.1 | Host the MCP server connects to. The servers themselves always bind 127.0.0.1. |
| `HELMSTACK_LITE_MAX_CHARS` | lite toolset (MCP server, local-model chat) | 2400 | Character cap of the page view the `look` verb returns. Clamped to 400 to 20000. |
| `HELMSTACK_LITE_SCREENSHOT_DIR` | lite toolset | <tmp>/helmstack-lite | Directory the lite `screenshot` verb saves PNG files into. |
| `HELMSTACK_LOCAL_ENDPOINTS` | desktop chat (local models) | Ollama :11434, LM Studio :1234, llama.cpp :8080 | Comma list of loopback URLs to probe. Port 11434 means Ollama; `ollama=URL` and `openai=URL` force a kind. Non-loopback entries are dropped; if nothing usable remains the defaults are used. |
| `HELMSTACK_LOCAL_NUM_CTX` | desktop chat (local models) | 8192 | Ollama context window sent as `options.num_ctx`. Clamped to 2048 to 131072. |
| `HELMSTACK_PORT` | desktop, daemon, MCP server, SDK clients | 7070 | Port of the agent API. The desktop app and daemon listen on it (desktop ignores an invalid value with a console warning and uses 7070); the MCP server connects to it. The daemon's `--port` flag wins. |
| `HELMSTACK_PROFILE` | desktop, core, MCP server | fe-dev | `fe-dev`, `agent-substrate` or `full`. The last two turn on the opt-in agent surfaces (stealth, social perception, MCP approval/account tools). Unknown values mean `fe-dev`. |
| `HELMSTACK_ROUTINE_MODEL` | routines (daemon fallback) | unset | `cli[:model]`, for example `claude`, `claude:haiku` or `ollama:llama3.2:3b`: the model that answers routine judgments, used only while no choice is saved from the Routines tab. The model is given no tools. Invalid values are ignored. |
| `HELMSTACK_SOCIAL` | desktop | off (on with the agent-substrate and full profiles) | Social-surface perception (feeds, posts, composers). Read by the desktop page preload; the daemon does not read it. |
| `HELMSTACK_STEALTH` | desktop, core | off (on with the agent-substrate and full profiles) | Human-like input timing and the desktop's anti-detection injection. An explicit value wins over the profile. |
| `HELMSTACK_TEST_HOST` | `npm run serve:test-pages` | 127.0.0.1 | Host of the bundled test-page server. |
| `HELMSTACK_TEST_PORT` | `npm run serve:test-pages` | 4177 | Port of the bundled test-page server. |
| `HELMSTACK_TOKEN` | MCP server | unset | Alias the MCP server accepts when `HELMSTACK_AUTH_TOKEN` is not set. |
| `HELMSTACK_TOKEN_FILE` | MCP server, SDK | unset | Path of a file holding the token. Read when no token variable is set. This is what "Connect an agent" writes into client configs, so the token itself is never copied. |
| `HELMSTACK_TOOLSET` | MCP server | full | `full` registers the `browser_*` tools; `lite` registers the 14 compact verbs only. The `--toolset <lite\|full>` argument wins. |
| `HELMSTACK_USER_DATA_DIR` | desktop | Electron's userData directory | Moves the desktop profile, vault, token file and stores, so a second instance does not share state. |
| `MAX_STEPS` | apps/agent-example (openai) | 15 | Step limit for the OpenAI example agent. |
| `OPENAI_API_KEY` | apps/agent-example (openai) | required | OpenAI key for the OpenAI example agent. |
| `OPENAI_MODEL` | apps/agent-example (openai) | gpt-4o | Model for the OpenAI example agent. |
| `PUPPETEER_CACHE_DIR` | daemon Chrome discovery | ~/.cache/puppeteer | Where Chrome for Testing installs from `@puppeteer/browsers` are looked up (`<dir>/chrome`). |
| `TASK` | apps/agent-example | built-in sample task | Task text for the example LLM agents. |
| `VERTEX_LOCATION` | apps/agent-example (llm) | us-central1 | Vertex region for the example agent. |
| `VERTEX_MODEL` | apps/agent-example (llm) | gemini-2.5-pro | Vertex model for the example agent. |
| `VERTEX_PROJECT` | apps/agent-example (llm) | unset | Google Cloud project for the Vertex example agent. |
<!-- generated:end -->

Agent CLIs launched by the in-window chat get a scrubbed environment: every `HELMSTACK_*` and `ELECTRON_*` variable is removed, along with `NODE_OPTIONS`, `NODE_PATH`, `MCP_CONNECTION_NONBLOCKING` and `DISABLE_MICROCOMPACT`. The MCP server they start receives only the port and a token file path.

## Ports

| Port | Used by | Change with |
| --- | --- | --- |
| 7070 | Agent API of the desktop app and the daemon | `HELMSTACK_PORT`, or `--port` on the daemon |
| 11434 | Ollama, probed by the chat | `HELMSTACK_LOCAL_ENDPOINTS` |
| 1234 | LM Studio, probed by the chat | `HELMSTACK_LOCAL_ENDPOINTS` |
| 8080 | llama.cpp, probed by the chat | `HELMSTACK_LOCAL_ENDPOINTS` |
| 4177 | Test-page server (`npm run serve:test-pages`) | `HELMSTACK_TEST_PORT` |

The API always binds `127.0.0.1`. The daemon accepts port `0` for any free port.

## Data files

Desktop: the Electron user-data directory (moved by `HELMSTACK_USER_DATA_DIR`). The connection popover shows the token path inside it. Daemon: `<data-dir>`, default `~/.helmstack/daemon`.

| File | Contents | Where |
| --- | --- | --- |
| `helmstack-agent-token` | API token, mode `0600` | desktop and daemon |
| `helmstack-approval-policies.json` | Approval decisions, mode `0600` | desktop and daemon |
| `helmstack-site-patterns.json` | Persisted per-origin site patterns | desktop and daemon |
| `helmstack-screenshots/`, `helmstack-perception/` | Named screenshot and perception baselines | desktop and daemon |
| `downloads/` | Files downloaded by pages | daemon |
| `helmstack-vault.enc`, `helmstack-vault.key` | Identity vault and its master key | desktop |
| `helmstack-accounts.enc` | Site accounts and TOTP seeds, encrypted with the same key | desktop |
| `helmstack-zoom.json` | Per-origin page zoom | desktop |
| `extensions-index.json` | Loaded Chrome extensions | desktop |
| `agent-chat-workspace/` | Default working directory for CLI chat | desktop |

## Verify it worked

Start the app with `HELMSTACK_PORT=7171` and check the chip shows `:7171`.
