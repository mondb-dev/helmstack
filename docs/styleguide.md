# Design system

The desktop shell's visual language lives in `apps/desktop/src/renderer/styles/`. This page describes how it is organized and lists the tokens. The token tables are generated from `tokens.css`, so they are the actual values.

**Prerequisites:** none. Scope is the shell renderer only; it does not apply to pages being tested.

## Layers

Stylesheets load in this order (see `index.html`):

| File | Holds |
| --- | --- |
| `tokens.css` | Custom properties: scales and the semantic color tokens for both themes |
| `base.css` | Reset, element defaults, keyboard-only focus ring, accessibility defaults |
| `components.css` | Component classes such as `btn`, `field`, `modal`, `sheet`, `popover`, `badge`, `override-chip`, `kv`, `meter`, `toast` and the chat, activity and MCP-install blocks |
| `layout.css` | Window layout: title bar, nav bar, viewport frame, side panel |

Rules:

- Components use semantic `--color-*` tokens and the scales. They do not use raw color values.
- Status color is never the only signal: pair it with an icon or text.
- Status text on tinted backgrounds uses `--color-warning-text` and `--color-danger-text`. Their contrast is asserted in `apps/desktop/test/token-contrast.test.ts` for both themes.

## Theming

The theme is set on the root element as `data-theme="dark"` or `"light"`. The user's choice (`light`, `dark` or `system`) is stored in local storage under `helmstack-theme`; `system` follows `prefers-color-scheme`, defaulting to dark when it is unavailable. The toggle is in the top bar.

## Typography and icons

`--font-sans` starts with Inter and `--font-mono` with JetBrains Mono, each falling back to system fonts. The base size is 13px. Icons are inline SVG paths from the Lucide set in `renderer/ui/icons.ts`, drawn with `currentColor` so they follow the theme.

## Accessibility baseline

The shell has landmarks and a skip link, an ARIA tablist for tabs with roving tabindex, focus-trapped dialogs that return focus to their opener (`renderer/ui/dialog.ts`), and a polite toast region. These behaviors are covered by `landmarks.test.ts`, `roving.test.ts`, `dialog.test.ts` and `toast.test.ts` in `apps/desktop/test`.

## Tokens

### Semantic color tokens

A token with no value in a theme column is not redefined for that theme.

<!-- generated:start tokens-semantic -->
| Token | Dark | Light |
| --- | --- | --- |
| `--color-bg` | `var(--neutral-950)` | `var(--neutral-50)` |
| `--color-surface` | `var(--neutral-850)` | `var(--white)` |
| `--color-surface-sunken` | `var(--neutral-900)` | `var(--neutral-100)` |
| `--color-surface-raised` | `var(--neutral-800)` | `var(--white)` |
| `--color-surface-overlay` | `var(--neutral-700)` | `var(--white)` |
| `--color-border` | `rgba(255, 255, 255, 0.08)` | `rgba(15, 20, 30, 0.12)` |
| `--color-border-strong` | `rgba(255, 255, 255, 0.14)` | `rgba(15, 20, 30, 0.22)` |
| `--color-hover` | `rgba(255, 255, 255, 0.04)` | `rgba(15, 20, 30, 0.04)` |
| `--color-active` | `rgba(255, 255, 255, 0.08)` | `rgba(15, 20, 30, 0.07)` |
| `--color-text` | `#e6e9ee` | `#15191f` |
| `--color-text-secondary` | `#9aa1ad` | `#4b5563` |
| `--color-text-tertiary` | `#808997` | `#5f6672` |
| `--color-text-disabled` | `#565d68` | `#aab0ba` |
| `--color-accent` | `var(--green-400)` | `var(--green-600)` |
| `--color-accent-hover` | `var(--green-500)` | `#2a9566` |
| `--color-accent-active` | `var(--green-600)` | `#23845a` |
| `--color-accent-subtle` | `rgba(62, 207, 142, 0.10)` | `rgba(45, 160, 109, 0.12)` |
| `--color-accent-muted` | `rgba(62, 207, 142, 0.18)` | `rgba(45, 160, 109, 0.22)` |
| `--color-on-accent` | `#04130b` | `var(--white)` |
| `--color-success` | `var(--green-400)` | `var(--green-600)` |
| `--color-success-subtle` | `rgba(62, 207, 142, 0.10)` | `rgba(45, 160, 109, 0.12)` |
| `--color-warning` | `var(--amber-400)` | `#b97e16` |
| `--color-warning-subtle` | `rgba(232, 164, 58, 0.10)` | `rgba(185, 126, 22, 0.12)` |
| `--color-warning-border` | `rgba(232, 164, 58, 0.16)` | `rgba(185, 126, 22, 0.24)` |
| `--color-on-warning` | `#1a1206` | `#ffffff` |
| `--color-danger` | `var(--red-400)` | `#d32f2f` |
| `--color-danger-subtle` | `rgba(239, 68, 68, 0.10)` | `rgba(211, 47, 47, 0.10)` |
| `--color-on-danger` | `#ffffff` | `#ffffff` |
| `--color-warning-text` | `var(--amber-400)` | `#7f5200` |
| `--color-danger-text` | `var(--red-300)` | `#b42318` |
| `--color-info` | `var(--blue-400)` | `#2563eb` |
| `--color-info-subtle` | `rgba(96, 165, 250, 0.10)` | `rgba(37, 99, 235, 0.10)` |
| `--color-overlay` | `rgba(0, 0, 0, 0.6)` | `rgba(15, 20, 30, 0.45)` |
| `--focus-ring` | `0 0 0 2px var(--color-bg), 0 0 0 4px rgba(62, 207, 142, 0.55)` | `0 0 0 2px var(--color-bg), 0 0 0 4px rgba(45, 160, 109, 0.5)` |
<!-- generated:end -->

