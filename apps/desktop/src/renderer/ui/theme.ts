/**
 * Theme resolution + persistence (styleguide §1.1, §5.1).
 *
 * Choice is one of light/dark/system; `system` follows the OS via
 * `prefers-color-scheme`. The resolved theme is written to
 * `document.documentElement[data-theme]`; the choice persists in localStorage.
 * The pure resolve/read functions are exported so they unit-test without DOM
 * timing concerns.
 */

export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "helmstack-theme";

/** The OS preference, defaulting to dark when `matchMedia` is unavailable. */
export function systemTheme(): ResolvedTheme {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

/** The persisted choice, or null when nothing valid is stored. */
export function storedChoice(): ThemeChoice | null {
  let value: string | null;
  try {
    value = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
  return value === "light" || value === "dark" || value === "system" ? value : null;
}

/** Resolve a choice to a concrete theme (`system` → the OS preference). */
export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  return choice === "system" ? systemTheme() : choice;
}

export function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.setAttribute("data-theme", resolved);
}

export function persistChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    /* storage unavailable — choice simply won't persist */
  }
}

export interface ThemeController {
  choice(): ThemeChoice;
  resolved(): ResolvedTheme;
  set(choice: ThemeChoice): void;
  /** Flip between explicit light/dark (leaves "system" behind). */
  toggle(): void;
  destroy(): void;
}

/**
 * Initialise theming: apply `stored ?? system`, keep following the OS while the
 * choice stays "system", and return a controller for changing it.
 */
export function initTheme(): ThemeController {
  let current: ThemeChoice = storedChoice() ?? "system";
  applyTheme(resolveTheme(current));

  const media = typeof window !== "undefined" ? window.matchMedia?.("(prefers-color-scheme: light)") : undefined;
  const onSystemChange = (): void => {
    if (current === "system") {
      applyTheme(resolveTheme("system"));
    }
  };
  media?.addEventListener?.("change", onSystemChange);

  const set = (choice: ThemeChoice): void => {
    current = choice;
    persistChoice(choice);
    applyTheme(resolveTheme(choice));
  };

  return {
    choice: () => current,
    resolved: () => resolveTheme(current),
    set,
    toggle: () => set(resolveTheme(current) === "dark" ? "light" : "dark"),
    destroy: () => media?.removeEventListener?.("change", onSystemChange),
  };
}
