# Social Perception

HelmStack now exposes optional social-platform semantics inside the existing
`BrowserPerceptionPacket`. The goal is to let an external agent navigate social
media surfaces by intent instead of brittle CSS selectors.

The generic page graph remains unchanged for non-social pages. When the
extractor sees social signals, `packet.result.graph.social` and
`packet.observation.social` are populated.

## What It Captures

`SocialSurface` describes the current social context:

- `platform`: detected host family such as `x`, `facebook`, `instagram`,
  `linkedin`, `tiktok`, `reddit`, `youtube`, `threads`, `bluesky`, `mastodon`,
  or `generic`
- `kind`: `feed`, `profile`, `thread`, `composer`, `search`, `messages`,
  `notifications`, or `unknown`
- `posts`: observed feed/thread items with author, handle, text, media, and
  post-scoped actions
- `composers`: post/reply/comment/message entry points with submit actions
- `navigation`: social destinations such as home, search, notifications,
  messages, profile, bookmarks, settings, and create
- `actions`: deduped social actions across the page, including like, react,
  comment, reply, share, repost, bookmark, follow, message, open profile,
  search, navigate, and submit post

## Agent Usage

Agents should prefer `graph.social` when it is present:

```ts
const packet = await browser.getPerception(tab.id);
const social = packet.result.graph.social;

if (social?.kind === "feed") {
  const firstPost = social.posts[0];
  const reply = firstPost?.actions.find((action) => action.kind === "reply");
}
```

For execution, agents should still call existing DOM or site-tool commands with
the returned `selectorHint`. Social perception is a semantic layer over the
same grounded browser substrate.

## Safety Boundary

Posting, replying, following, messaging, and sharing are user-visible social
actions. Treat `submit_post`, `message`, `follow`, `share`, and `repost` as
approval-sensitive actions at the agent policy layer, even when the DOM command
itself is technically available.
