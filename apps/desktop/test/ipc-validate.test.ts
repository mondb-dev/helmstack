import { describe, expect, it } from "vitest";

import { parseFindOptions, parseFindText, parseReloadMode, parseZoomAction, requireString } from "../src/main/ipc-validate.js";

describe("shell IPC validation", () => {
  it("requireString bounds ids", () => {
    expect(requireString("tab-1", "tab id", 200)).toBe("tab-1");
    expect(() => requireString("", "tab id", 200)).toThrow("Invalid tab id.");
    expect(() => requireString(5, "tab id", 200)).toThrow();
    expect(() => requireString("x".repeat(201), "tab id", 200)).toThrow();
  });

  it("reload mode must be a boolean or absent", () => {
    expect(parseReloadMode(undefined)).toBe(false);
    expect(parseReloadMode(true)).toBe(true);
    expect(() => parseReloadMode("true")).toThrow("Invalid reload mode.");
  });

  it("find text is a bounded string (empty clears)", () => {
    expect(parseFindText("")).toBe("");
    expect(parseFindText("hello")).toBe("hello");
    expect(() => parseFindText("x".repeat(501))).toThrow();
    expect(() => parseFindText({})).toThrow();
  });

  it("find options accept only booleans and drop unknown keys", () => {
    expect(parseFindOptions(undefined)).toEqual({});
    expect(parseFindOptions({ forward: false, findNext: true, evil: "x" })).toEqual({ forward: false, findNext: true });
    expect(() => parseFindOptions({ forward: "yes" })).toThrow("Invalid find options.");
    expect(() => parseFindOptions(null)).toThrow();
    expect(() => parseFindOptions([])).toThrow();
  });

  it("zoom action is one of in/out/reset", () => {
    expect(parseZoomAction("in")).toBe("in");
    expect(() => parseZoomAction("max")).toThrow("Invalid zoom action.");
    expect(() => parseZoomAction(undefined)).toThrow();
  });
});
