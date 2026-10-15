/**
 * "Keyboard shortcuts" dialog (Help menu / Cmd+/). Rows are generated from the
 * shared shortcut table, so the dialog, the application menu and the in-page
 * key routing can never disagree.
 */
import { shortcutSections, type ShortcutPlatform, type ShortcutSection } from "../../../../../packages/shared/src/shortcuts.js";
import { openDialog, type DialogHandle } from "../ui/dialog.js";

export interface ShortcutsDialogOptions {
  root?: ParentNode;
  platform: ShortcutPlatform;
  onOpen?: () => void;
  onClose?: () => void;
}

export interface ShortcutsDialogController {
  open(): void;
  close(): void;
  isOpen(): boolean;
}

/** Pure render of the sections into DOM (exported for tests). */
export function renderShortcutSections(sections: readonly ShortcutSection[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const section of sections) {
    const group = document.createElement("section");
    group.className = "shortcuts__group";
    const heading = document.createElement("h3");
    heading.className = "shortcuts__heading";
    heading.textContent = section.group;
    const list = document.createElement("dl");
    list.className = "shortcuts__list";
    for (const row of section.rows) {
      const term = document.createElement("dt");
      term.className = "shortcuts__label";
      term.textContent = row.label;
      const detail = document.createElement("dd");
      detail.className = "shortcuts__keys";
      row.keys.forEach((keys, index) => {
        if (index > 0) detail.append(" or ");
        const kbd = document.createElement("kbd");
        kbd.className = "kbd";
        kbd.textContent = keys;
        detail.append(kbd);
      });
      list.append(term, detail);
    }
    group.append(heading, list);
    fragment.append(group);
  }
  return fragment;
}

export function mountShortcutsDialog(options: ShortcutsDialogOptions): ShortcutsDialogController {
  const root = options.root ?? document;
  const modal = root.querySelector<HTMLElement>("#shortcuts-modal");
  const body = root.querySelector<HTMLElement>("#shortcuts-body");
  const closeButton = root.querySelector<HTMLButtonElement>("#shortcuts-close");
  const backdrop = root.querySelector<HTMLElement>("#shortcuts-backdrop");
  if (!modal || !body || !closeButton) throw new Error("Shortcuts dialog markup missing.");

  let dialog: DialogHandle | null = null;

  const hide = (): void => {
    if (!dialog) return;
    const handle = dialog;
    dialog = null;
    modal.hidden = true;
    handle.close();
    options.onClose?.();
  };

  closeButton.addEventListener("click", hide);
  backdrop?.addEventListener("click", hide);

  return {
    open() {
      if (dialog) return;
      body.replaceChildren(renderShortcutSections(shortcutSections(options.platform)));
      modal.hidden = false;
      options.onOpen?.();
      dialog = openDialog(modal, { dismissable: true, initialFocus: closeButton, onClose: () => {
        // Escape path: openDialog already closed; mirror the visual state.
        if (dialog) {
          dialog = null;
          modal.hidden = true;
          options.onClose?.();
        }
      } });
    },
    close: hide,
    isOpen: () => dialog !== null
  };
}
