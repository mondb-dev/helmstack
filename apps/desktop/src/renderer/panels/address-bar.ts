/**
 * Address bar state. The value follows the active tab (including agent
 * navigations) unless the human has actually typed: a dirty flag set by
 * `input` events and cleared on submit, blur or Escape. Focus alone —
 * including programmatic focus — never freezes the value.
 */

export interface AddressBarOptions {
  input: HTMLInputElement;
  /** URL the bar should show when not dirty (pending navigation or the active tab's URL). */
  currentValue: () => string | undefined;
}

export interface AddressBarController {
  /** Tabs changed — show the current value unless the user has typed. */
  sync(): void;
  /** The user submitted; clears the dirty flag (call before navigating). */
  markSubmitted(): void;
  isDirty(): boolean;
}

export function mountAddressBar(options: AddressBarOptions): AddressBarController {
  const { input } = options;
  let dirty = false;

  const show = (): void => {
    const value = options.currentValue();
    if (value !== undefined && input.value !== value) input.value = value;
  };

  input.addEventListener("input", () => {
    dirty = true;
  });
  input.addEventListener("blur", () => {
    dirty = false;
    show();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    dirty = false;
    show();
    input.select();
  });

  return {
    sync() {
      if (!dirty) show();
    },
    markSubmitted() {
      dirty = false;
    },
    isDirty: () => dirty,
  };
}
