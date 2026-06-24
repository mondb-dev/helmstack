# HelmStack UI/UX Standards & Implementation Guide

> **Looking for the decided values (colors, fonts, icons, type scale, component
> specs)?** Those live in **[styleguide.md](styleguide.md)** — the canonical
> source of truth. This document is the *rationale*: the review of the current
> UI, the gap analysis, and the phased migration plan. Where the two overlap, the
> style guide's decided tokens win.

How to evolve the desktop shell (`apps/desktop/src/renderer/`) into a consistent,
accessible, standards-based UI. Reviewed: 2026-06-21 against `index.html`,
`styles.css`, and `shell.ts`.

---

## 1. Review of the current UI

**What's already good** — keep and build on these:
- A real **design-token layer** in `:root` (colors, surfaces, borders, radii, shadows, plus layout dims). This is the right foundation; most of this guide extends it.
- A coherent **dark theme** with a clear accent and semantic status colors (warning/danger/info).
- Sensible **component vocabulary**: `.btn`/`.btn-primary`/`.btn-ghost`, `.panel` (native `<details>`), `.modal`, `.badge`, `.account-chip`, `.tab-pill`.
- Native semantics where it counts: collapsible panels use `<details>/<summary>`; dialogs set `role="dialog"`, `aria-modal`, `aria-labelledby`.
- Basic responsive reflow at `≤900px`.

**What's inconsistent or missing** — the gaps this guide fixes:

| # | Issue | Evidence |
|---|---|---|
| 1 | **No spacing scale.** Padding/margins are magic numbers (16/14/12/10/8/6/4px) scattered across rules. | every block in `styles.css` |
| 2 | **No type scale.** Font sizes hardcoded (10–16px) per rule; base is a cramped 13px. | `.tab-meta:10px`, `.panel-header:11px`, `.modal-title:16px` |
| 3 | **Token bypass.** Many `rgba(255,255,255,…)` / `rgba(0,0,0,…)` literals that should be tokens. | `.panel-header:hover`, `.dropdown-item:hover`, `.modal-backdrop`, button glows |
| 4 | **No visible keyboard focus.** Buttons/tabs/menu items have **no `:focus-visible` ring**; only inputs change border. | global — a real a11y blocker |
| 5 | **Modals lack focus management.** No initial focus, focus trap, `Esc` to close, or focus restore; the backdrop-close logic is inverted (`if (!activeApprovalRequestId) hide()` never fires while open). | `shell.ts` `showApprovalModal`/`approvalBackdrop` |
| 6 | **No toast/feedback system.** Action results go to a tiny `#fixture-status` line or the terminal; several errors are swallowed. | `setFixtureStatus`, empty `catch` paths |
| 7 | **No empty / loading / disabled / busy states.** Empty accounts render nothing; buttons have no `:disabled` or in-flight state. | `renderAccounts` early-return; no `.btn:disabled` rule |
| 8 | **Tabs/menus aren't ARIA widgets.** Tabs are bare `<button>`s; the "Demos" menu has no `aria-haspopup`/`aria-expanded`/roles/arrow-key nav. | `index.html` tab rail + dropdown |
| 9 | **No reduced-motion or theme support.** Transitions everywhere with no `prefers-reduced-motion`; `color-scheme` is hardcoded dark (no light/system). | `:root { color-scheme: dark }` |
| 10 | **Contrast risk.** `--text-tertiary:#555d6a` on dark surfaces is ~3:1 — fails WCAG AA for the body text it's used on (placeholders, tab meta). | token + usages |
| 11 | **Mixed icon sources.** Gradient div, `×` text, `&#9662;` entity, CSS `\25B8` — no icon system. | brand/close/caret/chevron |
| 12 | **Ad-hoc transitions / sizes.** Durations 80/100/150ms and button heights 28/32px without a scale. | throughout |

---

## 2. Principles

