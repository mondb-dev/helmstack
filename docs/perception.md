# Perception

Perception is how HelmStack turns a live page into data an agent can reason about, instead of raw HTML.

**Prerequisites:** none.

## What an agent gets

`GET /api/tabs/:id/perception` (MCP: `browser_get_perception`) returns a perception packet for the tab. It holds an observation (URL, title, headings, forms, alerts, primary actions) and a page graph built by the in-page extractor in `packages/perception`. The extractor:

- walks same-origin iframes and open shadow roots;
- gives each element a `selectorHint` so an action can target it.

On the desktop the page preload pushes fresh observations. On the daemon the same extractor is injected over CDP into every tab (`Page.addScriptToEvaluateOnNewDocument`).

## Comparing

- Named perception snapshots (`browser_save_perception_snapshot`) and `browser_diff_perception` report structural changes between two snapshots.
- Named screenshots and `browser_diff_screenshots` give pixel or perceptual diffs; `browser_changed_elements` maps changed regions back to elements.

Snapshots are stored under `helmstack-screenshots/` and `helmstack-perception/` in the data directory.

## Site capabilities

Each tab also has capability manifests (`GET /api/tabs/:id/manifests`). The `dom` provider is always present. A `webmcp` provider is reported when the page exposes WebMCP tools (`navigator.webMcp`, `window.WebMCP` or a `script[type="application/webmcp+json"]` manifest); its tools can then be invoked with the `invoke_site_tool` command (`POST /api/tabs/:id/command`). Detection notes and schema validation problems are surfaced in the manifest.

## Social surfaces (opt-in)

With `HELMSTACK_SOCIAL=1` (or the `agent-substrate` and `full` profiles) the desktop extractor also classifies social pages. `graph.social` and `observation.social` then carry:

- `platform` (for example `x`, `facebook`, `instagram`, `linkedin`, `tiktok`, `reddit`, `youtube`, `threads`, `bluesky`, `mastodon` or `generic`) and `kind` (`feed`, `profile`, `thread`, `composer`, `search`, `messages`, `notifications`, `unknown`);
- `posts` with author, handle, text, media and post-scoped actions; `composers`; `navigation`; deduplicated `actions`.

Off by default so that an ordinary web app is never labelled a social feed. Posting, replying, following, messaging and sharing are visible to other people; the personal-data approval policy does not cover all of them, so treat them as your agent's responsibility.

## Verify it worked

```bash
curl -H "X-HelmStack-Token: $TOKEN" http://127.0.0.1:7070/api/tabs/tab-1/perception
```

You should get JSON with `observation` and `result.graph`.
