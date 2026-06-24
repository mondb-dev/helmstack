# HelmStack Style Guide

**The single source of truth for the desktop shell's look & feel.** Every value
here is *decided* — pick from these tokens, don't invent new ones. Where this
guide and [ui-ux-guide.md](ui-ux-guide.md) overlap, **this file wins**; the
UI/UX guide is the rationale, the gap analysis, and the phased migration plan,
this is the system you build to.

Scope: `apps/desktop/src/renderer/`. Renderer-only — no main-process or agent-API
changes. Target: **WCAG 2.1 AA**.

---

## 0. The decisions, in one breath

- **Brand accent:** HelmStack green `#3ecf8e` on a cool near-black neutral ramp.
- **Type:** **Inter** for UI, **JetBrains Mono** for code/data/metrics. 13px base.
- **Icons:** **Lucide** (MIT), inline SVG, `currentColor`, 16px default.
- **Theme:** dark by default, full light theme, follows the OS, user-overridable.
- **Shape language:** 6px default radius, subtle 1px borders, low-chroma surfaces, restrained shadows reserved for overlays.
- **Density:** compact (this is a developer instrument), but never below AA contrast or 44px hit targets for primary actions.

---

## 1. Foundations

### 1.1 Color

A **3-tier** system: *primitives* (raw ramps, rarely referenced), *semantic*
tokens (what components use), themed for dark/light. Components reference **only
semantic tokens**.

#### Neutral ramp (cool gray, slightly blue — matches the existing chrome)

| Token | Hex | Role |
|---|---|---|
| `--neutral-950` | `#0a0c10` | app background |
| `--neutral-900` | `#111419` | base surface |
| `--neutral-850` | `#181b22` | panel / card |
| `--neutral-800` | `#1f232b` | raised panel, inputs |
| `--neutral-750` | `#272b34` | hover surface, dividers |
| `--neutral-700` | `#313742` | menus, popovers (highest surface) |
| `--neutral-600` | `#454c58` | strong borders, disabled fills |
| `--neutral-500` | `#6b7280` | — |
| `--neutral-400` | `#9aa1ad` | secondary text (dark) |
| `--neutral-300` | `#c3c8d0` | — |
| `--neutral-200` | `#dfe2e7` | borders (light theme) |
| `--neutral-100` | `#eef0f3` | surface (light theme) |
| `--neutral-50`  | `#f7f8fa` | background (light theme) |
| `--white` | `#ffffff` · `--black` | `#000000` | |

#### Accent (HelmStack green) & status — primitives

| Token | Hex | | Token | Hex |
|---|---|---|---|---|
| `--green-300` | `#6bdba8` | | `--amber-400` | `#e8a43a` |
| `--green-400` | `#3ecf8e` (brand) | | `--red-400` | `#ef4444` |
| `--green-500` | `#34b87e` | | `--blue-400` | `#60a5fa` |
| `--green-600` | `#2da06d` | | `--violet-400` | `#a78bfa` |

#### Semantic tokens — these are what you use

```css
/* DARK (default) */
--color-bg:            var(--neutral-950);
--color-surface:       var(--neutral-850);   /* panels, cards */
--color-surface-sunken:var(--neutral-900);   /* code/terminal wells */
--color-surface-raised:var(--neutral-800);   /* inputs, list rows */
--color-surface-overlay:var(--neutral-700);  /* menus, popovers, toasts */

--color-border:        rgba(255,255,255,.08);
--color-border-strong: rgba(255,255,255,.14);
--color-hover:         rgba(255,255,255,.04);
--color-active:        rgba(255,255,255,.08);

--color-text:          #e6e9ee;              /* 14.2:1 on surface — primary       */
--color-text-secondary:#9aa1ad;              /* 6.6:1 — labels, secondary (AA)    */
--color-text-tertiary: #808997;              /* 4.9:1 — meta, timestamps (AA)     */
--color-text-disabled: #565d68;              /* 2.6:1 — non-essential/disabled ONLY (exempt from AA) */

--color-accent:        var(--green-400);
--color-accent-hover:  var(--green-500);
--color-accent-active: var(--green-600);
--color-accent-subtle: rgba(62,207,142,.10);
--color-accent-muted:  rgba(62,207,142,.18);
--color-on-accent:     #04130b;              /* text on accent fill — ≥ 7:1  */

--color-success: var(--green-400); --color-success-subtle: rgba(62,207,142,.10);
--color-warning: var(--amber-400); --color-warning-subtle: rgba(232,164,58,.10); --color-on-warning:#1a1206;
--color-danger:  var(--red-400);   --color-danger-subtle:  rgba(239,68,68,.10);  --color-on-danger:#ffffff;
--color-info:    var(--blue-400);  --color-info-subtle:    rgba(96,165,250,.10);

--focus-ring: 0 0 0 2px var(--color-bg), 0 0 0 4px rgba(62,207,142,.55);
```

