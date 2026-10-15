import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import puppeteer, { type Browser } from "puppeteer-core";

export const CHROME_PATH_ENV = "HELMSTACK_CHROME_PATH";

export const INSTALL_HINT = "npx @puppeteer/browsers install chrome@stable";

export type ChromeSource = "env" | "system" | "chrome-for-testing";

export type ChromeExecutable = {
  path: string;
  source: ChromeSource;
};

/** Inputs for discovery; every field defaults to the live process so tests can inject fakes. */
export type FindChromeOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  cwd?: string;
  /** Returns true when `file` exists and is a regular file. */
  isFile?: (file: string) => boolean;
  /** Lists directory entries; returns [] when the directory is missing. */
  listDir?: (dir: string) => string[];
};

export class ChromeNotFoundError extends Error {
  readonly searched: string[];

  constructor(message: string, searched: string[]) {
    super(message);
    this.name = "ChromeNotFoundError";
    this.searched = searched;
  }
}

function defaultIsFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function defaultListDir(dir: string): string[] {
  try {
    return existsSync(dir) ? readdirSync(dir) : [];
  } catch {
    return [];
  }
}

/** Standard install locations for Chrome / Chromium, most preferred first. */
export function systemChromeCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDir: string
): string[] {
  if (platform === "darwin") {
    const apps = [
      "Google Chrome.app/Contents/MacOS/Google Chrome",
      "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "Chromium.app/Contents/MacOS/Chromium",
      "Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
      "Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
      "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
    ];
    return apps.flatMap((app) => [path.posix.join("/Applications", app), path.posix.join(homeDir, "Applications", app)]);
  }

  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(
      (root): root is string => Boolean(root)
    );
    const rels = [
      "Google\\Chrome\\Application\\chrome.exe",
      "Google\\Chrome for Testing\\Application\\chrome.exe",
      "Chromium\\Application\\chrome.exe",
      "Google\\Chrome Beta\\Application\\chrome.exe",
      "Google\\Chrome Dev\\Application\\chrome.exe",
      "Google\\Chrome SxS\\Application\\chrome.exe"
    ];
    return rels.flatMap((rel) => roots.map((root) => path.win32.join(root, rel)));
  }

  // Linux and other unixes: well-known absolute paths, then anything on PATH.
  const names = ["google-chrome-stable", "google-chrome", "chrome", "chromium", "chromium-browser"];
  const pathDirs = (env.PATH ?? "").split(path.posix.delimiter).filter(Boolean);
  return [
    "/opt/google/chrome/chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    ...names.flatMap((name) => pathDirs.map((dir) => path.posix.join(dir, name)))
  ];
}

/** Executable path inside a Chrome for Testing `chrome-<platform>` folder. */
function cftExecutable(platform: NodeJS.Platform, folder: string, join: (...p: string[]) => string): string {
  if (platform === "darwin") {
    return join(folder, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
  }
  if (platform === "win32") return join(folder, "chrome.exe");
  return join(folder, "chrome");
}

/**
 * Chrome for Testing builds installed by `@puppeteer/browsers` — either into
 * `./chrome` (the CLI default) or Puppeteer's cache (`~/.cache/puppeteer/chrome`).
 * Layout: `<root>/<platform>-<buildId>/chrome-<platform>/<executable>`. Newest build first.
 */
export function chromeForTestingCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDir: string,
  cwd: string,
  listDir: (dir: string) => string[]
): string[] {
  const p = platform === "win32" ? path.win32 : path.posix;
  const roots = [
    p.join(cwd, "chrome"),
    p.join(env.PUPPETEER_CACHE_DIR ?? p.join(homeDir, ".cache", "puppeteer"), "chrome")
  ];
  const out: string[] = [];
  for (const root of roots) {
    const builds = listDir(root)
      .filter((name) => /-\d/.test(name))
      .sort((a, b) => compareBuilds(b, a));
    for (const build of builds) {
      for (const folder of listDir(p.join(root, build)).filter((name) => name.startsWith("chrome-"))) {
        out.push(cftExecutable(platform, p.join(root, build, folder), p.join));
      }
    }
  }
  return out;
}

