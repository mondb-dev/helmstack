import { describe, expect, it } from "vitest";

import {
  isValidOrigin,
  validateAccountForm,
  type AccountFormValues,
} from "../src/renderer/ui/validate.js";

const valid: AccountFormValues = {
  label: "Amplify dev",
  origin: "https://example.com",
  username: "you@example.com",
  password: "hunter2",
  totpSeed: undefined,
};

describe("validateAccountForm", () => {
  it("accepts a fully valid form", () => {
    expect(validateAccountForm(valid)).toEqual([]);
  });

  it("flags every missing required field, in field order", () => {
    const errors = validateAccountForm({ label: "", origin: "", username: "", password: "" });
    expect(errors.map((e) => e.field)).toEqual(["label", "origin", "username", "password"]);
    expect(errors.every((e) => /required/.test(e.message))).toBe(true);
  });

  it("treats whitespace-only label/origin/username as empty", () => {
    const errors = validateAccountForm({ ...valid, label: "   " });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("label");
  });

  it("rejects an origin that is not a valid http(s) URL", () => {
    const errors = validateAccountForm({ ...valid, origin: "example.com" });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("origin");
    expect(errors[0].message).toMatch(/https:\/\//);
  });

  it("reports an empty origin once (required only, no format error)", () => {
    const errors = validateAccountForm({ ...valid, origin: "" });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/required/);
  });

  it("ignores totpSeed — it is optional", () => {
    expect(validateAccountForm({ ...valid, totpSeed: undefined })).toEqual([]);
    expect(validateAccountForm({ ...valid, totpSeed: "JBSWY3DPEHPK3PXP" })).toEqual([]);
  });
});

describe("isValidOrigin", () => {
  it.each([
    ["https://example.com", true],
    ["http://localhost:3000", true],
    ["https://example.com/path?q=1", true],
    ["example.com", false],
    ["ftp://example.com", false],
    ["", false],
    ["not a url", false],
  ])("%s -> %s", (input, expected) => {
    expect(isValidOrigin(input as string)).toBe(expected);
  });
});