```css
/* LIGHT — :root[data-theme="light"] */
--color-bg:            var(--neutral-50);
--color-surface:       #ffffff;
--color-surface-sunken:var(--neutral-100);
--color-surface-raised:#ffffff;
--color-surface-overlay:#ffffff;
--color-border:        rgba(15,20,30,.12);
--color-border-strong: rgba(15,20,30,.22);
--color-hover:         rgba(15,20,30,.04);
--color-active:        rgba(15,20,30,.07);
--color-text:          #15191f;
--color-text-secondary:#4b5563;
--color-text-tertiary: #69707c;
--color-text-disabled: #aab0ba;
--color-accent:        var(--green-600);     /* fills/borders/icons on white — 3:1+ */
--color-accent-hover:  #2a9566;
--color-accent-active: #23845a;              /* use THIS for green *text* on white — 4.65:1 (AA) */
--color-accent-subtle: rgba(45,160,109,.12);
--color-accent-muted:  rgba(45,160,109,.22);
--color-on-accent:     #ffffff;
--color-success: var(--green-600); --color-warning:#b97e16; --color-danger:#d32f2f; --color-info:#2563eb;
--focus-ring: 0 0 0 2px var(--color-bg), 0 0 0 4px rgba(45,160,109,.5);
```

**Color rules**
1. **Never** put a raw hex/`rgba()` in a component rule — only `var(--color-*)`. A value used twice becomes a token.
2. **Contrast targets:** body text ≥ 4.5:1, large text (≥18px/14px-bold) & UI borders/icons ≥ 3:1. The three text tokens above are chosen to pass on `--color-surface`; re-verify if you put text on a different surface.
3. **Status color is never the only signal** — pair with an icon or text (color-blind safe). A red border *and* an error message; a green check *and* "Passed".
4. **Accent is for one primary action / selection per view.** Don't paint large areas green; use `--color-accent-subtle/-muted` for tints.
5. **Elevation = surface step, not just shadow.** Going "up" a layer means the next `--color-surface-*` token; shadows are reserved for true overlays (§1.4).

### 1.2 Typography

**Fonts (decided).** Bundle the woff2s under `renderer/fonts/` and `@font-face`
them; the system stack is the graceful fallback if a glyph/file is missing.

```css
--font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
--font-mono: "JetBrains Mono", "SF Mono", "Cascadia Code", "Fira Code", ui-monospace, Consolas, monospace;
```

- **Inter** (OFL) — all UI text. Use `font-feature-settings: "cv05","ss03"` optional; enable `"tnum"` for numbers in tables/metrics.
- **JetBrains Mono** (OFL) — code, JSON, selectors, IDs, the terminal, and **all numeric metrics** (scores, %, ms, byte counts) so columns align.

**Type scale (decided).** Role-named, not size-named — pick by meaning.

| Role | Token | Size / line-height / weight | Use |
|---|---|---|---|
| Display | `--type-display` | 24 / 1.2 / 700 | empty-state hero, onboarding only |
| Title | `--type-title` | 20 / 1.25 / 600 | modal titles, page titles |
| Heading | `--type-heading` | 15 / 1.3 / 600 | panel headers, section titles |
| Body | `--type-body` | 13 / 1.5 / 400 | **default** |
| Body-strong | `--type-body-strong` | 13 / 1.5 / 500 | emphasis inline |
| Label | `--type-label` | 12 / 1.4 / 500 | form labels, button text |
| Caption | `--type-caption` | 11 / 1.4 / 500 | meta, timestamps, tab subtitles |
| Eyebrow | `--type-eyebrow` | 11 / 1.4 / 600, `letter-spacing:.04em`, UPPERCASE | section kickers |
| Code | `--type-code` | 12 / 1.5 / 400, `--font-mono` | inline code, IDs, values |

