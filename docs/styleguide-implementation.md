# Style Guide — Implementation Plan (loop checklist)

Task breakdown for applying **[styleguide.md](styleguide.md)** to the renderer
(`apps/desktop/src/renderer/`). Each item is **one loop iteration**: independently
shippable, dependency-ordered, with a concrete verification gate. Renderer-only —
no main-process or agent-API changes.

## How these are verified

Renderer work can't be screenshotted via the agent API (that captures *tabs*, not
the shell chrome), so the gates are:

- **Auto (every task):** `npm run build` (esbuild bundles `shell.ts` + copies
  `index.html`/CSS), `npm run typecheck`, `npm run lint`, `npm test` (the 232
  existing tests stay green — nothing here should touch them).
- **CSS correctness → grep-assertions** (scriptable, so loop-checkable): tokens
  present, **zero raw hex/`rgba()`/magic px** left in `components.css`/`layout.css`.
- **JS logic → jsdom unit tests** (the real lever — these helpers are testable
  exactly like the existing modules): `dialog.ts`, `toast.ts`, `theme.ts`,
  roving-tabindex, menu keyboard nav, `icon()`, the field-validation helper.
- **ARIA markup → jsdom test** loading `index.html` and asserting roles/attrs.
- **Visual → manual smoke at phase boundaries** (launch the app, eyeball it).
  Flagged per-task where it's the only check.

> **Build note:** `scripts/build.mjs` currently `cpSync`s a single `styles.css`.
> Task 1.1 changes it to copy a `styles/` dir; every later CSS task edits files
> inside that dir. Keep `index.html`'s `<link>`(s) in sync.

Status legend: `[ ]` todo · `[~]` partial · `[x]` done.

---

## Phase 1 — Foundation (tokens + base). *No visual change; immediate a11y win.*