### Scales

<!-- generated:start tokens-scales -->
#### Neutral and status colors

| Token | Value |
| --- | --- |
| `--neutral-950` | `#0a0c10` |
| `--neutral-900` | `#111419` |
| `--neutral-850` | `#181b22` |
| `--neutral-800` | `#1f232b` |
| `--neutral-750` | `#272b34` |
| `--neutral-700` | `#313742` |
| `--neutral-600` | `#454c58` |
| `--neutral-500` | `#6b7280` |
| `--neutral-400` | `#9aa1ad` |
| `--neutral-300` | `#c3c8d0` |
| `--neutral-200` | `#dfe2e7` |
| `--neutral-100` | `#eef0f3` |
| `--neutral-50` | `#f7f8fa` |
| `--white` | `#ffffff` |
| `--black` | `#000000` |
| `--green-300` | `#6bdba8` |
| `--green-400` | `#3ecf8e` |
| `--green-500` | `#34b87e` |
| `--green-600` | `#2da06d` |
| `--amber-400` | `#e8a43a` |
| `--red-300` | `#fca5a5` |
| `--red-400` | `#ef4444` |
| `--blue-400` | `#60a5fa` |
| `--violet-400` | `#a78bfa` |

#### Spacing

| Token | Value |
| --- | --- |
| `--space-0` | `0` |
| `--space-1` | `2px` |
| `--space-2` | `4px` |
| `--space-3` | `6px` |
| `--space-4` | `8px` |
| `--space-5` | `12px` |
| `--space-6` | `16px` |
| `--space-7` | `20px` |
| `--space-8` | `24px` |
| `--space-9` | `32px` |
| `--space-10` | `48px` |
| `--space-11` | `64px` |

#### Typography

| Token | Value |
| --- | --- |
| `--font-sans` | `"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif` |
| `--font-mono` | `"JetBrains Mono", "SF Mono", "Cascadia Code", "Fira Code", ui-monospace, Consolas, monospace` |
| `--text-2xl` | `24px` |
| `--text-xl` | `20px` |
| `--text-lg` | `15px` |
| `--text-base` | `13px` |
| `--text-sm` | `12px` |
| `--text-xs` | `11px` |
| `--leading-tight` | `1.25` |
| `--leading-normal` | `1.5` |
| `--weight-regular` | `400` |
| `--weight-medium` | `500` |
| `--weight-semibold` | `600` |
| `--weight-bold` | `700` |

#### Radius and elevation

| Token | Value |
| --- | --- |
| `--radius-xs` | `4px` |
| `--radius-sm` | `6px` |
| `--radius-md` | `8px` |
| `--radius-lg` | `12px` |
| `--radius-pill` | `999px` |
| `--shadow-sm` | `0 1px 2px rgba(0, 0, 0, 0.24)` |
| `--shadow-md` | `0 6px 20px rgba(0, 0, 0, 0.34)` |
| `--shadow-lg` | `0 16px 48px rgba(0, 0, 0, 0.50)` |
| `--shadow-accent-sm` | `0 2px 8px rgba(62, 207, 142, 0.20)` |
| `--shadow-accent-glow` | `0 0 12px rgba(62, 207, 142, 0.30)` |

#### Motion

| Token | Value |
| --- | --- |
| `--ease` | `cubic-bezier(0.2, 0, 0.2, 1)` |
| `--ease-out` | `cubic-bezier(0, 0, 0.2, 1)` |
| `--dur-fast` | `90ms` |
| `--dur-base` | `150ms` |
| `--dur-slow` | `240ms` |

#### Layering and sizes

| Token | Value |
| --- | --- |
| `--z-base` | `1` |
| `--z-titlebar` | `10` |
| `--z-sticky` | `50` |
| `--z-dropdown` | `100` |
| `--z-overlay` | `900` |
| `--z-modal` | `1000` |
| `--z-toast` | `1100` |
| `--z-tooltip` | `1200` |
| `--titlebar-height` | `46px` |
| `--navbar-height` | `44px` |
| `--sidebar-width` | `320px` |
| `--control-sm` | `28px` |
| `--control-md` | `32px` |
| `--control-lg` | `38px` |
| `--tap-min` | `44px` |
<!-- generated:end -->

## Changing the system

1. Edit `tokens.css`, not a component.
2. Run `npm run docs:generate` to refresh this page.
3. Run `npm test`: the contrast test fails if a status text token loses AA contrast.

## Verify it worked

`npm run docs:check` passes, and the app renders in both themes (toggle with the sun/moon button).
