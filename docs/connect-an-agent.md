# Connect an agent

You will register HelmStack's MCP server with an AI client so the client can call HelmStack's browser tools.

**Prerequisites:** a running HelmStack desktop app (or daemon) and a client from the table below. For the dialog, the app must be listening and must use a token file (see [Limits of the dialog](#limits-of-the-dialog)).

## Use the dialog (desktop)

1. Click the connection chip, then **Connect agents…**.
2. Optionally tick **Compact tools, for small models** (sets `HELMSTACK_TOOLSET=lite`, see [Lite toolset](lite-toolset.md)).
3. Under **How agents start HelmStack's MCP server**, choose the command source:
   - **HelmStack's bundled MCP server**: `node <app>/…/helmstack-mcp.mjs`. If Node 18 or newer is not on `PATH`, the app's own executable is used with `ELECTRON_RUN_AS_NODE=1`.
   - **`npx @helmstack/mcp-server`**: only available once the package exists on npm. The dialog checks `registry.npmjs.org` and shows "Package not published yet." until then.
4. On your client's row, click **Install**. A preview shows the exact command or file diff; nothing is written until you confirm.
5. Click **Verify** to confirm the entry is registered.

The entry is always named `helmstack` and nothing else in the client's config is touched. Config files are parsed, one key is set, and the file is written atomically with a timestamped `.bak` copy. A file that is not valid JSON is never overwritten. The entry holds the port and the token **file path**, never the token.

If the app's port or token file changes later, the row shows that it needs attention; **Update** rewrites the entry. **Remove** deletes only the `helmstack` entry.

## Clients

| Client | How it is installed | Verified against a real binary |
| --- | --- | --- |
| Claude Code | `claude mcp add helmstack -s user -e … -- <command>` | Yes |
| Gemini CLI | `gemini mcp add -s user -t stdio -e … helmstack <command>` | Yes |
| Codex CLI | `codex mcp add helmstack --env … -- <command>` | No, from its documentation |
| Claude Desktop | Edits `claude_desktop_config.json` | No |
| Cursor | Edits `~/.cursor/mcp.json` | No |
| Antigravity | Edits `~/.gemini/antigravity/mcp_config.json` (or `~/.gemini/config/mcp_config.json` if that is the one present) | No |
| Other client | **Copy config** gives you the JSON | n/a |
| ChatGPT | Not possible, see below | n/a |

`claude_desktop_config.json` lives in `~/Library/Application Support/Claude` on macOS, `%APPDATA%\Claude` on Windows and `~/.config/Claude` on Linux.

On Windows, a CLI that is installed as a `.cmd` shim is not run by the dialog; use **Copy config** and run the command yourself.

### ChatGPT

ChatGPT only accepts remote MCP connectors on a public HTTPS URL, so a local stdio server cannot be installed there. Exposing HelmStack's API through a tunnel would give anyone with the URL a path to your browser, and HelmStack does not set that up.

## Configure by hand

Any client that takes an `mcpServers` object works. Use the token **file** so the secret is not copied into the client config:

```json
{
  "mcpServers": {
    "helmstack": {
      "command": "node",
      "args": ["/absolute/path/to/helmstack/packages/mcp-server/dist/index.js"],
      "env": {
        "HELMSTACK_PORT": "7070",
        "HELMSTACK_TOKEN_FILE": "/absolute/path/to/helmstack-agent-token"
      }
    }
  }
}
```

Build the server first with `npm run build:packages`. The connection popover's **Copy MCP config** button produces the same JSON with your real port and token path; when the app was started with `HELMSTACK_AUTH_TOKEN` it uses a `<paste your token>` placeholder instead, because there is no token file.

Optional env vars in the entry: `HELMSTACK_TOOLSET=lite`, `HELMSTACK_PROFILE=agent-substrate|full`, `HELMSTACK_AGENT_ID=<name>` (attributes calls in the Activity tab). The full list is in [Configuration](configuration.md). For a daemon, point `HELMSTACK_PORT` at its port and `HELMSTACK_TOKEN_FILE` at `<data-dir>/helmstack-agent-token`.

## Limits of the dialog

- It is blocked while the agent API is not listening, or when the app takes its token from `HELMSTACK_AUTH_TOKEN` (there is no file to point at). Restart the app without that variable.
- Only the `user` scope is offered for CLI clients.
- Codex, Claude Desktop, Cursor and Antigravity paths come from their documentation and were not tested against the real apps.

## Verify it worked

In your client, list its MCP servers or tools. With the full toolset you should see 79 tools starting with `browser_` (89 with `HELMSTACK_PROFILE=agent-substrate`); with the lite toolset, 14 short verbs such as `look` and `click`. Then ask the agent to call `browser_health` (or `look`). The chip in HelmStack shows a connected client and the Activity tab lists the call.

For the exact tool lists see [MCP tools](mcp-tools.md).
