// @vitest-environment node
/**
 * A Chrome that never answers its first CDP command (seen intermittently on CI as
 * "Target.setDiscoverTargets timed out") is retried with a fresh profile, inside the same
 * total time budget.
 */
import { existsSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { launchChrome as realLaunchChrome, type LaunchChromeOptions } from "../src/chrome.js";

const launch = vi.fn();
const launcher = { launch, connect: vi.fn() } as unknown as NonNullable<LaunchChromeOptions["launcher"]>;
const launchChrome = (options: LaunchChromeOptions) => realLaunchChrome({ launcher, ...options });

const fakeBrowser = () => ({
  process: () => null,
  close: async () => {},
  disconnect: async () => {}
});

beforeEach(() => launch.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("launchChrome retry", () => {
  it("retries once with a fresh profile and the failed profile is removed", async () => {
    const dirs: string[] = [];
    launch.mockImplementationOnce(async (opts: { userDataDir: string }) => {
      dirs.push(opts.userDataDir);
      throw new Error("Target.setDiscoverTargets timed out");
    });
    launch.mockImplementationOnce(async (opts: { userDataDir: string }) => {
      dirs.push(opts.userDataDir);
      return fakeBrowser();
    });

    const handle = await launchChrome({ executablePath: "/fake/chrome", timeoutMs: 40_000 });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(dirs).toHaveLength(2);
    expect(dirs[0]).not.toBe(dirs[1]);
    expect(existsSync(dirs[0])).toBe(false); // the hung attempt's profile is gone
    expect(handle.userDataDir).toBe(dirs[1]);
    expect(existsSync(dirs[1])).toBe(true);
    await handle.close();
    expect(existsSync(dirs[1])).toBe(false);
  });

  it("splits the total budget across attempts", async () => {
    launch.mockResolvedValue(fakeBrowser());
    const handle = await launchChrome({ executablePath: "/fake/chrome", timeoutMs: 30_000 });
    expect(launch.mock.calls[0][0]).toMatchObject({ timeout: 15_000, protocolTimeout: 15_000, pipe: true });
    await handle.close();
  });

  it("fails after the last attempt with the attempt count and cleans up", async () => {
    const dirs: string[] = [];
    launch.mockImplementation(async (opts: { userDataDir: string }) => {
      dirs.push(opts.userDataDir);
      throw new Error("never answered");
    });
    await expect(launchChrome({ executablePath: "/fake/chrome", launchAttempts: 3, timeoutMs: 9_000 })).rejects.toThrow(
      /Failed to launch Chrome at \/fake\/chrome after 3 attempts: never answered/
    );
    expect(launch).toHaveBeenCalledTimes(3);
    for (const dir of dirs) expect(existsSync(dir)).toBe(false);
  });

  it("a single attempt keeps the original message and does not mention attempts", async () => {
    launch.mockRejectedValue(new Error("boom"));
    await expect(launchChrome({ executablePath: "/fake/chrome", launchAttempts: 1 })).rejects.toThrow(
      /^Failed to launch Chrome at \/fake\/chrome: boom$/
    );
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("never deletes a profile the caller supplied", async () => {
    launch.mockRejectedValueOnce(new Error("hang"));
    launch.mockResolvedValueOnce(fakeBrowser());
    const userDataDir = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "caller-profile-"));
    const handle = await launchChrome({ executablePath: "/fake/chrome", userDataDir });
    expect(launch.mock.calls.map((c) => c[0].userDataDir)).toEqual([userDataDir, userDataDir]);
    await handle.close();
    expect(existsSync(userDataDir)).toBe(true);
    (await import("node:fs")).rmSync(userDataDir, { recursive: true, force: true });
  });
});