1. **Tokens first.** No raw color/size/timing literals in component CSS — everything resolves to a `--token`. A value used twice becomes a token.
2. **Accessible by default.** Every interactive element has a visible `:focus-visible` state, a 44×44 minimum hit area where practical, an accessible name, and keyboard operability. Target WCAG 2.1 AA contrast.
3. **One component, all its states.** Each component defines default / hover / active / focus-visible / disabled / busy / (where relevant) selected and error — not just the happy path.
4. **Semantics over `<div>`s.** Use the right element/role (tablist, menu, dialog, status) so assistive tech and keyboards work for free.
5. **Theme-able.** Light/dark/system driven entirely by tokens; components never hardcode a palette.
6. **Predictable feedback.** Every user action produces visible, consistent feedback (toast, inline status, or a state change) within ~100ms.

---

## 3. The token system (foundation)

Split the single `styles.css` into layered files imported in order so cascade and intent are clear:

```
renderer/styles/
  tokens.css        # :root variables + theme overrides (no selectors that paint)
  base.css          # reset, element defaults, focus-visible, scrollbars, reduced-motion
  components.css     # .btn, .input, .panel, .tab, .menu, .dialog, .toast, .badge, .chip …
  layout.css        # app grid, titlebar, navbar, sidebar, workspace, responsive
```

### 3.1 Primitive + semantic color tokens, with theming

Keep your **primitive** palette, then add a **semantic** layer that components reference. This is what makes light/dark trivial.

```css
:root {
  /* ---- Primitives (raw values; rarely referenced directly) ---- */
  --green-500: #3ecf8e;  --green-600: #34b87e;
  --amber-500: #e8a43a;  --red-500: #ef4444;  --blue-400: #60a5fa;
  --white: #ffffff;      --black: #000000;

  /* ---- Spacing scale (4px base) ---- */
  --space-0: 0;     --space-1: 2px;  --space-2: 4px;  --space-3: 6px;
  --space-4: 8px;   --space-5: 12px; --space-6: 16px; --space-7: 20px;
  --space-8: 24px;  --space-9: 32px; --space-10: 48px;

  /* ---- Typography scale ---- */
  --font-sans: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;
  --font-mono: "SF Mono", "Fira Code", "Cascadia Code", "Consolas", monospace;
  --text-xs: 11px;  --text-sm: 12px;  --text-base: 13px; --text-md: 14px;
  --text-lg: 16px;  --text-xl: 20px;
  --leading-tight: 1.3; --leading-normal: 1.5; --leading-loose: 1.6;
  --weight-regular: 400; --weight-medium: 500; --weight-semibold: 600;

  /* ---- Radius / elevation ---- */
  --radius-xs: 4px; --radius-sm: 6px; --radius-md: 8px; --radius-lg: 12px; --radius-pill: 999px;
  --shadow-sm: 0 1px 2px rgba(0,0,0,.24);
  --shadow-md: 0 4px 12px rgba(0,0,0,.32);
  --shadow-lg: 0 12px 40px rgba(0,0,0,.48);

  /* ---- Motion (with reduced-motion override in base.css) ---- */
  --ease: cubic-bezier(.2,0,.2,1);
  --dur-fast: 90ms; --dur-base: 150ms; --dur-slow: 240ms;

  /* ---- Z-index scale (stop inventing numbers) ---- */
  --z-base: 1; --z-titlebar: 10; --z-dropdown: 100; --z-modal: 1000; --z-toast: 1100;

  /* ---- Layout dims ---- */
  --sidebar-width: 320px; --titlebar-height: 46px; --navbar-height: 44px;
  --control-h-sm: 28px; --control-h-md: 32px; --control-h-lg: 38px;
  --tap-min: 44px; /* minimum interactive target */
}

/* ---- Semantic tokens: dark (default) ---- */
:root, :root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0c0e12;
  --surface-0: #111419; --surface-1: #181b22; --surface-2: #1f232b; --surface-3: #272b34;
  --overlay: rgba(0,0,0,.6);
  --hover-bg: rgba(255,255,255,.04);
  --active-bg: rgba(255,255,255,.08);

  --border: rgba(255,255,255,.08);        /* nudged up from .06 for visibility */
  --border-hover: rgba(255,255,255,.12);
  --border-focus: var(--accent);

  --text: #e6e9ee;
  --text-secondary: #9aa1ad;              /* lighter than #848b97 → AA on surface-1 */
  --text-tertiary: #6b7280;               /* lighter than #555d6a → ~AA for meta text */
  --text-on-accent: #021a0e;

  --accent: var(--green-500); --accent-hover: var(--green-600);
  --accent-subtle: rgba(62,207,142,.10); --accent-muted: rgba(62,207,142,.20);
  --accent-glow: rgba(62,207,142,.25);

  --warning: var(--amber-500); --warning-subtle: rgba(232,164,58,.10);
  --danger: var(--red-500);    --danger-subtle: rgba(239,68,68,.10);
  --info: var(--blue-400);     --info-subtle: rgba(96,165,250,.10);

  --focus-ring: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent-muted);
}

/* ---- Semantic tokens: light ---- */
:root[data-theme="light"] {
  color-scheme: light;
  --bg: #f6f7f9;
  --surface-0: #ffffff; --surface-1: #ffffff; --surface-2: #f1f3f5; --surface-3: #e7eaee;
  --overlay: rgba(15,20,30,.4);
  --hover-bg: rgba(0,0,0,.04); --active-bg: rgba(0,0,0,.07);
  --border: rgba(15,20,30,.12); --border-hover: rgba(15,20,30,.2); --border-focus: var(--accent);
  --text: #1a1f27; --text-secondary: #4b5563; --text-tertiary: #6b7280; --text-on-accent: #042012;
  --accent: var(--green-600); --accent-hover: #2da06d;
  --accent-subtle: rgba(52,184,126,.12); --accent-muted: rgba(52,184,126,.24); --accent-glow: rgba(52,184,126,.22);
  --warning: #b97e16; --warning-subtle: rgba(185,126,22,.12);
  --danger: #d33; --danger-subtle: rgba(221,51,51,.10);
  --info: #2563eb; --info-subtle: rgba(37,99,235,.10);
  --focus-ring: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent-muted);
}

/* Follow the OS when no explicit choice is stored */
@media (prefers-color-scheme: light) {
  :root:not([data-theme]) { /* re-declare the light block here, or set data-theme via JS */ }
}
```