```css
--text-2xl:24px; --text-xl:20px; --text-lg:15px; --text-base:13px;
--text-sm:12px; --text-xs:11px;
--leading-tight:1.25; --leading-normal:1.5;
--weight-regular:400; --weight-medium:500; --weight-semibold:600; --weight-bold:700;
```

**Rules:** base body is **13px** (this is an instrument, density matters). Never
go below **11px**. One weight jump signals hierarchy — don't stack size + weight
+ color all at once. Numerals in any tabular/metric context get
`font-variant-numeric: tabular-nums`.

### 1.3 Spacing & layout

**4px base scale** — all padding, margins, and gaps come from here:

```css
--space-0:0; --space-1:2px; --space-2:4px; --space-3:6px; --space-4:8px;
--space-5:12px; --space-6:16px; --space-7:20px; --space-8:24px;
--space-9:32px; --space-10:48px; --space-11:64px;
```

- Component internal padding: `--space-4`/`--space-5`. Section gaps: `--space-6`. Page gutters: `--space-7`.
- **Layout dims:** `--titlebar-h:46px`, `--navbar-h:44px`, `--sidebar-w:320px`.
- **Density:** control heights `--control-sm:28px`, `--control-md:32px` (default), `--control-lg:38px`; minimum interactive target `--tap-min:44px` (enlarge hit area with padding, keep the glyph small).
- App grid: titlebar (fixed) → navbar (fixed) → `[sidebar | workspace]`. Sidebar collapses below `900px`; panels stack.

### 1.4 Radius & elevation

```css
--radius-xs:4px;  /* badges, chips, small insets */
--radius-sm:6px;  /* DEFAULT — buttons, inputs, list rows */
--radius-md:8px;  /* panels, cards, toasts */
--radius-lg:12px; /* dialogs, large surfaces */
--radius-pill:999px;
```

Shadows are **only for things that float above the page** (menus, toasts,
dialogs) — flat surfaces use a border + surface step, never a shadow.

```css
--shadow-sm:0 1px 2px rgba(0,0,0,.24);    /* popovers */
--shadow-md:0 6px 20px rgba(0,0,0,.34);   /* menus, toasts */
--shadow-lg:0 16px 48px rgba(0,0,0,.50);  /* dialogs */
```

### 1.5 Motion

```css
--ease:cubic-bezier(.2,0,.2,1);  --ease-out:cubic-bezier(0,0,.2,1);
--dur-fast:90ms;   /* hover, color, small state */
--dur-base:150ms;  /* enter/leave, expand */
--dur-slow:240ms;  /* dialogs, large moves */
```

Animate **opacity** and **transform** only (cheap, smooth). Always honor
reduced-motion (base layer kills durations). Motion clarifies cause→effect; it's
never decoration.

### 1.6 Z-index (stop inventing numbers)

```css
--z-base:1; --z-titlebar:10; --z-sticky:50; --z-dropdown:100;
--z-overlay:900; --z-modal:1000; --z-toast:1100; --z-tooltip:1200;
```

### 1.7 Iconography

**Lucide** (MIT), inline SVG, no icon font. One set, one weight.

```html
<button class="btn btn--icon" aria-label="Close tab">
  <svg class="icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">…</svg>
</button>
```
```css
.icon { display:block; width:1em; height:1em; stroke:currentColor; fill:none;
  stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
.icon--sm{width:14px;height:14px} .icon--md{width:16px;height:16px} .icon--lg{width:20px;height:20px}
```

