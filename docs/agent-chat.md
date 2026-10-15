# Agent chat and local models

You will talk to an agent from inside the HelmStack window, using either an installed agent CLI (Claude Code, Gemini CLI) or a model served on your own machine (Ollama, LM Studio, llama.cpp).

**Prerequisites:** the desktop app, and at least one of: Claude Code or Gemini CLI on your `PATH`, or a running local model server with a model that supports tool calling.

## Start a conversation

1. Open the side panel (`Cmd/Ctrl+Shift+A`) and choose the **Chat** tab.
2. In **Agent and model**, pick an entry. Choose **Refresh** after you start or stop a server or install a CLI.
3. Type a request and press Enter (Shift+Enter for a new line). `Cmd/Ctrl+Shift+K` focuses the composer.

A conversation is pinned to the tab that was active when you started it and ends when that tab closes. At most 4 conversations can be open at once; the message is "At most 4 agent conversations can be open at once. Close one first." One turn runs at a time per conversation; **Stop** ends it.

![Chat tab with a local model: each tool call is a chip. Captured against a scripted test server, so the reply text is canned.](images/chat-local-model.png)

## Agent CLIs

| CLI | Executable name | Confinement | Notes |
| --- | --- | --- | --- |
| Claude Code | `claude` | Verified: no built-in tools, only HelmStack's MCP server | Models: Default, Sonnet, Opus, Haiku |
| Gemini CLI | `gemini` | Not verified end to end; experimental | Starting a conversation needs an explicit acknowledgement |

HelmStack looks for these names on `PATH` and a few well-known directories (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.claude/local`, `~/.npm-global/bin`, `~/.bun/bin`, `~/.volta/bin`). The only thing it runs to detect them is `<binary> --version`.

The CLI authenticates with your own login and sends what the agent reads to that provider. See [Security model](security-model.md#in-window-agent-chat) for confinement details.

## Local models

HelmStack runs the agent loop itself for local models, because a local server is only a model API. It gives the model the 14 [lite verbs](lite-toolset.md), executes only well-formed structured tool calls, and feeds results back.

### How detection works

On start and on **Refresh**, HelmStack probes loopback addresses with an 800 ms timeout:

| Server | Default address | Probe |
| --- | --- | --- |
| Ollama | `http://127.0.0.1:11434` | `GET /api/version`, `GET /api/tags`, then `POST /api/show` per model to read its capabilities |
| LM Studio | `http://127.0.0.1:1234` | `GET /v1/models` |
| llama.cpp | `http://127.0.0.1:8080` | `GET /v1/models` |

"Installed" is judged from an `ollama` binary on `PATH` or `/Applications/Ollama.app`, and `llama-server` or `lms` on `PATH` or `/Applications/LM Studio.app`. The panel then shows one of these states:

| State | Message |
| --- | --- |
| Not installed | "Ollama is not installed." / "LM Studio or llama.cpp was not detected." |
| Installed, not running | "Ollama is installed but not running. Start it, then refresh." |
| Running, no models | "Ollama is running but has no models. Pull one (for example `ollama pull llama3.2`), then refresh." |
| Running, no tool-capable model | "No installed model supports tool calling." |

To probe other addresses set `HELMSTACK_LOCAL_ENDPOINTS`, for example `http://127.0.0.1:11434,openai=http://127.0.0.1:9000`. Only loopback hosts are accepted; others are dropped, and if nothing usable is left the defaults apply.

### What to pull

HelmStack never pulls or downloads models. Choose one that supports tool calling:

- For Ollama, a model whose `/api/show` capabilities include `tools` is selectable. A model without it is listed but disabled ("No tool-calling support"). An older server that reports no capabilities is marked "tool support unknown" and is selectable with a warning.
- LM Studio and llama.cpp report no capabilities, so their models are always "unknown". Pick a tool-capable model there and expect to find out by trying.

### Small-model advice

- Raise the context window if the model loses track: `HELMSTACK_LOCAL_NUM_CTX` (default 8192, clamped to 2048 to 131072). Ollama otherwise truncates prompts silently at its small default. Larger values use more memory.
- Keep requests narrow. A turn is limited to 12 model steps and 4 tool calls per step; if the model uses all 12 it says: "The model used all 12 steps without finishing. Ask again with a narrower request."
- Page views are short by design (see `HELMSTACK_LITE_MAX_CHARS`). History keeps the last 12 messages.
- A request that produces no bytes for 120 seconds, or a turn that runs past 5 minutes, ends cleanly.

### Errors you may see

| Text | Meaning |
| --- | --- |
| "Couldn't reach the local model server. Is it still running?" | The connection failed mid-turn |
| "The local model stopped responding." | No data for 120 seconds, or the stream broke |
| "The model used all 12 steps without finishing. Ask again with a narrower request." | Step limit |
| "No agent CLI found" | Neither a CLI nor a local server was detected |

## Known limitations

- In-window chat with agent CLIs is not supported on Windows: the CLIs install as `.cmd` shims that HelmStack does not run. The panel says "In-window agent chat with CLIs isn't supported on Windows yet." In the code, local-model chat is not disabled on Windows, but it was not tried there.
- The local-model loop has been verified against fake loopback servers in the test suite, not against a real Ollama or LM Studio.
- The Gemini CLI path is unverified.
- The daemon has no chat.
- Conversations are not saved across app restarts.

## Verify it worked

With a local model selected, send "open http://127.0.0.1:4177/contact-form.html and tell me the page heading" (with `npm run serve:test-pages` running). You should see a `go` chip, a `look` chip and a text answer, and the **Activity** tab shows the requests attributed to `chat:ollama:<model>`.
