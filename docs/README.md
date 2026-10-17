# HelmStack documentation

HelmStack lets an AI agent inspect and test a front-end in a real browser, from a desktop app or a headless daemon. Start with the [project README](../README.md) for the overview and quickstart.

## Guides

| Page | You will |
| --- | --- |
| [Getting started](getting-started.md) | Run the desktop app and confirm the API answers |
| [Shell tour](shell-tour.md) | Learn the window: panels, chips, approvals |
| [Keyboard shortcuts](keyboard-shortcuts.md) | Look up every shortcut |
| [Connect an agent](connect-an-agent.md) | Install the MCP server into Claude Code, Gemini CLI, Cursor and others |
| [Agent chat and local models](agent-chat.md) | Chat with a CLI agent or an Ollama or LM Studio model in the window |
| [Lite toolset](lite-toolset.md) | Give a small model 14 plain-text verbs |
| [Page analysis reports](reports.md) | Have an agent write up findings and measurements as a downloadable file |
| [Routines](routines.md) | Have an agent turn "watch this for me" into a procedure you review and approve |
| [Headless and CI](headless-ci.md) | Run the daemon and use it in CI |

## Reference

| Page | Contents |
| --- | --- |
| [HTTP API](http-api.md) | Routes, events, errors, auth |
| [MCP tools](mcp-tools.md) | Every tool, by toolset |
| [Agent SDK](agent-sdk.md) | The TypeScript client |
| [Configuration](configuration.md) | Environment variables, ports, data files |
| [Design system](styleguide.md) | Shell tokens and layers |

## Concepts

| Page | Contents |
| --- | --- |
| [Architecture](architecture.md) | Shared core, two backends; links the [ADR](adr/0001-headless-chrome-backend.md) |
| [Security model](security-model.md) | Trust boundaries and caveats |
| [Approvals](approvals.md) | What is gated, who decides, expiry |
| [Routines](routines.md) | The routine spec, confidence and thresholds, and the safety model |
| [Perception](perception.md) | What an agent sees of a page |
| [Profiles and toolsets](profiles-and-toolsets.md) | Opt-in surfaces and tool counts |

## Contributing and operations

| Page | Contents |
| --- | --- |
| [Contributing](../CONTRIBUTING.md) | Setup, commits, pull requests |
| [Testing](testing.md) | Vitest projects, contract suite, real Chrome |
| [CI](ci.md) | Workflow jobs |
| [Releasing](releasing.md) | semantic-release, `[skip release]`, preflight checks |
| [Troubleshooting](troubleshooting.md) | Symptoms and fixes |

## How these docs stay accurate

Tables of tools, routes, environment variables, shortcuts and design tokens are generated from source by `scripts/docs`. `npm run docs:check` fails in CI when a generated region is stale or a relative link or anchor is broken.
