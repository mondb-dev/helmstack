import { describe, expect, it } from "vitest";

import { isAllowedOrigin, isLoopbackHostHeader, parseHostname } from "../src/main/agent-server.js";

describe("parseHostname", () => {
  it("strips the port", () => {
    expect(parseHostname("127.0.0.1:7070")).toBe("127.0.0.1");
    expect(parseHostname("localhost:7070")).toBe("localhost");
  });

  it("handles bare hosts and IPv6 brackets", () => {
    expect(parseHostname("example.com")).toBe("example.com");
    expect(parseHostname("[::1]:7070")).toBe("::1");
  });

  it("returns null for empty input", () => {
    expect(parseHostname(undefined)).toBeNull();
    expect(parseHostname("")).toBeNull();
  });
});

describe("isLoopbackHostHeader (DNS-rebinding guard)", () => {
  it("accepts loopback hosts", () => {
    expect(isLoopbackHostHeader("127.0.0.1:7070")).toBe(true);
    expect(isLoopbackHostHeader("localhost:7070")).toBe(true);
    expect(isLoopbackHostHeader("[::1]:7070")).toBe(true);
  });

  it("rejects non-loopback and rebinding hosts", () => {
    expect(isLoopbackHostHeader("evil.com")).toBe(false);
    expect(isLoopbackHostHeader("attacker.example:7070")).toBe(false);
    expect(isLoopbackHostHeader("192.168.1.5:7070")).toBe(false);
    expect(isLoopbackHostHeader(undefined)).toBe(false);
  });
});

describe("isAllowedOrigin (cross-origin guard)", () => {
  it("allows requests with no Origin header (Node/curl/SDK)", () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
  });

  it("allows loopback origins", () => {
    expect(isAllowedOrigin("http://127.0.0.1:7070")).toBe(true);
    expect(isAllowedOrigin("http://localhost:3000")).toBe(true);
    expect(isAllowedOrigin("http://[::1]:5173")).toBe(true);
  });

  it("rejects web origins and opaque origins", () => {
    expect(isAllowedOrigin("https://evil.com")).toBe(false);
    expect(isAllowedOrigin("https://app.example.com")).toBe(false);
    expect(isAllowedOrigin("null")).toBe(false);
    expect(isAllowedOrigin("not a url")).toBe(false);
  });
});
