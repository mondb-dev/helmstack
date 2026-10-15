# Testing

How the test suites are organized and how to run them.

**Prerequisites:** `npm install`. Real-Chrome tests need a Chrome or Chromium (see [Headless and CI](headless-ci.md#how-chrome-is-found)); without one they skip.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | Runs every Vitest project |
| `npx vitest run --project daemon --project contract` | Only the real-Chrome projects (what the `daemon-headless` CI job runs) |
| `npx vitest run path/to/file.test.ts` | One file |
| `npm run typecheck` | `tsc --noEmit` over every workspace including tests |
| `npm run lint` | ESLint |
| `npm run docs:check` | Generated docs are current and links resolve |
| `npm run docs:test` | Unit tests for the docs scripts (Node's built-in runner) |

`npm run test:perception` is an alias of `npm test` (it runs everything).

## Vitest projects

Defined in `vitest.config.ts`.

| Project | Environment | Covers |
| --- | --- | --- |
| `dom` | jsdom (page URL `https://example.com/`) | perception, desktop (main and renderer units), MCP server, agent SDK, devtools-core unit tests |
| `local-models` | node | `packages/devtools-core/test/agent-runner/local.test.ts`: the local-model loop against fake loopback servers. Separate because jsdom replaces `AbortController` with one `undici` rejects. |
| `daemon` | node | `apps/daemon/test/**`: Chrome discovery, backend, and integration tests that launch real Chrome |
| `contract` | node | `packages/devtools-core/test/contract/**`: one HTTP scenario set run against several backends |

## The contract suite

`packages/devtools-core/test/contract/suite.ts` defines the scenarios; `backends.ts` supplies the backends:

- **scripted**: an in-process fake browser (no Chrome);
- **daemon**: the real daemon on headless Chrome (skipped when no Chrome is found);
- **external** (opt-in): a running instance. Set `HELMSTACK_CONTRACT_URL` (and `HELMSTACK_CONTRACT_TOKEN`) to point at it. It never defaults to `127.0.0.1:7070`. For a desktop instance start the app with `HELMSTACK_AGENT_APPROVALS=1` so the suite can approve its own queued actions.

## Real-Chrome tests

Tests named `*.integration.test.ts` under `apps/daemon/test` launch Chrome. They skip when no Chrome is found. Set `CI_REQUIRE_CHROME=1` to make a missing Chrome fail the run instead; the `daemon-headless` job does this so the suite cannot skip its way to green. `HELMSTACK_CHROME_PATH` selects the executable.

## What is not covered by automated tests

- The Electron shell is exercised by unit tests of its parts (renderer panels, install service, shortcuts) but there is no automated end-to-end run of the packaged app.
- Agent CLI chat (Claude Code, Gemini CLI) and real Ollama or LM Studio servers: the runner is tested against fakes.
- Windows behavior beyond what CI's Windows runner executes (unit tests only).

## Verify it worked

`npm test` ends with all projects passing. Projects that need Chrome report skipped tests when it is missing.
