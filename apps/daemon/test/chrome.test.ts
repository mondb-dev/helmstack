// @vitest-environment node
import { describe, expect, it } from "vitest";

import { CHROME_PATH_ENV, ChromeNotFoundError, INSTALL_HINT, findChrome, tryFindChrome } from "../src/chrome.js";

function fs(files: string[], dirs: Record<string, string[]> = {}) {
  const set = new Set(files);
  return { isFile: (f: string) => set.has(f), listDir: (d: string) => dirs[d] ?? [] };
}

describe("findChrome", () => {
  it("prefers HELMSTACK_CHROME_PATH over system installs", () => {
    const result = findChrome({
      platform: "darwin",
      homeDir: "/Users/me",
      env: { [CHROME_PATH_ENV]: "/custom/chrome" },
      ...fs(["/custom/chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"])
    });
    expect(result).toEqual({ path: "/custom/chrome", source: "env" });
  });

  it("throws when HELMSTACK_CHROME_PATH points nowhere instead of silently falling back", () => {
    expect(() =>
      findChrome({
        platform: "darwin",
        homeDir: "/Users/me",
        env: { [CHROME_PATH_ENV]: "/missing" },
        ...fs(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"])
      })
    ).toThrow(/HELMSTACK_CHROME_PATH is set to "\/missing"/);
  });

  it("finds macOS Chrome in ~/Applications", () => {
    const exe = "/Users/me/Applications/Chromium.app/Contents/MacOS/Chromium";
    expect(findChrome({ platform: "darwin", homeDir: "/Users/me", env: {}, ...fs([exe]) })).toEqual({
      path: exe,
      source: "system"
    });
  });

  it("finds Windows Chrome under LOCALAPPDATA", () => {
    const exe = "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
    const result = findChrome({
      platform: "win32",
      homeDir: "C:\\Users\\me",
      cwd: "C:\\work",
      env: { PROGRAMFILES: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      ...fs([exe])
    });
    expect(result.path).toBe(exe);
  });

  it("finds Linux chromium on PATH", () => {
    const result = findChrome({
      platform: "linux",
      homeDir: "/home/me",
      cwd: "/work",
      env: { PATH: "/usr/local/bin:/home/me/bin" },
      ...fs(["/home/me/bin/chromium"])
    });
    expect(result).toEqual({ path: "/home/me/bin/chromium", source: "system" });
  });

  it("falls back to the newest Chrome for Testing build installed by @puppeteer/browsers", () => {
    const root = "/work/chrome";
    const older = `${root}/linux-120.0.6099.109/chrome-linux64/chrome`;
    const newer = `${root}/linux-131.0.6778.85/chrome-linux64/chrome`;
    const result = findChrome({
      platform: "linux",
      homeDir: "/home/me",
      cwd: "/work",
      env: {},
      ...fs([older, newer], {
        [root]: ["linux-120.0.6099.109", "linux-131.0.6778.85"],
        [`${root}/linux-120.0.6099.109`]: ["chrome-linux64"],
        [`${root}/linux-131.0.6778.85`]: ["chrome-linux64"]
      })
    });
    expect(result).toEqual({ path: newer, source: "chrome-for-testing" });
  });

  it("checks the puppeteer cache for macOS Chrome for Testing", () => {
    const root = "/Users/me/.cache/puppeteer/chrome";
    const exe = `${root}/mac_arm-131.0.6778.85/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
    const result = findChrome({
      platform: "darwin",
      homeDir: "/Users/me",
      cwd: "/work",
      env: {},
      ...fs([exe], {
        [root]: ["mac_arm-131.0.6778.85"],
        [`${root}/mac_arm-131.0.6778.85`]: ["chrome-mac-arm64"]
      })
    });
    expect(result.path).toBe(exe);
  });

  it("throws a ChromeNotFoundError with an install hint when nothing is found", () => {
    const opts = { platform: "linux" as const, homeDir: "/home/me", cwd: "/work", env: {}, ...fs([]) };
    let error: unknown;
    try {
      findChrome(opts);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ChromeNotFoundError);
    expect((error as Error).message).toContain(INSTALL_HINT);
    expect((error as Error).message).toContain(CHROME_PATH_ENV);
    expect((error as ChromeNotFoundError).searched.length).toBeGreaterThan(0);
    expect(tryFindChrome(opts)).toBeNull();
  });
});
