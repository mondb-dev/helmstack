import { describe, expect, it } from "vitest";

import { buildHar } from "../src/main/har.js";
import type { NetworkRequestEntry } from "../../../packages/shared/src/index.js";

function req(partial: Partial<NetworkRequestEntry>): NetworkRequestEntry {
  return {
    requestId: "1",
    url: "https://example.com/api?q=1&page=2",
    method: "GET",
    failed: false,
    timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
    ...partial
  };
}

describe("buildHar", () => {
  it("produces a valid HAR 1.2 envelope", () => {
    const har = buildHar("https://example.com/", [req({})]);
    expect(har.log.version).toBe("1.2");
    expect(har.log.creator.name).toBe("HelmStack");
    expect(har.log.pages).toHaveLength(1);
    expect(har.log.entries).toHaveLength(1);
  });

  it("maps method, url, status, mime, and headers", () => {
    const [entry] = buildHar("https://example.com/", [
      req({
        method: "POST",
        statusCode: 201,
        statusText: "Created",
        mimeType: "application/json",
        requestHeaders: { "content-type": "application/json" },
        responseHeaders: { "cache-control": "no-store" }
      })
    ]).log.entries;

    expect(entry.request.method).toBe("POST");
    expect(entry.response.status).toBe(201);
    expect(entry.response.content.mimeType).toBe("application/json");
    expect(entry.request.headers).toContainEqual({ name: "content-type", value: "application/json" });
    expect(entry.response.headers).toContainEqual({ name: "cache-control", value: "no-store" });
  });

  it("parses the query string from the URL", () => {
    const [entry] = buildHar("https://example.com/", [req({})]).log.entries;
    expect(entry.request.queryString).toEqual([
      { name: "q", value: "1" },
      { name: "page", value: "2" }
    ]);
  });

  it("captures failure detail on the response", () => {
    const [entry] = buildHar("https://example.com/", [
      req({ failed: true, errorText: "net::ERR_CONNECTION_REFUSED", statusCode: undefined })
    ]).log.entries;
    expect(entry.response.status).toBe(0);
    expect(entry.response._error).toBe("net::ERR_CONNECTION_REFUSED");
  });

  it("emits ISO timestamps", () => {
    const [entry] = buildHar("https://example.com/", [req({})]).log.entries;
    expect(entry.startedDateTime).toBe("2026-01-01T00:00:00.000Z");
  });

  it("handles an empty request buffer", () => {
    const har = buildHar("https://example.com/", []);
    expect(har.log.entries).toEqual([]);
    expect(har.log.pages).toHaveLength(1);
  });
});
