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

### [ ] 1.2 — Replace `:root` with the decided token set
- **Scope:** Put the full token system from styleguide §1–§2 into `tokens.css`: primitive ramps, spacing/type/radius/shadow/motion/z scales, and the **semantic dark block**. Values are chosen to match the current chrome closely, so visual drift is minimal.
- **Files:** `styles/tokens.css`.
- **Depends on:** 1.1.
- **Verify:** Build. Grep: `--color-*`, `--space-*`, `--text-*`, `--radius-*`, `--z-*` all defined. Launch → near-identical (only the contrast-fixed text tokens shift slightly lighter). Run the contrast numbers from styleguide §1.1 are pre-verified AA.
- **Risk:** Low. Components still reference *old* token names here — keep the old names aliased to the new semantic ones for this step, or do the rename in 2.1.

### [ ] 1.3 — `base.css`: the missing a11y defaults
- **Scope:** Global `:focus-visible` ring (`--focus-ring`), `:focus:not(:focus-visible){outline:none}`, `@media (prefers-reduced-motion)` kill-switch, unified scrollbars, and a `.skip-link` (with the markup hook in `index.html`).
- **Files:** `styles/base.css`, `index.html` (add `<a class="skip-link" href="#viewport-frame">`).
- **Depends on:** 1.1, 1.2.
- **Verify:** Grep `focus-visible` + `prefers-reduced-motion` present. Build. Manual: Tab through the UI → visible ring on every control; no ring on mouse click.
- **Risk:** Low. The single highest-value a11y change.

---

## Phase 2 — Tokenize components + fix contrast.

### [ ] 2.1 — Kill raw color literals; apply the contrast fixes
- **Scope:** Replace the **17 raw `rgba()`** + any hardcoded hex in `components.css`/`layout.css` with semantic tokens. Rename old token refs (`--text`/`--accent`/…) to the new `--color-*` names (or keep aliases). Ensure text uses the AA tokens (the `#555d6a` tertiary is gone).
- **Files:** `styles/components.css`, `styles/layout.css`, `styles/tokens.css` (drop aliases).
- **Depends on:** 1.2.
- **Verify:** **Grep-assert:** `grep -nE '#[0-9a-fA-F]{3,6}|rgba?\(' styles/components.css styles/layout.css` → only inside comments (ideally zero). Build. Visual: unchanged except slightly more legible meta text.
- **Risk:** Medium — easy to miss a literal; the grep gate catches it.

### [ ] 2.2 — Spacing / type / radius pass
- **Scope:** Replace magic `px` paddings/margins/gaps with `--space-*`, font-sizes with `--text-*`/the role scale, radii with `--radius-*`. Keep layout dims (`--sidebar-w` etc.) as tokens.
- **Files:** `styles/components.css`, `styles/layout.css`.
- **Depends on:** 2.1.
- **Verify:** Grep for stray `padding:.*px`/`font-size:.*px`/`gap:.*px` outside `var()` (allow the dims tokens). Build. Visual: spacing rhythm tightens to the 4px grid (minor, intentional).
- **Risk:** Medium — visual nudges; eyeball the tab rail + sidebar density.

### [ ] 2.3 — Button system → `btn--*` with all states
- **Scope:** Migrate `.btn-primary`/`.btn-sm`/`.btn-nav` → `.btn .btn--primary`/`.btn--sm`/(default); add `--ghost`/`--danger`/`--icon`, sizes, and `:disabled`/`[aria-busy]`/`:active` states (styleguide §3.1).
- **Files:** `styles/components.css`, `index.html`, `shell.ts` (any `className`/`classList` button refs).
- **Depends on:** 2.1.
- **Verify:** Grep: old `btn-primary`/`btn-nav` classes gone from HTML+TS. `npm test`/typecheck/lint green. Build. jsdom: optional smoke asserting buttons in `index.html` carry `.btn`.
- **Risk:** Medium — must update **both** CSS and the markup/TS that apply the classes; miss one → unstyled button. Grep both.

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