> **Theming control:** set `document.documentElement.dataset.theme = "light" | "dark"`. Default to system (`matchMedia('(prefers-color-scheme: light)')`) and persist the user's choice. This pairs naturally with the app's own `setMediaEmulation` feature — the *chrome* should honor the user's OS theme even while a tab emulates the opposite.

### 3.2 Base layer — the accessibility defaults that are currently missing

```css
/* base.css */
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text);
  font: var(--weight-regular) var(--text-base)/var(--leading-normal) var(--font-sans);
  -webkit-font-smoothing: antialiased; }

/* The single most important fix: a consistent, visible keyboard focus ring. */
:where(button, a, input, textarea, select, summary, [tabindex]):focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
  border-radius: var(--radius-sm);
}
:focus:not(:focus-visible) { outline: none; } /* no ring on mouse click */

/* Respect users who don't want motion. */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}

/* One scrollbar treatment everywhere. */
* { scrollbar-width: thin; scrollbar-color: var(--surface-3) transparent; }
*::-webkit-scrollbar { width: 10px; height: 10px; }
*::-webkit-scrollbar-thumb { background: var(--surface-3); border-radius: var(--radius-pill);
  border: 2px solid transparent; background-clip: padding-box; }

/* Skip link for keyboard users (add <a class="skip-link" href="#viewport-frame">). */
.skip-link { position: fixed; top: var(--space-2); left: var(--space-2); z-index: var(--z-toast);
  padding: var(--space-3) var(--space-5); background: var(--surface-2); color: var(--text);
  border-radius: var(--radius-sm); transform: translateY(-200%); }
.skip-link:focus-visible { transform: none; }
```

---

## 4. Component standards

Each component below specifies the markup, the full state set, and the a11y contract.

