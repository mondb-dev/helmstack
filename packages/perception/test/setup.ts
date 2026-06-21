import { afterEach, beforeAll } from "vitest";

beforeAll(() => {
  const view = window as unknown as { CSS?: { escape?: (value: string) => string } };
  const css = (view.CSS ??= {});
  if (typeof css.escape !== "function") {
    css.escape = (value: string) => value.replace(/"/g, '\\"');
  }

  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: function getBoundingClientRect() {
      const style = window.getComputedStyle(this);
      if (style.display === "none" || style.visibility === "hidden") {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          width: 0,
          height: 0,
          toJSON: () => ({})
        };
      }

      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 320,
        bottom: 40,
        width: 320,
        height: 40,
        toJSON: () => ({})
      };
    }
  });
});

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.title = "";
  history.replaceState({}, "", "https://example.com/");
});