- **Sizes:** 14px in dense controls, **16px default**, 20px for prominent/empty-state.
- **Color:** always `currentColor` (theme-aware for free).
- **A11y:** decorative icons `aria-hidden="true"`; icon-only controls require `aria-label`. Never convey meaning by icon alone without a label/tooltip.
- **Canonical mappings:** close→`x`, add→`plus`, menu caret→`chevron-down`, expand→`chevron-right`, navigate/run→`play`, stop→`square`, inspect→`crosshair`/`mouse-pointer-2`, screenshot→`camera`, copy→`copy`, success→`check`, warning→`triangle-alert`, error→`circle-x`, info→`info`, settings→`settings`. Replace the current gradient brand div, `×`, `&#9662;`, and CSS `\25B8` glyphs.

---

## 2. Token reference (copy-paste `tokens.css`)

Lay the renderer CSS out as four cascade-ordered files; this is the first file:

```
renderer/styles/
  tokens.css      # everything in §1 — :root + [data-theme] (no painting selectors)
  base.css        # reset, element defaults, :focus-visible, scrollbars, reduced-motion, skip link
  components.css  # §3 — every component + all its states
  layout.css      # app grid, titlebar, navbar, sidebar, workspace, responsive
```

`tokens.css` = the primitive ramps (§1.1) + the spacing/type/radius/shadow/motion/z
scales (§1.3–1.6) under `:root`, then the **semantic** dark block under
`:root, :root[data-theme="dark"]` and the **light** block under
`:root[data-theme="light"]` (§1.1). Theme is set with
`document.documentElement.dataset.theme`; default to the OS via
`matchMedia('(prefers-color-scheme: light)')` and persist the user's choice.

---

## 3. Components

Each spec lists markup, the **full state set** (default · hover · active ·
focus-visible · disabled · busy · selected · error where relevant), and the a11y
contract. Naming is **BEM-lite**: `.block`, `.block__el`, `.block--modifier`;
state via `aria-*` / `data-*` / `is-*`.

### 3.1 Button

Variants `--primary` `--ghost` `--danger` `--icon`; sizes `--sm` `--md`(default) `--lg`.
```css
.btn{display:inline-flex;align-items:center;justify-content:center;gap:var(--space-3);
  height:var(--control-md);padding:0 var(--space-5);border:1px solid transparent;
  border-radius:var(--radius-sm);font:var(--weight-medium) var(--text-sm)/1 var(--font-sans);
  white-space:nowrap;cursor:pointer;user-select:none;
  transition:background var(--dur-fast) var(--ease),border-color var(--dur-fast) var(--ease),color var(--dur-fast) var(--ease)}
.btn:disabled,.btn[aria-disabled=true]{opacity:.5;pointer-events:none}
.btn[aria-busy=true]{color:transparent;position:relative}
.btn[aria-busy=true]::after{content:"";position:absolute;width:14px;height:14px;border:2px solid currentColor;
  border-top-color:transparent;border-radius:50%;color:var(--color-text);animation:spin .6s linear infinite}
.btn--sm{height:var(--control-sm);padding:0 var(--space-4)} .btn--lg{height:var(--control-lg);padding:0 var(--space-6)}
.btn--primary{background:var(--color-accent);color:var(--color-on-accent);font-weight:var(--weight-semibold)}
.btn--primary:hover{background:var(--color-accent-hover)} .btn--primary:active{background:var(--color-accent-active)}
.btn--ghost{background:transparent;border-color:var(--color-border);color:var(--color-text-secondary)}
.btn--ghost:hover{background:var(--color-hover);border-color:var(--color-border-strong);color:var(--color-text)}
.btn--danger{background:var(--color-danger-subtle);color:var(--color-danger)}
.btn--danger:hover{background:var(--color-danger);color:var(--color-on-danger)}
.btn--icon{width:var(--control-md);padding:0}
@keyframes spin{to{transform:rotate(360deg)}}
```
**Contract:** every button has a text label or `aria-label`. Loading sets
`aria-busy="true"`. One `--primary` per view. Migrate the legacy
`btn-primary`/`btn-sm`/`btn-nav` to `btn btn--primary` / `btn--sm` / `btn` (default).

### 3.2 Field (input · textarea · select)

