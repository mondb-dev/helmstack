import { describe, expect, it } from "vitest";

import { DEFAULT_SEARCH_URL_TEMPLATE, normalizeNavigationTarget } from "../src/renderer/ui/format.js";

const search = (q: string) => DEFAULT_SEARCH_URL_TEMPLATE.replace("%s", encodeURIComponent(q));

describe("normalizeNavigationTarget", () => {
  it("returns null for empty input", () => {
    expect(normalizeNavigationTarget("")).toBeNull();
    expect(normalizeNavigationTarget("   ")).toBeNull();
  });

  it("keeps explicit schemes untouched", () => {
    for (const url of ["https://example.com/a?b=c", "http://example.com", "file:///Users/me/index.html", "about:blank", "data:text/html,hi"]) {
      expect(normalizeNavigationTarget(url)).toBe(url);
    }
    expect(normalizeNavigationTarget("  https://example.com  ")).toBe("https://example.com");
  });

  it("gives host:port inputs a scheme (http for local dev, https otherwise)", () => {
    expect(normalizeNavigationTarget("localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeNavigationTarget("localhost:3000/app?x=1")).toBe("http://localhost:3000/app?x=1");
    expect(normalizeNavigationTarget("127.0.0.1:4177")).toBe("http://127.0.0.1:4177");
    expect(normalizeNavigationTarget("[::1]:8080")).toBe("http://[::1]:8080");
    expect(normalizeNavigationTarget("app.localhost:5173")).toBe("http://app.localhost:5173");
    expect(normalizeNavigationTarget("example.com:8443")).toBe("https://example.com:8443");
  });

  it("treats dotted hosts as addresses", () => {
    expect(normalizeNavigationTarget("example.com")).toBe("https://example.com");
    expect(normalizeNavigationTarget("www.example.co.uk/path?q=1#frag")).toBe("https://www.example.co.uk/path?q=1#frag");
    expect(normalizeNavigationTarget("192.168.1.10/admin")).toBe("http://192.168.1.10/admin");
    expect(normalizeNavigationTarget("//example.com/x")).toBe("https://example.com/x");
    expect(normalizeNavigationTarget("localhost")).toBe("http://localhost");
  });

  it("searches for bare words and anything with spaces", () => {
    expect(normalizeNavigationTarget("helmstack")).toBe(search("helmstack"));
    expect(normalizeNavigationTarget("how to center a div")).toBe(search("how to center a div"));
    expect(normalizeNavigationTarget("what is 1.5 + 2")).toBe(search("what is 1.5 + 2"));
    expect(normalizeNavigationTarget("a&b=c d")).toBe(search("a&b=c d"));
    expect(normalizeNavigationTarget("foo.")).toBe(search("foo."));
  });

  it("never navigates to javascript: from the bar", () => {
    expect(normalizeNavigationTarget("javascript:alert(1)")).toBe(search("javascript:alert(1)"));
    expect(normalizeNavigationTarget("JavaScript:alert(1)")).toBe(search("JavaScript:alert(1)"));
  });

  it("uses a configurable engine, DuckDuckGo by default", () => {
    expect(DEFAULT_SEARCH_URL_TEMPLATE).toContain("duckduckgo.com");
    expect(normalizeNavigationTarget("cats", "https://example.test/s?q=%s")).toBe("https://example.test/s?q=cats");
  });
});
