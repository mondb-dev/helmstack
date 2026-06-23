import { describe, expect, it } from "vitest";

import { selectorForElement, SELECTOR_FOR_SOURCE } from "../src/page-selector.js";

/** Evaluate the injectable source the way the page-world scripts do. */
function evalSource(node: Node | null): string {
  return new Function("node", `return (${SELECTOR_FOR_SOURCE})(node);`)(node) as string;
}

function pick(html: string, selector: string): Element {
  document.body.innerHTML = html;
  return document.querySelector(selector)!;
}

describe("selectorForElement", () => {
  it("prefers an id (tag#id)", () => {
    expect(selectorForElement(pick(`<span id="clock">x</span>`, "#clock"))).toBe("span#clock");
  });

  it("uses data-testid before class", () => {
    const el = pick(`<button data-testid="buy" class="cta">Buy</button>`, "button");
    expect(selectorForElement(el)).toBe('button[data-testid="buy"]');
  });

  it("uses the first class when there's no id/testid", () => {
    expect(selectorForElement(pick(`<div class="card big">x</div>`, ".card"))).toBe("div.card");
  });

  it("falls back to nth-of-type when same-tag siblings exist", () => {
    document.body.innerHTML = `<ul><li>a</li><li>b</li><li>c</li></ul>`;
    const third = document.querySelectorAll("li")[2];
    expect(selectorForElement(third)).toBe("li:nth-of-type(3)");
  });

  it("returns a bare tag for a unique element with no id/class (e.g. body)", () => {
    document.body.innerHTML = `<main>only</main>`;
    expect(selectorForElement(document.querySelector("main")!)).toBe("main");
    expect(selectorForElement(document.body)).toBe("body");
  });

  it("coerces a non-element node to its parent element, and reports detached", () => {
    const el = pick(`<p class="lead">hello</p>`, "p");
    const textNode = el.firstChild!; // a Text node
    expect(selectorForElement(textNode)).toBe("p.lead");
    expect(selectorForElement(null)).toBe("(detached)");
  });

  it("escapes id/class values", () => {
    const el = pick(`<div class="w-1/2">x</div>`, "div");
    // CSS.escape turns the slash into an escaped sequence
    expect(selectorForElement(el)).toBe("div." + CSS.escape("w-1/2"));
  });
});

describe("SELECTOR_FOR_SOURCE parity", () => {
  it("is derived from the function", () => {
    expect(SELECTOR_FOR_SOURCE).toBe(selectorForElement.toString());
  });

  it("evaluates to the same result as the typed function (cannot drift)", () => {
    document.body.innerHTML = `<section><a class="x">1</a><a class="x">2</a></section>`;
    const second = document.querySelectorAll("a")[1];
    expect(evalSource(second)).toBe(selectorForElement(second));
    expect(evalSource(document.body)).toBe(selectorForElement(document.body));
  });
});