/** Compares `mac_arm-131.0.6778.85`-style names by numeric build version. */
function compareBuilds(a: string, b: string): number {
  const va = (a.split("-").pop() ?? "").split(".").map(Number);
  const vb = (b.split("-").pop() ?? "").split(".").map(Number);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (va[i] || 0) - (vb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Finds a Chrome executable: `HELMSTACK_CHROME_PATH` → system Chrome / Chromium
 * → Chrome for Testing installs. Throws `ChromeNotFoundError` if none is found,
 * or if `HELMSTACK_CHROME_PATH` is set but does not point at a file.
 */
export function findChrome(options: FindChromeOptions = {}): ChromeExecutable {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const isFile = options.isFile ?? defaultIsFile;
  const listDir = options.listDir ?? defaultListDir;

  const override = env[CHROME_PATH_ENV]?.trim();
  if (override) {
    if (isFile(override)) return { path: override, source: "env" };
    throw new ChromeNotFoundError(
      `${CHROME_PATH_ENV} is set to "${override}", but no file exists there. ` +
        `Point it at a Chrome/Chromium executable, or unset it to auto-detect.`,
      [override]
    );
  }

  const system = systemChromeCandidates(platform, env, home);
  for (const candidate of system) {
    if (isFile(candidate)) return { path: candidate, source: "system" };
  }

  const cft = chromeForTestingCandidates(platform, env, home, cwd, listDir);
  for (const candidate of cft) {
    if (isFile(candidate)) return { path: candidate, source: "chrome-for-testing" };
  }

  throw new ChromeNotFoundError(
    "No Chrome executable found. Install one with:\n" +
      `  ${INSTALL_HINT}\n` +
      `or set ${CHROME_PATH_ENV} to the path of a Chrome/Chromium executable.`,
    [...system, ...cft]
  );
}

/** Like `findChrome` but returns null instead of throwing. */
export function tryFindChrome(options?: FindChromeOptions): ChromeExecutable | null {
  try {
    return findChrome(options);
  } catch (error) {
    if (error instanceof ChromeNotFoundError) return null;
    throw error;
  }
}

export type LaunchChromeOptions = {
  /** Explicit executable; skips discovery. */
  executablePath?: string;
  /** Headless by default; pass false for a visible window. */
  headless?: boolean;
  /** Profile directory. Defaults to a fresh temp dir that is deleted on close. */
  userDataDir?: string;
  /** Extra Chrome command-line flags. */
  args?: string[];
  /** Window size for new pages (headless and headed). Default 1280×800. */
  windowSize?: { width: number; height: number };
  /** Connect to an already-running Chrome (`http://127.0.0.1:9222`) instead of launching. */
  browserURL?: string;
  /** Connect to an already-running Chrome via its DevTools WebSocket URL. */
  wsEndpoint?: string;
  /** Launch / connect timeout in ms, in total across launch attempts. Default 30000. */
  timeoutMs?: number;
  /**
   * How many times to try launching a Chrome that never answers its first CDP command
   * (seen intermittently on CI). Each attempt gets a fresh temp profile and an equal
   * share of `timeoutMs`. Default 2.
   */
  launchAttempts?: number;
  /** Discovery overrides (tests). */
  discovery?: FindChromeOptions;
  /** Replaces puppeteer's launch/connect (tests only). */
  launcher?: Pick<typeof puppeteer, "launch" | "connect">;
};

export type ChromeHandle = {
  browser: Browser;
  /** "launched" processes are killed on close; "connected" browsers are only disconnected. */
  mode: "launched" | "connected";
  executablePath?: string;
  userDataDir?: string;
  /** Closes (launched) or disconnects from (connected) the browser. Idempotent. */
  close(): Promise<void>;
};

/** Launches a local Chrome, or connects to one when `browserURL`/`wsEndpoint` is given. */
export async function launchChrome(options: LaunchChromeOptions = {}): Promise<ChromeHandle> {
  const timeout = options.timeoutMs ?? 30_000;

  if (options.browserURL || options.wsEndpoint) {
    const browser = await (options.launcher ?? puppeteer).connect({
      browserURL: options.wsEndpoint ? undefined : options.browserURL,
      browserWSEndpoint: options.wsEndpoint,
      defaultViewport: null,
      protocolTimeout: timeout
    });
    let closed = false;
    return {
      browser,
      mode: "connected",
      async close() {
        if (closed) return;
        closed = true;
        await browser.disconnect().catch(() => {});
      }
    };
  }

  const executablePath = options.executablePath ?? findChrome(options.discovery).path;
  const ownsProfile = !options.userDataDir;
  const size = options.windowSize ?? { width: 1280, height: 800 };
  const attempts = Math.max(1, Math.floor(options.launchAttempts ?? 2));
  // The total budget is unchanged; a hang is simply discovered sooner and retried.
  const attemptTimeout = Math.max(1_000, Math.floor(timeout / attempts));

  let browser: Browser | undefined;
  let userDataDir = "";
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts && !browser; attempt += 1) {
    userDataDir = options.userDataDir ?? (await mkdtemp(path.join(tmpdir(), "helmstack-chrome-")));
    try {
      browser = await (options.launcher ?? puppeteer).launch({
        executablePath,
        headless: options.headless ?? true,
        userDataDir,
        // Leave the viewport to Chrome (window size) so our own CDP session's
        // Emulation overrides are the only ones in play.
        defaultViewport: null,
        // ADR 0001 §6.2: talk to Chrome over a pipe; no remote-debugging port is opened.
        pipe: true,
        args: [
          `--window-size=${size.width},${size.height}`,
          "--no-first-run",
          "--no-default-browser-check",
          ...(options.args ?? [])
        ],
        timeout: attemptTimeout,
        protocolTimeout: attemptTimeout,
        // The daemon owns signal handling; puppeteer still kills Chrome on process exit.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false
      });
    } catch (error) {
      lastError = error;
      if (ownsProfile) await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (!browser) {
    const reason = (lastError as Error | undefined)?.message ?? "unknown error";
    const tried = attempts > 1 ? ` after ${attempts} attempts` : "";
    throw new Error(`Failed to launch Chrome at ${executablePath}${tried}: ${reason}`, { cause: lastError });
  }
  const launched = browser;

  let closing: Promise<void> | null = null;
  return {
    browser: launched,
    mode: "launched",
    executablePath,
    userDataDir,
    close() {
      closing ??= (async () => {
        const proc = launched.process();
        await Promise.race([
          launched.close().catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 5_000).unref())
        ]);
        if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        if (ownsProfile) {
          await rm(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
        }
      })();
      return closing;
    }
  };
}
