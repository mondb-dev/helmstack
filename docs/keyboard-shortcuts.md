# Keyboard shortcuts

The desktop app's shortcuts, as registered in the application menu and the in-page key routing. Press `Cmd/Ctrl+/` inside the app to open the same list.

The tables below are generated from `packages/shared/src/shortcuts.ts`. Run `npm run docs:generate` after changing that file.

<!-- generated:start shortcuts -->
### Tabs

| Action | macOS | Windows and Linux |
| --- | --- | --- |
| New tab | ⌘T | Ctrl+T |
| Close tab | ⌘W | Ctrl+W, Ctrl+F4 |
| Reopen closed tab | ⌘⇧T | Ctrl+Shift+T |
| Close window | ⌘⇧W | Ctrl+Shift+W |
| Next tab | ⌃⇥, ⌘⌥→, ⌘⇧] | Ctrl+Tab, Ctrl+PgDn |
| Previous tab | ⌃⇧⇥, ⌘⌥←, ⌘⇧[ | Ctrl+Shift+Tab, Ctrl+PgUp |
| Select tab 1–8 | ⌘1–8 | Ctrl+1–8 |
| Select last tab | ⌘9 | Ctrl+9 |

### Navigation

| Action | macOS | Windows and Linux |
| --- | --- | --- |
| Back | ⌘[ | Alt+Left |
| Forward | ⌘] | Alt+Right |
| Reload | ⌘R, F5 | Ctrl+R, F5 |
| Hard reload (bypass cache) | ⌘⇧R | Ctrl+Shift+R, Ctrl+F5, Shift+F5 |
| Stop loading | Esc | Esc |
| Focus address bar | ⌘L | Ctrl+L, Alt+D, F6 |

### Page

| Action | macOS | Windows and Linux |
| --- | --- | --- |
| Print… | ⌘P | Ctrl+P |
| Developer tools for the page | ⌘⌥I, F12 | F12, Ctrl+Shift+I |

### Find

| Action | macOS | Windows and Linux |
| --- | --- | --- |
| Find in page | ⌘F | Ctrl+F |
| Find next | ⌘G | F3, Ctrl+G |
| Find previous | ⌘⇧G | Shift+F3, Ctrl+Shift+G |

### Zoom

| Action | macOS | Windows and Linux |
| --- | --- | --- |
| Zoom in | ⌘+, ⌘= | Ctrl++, Ctrl+= |
| Zoom out | ⌘- | Ctrl+- |
| Actual size | ⌘0 | Ctrl+0 |

### HelmStack

| Action | macOS | Windows and Linux |
| --- | --- | --- |
| Select an element for the agent | ⌘⇧E | Ctrl+Shift+E |
| Show or hide the agent panel | ⌘⇧A | Ctrl+Shift+A |
| Focus the chat composer | ⌘⇧K | Ctrl+Shift+K |
| Keyboard shortcuts… | ⌘/ | Ctrl+/ |
<!-- generated:end -->

## Notes

- Some entries have alternates (for example `Ctrl+Tab` and `Ctrl+PgDn` for the next tab). All are listed.
- `Esc` (stop loading) is handled only by the in-page key routing, so it never steals the key from pages that use it.
- Shortcuts apply to the desktop app only; the daemon has no window.

## Verify it worked

Press `Cmd/Ctrl+T`: a new tab opens and the address bar is focused. Press `Cmd/Ctrl+/`: the shortcuts dialog opens.
