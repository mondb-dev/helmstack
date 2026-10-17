# MCP tools reference

`helmstack-mcp` (package `@helmstack/mcp-server`) is a stdio MCP server. It translates tool calls into [HTTP API](http-api.md) requests against a running desktop app or daemon.

**Prerequisites:** a running HelmStack instance; see [Connect an agent](connect-an-agent.md) for installing the server in a client.

## What gets registered

<!-- generated:start mcp-counts -->
The full toolset registers **87** tools by default and **97** when the agent-substrate surface is on. The lite toolset registers **14** verbs.
<!-- generated:end -->

| Setting | Effect |
| --- | --- |
| `HELMSTACK_TOOLSET=full` (default) | The `browser_*` tools below |
| `HELMSTACK_TOOLSET=lite` or `--toolset lite` | Only the [lite verbs](lite-toolset.md) |
| `HELMSTACK_PROFILE=agent-substrate` or `full`, or `HELMSTACK_AGENT_SUBSTRATE=1` | Adds the agent-substrate tools (full toolset only) |
| `HELMSTACK_AGENT_SUBSTRATE=0` | Removes them even under the agent-substrate profile |

Connection settings (`HELMSTACK_PORT`, `HELMSTACK_HOST`, `HELMSTACK_AUTH_TOKEN`, `HELMSTACK_TOKEN_FILE`, `HELMSTACK_AGENT_ID`) are in [Configuration](configuration.md).

## Full toolset

First sentence of each tool's description, extracted from `packages/mcp-server/src/index.ts`. Full descriptions and argument schemas are sent to the client at runtime.

