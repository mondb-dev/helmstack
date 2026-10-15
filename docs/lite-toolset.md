# Lite toolset

You will understand the 14-verb toolset for small and cheap models and how to turn it on.

**Prerequisites:** none to read; to use it you need the MCP server or the in-window chat.

## What it is

The full MCP server registers 79 `browser_*` tools that return JSON. A small model handles that poorly: long schemas, large results. The lite toolset registers only 14 verbs. Each returns short plain text, and page elements are numbered so the model says `click 3` instead of building a selector.

Lite is implemented once in `@helmstack/agent-sdk` (`createLiteSession`) and used by two things: the MCP server (`HELMSTACK_TOOLSET=lite`) and the in-window loop for local models.

<!-- generated:start mcp-lite -->
| Verb | What it does | Arguments |
| --- | --- | --- |
| `look` | Show the current page as a short numbered list of things you can act on. | `all` (boolean, optional) |
| `click` | Click item n from the latest look. | `n` (integer) |
| `type` | Type text into text field n (set submit true to press its form's submit button after). | `n` (integer), `text` (string), `submit` (boolean, optional) |
| `select` | Choose an option in dropdown n. | `n` (integer), `option` (string) |
| `go` | Open a web address in the current tab. | `url` (string) |
| `back` | Go back one page. | none |
| `forward` | Go forward one page. | none |
| `reload` | Reload the current page. | none |
| `scroll` | Scroll the page up or down by one screen. | `direction` (up/down) |
| `tabs` | List open tabs, or switch to tab n. | `n` (integer, optional) |
| `audit` | Check the page and report the top problems. | `kind` (accessibility/seo/layout/performance/health) |
| `details` | Explain item n of the latest audit and how to fix it. | `n` (integer) |
| `viewport` | Resize the page to a phone, tablet or desktop screen, or reset it. | `size` (mobile/tablet/desktop/reset) |
| `screenshot` | Save a screenshot and say where it is and what is on screen. | none |
<!-- generated:end -->

## Turn it on

| Where | How |
| --- | --- |
| MCP server | `HELMSTACK_TOOLSET=lite` in the server's environment, or `--toolset lite` on its command line (the flag wins) |
| Connect an agent dialog | Tick **Compact tools, for small models** before installing |
| In-window chat with a local model | Always on; the loop gives the model exactly these 14 verbs |

Lite and the full toolset are exclusive: with `lite`, none of the `browser_*` tools exist. `HELMSTACK_PROFILE` has no effect on the lite verbs.

## Behavior to know

- `look` returns a view capped at 2400 characters by default (`HELMSTACK_LITE_MAX_CHARS`, clamped to 400 to 20000). Pass `all=true` to list what did not fit.
- Element numbers are only valid for the latest `look`; the session keeps them per tab.
- `screenshot` saves a PNG under `<tmp>/helmstack-lite` (`HELMSTACK_LITE_SCREENSHOT_DIR`) and returns the file path.
- When an action needs human approval the result says `NEEDS APPROVAL`. There is no verb that approves.
- Errors come back as `ERROR: … NEXT: …` text rather than exceptions, so a model can recover.

## Known limitations

- Lite has no access to the audit-detail, mock, storage or recording tools. Use the full toolset for those.

## Verify it worked

Start the MCP server with `HELMSTACK_TOOLSET=lite` and list its tools in your client: you should see exactly the 14 verbs above.
