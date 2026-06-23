# HelmStack Positioning — FE-dev core vs. agent-substrate surface

**Status:** recommendation for a decision (the call is the maintainer's). Drafted
from a full pass over the codebase; see [frontend-dev-review.md](frontend-dev-review.md) §0.

## The question

HelmStack carries two audiences in one binary:

1. **Front-end development** — a deterministic perception + execution instrument
   you point at `localhost:3000` to inspect, assert, screenshot, audit, and
   profile your own app.
2. **Autonomous web-agent substrate** — social-feed perception, OAuth, a TOTP
   vault, human-handoff/approval flows, and anti-detection hardening for driving
   *third-party* sites.

The risk flagged in the review: a developer using audience (1) "pays for (and is
confused by)" machinery built for audience (2).

## What's actually shared vs. specific (grounded in the code)

| Surface | Where | FE-dev relevance | Status today |
|---|---|---|---|
| Anti-detection / input jitter | `anti-detection.ts`, `dom-actuator.ts`, gated by `runtime-config.isStealthEnabled` | None | **Already opt-in** — `HELMSTACK_STEALTH` defaults **off**. ✅ |
| Social-surface perception | `perception/dom-extractor.ts` (`collectSocialSurface`, `classifyPageKind` → `social-feed`/`social-profile`/…) | None | **Always on** — runs on every page, incl. `localhost`. ⚠️ |
| TOTP vault / accounts | `shared/account.ts`, SDK + MCP (`browser_generate_totp`, `browser_list_accounts`, …) | None | Separate surface; only reached if used. Adds tool-list noise. |
| Approvals / human handoff | `agent-server.ts`, MCP (`browser_approve`, `browser_list_handoffs`, …) | Low | Separate surface; tool-list noise. |
| DOM perception, actuation, screenshots, a11y, coverage, tokens, trace, framework detect | `perception/`, `tab-manager.ts` + the new modules | **Core** | Shared foundation. ✅ |

**Takeaway:** the foundation (perception + execution) is genuinely shared. Only
three surfaces are audience-(2)-specific, and **one of them (stealth) is already
gated correctly.** The remaining bleed is (a) always-on social classification and
(b) tool-list / UI noise from vault + handoff + approval surfaces.

## Options

- **A — Keep the monolith, do nothing.** Cheapest now; the confusion persists and
  grows as each audience adds surface.
- **B — Capability flags within one binary (recommended).** Keep one package, but
  gate the audience-(2) surfaces behind a `capabilities` config so the FE-dev
  profile is lean by default. No package split, fully incremental, reversible.
- **C — Split into `@helmstack/core` + `@helmstack/agent-substrate` plugin.**
  Cleanest separation; highest cost (package boundaries, a plugin-loading seam,
  release coordination). Premature until B's flags prove the seam.

## Recommendation — B now, with C as the eventual shape

Stealth already shows the pattern works (`isStealthEnabled`, default off). Extend
that same opt-in discipline to the other two surfaces, in priority order:

1. **Gate social-surface perception** behind a flag (`HELMSTACK_SOCIAL`,
   default **off**). ✅ **DONE.** `runtime-config.isSocialPerceptionEnabled` mirrors
   `isStealthEnabled`; `extractPageObservation(tabId, { includeSocial })` skips
   `collectSocialSurface` (so `classifyPageKind` never returns a `social-*` kind)
   unless requested; the preload reads the flag once and passes it. A `localhost`
   app is now never mislabelled `social-feed`. Covered by `runtime-config.test.ts`
   (default-off + truthy parsing) and `dom-extractor.test.ts` (a feed fixture is
   **not** social when off, **is** when `includeSocial: true`). This is the concrete
   fix for the exact complaint in the review.
2. **Group the agent-substrate tools behind a capability.** ✅ **DONE.** The MCP
   accounts/TOTP, approvals, handoffs, and intent tools (10 of 83) are now
   registered only when `HELMSTACK_AGENT_SUBSTRATE` is on (`capabilities.ts` →
   `isAgentSubstrateEnabled`; `registerAgentSubstrateTools()` gated in
   `index.ts`). The default surface stays the perception/execution/audit tools an
   app developer wants. Asserted by `capabilities.test.ts`, which imports the
   real server and checks the registered tool set toggles **exactly** those 10
   with the flag — so the gate and the canonical `AGENT_SUBSTRATE_TOOLS` list
   can't drift. *(The earlier "82 → ~dozen" framing overstated it: most tools are
   FE-dev; the substrate surface is a focused 10.)*
3. **Define a `profile`** (`fe-dev` | `agent-substrate` | `full`) that presets the
   flags above. ✅ **DONE.** `HELMSTACK_PROFILE` presets all three opt-in surfaces:
   `fe-dev` (or unset) = stealth/social/substrate **off**; `agent-substrate` /
   `full` = all **on**. An explicit per-flag env var always overrides the profile.
   Implemented in both `runtime-config` (stealth/social, desktop process) and
   `capabilities` (substrate, MCP-server process) since they run separately;
   covered by `runtime-config.test.ts` and `capabilities.test.ts` (presets,
   explicit-override both directions, unknown-profile fallback, and an
   integration check that `HELMSTACK_PROFILE=full` actually registers the
   substrate MCP tools).
4. **Defer the package split (C)** until these flags have settled the boundary in
   practice. Once the `agent-substrate` capability cleanly fences its modules,
   extracting it into a plugin package is mechanical rather than speculative.

### Why not split now

The shared foundation is large and the substrate-specific surface is small and
already mostly isolable by flags. A package split pays its cost up front
(boundaries, plugin seam, two release trains) to buy separation a config flag
buys for far less — and the flag work is exactly the refactoring that would make
a later split safe. Flags first, package second.

## Suggested acceptance criteria

- `HELMSTACK_SOCIAL` (default off) suppresses social-surface perception; a unit
  test asserts a feed-like fixture is **not** classified `social-feed` when off,
  and still **is** when on.
- A `profile=fe-dev` run registers no vault/handoff/approval MCP tools (assert the
  tool count/list).
- `docs/security-model.md` and the README state the profiles and what each
  includes.

> This document records analysis and a recommendation only. Choosing A/B/C — and
> the default profile — is the maintainer's decision.
