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

### [ ] 2.4 — `.field` component + real inline validation
- **Scope:** `.field`/`.input`/`.textarea`/`.select` + `.field__label`/`.field__error` (§3.2). Wire `accountForm` (and other forms) to set `aria-invalid` + unhide the error instead of the current silent `return`.
- **Files:** `styles/components.css`, `index.html`, `shell.ts`, plus a small **pure validator** (e.g. `renderer/ui/validate.ts`) so it's unit-testable.
- **Depends on:** 2.1.
- **Verify:** **jsdom unit test** of the validator (required/empty/valid → error messages). typecheck/lint/build.
- **Risk:** Medium — touches form-submit logic; the validator extraction makes it testable.

### [ ] 2.5 — Empty / loading / skeleton states
- **Scope:** `.empty-state`/`.skeleton` (§3.13). Use `.empty-state` where lists render blank (`renderAccounts`/vault/snapshot); `.skeleton` while `listTabs()`/`listAccounts()` are in flight.
- **Files:** `styles/components.css`, `shell.ts` (render funcs).
- **Depends on:** 2.1.
- **Verify:** **jsdom test:** `renderAccounts([])` produces an `.empty-state` node (extract the render to a pure DOM-returning fn if needed). Build.
- **Risk:** Low–medium.

---

## Phase 3 — Dialog + toast (mostly testable JS).

### [ ] 3.1 — `renderer/ui/dialog.ts` focus-trap helper
- **Scope:** `openDialog(el, {dismissable})` per styleguide §3.5 (store focus → move in → trap Tab → `Esc` if dismissable → restore).
- **Files:** new `renderer/ui/dialog.ts` + `test`.
- **Depends on:** —
- **Verify:** **jsdom unit test:** initial focus lands on `[data-autofocus]`/first focusable; Tab from last → first (and Shift+Tab wrap); `Esc` closes when `dismissable`, **doesn't** when not; focus restored to opener on close.
- **Risk:** Low — self-contained, fully testable.

### [ ] 3.2 — Adopt `dialog.ts` for approval/handoff modals; fix inverted backdrop
- **Scope:** Route `showApprovalModal`/`showHandoffModal` through `openDialog`; mark them `data-dismissable="false"` (required decisions) and delete the dead inverted `if (!activeApprovalRequestId) hide()` backdrop check.
- **Files:** `shell.ts`, `index.html`, `styles/components.css` (Modals → dialog tokens).
- **Depends on:** 3.1.
- **Verify:** typecheck/lint/build; `npm test` green. jsdom: opening sets focus inside, `Esc` does **not** dismiss the approval modal. Manual: approve/reject still work.
- **Risk:** Medium — touches the live approval flow; keep approve/reject handlers intact.

### [ ] 3.3 — `renderer/ui/toast.ts` + route all feedback through it
- **Scope:** `toast(msg, kind)` + the `role="status" aria-live="polite"` region (§3.6). Replace the `#fixture-status` line and the swallowed `catch {}` paths with toasts (success/error).
- **Files:** new `renderer/ui/toast.ts` + `test`; `index.html` (region); `shell.ts`.
- **Depends on:** —
- **Verify:** **jsdom unit test** (fake timers): appends a node, auto-removes after ~4s, errors persist; region has `role=status`. Grep: empty `catch {}` blocks in `shell.ts` reduced. Build.
- **Risk:** Low–medium.

---

## Phase 4 — ARIA widgets + landmarks.

### [ ] 4.1 — Tab strip → ARIA tablist (roving tabindex + arrows)
- **Scope:** `role="tablist"` + `role="tab"`/`aria-selected`/roving `tabindex`; ←/→ move selection; close button `aria-label` (§3.3). Extract a **pure `rovingTabindex` helper** for testing.
- **Files:** `index.html`, `shell.ts` (`renderTabs`), new `renderer/ui/roving.ts` + `test`, `styles/components.css`.
- **Depends on:** 1.3 (focus ring), 2.3.
- **Verify:** **jsdom test** of the roving helper (arrow keys move focus + selection, wraps). jsdom: rendered tabs carry `role=tab`. Build.
- **Risk:** Medium — `renderTabs` is core; keep click-to-activate + close working.

### [ ] 4.2 — Demos menu → `role="menu"` with keyboard nav
- **Scope:** Trigger `aria-haspopup/expanded/controls`; `role=menu`/`menuitem`; `↑/↓` cycle, `Enter`/`Space` open+focus-first, `Esc` close+restore (§3.4). Click-outside already exists.
- **Files:** `index.html`, `shell.ts`, new `renderer/ui/menu.ts` (keyboard helper) + `test`.
- **Depends on:** 1.3.
- **Verify:** **jsdom test** of the menu keyboard helper. Build. Manual: open/close/keyboard.
- **Risk:** Low–medium.

### [ ] 4.3 — Landmarks + skip-link wiring
- **Scope:** Distinct `aria-label`s on the two `<nav>`s and the `<aside>`; ensure the §1.3 skip-link targets the viewport.
- **Files:** `index.html`.
- **Depends on:** 1.3.
- **Verify:** **jsdom/grep:** both navs + aside have unique `aria-label`; skip-link present + targets an existing id. Build.
- **Risk:** Low.

---

## Phase 5 — Theming + icons.

### [ ] 5.1 — Theme system (dark/light/system + persistence)
- **Scope:** Add the **light** semantic block to `tokens.css`; `renderer/ui/theme.ts` resolves `stored ?? system`, sets `data-theme`, persists to `localStorage`, listens to `matchMedia` changes; add a toggle control in the titlebar.
- **Files:** `styles/tokens.css`, new `renderer/ui/theme.ts` + `test`, `index.html`, `shell.ts`.
- **Depends on:** 1.2.
- **Verify:** **jsdom unit test** of the resolve/persist logic (stored wins; falls back to system; toggles). Build. Manual: toggle flips the whole UI; light theme contrast pre-verified AA in styleguide §1.1.
- **Risk:** Medium — light block must cover every semantic token (audit for `var()`s with no light value).

### [ ] 5.2 — Lucide icon set; replace ad-hoc glyphs
- **Scope:** Add the Lucide SVGs used (close/add/chevron/play/stop/crosshair/camera/copy/check/alert/info/settings…) via a tiny `icon(name)` helper or inline `<svg>`; replace the brand gradient div, `×`, `&#9662;`, and CSS `\25B8` (§1.7).
- **Files:** new `renderer/ui/icons.ts` (+ test), `index.html`, `shell.ts`, `styles/{components,base}.css` (`.icon`).
- **Depends on:** —
- **Verify:** **jsdom test** of `icon()` (returns an `<svg aria-hidden>` with the right path). Grep: `&#9662;`/`\\25B8`/`×`-as-glyph gone. Build. Manual: icons render at consistent sizes, theme-aware.
- **Risk:** Medium — sourcing/inlining the SVG paths; keep icon-only buttons' `aria-label`.

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
