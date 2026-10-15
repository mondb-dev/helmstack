# Profiles and toolsets

Two independent settings decide what an agent can do: the profile (which opt-in surfaces exist) and the toolset (which MCP tools are registered).

**Prerequisites:** none.

## Profiles

`HELMSTACK_PROFILE` presets the opt-in agent surfaces.

| Profile | Meaning |
| --- | --- |
| `fe-dev` (default, also for unset or unknown values) | Lean front-end instrument: no stealth, no social perception, no agent-substrate MCP tools, no settings sheet |
| `agent-substrate` | Turns the opt-in surfaces on |
| `full` | Same as `agent-substrate` today |

What the opt-in surfaces are:

| Surface | Flag | Where it applies |
| --- | --- | --- |
| Human-like input timing and anti-detection injection | `HELMSTACK_STEALTH` | Desktop (anti-detection) and the core's input actuator |
| Social-feed perception (`graph.social`) | `HELMSTACK_SOCIAL` | Desktop page preload. The daemon does not read it. |
| Approval, handoff, account, TOTP and intent MCP tools | `HELMSTACK_AGENT_SUBSTRATE` | MCP server (full toolset) |
| Settings sheet (vault, accounts, policies) | profile only | Desktop shell |

An explicit per-flag variable always wins over the profile: `HELMSTACK_STEALTH=0` turns stealth off under `agent-substrate`.

`HELMSTACK_AGENT_APPROVALS` is not affected by the profile.

## Toolsets

`HELMSTACK_TOOLSET` (or `--toolset` on the MCP server's command line):

| Toolset | Registers | For |
| --- | --- | --- |
| `full` (default) | The `browser_*` tools | Capable models and scripted use |
| `lite` | 14 plain-text verbs | Small or cheap models. See [Lite toolset](lite-toolset.md). |

Counts and lists: [MCP tools](mcp-tools.md).

## Combining them

| Goal | Settings |
| --- | --- |
| Verify your own UI from a coding agent | defaults |
| Same, with a small local model | `HELMSTACK_TOOLSET=lite` |
| Autonomous agent that logs in and fills forms | `HELMSTACK_PROFILE=agent-substrate` on both the app and the MCP server process |

The app and the MCP server are separate processes and each reads its own environment, so set the profile on both when you need both.

## Verify it worked

The connection popover shows the app's profile. The MCP tool count shows the server's: 79 default, 89 with the agent-substrate surface, 14 lite.