### 4.1 Button — one class, variants + sizes + every state

```css
.btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--space-3);
  height: var(--control-h-md); padding: 0 var(--space-5);
  border: 1px solid transparent; border-radius: var(--radius-sm);
  font-size: var(--text-sm); font-weight: var(--weight-medium); white-space: nowrap;
  cursor: pointer; user-select: none; transition: background var(--dur-fast) var(--ease),
  border-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease); }
.btn:disabled, .btn[aria-disabled="true"] { opacity: .5; pointer-events: none; }
.btn[data-busy="true"] { color: transparent; position: relative; }
.btn[data-busy="true"]::after { content: ""; position: absolute; width: 14px; height: 14px;
  border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%;
  color: var(--text); animation: spin .6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.btn--sm { height: var(--control-h-sm); padding: 0 var(--space-4); }
.btn--lg { height: var(--control-h-lg); padding: 0 var(--space-6); }

.btn--primary { background: var(--accent); color: var(--text-on-accent); font-weight: var(--weight-semibold); }
.btn--primary:hover { background: var(--accent-hover); }
.btn--primary:active { background: var(--accent-hover); transform: translateY(.5px); }

.btn--ghost { background: transparent; border-color: var(--border); color: var(--text-secondary); }
.btn--ghost:hover { background: var(--hover-bg); border-color: var(--border-hover); color: var(--text); }

.btn--danger { background: var(--danger-subtle); color: var(--danger); }
.btn--danger:hover { background: var(--danger); color: var(--white); }

.btn--icon { width: var(--control-h-md); padding: 0; } /* square icon button */
```

**Contract:** every `.btn` needs a text label or `aria-label`. Disabled uses the `disabled` attribute (and styling above); loading sets `data-busy="true"` and `aria-busy="true"`. Migrate `btn-primary`→`btn--primary`, `btn-sm`→`btn--sm`, drop `btn-nav` (use `btn--md` default).

### 4.2 Field (input + textarea) with label and error

Inputs today lack labels and inline errors. Standardize a field block:

```html
<div class="field">
  <label class="field__label" for="account-label">Label</label>
  <input class="input" id="account-label" required aria-describedby="account-label-err" />
  <p class="field__error" id="account-label-err" hidden>Required.</p>
</div>
```
```css
.field { display: flex; flex-direction: column; gap: var(--space-2); }
.field__label { font-size: var(--text-xs); font-weight: var(--weight-medium); color: var(--text-secondary); }
.input, .textarea { width: 100%; min-height: var(--control-h-sm); padding: var(--space-2) var(--space-4);
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--surface-1); color: var(--text); font-size: var(--text-sm);
  transition: border-color var(--dur-fast) var(--ease); }
.input:hover, .textarea:hover { border-color: var(--border-hover); }
.input::placeholder { color: var(--text-tertiary); }
.input[aria-invalid="true"] { border-color: var(--danger); }
.field__error { margin: 0; font-size: var(--text-xs); color: var(--danger); }
```
On submit, set `aria-invalid="true"` and unhide the matching `.field__error` instead of silently `return`ing (current `accountForm` behavior). Required fields get a subtle `*` in the label.

### 4.3 Tabs — a real ARIA tablist

The browser tab strip should be a keyboard-navigable tablist:
- Container `role="tablist"` `aria-label="Open tabs"`; each tab `role="tab"` `aria-selected` `tabindex="0|-1"` (roving tabindex). Left/Right arrows move selection; the close button is a nested control with its own `aria-label="Close <title>"`.
- Keep the existing `.tab-pill` visuals; add `:focus-visible` (now free from base.css) and `aria-selected` styling instead of only the `.is-active` class.

### 4.4 Menu (the "Demos" dropdown)

Currently a toggled `[hidden]` div with no semantics. Standard menu:
- Trigger: `aria-haspopup="menu"`, `aria-expanded`, `aria-controls`.
- Menu: `role="menu"`; items `role="menuitem"`.
- Keyboard: `Enter`/`Space`/`ArrowDown` opens and focuses first item; `ArrowUp/Down` cycles; `Esc` closes and returns focus to the trigger; click-outside closes (already implemented). Rename "Demos" to something product-appropriate or move dev demos under a "Developer" affordance.