```html
<div class="field">
  <label class="field__label" for="x">Label</label>
  <input class="input" id="x" aria-describedby="x-err" />
  <p class="field__error" id="x-err" hidden>Required.</p>
</div>
```
```css
.field{display:flex;flex-direction:column;gap:var(--space-2)}
.field__label{font:var(--weight-medium) var(--text-sm)/1.4 var(--font-sans);color:var(--color-text-secondary)}
.input,.textarea,.select{width:100%;min-height:var(--control-md);padding:var(--space-2) var(--space-4);
  border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-surface-raised);
  color:var(--color-text);font:var(--text-sm)/1.5 var(--font-sans);transition:border-color var(--dur-fast) var(--ease)}
.input:hover,.textarea:hover,.select:hover{border-color:var(--color-border-strong)}
.input::placeholder{color:var(--color-text-tertiary)}
.input[aria-invalid=true]{border-color:var(--color-danger)}
.field__error{margin:0;font:var(--text-xs)/1.4 var(--font-sans);color:var(--color-danger)}
.field--required .field__label::after{content:" *";color:var(--color-danger)}
```
On submit: set `aria-invalid` + unhide `.field__error` — never silently `return`.
Mono inputs (selector, URL, token) use `font-family:var(--font-mono)`.

### 3.3 Tabs → ARIA tablist

Container `role="tablist" aria-label="Open tabs"`; each tab `role="tab"
aria-selected tabindex="0|-1"` (roving). ←/→ move selection; the close control is
a nested button with `aria-label="Close <title>"`. Keep the `.tab` pill visuals;
selection styling keys off `aria-selected`, not a bespoke `.is-active`. Subtitle
uses `--type-caption` / `--color-text-tertiary`.

### 3.4 Menu (dropdown)

Trigger `aria-haspopup="menu" aria-expanded aria-controls`; menu `role="menu"`,
items `role="menuitem"`. `Enter`/`Space`/`↓` opens + focuses first; `↑/↓` cycle;
`Esc` closes + restores focus; click-outside closes. Surface =
`--color-surface-overlay` + `--shadow-md` + `--radius-md`.

### 3.5 Dialog

Use the platform `<dialog>` (free focus trap, `Esc`, top-layer) **or** the
`renderer/ui/dialog.ts` focus-trap helper. Contract: store focus → move into
dialog (`[data-autofocus]` or first focusable) → trap Tab → restore on close.
**Required** dialogs (approval/handoff) set `data-dismissable="false"` and do
**not** close on `Esc`/backdrop — make it explicit (replaces the current inverted
backdrop check). Surface `--color-surface-overlay`, `--radius-lg`, `--shadow-lg`,
backdrop `--color-overlay`.

### 3.6 Toast

```html
<div class="toast-region" id="toasts" role="status" aria-live="polite"></div>
```
`role="status" aria-live="polite"`; `toast(msg, kind)` appends + auto-removes
after ~4s (errors persist until dismissed). Variants `--success` (accent left
border), `--warning`, `--error` (danger border). Surface
`--color-surface-overlay` + `--shadow-md`. **All** action results and errors flow
through here — replace the lone `#fixture-status` line and every swallowed
`catch`.

### 3.7 Badge & chip

Status pills: `--success` `--warning` `--danger` `--info` `--neutral`. Built from
`--color-*-subtle` background + the matching solid color text, `--radius-xs`,
`--type-caption`. Always include a label (and an icon when it's the primary
signal). Add the missing `--danger` variant for parity.

### 3.8 Data table  *(new — the app is data-heavy)*

For tab lists, accounts, coverage results, focus order, etc.
```css
.table{width:100%;border-collapse:collapse;font:var(--text-sm)/1.5 var(--font-sans)}
.table th{position:sticky;top:0;background:var(--color-surface);text-align:left;
  font:var(--type-eyebrow);color:var(--color-text-tertiary);padding:var(--space-3) var(--space-4);
  border-bottom:1px solid var(--color-border)}
.table td{padding:var(--space-3) var(--space-4);border-bottom:1px solid var(--color-border);color:var(--color-text-secondary)}
.table tr:hover td{background:var(--color-hover)}
.table .num{font-family:var(--font-mono);font-variant-numeric:tabular-nums;text-align:right;color:var(--color-text)}
```
No zebra stripes (use hairline borders); numbers right-aligned + mono; header is
a sticky eyebrow row.

