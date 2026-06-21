import { describe, expect, it } from "vitest";

import {
  parseAccountInput,
  parseNetworkMockRules,
  parseResourceBudget,
  parseViewportBody
} from "../src/main/request-validation.js";

describe("parseNetworkMockRules", () => {
  it("accepts well-formed rules", () => {
    const r = parseNetworkMockRules({ rules: [{ urlPattern: "*/api/*", method: "GET", responseStatus: 200 }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toHaveLength(1);
  });

  it("rejects a non-array, a non-object element, and a missing urlPattern", () => {
    expect(parseNetworkMockRules({ rules: "nope" }).ok).toBe(false);
    expect(parseNetworkMockRules({ rules: [42] }).ok).toBe(false);
    expect(parseNetworkMockRules({ rules: [{ method: "GET" }] }).ok).toBe(false);
  });

  it("rejects a wrong-typed responseStatus with a pointed error", () => {
    const r = parseNetworkMockRules({ rules: [{ urlPattern: "x", responseStatus: "200" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/responseStatus/);
  });
});

describe("parseResourceBudget", () => {
  it("accepts optional numeric/boolean fields", () => {
    expect(parseResourceBudget({ cpuThrottlingRate: 4, offline: true }).ok).toBe(true);
    expect(parseResourceBudget({}).ok).toBe(true);
  });

  it("rejects wrong types", () => {
    expect(parseResourceBudget({ latencyMs: "100" }).ok).toBe(false);
    expect(parseResourceBudget({ offline: "yes" }).ok).toBe(false);
  });
});

describe("parseAccountInput", () => {
  it("accepts a complete account", () => {
    const r = parseAccountInput({ label: "GH", origins: ["github.com"], username: "u", password: "p" });
    expect(r.ok).toBe(true);
  });

  it("rejects missing label, non-string origins, and missing password", () => {
    expect(parseAccountInput({ origins: ["x"], username: "u", password: "p" }).ok).toBe(false);
    expect(parseAccountInput({ label: "x", origins: [1], username: "u", password: "p" }).ok).toBe(false);
    expect(parseAccountInput({ label: "x", origins: ["x"], username: "u" }).ok).toBe(false);
  });
});

describe("parseViewportBody", () => {
  it("accepts numbers + optional mobile, defaulting mobile to false", () => {
    const r = parseViewportBody({ width: 390, height: 844 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ width: 390, height: 844, mobile: false });
  });

  it("rejects missing dimensions and a non-boolean mobile", () => {
    expect(parseViewportBody({ width: 390 }).ok).toBe(false);
    expect(parseViewportBody({ width: 390, height: 844, mobile: "yes" }).ok).toBe(false);
  });
});