### 4.5 Dialog — focus management is mandatory

Replace the hand-rolled overlay with the platform `<dialog>` element (free focus trap, `Esc`, top-layer, backdrop) **or** add a small focus-trap helper. Either way the contract is:
1. On open: store `document.activeElement`, move focus to the dialog (first focusable or the primary action).
2. Trap `Tab`/`Shift+Tab` within the dialog.
3. `Esc` closes **dismissable** dialogs; **required** dialogs (approval/handoff) do not close on `Esc`/backdrop — make that explicit with `data-dismissable="false"` rather than the current inverted backdrop check.
4. On close: restore focus to the stored element.

Minimal helper to add under `renderer/ui/dialog.ts`:
```ts
export function openDialog(el: HTMLElement, { dismissable = true } = {}) {
  const prev = document.activeElement as HTMLElement | null;
  el.removeAttribute("hidden");
  const focusables = () => [...el.querySelectorAll<HTMLElement>(
    'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')].filter(f => !f.hasAttribute("disabled"));
  (el.querySelector<HTMLElement>("[data-autofocus]") ?? focusables()[0])?.focus();
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && dismissable) close();
    if (e.key !== "Tab") return;
    const f = focusables(); if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  function close() { el.setAttribute("hidden", ""); el.removeEventListener("keydown", onKey); prev?.focus(); }
  el.addEventListener("keydown", onKey);
  return close;
}
```

### 4.6 Toast / inline status — consistent, ephemeral feedback

Add a global toast region so actions ("Account saved", "Navigation failed") give consistent feedback instead of the lone `#fixture-status` line and swallowed errors.

```html
<div class="toast-region" id="toasts" role="status" aria-live="polite"></div>
```
```css
.toast-region { position: fixed; bottom: var(--space-6); right: var(--space-6);
  z-index: var(--z-toast); display: flex; flex-direction: column; gap: var(--space-3); }
.toast { display: flex; gap: var(--space-3); align-items: center; max-width: 360px;
  padding: var(--space-4) var(--space-5); border: 1px solid var(--border-hover);
  border-radius: var(--radius-md); background: var(--surface-2); box-shadow: var(--shadow-lg);
  font-size: var(--text-sm); animation: toast-in var(--dur-base) var(--ease); }
.toast--error { border-color: var(--danger); }
.toast--success { border-left: 3px solid var(--accent); }
@keyframes toast-in { from { opacity: 0; transform: translateY(8px); } }
```
`role="status"` + `aria-live="polite"` makes screen readers announce them. A `toast(message, kind)` helper appends + auto-removes after ~4s (errors stay until dismissed).

### 4.7 Empty / loading / skeleton states

Define a reusable pattern so lists never render blank:
```css
.empty-state { padding: var(--space-7) var(--space-5); text-align: center;
  color: var(--text-tertiary); font-size: var(--text-sm); }
.skeleton { border-radius: var(--radius-sm); background: linear-gradient(90deg,
  var(--surface-1), var(--surface-2), var(--surface-1)); background-size: 200% 100%;
  animation: shimmer 1.2s infinite; }
@keyframes shimmer { to { background-position: -200% 0; } }
```
Use `.empty-state` for the accounts list (currently renders nothing when empty) and the snapshot/terminal panels; use `.skeleton` while `listTabs()`/`listAccounts()` are in flight.

### 4.8 Badge & chip — already close, just tokenize

Keep `.badge`/`.account-chip`/`.vault-chip`; replace their hardcoded paddings/sizes with the spacing/type tokens and add a `--danger` badge variant for parity with warning/info.

---

## 5. Iconography

