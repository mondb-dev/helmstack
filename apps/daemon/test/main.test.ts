// @vitest-environment node
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";

import { CliUsageError, daemonVersion, main, parseCliArgs, USAGE } from "../src/main.js";

describe("parseCliArgs", () => {
  it("defaults: port 7070, ~/.helmstack/daemon, headless, launch", () => {
    expect(parseCliArgs([], {})).toEqual({ port: 7070, dataDir: path.join(homedir(), ".helmstack", "daemon"), headful: false });
  });

  it("honours HELMSTACK_PORT, with --port taking precedence", () => {
    expect(parseCliArgs([], { HELMSTACK_PORT: "7171" })).toMatchObject({ port: 7171 });
    expect(parseCliArgs(["--port", "0"], { HELMSTACK_PORT: "7171" })).toMatchObject({ port: 0 });
  });

  it("parses every flag", () => {
    expect(parseCliArgs(["--port=9000", "--data-dir", "/tmp/hs", "--chrome-path", "/opt/chrome", "--headful"], {})).toEqual({
      port: 9000,
      dataDir: "/tmp/hs",
      chromePath: "/opt/chrome",
      headful: true
    });
    expect(parseCliArgs(["--connect", "http://127.0.0.1:9222"], {})).toMatchObject({ connect: "http://127.0.0.1:9222" });
    expect(parseCliArgs(["-h"], {})).toBe("help");
  });

  it("rejects bad input", () => {
    expect(() => parseCliArgs(["--port", "70000"], {})).toThrow(CliUsageError);
    expect(() => parseCliArgs([], { HELMSTACK_PORT: "x" })).toThrow(/HELMSTACK_PORT/);
    expect(() => parseCliArgs(["--bogus"], {})).toThrow(CliUsageError);
    expect(() => parseCliArgs(["--connect", "not a url"], {})).toThrow(/--connect/);
    expect(() => parseCliArgs(["--connect", "ftp://x"], {})).toThrow(/--connect/);
    expect(() => parseCliArgs(["--connect", "http://127.0.0.1:9222", "--headful"], {})).toThrow(/cannot be combined/);
  });
});

describe("main", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { env: {}, log: (l: string) => out.push(l), error: (l: string) => err.push(l), onSignal: () => {} } };
  };

  it("--help prints usage and exits 0", async () => {
    const { out, io: opts } = io();
    await expect(main(["--help"], opts)).resolves.toBe(0);
    expect(out.join("\n")).toBe(USAGE);
  });

  it("bad arguments exit 2 with usage", async () => {
    const { err, io: opts } = io();
    await expect(main(["--port", "nope"], opts)).resolves.toBe(2);
    expect(err.join("\n")).toMatch(/Invalid port "nope"[\s\S]*Usage: helmstack-daemon/);
  });

  it("exits 1 with a clear message when the port is taken, before launching Chrome", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as net.AddressInfo).port;
    try {
      const { err, io: opts } = io();
      // A bogus chrome path proves Chrome is never reached.
      await expect(main(["--port", String(port), "--chrome-path", "/nonexistent/chrome"], opts)).resolves.toBe(1);
      expect(err.join("\n")).toMatch(new RegExp(`cannot listen on 127\\.0\\.0\\.1:${port}: the port is already in use`));
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});

describe("daemonVersion", () => {
  it("reads the version from the daemon's package.json", () => {
    const manifest = JSON.parse(readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));
    expect(daemonVersion()).toBe(manifest.version);
    expect(daemonVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
