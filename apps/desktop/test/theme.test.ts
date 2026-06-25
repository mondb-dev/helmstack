import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  initTheme,
  resolveTheme,
  storedChoice,
  systemTheme,
  THEME_STORAGE_KEY,
  type ThemeController,
} from "../src/renderer/ui/theme.js";

// Shared, mutable matchMedia mock (jsdom has none).
let systemLight = false;
const listeners = new Set<() => void>();

function installMatchMedia(): void {
  // @ts-expect-error — install a minimal MediaQueryList
  window.matchMedia = (query: string) => ({
    get matches() {
      return query.includes("light") ? systemLight : !systemLight;
    },
    media: query,
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    dispatchEvent: () => true,
  });
}
const setSystem = (light: boolean): void => {
  systemLight = light;
};
const fireSystem = (): void => listeners.forEach((cb) => cb());

let controller: ThemeController | null = null;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  systemLight = false;
  listeners.clear();
  installMatchMedia();
});

afterEach(() => {
  controller?.destroy();
  controller = null;
});

describe("resolveTheme / systemTheme", () => {
  it("system resolves to the OS preference", () => {
    setSystem(true);
    expect(systemTheme()).toBe("light");
    expect(resolveTheme("system")).toBe("light");
    setSystem(false);
    expect(resolveTheme("system")).toBe("dark");
  });

  it("explicit choices pass through regardless of OS", () => {
    setSystem(true);
    expect(resolveTheme("dark")).toBe("dark");
    expect(resolveTheme("light")).toBe("light");
  });
});

describe("storedChoice", () => {
  it("returns a valid stored value or null", () => {
    expect(storedChoice()).toBeNull();
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    expect(storedChoice()).toBe("light");
    localStorage.setItem(THEME_STORAGE_KEY, "bogus");
    expect(storedChoice()).toBeNull();
  });
});

describe("initTheme", () => {
  it("falls back to system when nothing is stored", () => {
    setSystem(true);
    controller = initTheme();
    expect(controller.choice()).toBe("system");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("a stored choice wins over the system preference", () => {
    setSystem(true); // OS = light
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    controller = initTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("set() persists and applies the choice", () => {
    setSystem(false);
    controller = initTheme();
    controller.set("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("toggle() flips the resolved theme", () => {
    setSystem(false); // OS = dark
    controller = initTheme();
    expect(controller.resolved()).toBe("dark");
    controller.toggle();
    expect(controller.resolved()).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("follows OS changes only while the choice is system", () => {
    setSystem(false); // OS = dark
    controller = initTheme(); // choice = system → dark
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    setSystem(true); // OS flips to light
    fireSystem();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    controller.set("dark"); // pin to dark explicitly
    setSystem(false);
    fireSystem(); // ignored — choice is no longer system
    setSystem(true);
    fireSystem();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