Mixed glyph sources today (gradient div, `×`, `&#9662;`, CSS `\25B8`). Standardize on **one inline-SVG icon set** (e.g. Lucide, MIT-licensed) rendered as `currentColor`:
```html
<button class="btn btn--icon" aria-label="Close tab">
  <svg class="icon" width="14" height="14" aria-hidden="true">…</svg>
</button>
```
```css
.icon { display: block; stroke: currentColor; fill: none; stroke-width: 2; }
```
Benefits: consistent weight/size, theme-aware via `currentColor`, accessible (`aria-hidden` on decorative, `aria-label` on the control). Replace the close `×`, the menu caret, the panel chevron, and the brand mark with SVGs at consistent 14/16px sizes.

---

## 6. Accessibility checklist (definition of done)

- [ ] Every interactive element shows a **`:focus-visible`** ring (base.css `--focus-ring`).
- [ ] Dialogs: initial focus, **focus trap**, `Esc` for dismissable ones, focus **restored** on close; `aria-describedby` added.
- [ ] Tab strip is a **tablist** with roving tabindex + arrow keys; close buttons have `aria-label`.
- [ ] Menu has `aria-haspopup/expanded/controls`, `role=menu/menuitem`, arrow-key + `Esc` nav.
- [ ] Toast region is `role="status" aria-live="polite"`; errors are surfaced, never swallowed.
- [ ] Color contrast ≥ **4.5:1** for body text, **3:1** for large text / UI borders (re-check `--text-tertiary`, `--text-secondary`, placeholders) — verify with the app's own `browser_a11y_audit` / element-style contrast tooling pointed at the renderer.
- [ ] `prefers-reduced-motion` disables transitions/animations.
- [ ] Light/dark/system theming works end-to-end via `data-theme`.
- [ ] Landmarks labeled: the two `<nav>`s and `<aside>` get distinct `aria-label`s; add a skip link to the viewport.
- [ ] Minimum 44×44 hit targets for primary controls (tab close is 16px today — enlarge the hit area via padding while keeping the glyph small).

---

## 7. Phased migration plan

Each phase is independently shippable and low-risk (renderer-only; no main-process or agent-API changes).

**Phase 1 — Foundation (½ day).** Split CSS into `tokens/base/components/layout`. Add spacing/type/motion/z-index tokens and the semantic color layer. Add the global `:focus-visible` ring and `prefers-reduced-motion`. *No visual regressions; immediate a11y win.*

**Phase 2 — Tokenize components (1 day).** Replace every magic number and raw `rgba()` in `styles.css` with tokens. Normalize button classes to `btn--*` and add disabled/busy/active states. Add `.field`, `.empty-state`, `.skeleton`.

**Phase 3 — Dialogs + toasts (1 day).** Introduce `renderer/ui/dialog.ts` (focus trap) and `renderer/ui/toast.ts`; convert approval/handoff modals; route `setFixtureStatus`/error paths through toasts. Fix the inverted backdrop-dismiss logic.

**Phase 4 — ARIA widgets (1 day).** Upgrade the tab strip to a tablist and the Demos menu to a real menu, both keyboard-navigable. Add landmark labels + skip link.

**Phase 5 — Theming + icons (1 day).** Add `data-theme` + system detection + persistence; introduce the SVG icon set and replace the ad-hoc glyphs.

**Phase 6 — Polish.** Loading skeletons during bootstrap fetches, consistent hover/active affordances, inline form validation, contrast pass with the in-house a11y audit.

---

## 8. Conventions to keep it consistent going forward

- **Naming:** BEM-lite — `.block`, `.block__element`, `.block--modifier`. State via `is-*`/`aria-*`/`data-*`, never bespoke one-off classes.
- **No literals in components:** colors, spacing, radii, durations, z-index all come from tokens. PR review rejects raw hex/px-color/`rgba()` in `components.css`/`layout.css`.
- **Every interactive element:** accessible name + `:focus-visible` + full state set.
- **Dogfood the platform:** point HelmStack's own `browser_a11y_audit`, `browser_design_tokens`, and element-style contrast tools at the renderer (`http://localhost` dev build) in CI to catch contrast regressions, untokenized colors, and a11y violations in the chrome itself.