<!-- generated:start mcp-full -->
| Tool | What it does |
| --- | --- |
| `browser_health` | Check if the HelmStack browser substrate is running and how many tabs are open. |
| `browser_list_tabs` | List all open browser tabs with their id, title, URL, and active status. |
| `browser_open_tab` | Open a new browser tab, optionally navigating to a URL. |
| `browser_navigate` | Navigate a specific tab to a URL. |
| `browser_reload` | Reload a tab and wait for the page to finish loading. |
| `browser_go_back` | Go back one entry in a tab's history and wait for the load. |
| `browser_go_forward` | Go forward one entry in a tab's history and wait for the load. |
| `browser_set_viewport` | Resize a tab's viewport. |
| `browser_get_perception` | Get a structured perception of the current page: DOM graph, forms, fields, actions, and accessibility metadata. |
| `browser_list_manifests` | List site capability manifests for a tab (available site-specific tools). |
| `browser_screenshot` | Take a screenshot of a tab and return it as a base64 PNG image. |
| `browser_execute` | Execute a command on a tab. |
| `browser_log` | Write a message to the HelmStack terminal panel in the UI. |
| `browser_get_tab_logs` | Return buffered console logs, network requests (with headers, SSL details, cache status), WebSocket frames, EventSource events, and JS errors captured for a tab since it was last cleared. |
| `browser_clear_tab_logs` | Clear buffered console, network, WebSocket, EventSource, and JS error logs for a tab. |
| `browser_export_har` | Export the tab's buffered network requests as a HAR 1.2 archive (importable into Chrome DevTools, Charles, Insomnia, etc.). |
| `browser_network_audit` | Produce a focused network/security audit for a tab. |
| `browser_get_network_mock` | Return the currently active network mock/intercept rules for a tab. |
| `browser_enable_network_mock` | Enable network request mocking for a tab. |
| `browser_disable_network_mock` | Disable network mocking for a tab and restore normal request handling. |
| `browser_capture_named_screenshot` | Capture a screenshot and store it in HelmStack's in-memory screenshot cache under a snapshot ID. |
| `browser_diff_screenshots` | Compare two named screenshots pixel-by-pixel and return changed regions plus a base64 diff image. |
| `browser_changed_elements` | Map changed pixel regions (a diffScreenshots result's diffRegions) to the DOM elements that occupy them — a structural 'which elements changed'. |
| `browser_list_screenshots` | List named screenshots currently held in HelmStack's in-memory cache. |
| `browser_delete_screenshot` | Delete a named screenshot from HelmStack's in-memory cache. |
| `browser_viewport_suite` | Capture screenshots at multiple responsive viewport presets, optionally including pairwise visual diffs. |
| `browser_performance` | Capture Core Web Vitals, navigation timing, slow resources, and raw CDP performance metrics for a tab. |
| `browser_health_report` | Aggregated page-health scorecard fusing Core Web Vitals, the WCAG audit, console/JS errors, failed network requests, layout overflow and SEO (metadata, indexability, structured data) into per-category scores plus an overall score and a pass/fail gate (suitable for CI). |
| `browser_create_report` | Prepare a downloadable report of a page analysis: ONE self-contained HTML file (plus a Markdown copy) that the user can open, save and share. |
| `browser_list_reports` | List the page analysis reports saved on this machine (newest first): id, title, page, when, finding counts by severity, which measurements were included or skipped, and file size. |
| `browser_routine_schema` | Read the JSON Schema for a HelmStack routine, a complete worked example and the size limits. |
| `browser_propose_routine` | Propose a routine: a reusable procedure you compile from what the user asked HelmStack to watch, monitor or repeat. |
| `browser_list_routines` | List the routines on this machine (newest first): id, title, state (proposed, approved, paused, stopped or rejected), trigger, hosts and the plain-language preview. |
| `browser_get_routine` | Read one routine by id: its state, the plain-language preview, the validated spec, what the spec asked to be allowed (requestedGrants) and what the user actually allowed (grants; by default nothing, so every action asks). |
| `browser_list_routine_actions` | List what a routine did on its site, was blocked from doing, or is waiting for the user to approve (newest first, at most 100): effect, one-sentence description, status (pending, approved, declined, expired, done, failed, blocked), why, and whether the user's grant or a tap allowed it. |
| `browser_withdraw_routine` | Withdraw a routine you proposed while it is still waiting for the user (it becomes rejected). |
| `browser_focus_order` | Audit keyboard tab order vs. the page's visual reading order: flags positive tabindex (which hijacks order) and points where focus jumps backwards (to an element above or left of the previous one). |
| `browser_a11y_audit` | Run a comprehensive WCAG 2.2 accessibility audit against the live accessibility tree and DOM. |
| `browser_seo_audit` | Deterministic SEO audit of the loaded page. |
| `browser_inspect_element_styles` | Inspect computed styles and layout diagnostics for elements matching a CSS selector. |
| `browser_assert_element_styles` | Assert computed CSS styles for all elements matching a selector. |
| `browser_component_tree` | Capture a React, Vue, or Svelte component tree when framework dev hooks are exposed on the page. |
| `browser_design_tokens` | Harvest the de-facto design system in use on the page: colors, font families, type scale, font weights, spacing, border-radii, shadows, and z-index layers (each ranked by usage frequency), plus declared CSS custom properties. |
| `browser_css_coverage` | Report unused CSS on the page via rule-usage tracking. |
| `browser_js_coverage` | Report dead JavaScript on the page via V8 precise coverage. |
| `browser_trace` | Record a CDP performance trace for a window (default 3000ms) and return a digest for diagnosing jank: long main-thread tasks (>= 50ms, longest first, with start time + duration) and a per-category time breakdown. |
| `browser_detect_framework` | Fingerprint the page's frontend framework (Next.js, Nuxt, SvelteKit, Remix, Astro, bare Vite, CRA, Angular), its dev server / bundler (Vite, webpack, Turbopack), and whether it's a local dev build with hot-module-replacement (HMR). |
| `browser_evaluate` | Evaluate a JavaScript expression in the page and return its JSON-able value (awaits promises). |
| `browser_pick_element` | Activate a devtools-style inspect overlay in the tab and WAIT for the human to click an element (or cancel with Escape). |
| `browser_get_selected_element` | Returns the element the user selected with 'Select for agent' in the HelmStack window — call this when the user says 'this element', 'the thing I selected', etc. |
| `browser_component_sources` | Map rendered DOM nodes back to the component + source file:line that produced them (React _debugSource, Svelte __svelte_meta, Vue __file). |
| `browser_layout_issues` | Detect layout problems at the current viewport: horizontal page overflow and the elements responsible, children escaping their constrained container, and elements clipping their own content. |
| `browser_media_state` | Read the page's current responsive state: resolved media features (prefers-color-scheme, prefers-reduced-motion, prefers-contrast, forced-colors, pointer, hover, orientation), the viewport size, and which @media queries from the page's stylesheets currently match. |
| `browser_mutation_timeline` | Sample DOM mutations over a time window (durationMs, default 1000) and rank the busiest subtrees — a re-render/layout-thrash detector. |
| `browser_threejs_scene` | Inspect a live Three.js scene graph, renderer stats, materials, and an FPS estimate. |
| `browser_assert` | Evaluate a natural-language assertion against the current page graph (deterministic, no LLM) and return pass/fail, an explanation, the matched page items and evidence. |
| `browser_get_recording` | Return the current command recording session for a tab, if recording is active. |
| `browser_start_recording` | Start recording commands executed against a tab. |
| `browser_stop_recording` | Stop recording commands for a tab and return a replayable script. |
| `browser_get_site_patterns` | Return saved site patterns for the current origin of a tab. |
| `browser_add_site_patterns` | Add site patterns for the current origin of a tab. |
| `browser_set_site_patterns` | Replace site patterns for the current origin of a tab. |
| `browser_clear_site_patterns` | Clear saved site patterns for the current origin of a tab. |
| `browser_set_file_input_files` | Set files on a file input matching a CSS selector. |
| `browser_list_downloads` | List downloads tracked for a tab. |
| `browser_clear_downloads` | Clear tracked download records for a tab. |
| `browser_get_resource_budget` | Return the current CPU/network/heap resource budget for a tab. |
| `browser_set_resource_budget` | Set CPU/network/heap resource constraints for a tab. |
| `browser_clear_resource_budget` | Clear CPU/network/heap resource constraints for a tab. |
| `browser_get_location_override` | Return the current geolocation/timezone/locale override for a tab. |
| `browser_set_location_override` | Set a geolocation/timezone/locale override for a tab. |
| `browser_clear_location_override` | Clear geolocation/timezone/locale overrides for a tab. |
| `browser_get_media_emulation` | Return the current CSS media emulation (dark mode, reduced motion, forced-colors, print) for a tab. |
| `browser_set_media_emulation` | Emulate CSS media state for a tab to test dark mode, reduced motion, forced-colors (high-contrast), and print styles. |
| `browser_clear_media_emulation` | Clear all CSS media emulation for a tab (return to the real OS/browser media state). |
| `browser_capture_storage` | Capture localStorage, sessionStorage, cookies, and IndexedDB for the tab's current origin. |
| `browser_get_storage` | Read localStorage or sessionStorage entries for a tab. |
| `browser_set_storage` | Write localStorage or sessionStorage entries for a tab. |
| `browser_clear_storage` | Clear localStorage or sessionStorage for a tab, optionally limited to specific keys. |
| `browser_get_cookies` | List cookies for the tab's current origin. |
| `browser_set_cookie` | Set or update a cookie for the tab's current origin. |
| `browser_delete_cookie` | Delete a cookie by name for the tab's current origin, or for an explicit URL. |
| `browser_clear_cookies` | Clear all cookies for the tab's current origin. |
| `browser_save_perception_snapshot` | Capture and cache the current semantic PageGraph under a snapshot ID. |
| `browser_diff_perception` | Compare two named perception snapshots and return structural changes. |
| `browser_list_perception_snapshots` | List cached named perception snapshots. |
| `browser_delete_perception_snapshot` | Delete a named perception snapshot from the in-memory cache. |
<!-- generated:end -->

## Agent-substrate tools

Only registered under the agent-substrate surface. `browser_approve` on the desktop app returns `requires_human`; see [Approvals](approvals.md).

<!-- generated:start mcp-substrate -->
| Tool | What it does |
| --- | --- |
| `browser_list_approvals` | List pending approval requests waiting for human confirmation. |
| `browser_approve` | Approve a pending command that requires human confirmation. |
| `browser_reject` | Reject a pending command that requires human confirmation. |
| `browser_list_handoffs` | List pending human handoff requests (tasks that require a human to take over). |
| `browser_resolve_handoff` | Mark a human handoff as resolved, returning control to the agent. |
| `browser_list_accounts` | List saved accounts (credential entries) stored in the vault. |
| `browser_lookup_accounts` | Look up saved accounts matching a given origin (e.g. https://github.com). |
| `browser_generate_totp` | Generate a TOTP code for an account that has 2FA configured. |
| `browser_get_intent` | Get the current agent intent/task set in the HelmStack UI. |
| `browser_set_intent` | Set the agent intent/task displayed in the HelmStack UI. |
<!-- generated:end -->

## Lite toolset

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

## Verify it worked

List the server's tools from a client. You should see the counts above. Starting the server without a reachable HelmStack still lists tools; calls fail with a connection error until the app or daemon is up.