### [x] 1.1 — Split `styles.css` into a layered `styles/` dir
- **Done.** Verbatim split (722 non-blank lines preserved, +3 section headers) into `renderer/styles/{tokens,base,components,layout}.css`; `index.html` links the 4 in cascade order; `build.mjs` **and** `dev.mjs` now copy the `styles/` dir (the dev watcher recurses + triggers on any `.css`). Build emits all 4, links resolve, every file brace-balanced, gate green (lint/typecheck/232 tests). **Notes:** (a) cascade is `tokens → base → components → layout`; the `Responsive` `@media` block is last in `layout.css`, so its overrides still win as before — verified safe because layout/component sections target disjoint selectors. (b) Removed a stale `dist/renderer/styles.css` artifact (the build doesn't clean `dist`). (c) **Visual "pixel-identical" deferred to the Phase-1 boundary smoke** — a verbatim content move + brace balance + identical cascade semantics makes a per-task repackage unnecessary; I'll launch once after 1.3.

- **Scope:** Move the existing 854-line `styles.css` into `styles/{tokens,base,components,layout}.css` **verbatim** (no value changes), by its existing section markers: tokens→`tokens.css`; reset/`html,body`/scrollbars→`base.css`; App Layout/Titlebar/Tab Rail/Navbar/Workspace/Sidebar/Viewport/Responsive→`layout.css`; Buttons/Dropdown/Panels/Intent/Terminal/Accounts/Developer/Modals→`components.css`.
- **Files:** new `renderer/styles/*.css`; `scripts/build.mjs` (copy the dir, not the file); `index.html` (link the 4 in cascade order, or a barrel `styles.css` that `@import`s them); delete old `styles.css`.
- **Depends on:** —
- **Verify:** `npm run build` emits all 4 under `dist/renderer/styles/`; launch → **pixel-identical** to before (verbatim move). Grep: no rules lost (line count ≈ sum).
- **Risk:** Low, but it's the one build-script change — confirm `dist` has the files and the `<link>` order matches the cascade (tokens → base → components → layout).

### [x] 1.2 — Replace `:root` with the decided token set
- **Done.** `tokens.css` now holds the full decided system: primitive ramps (neutral/green/amber/red/blue), the spacing/type/radius/shadow/motion/z scales, layout+control dims, and the semantic **dark** `--color-*` block — plus a **legacy-alias block** mapping every old token name to the new ones so components render unchanged until 2.1. Verified: all **29** `var(--…)` refs in base/components/layout resolve (0 dangling), decided tokens present, build + lint + typecheck + 232 tests green.
- **Notes:** (a) intended minor drift is baked in now via the aliases — text contrast AA-fixed (`--text-tertiary` #555d6a→#808997, secondary #848b97→#9aa1ad), borders `.06`→`.08`, accent/warning subtles `.08`→`.10`, app bg `#0c0e12`→`#0a0c10`, shadows md/lg deepened. (b) `color-scheme` + `--focus-ring` are defined here; the `[data-theme="light"]` block lands in task 5.1. (c) The alias block carries a `DELETE in task 2.1` marker.

### [x] 1.3 — `base.css`: the missing a11y defaults
- **Done.** Added the global `:focus-visible` ring, `:focus:not(:focus-visible){outline:none}`, the `prefers-reduced-motion` kill-switch, unified thin scrollbars, and the `.skip-link`; wired `<a class="skip-link" href="#viewport-frame">` as the first body child + `tabindex="-1"` on `#viewport-frame`. Also moved `html,body` onto the new `--color-*` names. Verified: all four primitives present, all base refs resolve, build + lint + typecheck + 232 tests green.
- **Notes:** (a) **Chose `outline` over the `--focus-ring` box-shadow** for the global ring — this app has many `overflow:hidden` containers (tab rail, panels) that would clip a box-shadow ring; `outline` is never clipped and follows each element's border-radius in Chromium. The `--focus-ring` token stays defined for opt-in use on non-clipped elements. (b) **Visual-verification limitation discovered:** the chrome can't be smoke-tested in a browser preview — `shell.js` gates all rendering on the Electron `contextBridge`, so a plain browser renders a blank body; the agent API only screenshots *tabs*, not the shell window. So Phase-1 visual rests on: verbatim split (no rules lost) + 0 dangling token refs + valid/brace-balanced CSS + green gate. A true visual pass needs the **Electron app** (deferred to a meaningful visual boundary — Phase 2 buttons or Phase 5 theming/icons — or a user look).

---

## Phase 2 — Tokenize components + fix contrast.

### [x] 2.1 — Kill raw color literals; apply the contrast fixes
- **Done.** Migrated `components.css` + `layout.css` to `--color-*` (all 21 distinct old alias refs renamed via a `)`-anchored substring-safe pass), replaced all **7** raw color literals, and **deleted the legacy-alias block** from `tokens.css`. Verified: **0** raw hex/rgba in components+layout, **0** leftover old refs, **0** dangling refs (alias net removed), build + lint + typecheck + 232 tests green.
- **Notes — how each literal resolved:** `.dropdown-item:hover` & `.panel-header:hover` whites (`.06`/`.02`) → `--color-hover`; `.modal-backdrop` `rgba(0,0,0,.6)` → `--color-overlay` (exact); `.approval-effect` amber border `.16` → new **`--color-warning-border`** token; brand-icon gradient end `#60a5fa` → `--blue-400`; the two accent glows (brand icon `0 0 12px /.30`, primary button `0 2px 8px /.20`) → new **`--shadow-accent-glow`** / **`--shadow-accent-sm`** tokens. (The grep "17" in the original scope was an over-count from the gap doc; the renderer actually had 7 raw literals here — recorded for accuracy.)
- **Decision:** kept raw values as *tokens in tokens.css* (the legitimate home for raw values) instead of `color-mix()`, to avoid taking a dependency on a newer CSS feature mid-migration.

### [x] 2.2 — Spacing / type / radius pass
- **Done.** Tokenized every padding/margin/gap → `--space-*`, every font-size → `--text-*`, and the two remaining raw radii → `--radius-pill`/`--radius-xs` in components+layout. Verified: 0 residual mapped px in spacing props, 0 raw font-size, 0 non-token border-radius, all refs resolve, build + lint + typecheck + 232 tests green.
- **Decisions/notes:** (a) the styleguide 4px scale omits 10 & 14 — rounded **down** (10→8, 14→12) for the compact dev-tool density; (b) sub-11px text bumped to `--text-xs` (11px) — fixes the "never below 11px" rule on `.tab-meta` and the badge; 16px text → `--text-lg` (15px, nearest); (c) the two **icon glyphs** (new-tab `+` 16→15, expand caret `▸` 10→11) shift ≤1px harmlessly and are replaced by SVG in task 5.2, so they were tokenized uniformly rather than special-cased; (d) **two intentional raw px remain & are documented in-CSS:** the `80px` titlebar left inset (macOS traffic lights) and a `1px` hairline padding nudge — both below/outside the spacing rhythm.

### [x] 2.3 — Button system → `btn--*` with all states
- **Done.** Rebuilt the `.btn` system per styleguide §3.1: base + `.btn--sm`/`.btn--lg`/`.btn--icon` sizes, `.btn--primary`/`.btn--ghost`/`.btn--danger` variants, and `:hover`/`:active`/`:disabled`/`[aria-disabled]`/`[aria-busy]` (spinner) states. Heights now use `--control-md`/`--control-sm`/`--control-lg`; transitions use `--dur-fast`/`--ease`. Migrated all 8 button sites in `index.html` to `btn--*` and dropped `btn-nav` (the Go button is now a plain `.btn .btn--primary`). Verified: **0** old `btn-(primary|ghost|sm|nav)` classes left in HTML or CSS, all refs resolve, build + lint + typecheck + 232 tests green.
- **Notes:** (a) `shell.ts` does **not** manipulate button classes/state today (grep clean), so no TS change was needed — the new `:disabled`/`[aria-busy]` states are defined and ready but not yet triggered by app behavior. **Follow-up (behavioral, out of this CSS-system task):** wire `aria-busy`/`disabled` on the Run button during agent execution and on Approve/Reject while submitting. (b) `btn-nav`'s only effect was wider padding (space-6); dropping it tightens the Go button to the default space-5 — intentional. (c) The icon-button candidates (`.tab-new` `+`, future tab-close) still use bespoke classes; folding them into `.btn--icon` pairs naturally with the SVG icon work in 5.2.

### [x] 2.4 — `.field` component + real inline validation
- **Done.** Added the `.field` system to `components.css` (`.field`/`.field__label`/`.field__error` + `.input`/`.textarea`/`.select` with `[aria-invalid]` danger styling). Extracted a **pure, DOM-free validator** at `renderer/ui/validate.ts` (`validateAccountForm` + `isValidOrigin`) and wired `accountForm` in `shell.ts` to paint inline `aria-invalid` + error text, focus the first invalid field, and clear a field's error on `input` — replacing the silent `return`. Restructured the account form markup into labelled `.field` blocks. Verified: new `account-validate.test.ts` (**13 tests**) green, full suite **245 passed** (was 232), build + lint + typecheck green, CSS refs resolve.
- **Notes:** (a) the validator is **DOM-free** so it needed no jsdom — pure data-in/errors-out, which is why it's the testable seam (`shell.ts` just maps field keys → input/error nodes). (b) **a11y wins beyond the plan:** the form had **placeholder-as-label** (no real `<label>`); added visible `.field__label`s, `for`/`id` pairing, `aria-describedby` → error node, and `novalidate` so our messages (not the native bubble) show. (c) origin validation goes past "required" — rejects non-`http(s)` / hostless values with a format hint, but only when non-empty (no double-report). (d) `.textarea`/`.select` selectors are defined for system-completeness though only `.input` is used today (the intent/nav boxes keep their bespoke classes).

### [x] 2.5 — Empty / loading / skeleton states
- **Done.** Added `.empty-state` (+`__title`/`__hint`) and `.skeleton`/`.skeleton--row` (shimmer) to `components.css` (§3.13). Extracted **pure DOM builders** at `renderer/ui/states.ts` (`buildEmptyState`, `buildSkeletonRows`) and wired them: `renderAccounts([])` and `renderVaultSecrets([])` now render a real empty-state instead of going blank, and `bootstrap()` paints 2 skeleton rows in the vault + accounts lists while data loads. Verified: new `ui-states.test.ts` (**6 tests**) green, suite **251 passed** (was 245), build + lint + typecheck green, CSS refs resolve. **Completes Phase 2.**
- **Notes:** (a) the builders are the tested seam — `buildEmptyState({title})` → `.empty-state` node, `buildSkeletonRows(n)` → n rows (clamps negatives); both set text via `textContent` (an injection-safety test asserts no child elements from `<img …>` input). (b) **bonus perf:** `bootstrap()` now loads tabs/vault/accounts via `Promise.all` (was three serial awaits) so the skeletons clear together. (c) the skeleton shimmer is automatically frozen by the `prefers-reduced-motion` kill-switch from task 1.3. (d) the snapshot `<pre>` already shows a "No snapshot captured yet." placeholder, so it wasn't a blank-list case needing `.empty-state`.

---

## Phase 3 — Dialog + toast (mostly testable JS).

### [x] 3.1 — `renderer/ui/dialog.ts` focus-trap helper
- **Done.** Built `openDialog(el, { dismissable, initialFocus, onClose })` → `DialogHandle` (§3.5): stores the active element, moves focus in (`initialFocus` → `[data-autofocus]` → first focusable → the dialog itself with `tabindex=-1`), traps Tab/Shift+Tab with wraparound, closes on `Escape` only when `dismissable`, and restores focus to the opener on close. Exposes `getFocusable()` too. Verified: new `dialog.test.ts` (**8 tests**) green covering every verify point, suite **259 passed** (was 251), typecheck + lint + build green.
- **Notes:** (a) deliberately **layout-free** — no `offsetParent`/`getClientRects`, filters by `disabled`/`aria-hidden`/`[hidden]` only — so it behaves identically in jsdom and the real renderer (a visibility-based filter would falsely hide everything under jsdom). (b) Focus-trap is computed **live** on each Tab (re-queries focusables) so it survives dynamic dialog content. (c) `close()` is **idempotent** (guarded) and `onClose` fires exactly once. (d) The helper owns focus only — **it does not toggle visibility**; the caller shows/hides. Not yet imported anywhere (so not in the esbuild bundle); **task 3.2** wires it into the approval/handoff modals.

### [x] 3.2 — Adopt `dialog.ts` for approval/handoff modals; fix inverted backdrop
- **Done.** `showApprovalModal`/`showHandoffModal` now open the modal then call `openDialog(modal, { dismissable: false })`, storing a `DialogHandle`; `hideApprovalModal`/`hideHandoffModal` call `handle.close()` (restores focus to the opener) after re-hiding. **Deleted both dead inverted backdrop handlers** (`if (!active…Id) hide()` — the id is always set while open, so they never fired) and removed the now-unused `approvalBackdrop`/`handoffBackdrop` refs. Verified: typecheck + lint + build green, **259 tests** pass.
- **Notes:** (a) **latent z-index bug fixed:** `.modal-overlay` was `z-index: 50` but `.dropdown-menu` is `100` — an open dropdown would have painted *over* a modal. Tokenized the global layers to the scale (`--z-modal` 1000 / `--z-dropdown` 100 / titlebar `--z-titlebar` 10); the remaining raw `z-index: 1`s are local sibling-stacking nudges, intentionally left. (b) **focus default is the safe action** — first focusable is **Reject**/**Cancel** (they precede Approve/Done in DOM), so a stray Enter never auto-approves. (c) the "focus trapped inside, Esc inert" behavior is covered transitively by `dialog.test.ts` (dismissable:false case); the wiring adds no new logic to test. (d) approve/reject/done/cancel handlers are **untouched** (their `if (!active…Id) return` guards are correct and stay). Backdrop click is now intentionally inert (commented). Live approve/reject needs the running agent to exercise; the change only adds focus management around the unchanged handlers.

### [x] 3.3 — `renderer/ui/toast.ts` + route all feedback through it
- **Done.** Built `toast(message, kind)` → `ToastHandle` into a lazy `role="status" aria-live="polite"` region (added to `index.html` so it exists at load); info/success auto-dismiss after 4s, **errors persist** with a close button and carry `role="alert"`. Added the `.toast`/`.toast-region` CSS (§3.6). Wired `shell.ts`: `setFixtureStatus(text, kind)` now also pops a toast for `success`/`error` (info stays inline-only), and annotated the outcome sites — command completed → success, command blocked/failed + rejected-blocked + fixture-runner error → error, approval-granted + handoff-resolved → success. Verified: new `toast.test.ts` (**7 tests**, fake timers) green, suite **266 passed** (was 259), typecheck + lint + build green, CSS refs resolve. **Completes Phase 3.**
- **Notes:** (a) **kept `#fixture-status`** as the inline progress line rather than deleting it — routine "info" steps (filling form, opening fixture) stay inline so they don't spam toasts; only notable success/error outcomes toast. This is a deliberate read of "replace the status line with toasts" (toasts *augment* for the outcomes that matter). (b) **the "swallowed `catch {}`" premise didn't hold** — shell.ts has only 2 `catch` blocks and both are legitimate (a `safeHostLabel` URL-parse fallback and the fixture runner, which now toasts the error). The real feedback gap was *result*-level failures (`blocked`/`failed` statuses) silently updating only an easily-missed inline line; those now toast. (c) error toasts use `role="alert"` (assertive) inside the polite region for prompt SR announcement. (d) the slide-in + the persistence interact correctly with the `prefers-reduced-motion` freeze from 1.3.

---

## Phase 4 — ARIA widgets + landmarks.

### [x] 4.1 — Tab strip → ARIA tablist (roving tabindex + arrows)
- **Done.** `#tabs` is now `role="tablist"` (`aria-label="Open tabs"`); each tab gets `role="tab"`, `aria-selected`, `aria-controls="viewport-frame"`, and roving `tabindex` (0 active / -1 rest). The viewport is `role="tabpanel"`. Extracted `renderer/ui/roving.ts` — pure `nextRovingIndex()` + `applyRovingTabindex()` + a live-querying `attachRovingKeys()` — and wired ←/→/Home/End roving onto the strip, plus Delete/Backspace to close the focused tab. Close buttons got `aria-label` + `tabindex=-1`. Verified: new `roving.test.ts` (**11 tests**) green, suite **277 passed** (was 266), typecheck + lint + build green.
- **Notes:** (a) **manual activation** (arrows move focus only; Enter/Space/click activate) — chosen because automatic activation would switch the real `WebContentsView` on every arrow *and* the resulting `renderTabs` re-render (replaceChildren) would drop focus mid-keystroke. Native `<button>` Enter/Space already activates, so no extra code. (b) the roving handler queries `[role="tab"]` **live** on each keydown, so it survives `renderTabs` re-renders without re-binding. (c) close buttons are out of the Tab order (`tabindex=-1`) to keep the roving order clean; keyboard close is **Delete/Backspace** on the focused tab (APG pattern). (d) click-to-activate + close handlers are **untouched**. (e) pre-existing nuance left as-is: the close `<button>` is nested inside the tab `<button>` (invalid HTML but functional) — un-nesting is a renderTabs structural change deferred to avoid layout risk.

### [x] 4.2 — Demos menu → `role="menu"` with keyboard nav
- **Done.** Built `renderer/ui/menu.ts` → `createMenu(trigger, menu)`: sets `aria-haspopup="menu"`/`aria-expanded`/`aria-controls` on the trigger; ↓/Enter/Space opens to the first item, ↑ to the last; ↑/↓/Home/End rove `[role="menuitem"]` (reusing `nextRovingIndex` from 4.1); Esc closes + restores focus to the trigger; Tab and outside-click close; selecting an item closes. Markup got `role="menu"`/`menuitem`/`separator` + `aria-label`. Replaced the old toggle+outside-click block in `shell.ts` and removed the 4 per-item self-hide calls. Verified: new `menu.test.ts` (**8 tests**) green, suite **285 passed** (was 277), typecheck + lint + build green.
- **Notes:** (a) **reused** `roving.ts`'s `nextRovingIndex` (vertical orientation) rather than duplicating the cycle math. (b) menu items set to `tabindex=-1` (roving) so the menu uses programmatic focus, not Tab order. (c) the per-item handlers **no longer self-hide** — closing is owned by `createMenu` (item-click delegation) so `aria-expanded` never goes stale (the old `setAttribute("hidden")` bypassed it). (d) the four item *actions* (open/run fixture, snapshot, inspect) are untouched. (e) live keyboard open/close needs the running app to fully exercise, but every branch is covered by the jsdom helper test.

### [x] 4.3 — Landmarks + skip-link wiring
- **Done.** Labelled `<nav class="navbar">` → `aria-label="Address bar and tools"` and `<aside class="sidebar">` → `aria-label="Agent and developer tools"`; confirmed the skip-link (`#viewport-frame`) targets the existing `role="tabpanel"` viewport. Added `landmarks.test.ts` (**5 tests**) parsing the real `index.html`: single header/main, nav+aside distinctly labelled, skip-link resolves to a real id, tablist+tabpanel present, and **all static `aria-label`s unique**. Verified: suite **290 passed** (was 285), typecheck + lint + build green. **Completes Phase 4.**
- **Notes:** (a) **the scope's "two `<nav>`s" was a miscount** — the markup has exactly **one** `<nav>`; the tab rail is correctly a `role="tablist"` (from 4.1), not a navigation landmark, so promoting it to a second nav would be wrong. Labelled the one nav + the aside instead; the `<header>` (banner) and `<main>` are unique singletons that need no disambiguating label per ARIA. (b) the new test doubles as a **regression guard** for the whole Phase-4 + 1.3 a11y structure (roles, labels, skip target). (c) test gotcha recorded: under the jsdom env `import.meta.url` is the `https://example.com/` jsdom URL, so `fileURLToPath` throws "must be of scheme file" — read fixtures via a **cwd-relative path** (vitest runs from repo root) instead.

---

## Phase 5 — Theming + icons.

### [x] 5.1 — Theme system (dark/light/system + persistence)
- **Done.** Added the `:root[data-theme="light"]` semantic block to `tokens.css` (audited: covers **all 32** dark `--color-*`/`--focus-ring` tokens, 0 missing) with `color-scheme: light`. Built `renderer/ui/theme.ts` (`initTheme()` → controller): resolves `stored ?? system`, writes `data-theme` on `<html>`, persists the choice to `localStorage`, and follows `matchMedia('(prefers-color-scheme: light)')` changes **only while the choice is "system"**. Added a titlebar toggle (`#theme-toggle`) wired to `controller.toggle()`. Verified: new `theme.test.ts` (**8 tests**) green — stored-wins, system-fallback, persist, toggle, and OS-follow-only-when-system — suite **298 passed** (was 290), lint + typecheck + build green, CSS refs resolve.
- **Notes:** (a) the **dark block stays the bare-`:root` default** (`:root, :root[data-theme="dark"]`) so tokens are defined pre-JS — no unstyled FOUC; the only flash is a brief dark→light for a light-OS user with no stored pref, since `shell.js` (which calls `initTheme`) loads at end of `<body>`. Acceptable; a `<head>` inline script could eliminate it later if desired. (b) `initTheme()` runs at **module top-level** (before render) to minimise that flash. (c) light values are the styleguide §1.1 decided set (AA-pre-verified); I filled the few tokens its snippet omitted — the status `*-subtle`/`-border`, `on-warning`/`on-danger`, and a lighter `--color-overlay` scrim `rgba(15,20,30,.45)`. (d) the toggle glyph is a placeholder `◐` — **task 5.2** swaps it for a Lucide sun/moon SVG. (e) full visual flip needs the Electron app; logic is covered by the jsdom test.

### [x] 5.2 — Lucide icon set; replace ad-hoc glyphs
- **Done.** Built `renderer/ui/icons.ts` → `icon(name, { size, className })` returning a fresh `<svg class="icon" aria-hidden stroke="currentColor">` via `createElementNS` (Lucide paths for x/plus/chevron-down/chevron-right/sun/moon). Replaced every ad-hoc glyph: the tab-close + account-delete + toast-close `×`, the Demos `&#9662;`, the CSS `\25B8` panel caret (now an injected `.panel-caret` chevron that rotates on `[open]`), the new-tab `+`, and the `◐` theme toggle (now a **sun in dark / moon in light**, re-rendered on toggle). Added a base `.icon` class. Verified: grep confirms `×`/`&#9662;`/`◐`/`\25B8` all gone, new `icons.test.ts` (**5 tests**) green, suite **303 passed** (was 298), typecheck + lint + build green, CSS refs resolve. **Completes Phase 5.**
- **Notes:** (a) **deliberately kept the brand gradient** `.brand-icon` square as the product mark — it's a distinctive logo, not a functional glyph, and it isn't in the verify grep; swapping it for a monochrome Lucide icon would lose brand identity and read worse at 14px. (b) icons are **theme-aware for free** via `stroke: currentColor` (no fill) — they recolour with the surrounding text. (c) **a11y preserved**: every now-icon-only button keeps an `aria-label` (tab close from 4.1, toast dismiss from 3.3, and a new `aria-label` added to the account-delete button which previously had only a `title`); the SVGs are `aria-hidden`. (d) `createElementNS` (not `innerHTML`) is used so SVG children get the correct namespace in both jsdom and Chromium. (e) TS gotcha recorded: `satisfies Record<…>` narrows each shape's attrs to a union, so iterate with `Object.entries(attrs)` (not `attrs[key]`) to avoid an implicit-any index error.

---

## Phase 6 — Data components + content/polish.

### [ ] 6.1 — Data-display components
- **Scope:** Formalize `.table`/`.kv`/`.stat`/`.meter`/`.code`/`.terminal` (§3.8–3.12); apply: terminal levels → semantic colors, perception/metric panels → key-value + mono numerics, any score/% → meter with threshold colors.
- **Files:** `styles/components.css`, `shell.ts` (render funcs), `index.html`.
- **Depends on:** 2.1, 2.2.
- **Verify:** Grep tokens-only. Build. **jsdom:** any extracted render fn (e.g. terminal line → correct level class). Manual: terminal/data panels read cleanly.
- **Risk:** Medium — most markup-touching; do per-panel, one panel per sub-iteration if large.

### [ ] 6.2 — Content & voice pass
- **Scope:** Sentence-case all buttons/titles/menu items; action-first labels; error messages say what+how (styleguide §5).
- **Files:** `index.html`, `shell.ts` (strings).
- **Depends on:** —
- **Verify:** Manual/grep for Title-Case button text + bare "Error". Build.
- **Risk:** Low.

### [ ] 6.3 — Final a11y + visual pass
- **Scope:** Tab-through audit (every control reachable + ringed); contrast spot-check with the computed values; reduced-motion check; light/dark/system check; confirm all jsdom UI tests green.
- **Files:** —
- **Depends on:** all above.
- **Verify:** Full `npm run build && npm run lint && npm run typecheck && npm test`. Manual keyboard + theme smoke. (The chrome can't be `browser_a11y_audit`'d via the agent API; if desired, temporarily load `index.html` as a `file://` tab to run the audit against it.)
- **Risk:** Low — it's the sign-off.

---

## Sequencing & notes

- **Order:** 1.1 → 1.2 → 1.3 unlock everything. Phase 2 is the bulk (tokenize). Phase 3 (dialog/toast) and the helpers in 4/5 are the **testable** wins — favor them when you want a green unit-test gate. Phase 6 is markup-heavy; split per panel if a task feels too big.
- **Each task ends green:** build + lint + typecheck + the 232 existing tests, plus any new jsdom test for that task. New UI helpers (`dialog`/`toast`/`theme`/`roving`/`menu`/`icons`/`validate`) each ship with a `test`.
- **Commit cadence:** one task = one commit (`feat(ui): …` / `refactor(ui): …` / `style(ui): …`), branch off `main`, FF-merge — same flow as the rest of the project.
- **Don't:** introduce raw literals (grep-gated), change the agent API or main process, or regress the 232 tests.