### 3.9 Key-value / definition list  *(new — perception fields, metadata)*

```css
.kv{display:grid;grid-template-columns:max-content 1fr;gap:var(--space-2) var(--space-5)}
.kv__key{font:var(--type-caption);color:var(--color-text-tertiary)}
.kv__val{font:var(--text-sm)/1.5 var(--font-mono);color:var(--color-text);overflow-wrap:anywhere}
```
Use for `selector → value`, perf vitals, request headers, account fields. Keys
are captions; values are mono.

### 3.10 Stat tile & score / meter  *(new — scores, coverage %, CWV)*

```css
.stat{display:flex;flex-direction:column;gap:var(--space-1)}
.stat__value{font:var(--weight-semibold) var(--text-xl)/1 var(--font-mono);font-variant-numeric:tabular-nums;color:var(--color-text)}
.stat__label{font:var(--type-caption);color:var(--color-text-tertiary)}
.meter{height:6px;border-radius:var(--radius-pill);background:var(--color-surface-raised);overflow:hidden}
.meter__fill{height:100%;border-radius:inherit;background:var(--color-accent);transition:width var(--dur-base) var(--ease)}
.meter[data-level=warn] .meter__fill{background:var(--color-warning)}
.meter[data-level=bad]  .meter__fill{background:var(--color-danger)}
```
Thresholds map to semantic colors: good→success, warn→warning, bad→danger
(e.g. a11y score ≥90 good / ≥70 warn / else bad; coverage % similarly). Always
show the **number** next to the meter — color is a secondary cue. Give the meter
`role="meter" aria-valuenow/min/max`.

### 3.11 Code / JSON block  *(formalize existing `.code-block`)*

```css
.code{font:var(--type-code);background:var(--color-surface-sunken);color:var(--color-text);
  border:1px solid var(--color-border);border-radius:var(--radius-md);padding:var(--space-4) var(--space-5);
  overflow:auto;white-space:pre;tab-size:2}
.code__key{color:var(--color-info)} .code__str{color:var(--color-accent)}
.code__num{color:var(--color-warning)} .code__punct{color:var(--color-text-tertiary)}
```
Sunken surface, mono, horizontal scroll (never wrap code). Optional minimal
syntax tints reuse semantic colors. A **copy** button (icon, top-right) on every
code block.

### 3.12 Terminal / agent log  *(formalize existing `.terminal`)*

```css
.terminal{font:var(--type-code);background:var(--color-surface-sunken);color:var(--color-text-secondary);
  padding:var(--space-4) var(--space-5);overflow:auto}
.terminal__line{display:flex;gap:var(--space-4)}
.terminal__time{color:var(--color-text-tertiary);font-variant-numeric:tabular-nums;flex:none}
.terminal__line--system{color:var(--color-text-secondary)}
.terminal__line--agent{color:var(--color-text)}
.terminal__line--ai{color:var(--color-info)}
.terminal__line--error{color:var(--color-danger)}
.terminal__line--nav{color:var(--color-accent)}
```
Level → semantic color (the renderer's `appendTerminal` levels: system / agent /
ai / error / nav). Timestamp is a tertiary tabular caption.

### 3.13 Empty · loading · skeleton  *(lists must never render blank)*

```css
.empty-state{padding:var(--space-8) var(--space-5);text-align:center;color:var(--color-text-tertiary);
  font:var(--text-sm)/1.5 var(--font-sans);display:flex;flex-direction:column;align-items:center;gap:var(--space-4)}
.empty-state .icon{width:24px;height:24px;color:var(--color-text-disabled)}
.skeleton{border-radius:var(--radius-sm);background:linear-gradient(90deg,var(--color-surface),var(--color-surface-raised),var(--color-surface));
  background-size:200% 100%;animation:shimmer 1.2s infinite}
@keyframes shimmer{to{background-position:-200% 0}}
```
Use `.empty-state` for the accounts/vault/snapshot panels (today they render
nothing when empty); `.skeleton` while `listTabs()`/`listAccounts()`/captures are
in flight; an inline error row (danger icon + retry) when a fetch fails.

