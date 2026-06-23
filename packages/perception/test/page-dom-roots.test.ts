import { describe, expect, it } from "vitest";

import { collectQueryRoots, COLLECT_QUERY_ROOTS_SOURCE } from "../src/page-dom-roots.js";

/** Evaluate the injectable source string the way actuation does, in the page world. */
function evalSource(doc: Document): Array<Document | ShadowRoot> {
  return new Function("document", `return (${COLLECT_QUERY_ROOTS_SOURCE})(document);`)(doc);
}

describe("collectQueryRoots", () => {
  it("returns just the document when there are no shadow roots or iframes", () => {
    document.body.innerHTML = `<div><span>hi</span></div>`;
    const roots = collectQueryRoots(document);
    expect(roots).toEqual([document]);
  });

  it("discovers open shadow roots, including nested ones", () => {
    document.body.innerHTML = `<div id="host"></div>`;
    const host = document.getElementById("host")!;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<div id="inner-host"></div>`;
    const innerHost = shadow.getElementById("inner-host")!;
    const innerShadow = innerHost.attachShadow({ mode: "open" });

    const roots = collectQueryRoots(document);
    expect(roots).toContain(document);
    expect(roots).toContain(shadow);
    expect(roots).toContain(innerShadow);
    expect(roots).toHaveLength(3);
  });

  it("de-duplicates and ignores closed shadow roots (not exposed via .shadowRoot)", () => {
    document.body.innerHTML = `<div id="host"></div>`;
    const host = document.getElementById("host")!;
    host.attachShadow({ mode: "closed" });
    const roots = collectQueryRoots(document);
    expect(roots).toEqual([document]); // closed shadow root is invisible to traversal
  });

  it("does not throw on iframes (cross-origin access is swallowed)", () => {
    document.body.innerHTML = `<iframe src="about:blank"></iframe>`;
    expect(() => collectQueryRoots(document)).not.toThrow();
  });
});

describe("COLLECT_QUERY_ROOTS_SOURCE parity", () => {
  it("is derived from the function and is a non-empty function source", () => {
    expect(COLLECT_QUERY_ROOTS_SOURCE).toBe(collectQueryRoots.toString());
    expect(COLLECT_QUERY_ROOTS_SOURCE).toContain("querySelectorAll");
  });

  it("evaluates to the same roots as the typed function (cannot drift)", () => {
    document.body.innerHTML = `<div id="a"></div><div id="b"></div>`;
    const a = document.getElementById("a")!.attachShadow({ mode: "open" });
    a.innerHTML = `<div id="deep"></div>`;
    document.getElementById("b")!.attachShadow({ mode: "open" });

    const typed = collectQueryRoots(document);
    const injected = evalSource(document);
    expect(injected).toEqual(typed); // same root objects, same order
    expect(typed.length).toBe(3);
  });
});