---

## 4. Patterns

- **Feedback:** every action → visible result within ~100ms (optimistic state +
  toast on settle). Destructive actions confirm in a dialog. Long operations
  (coverage reload, trace) show `aria-busy` on the trigger + a toast on completion.
- **Forms:** label every field; validate on submit and on blur for touched
  fields; show inline errors (§3.2); disable submit only while in-flight, not to
  signal invalidity (explain instead).
- **Data display:** tables for homogeneous rows, key-value for one object's
  fields, stat tiles + meters for scores/metrics, code blocks for raw payloads.
  Truncate long values with a tooltip/expand, never overflow the layout.
- **Navigation:** the tab rail is the primary nav; the address bar drives the
  active tab; the sidebar is inspection. Keep these three regions distinct and
  labeled.
- **Overlays:** menu → popover → dialog in ascending modality; only dialogs trap
  focus and block the page.

## 5. Content & voice

- **Sentence case** everywhere (buttons, titles, menus) — not Title Case, not
  ALL CAPS (except the eyebrow style).
- **Action-first buttons:** "Save account", "Run sketch", "Approve" — verb +
  object, not "OK"/"Submit".
- **Errors say what + how to fix:** "Couldn't reach the dev server on :3000 —
  is it running?" not "Error".
- **Consistent nouns:** Tab, Sketch, Approval, Handoff, Snapshot, Perception —
  capitalize product concepts; don't synonym-swap.
- **No jargon-as-drama**, no emoji in product chrome, numbers with units
  (`247 ms`, `16.3% used`, `192 KB`).

## 6. Accessibility (baked in — definition of done)

- [ ] Every interactive element has a visible **`:focus-visible`** ring (`--focus-ring` in base.css).
- [ ] **Contrast:** body ≥ 4.5:1, large/UI ≥ 3:1 — verified with the app's own `browser_a11y_audit` / element-style contrast tooling pointed at the renderer.
- [ ] **Dialogs:** initial focus, focus **trap**, `Esc` for dismissable, focus **restored** on close, `aria-describedby` set.
- [ ] **Tablist:** roving tabindex + arrow keys; close buttons have `aria-label`.
- [ ] **Menus:** `aria-haspopup/expanded/controls`, `role=menu/menuitem`, arrow + `Esc`.
- [ ] **Status is never color-only** (icon/text pair).
- [ ] **Feedback** region is `role="status" aria-live="polite"`; no swallowed errors.
- [ ] `prefers-reduced-motion` disables transitions/animations.
- [ ] **Theming** (light/dark/system) works end-to-end via `data-theme`.
- [ ] **Landmarks** labeled (both `<nav>`s + `<aside>`); a **skip link** to the viewport.
- [ ] Primary controls meet **44×44** hit area (enlarge padding, keep glyph small — the 16px tab-close especially).

## 7. Do / Don't

| Do | Don't |
|---|---|
| `var(--color-accent)` | `#3ecf8e` in a component rule |
| `gap:var(--space-5)` | `gap:12px` |
| `--type-caption` for meta | a new 10px hardcoded size |
| Lucide `<svg>` + `aria-label` | `×` / `&#9662;` / CSS glyph |
| One `--primary` button per view | three green buttons competing |
| Mono + `tabular-nums` for metrics | proportional digits in a table |
| Icon **and** color for status | red-only / green-only signal |
| Toast every result | swallow it in `catch {}` |

## 8. Governance

- **PR review rejects** raw hex / `px` colors / `rgba()` / one-off magic numbers
  in `components.css` & `layout.css`. New value used twice → promote to a token here.
- **Extending the system:** add the token to §1/§2, document the component in §3,
  then use it — not the other way round.
- **Dogfood:** point HelmStack's own `browser_a11y_audit`, `browser_design_tokens`,
  and element-style contrast tools at the renderer dev build in CI to catch
  contrast regressions, untokenized colors, and a11y violations in the chrome itself.
- **Source of truth:** this file. The [ui-ux-guide.md](ui-ux-guide.md) explains
  *why* and *how to migrate* (its phased plan still applies); when they disagree,
  this guide's decided values win.
```
