import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ZOOM_STEPS, ZoomStore, nextZoomFactor, zoomOriginOf } from "../src/main/zoom-store.js";

const dirs: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helmstack-zoom-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("zoom steps", () => {
  it("spans 25% to 500% in Chrome's steps", () => {
    expect(ZOOM_STEPS[0]).toBe(0.25);
    expect(ZOOM_STEPS.at(-1)).toBe(5);
    expect(ZOOM_STEPS).toContain(1);
  });

  it("steps in and out and clamps", () => {
    expect(nextZoomFactor(1, "in")).toBe(1.1);
    expect(nextZoomFactor(1, "out")).toBe(0.9);
    expect(nextZoomFactor(5, "in")).toBe(5);
    expect(nextZoomFactor(0.25, "out")).toBe(0.25);
    // Off-grid values snap to the next step in the direction of travel.
    expect(nextZoomFactor(1.2, "in")).toBe(1.25);
    expect(nextZoomFactor(1.2, "out")).toBe(1.1);
  });
});

describe("zoomOriginOf", () => {
  it("keys http(s) and file pages and skips the rest", () => {
    expect(zoomOriginOf("https://a.test:8443/x?y")).toBe("https://a.test:8443");
    expect(zoomOriginOf("file:///tmp/a.html")).toBe("file://");
    expect(zoomOriginOf("about:blank")).toBeNull();
    expect(zoomOriginOf("not a url")).toBeNull();
  });
});

describe("ZoomStore", () => {
  it("persists per origin across instances", () => {
    const dir = tmp();
    const store = new ZoomStore(dir);
    expect(store.get("https://a.test")).toBe(1);
    expect(store.set("https://a.test", 1.5)).toBe(true);
    expect(new ZoomStore(dir).get("https://a.test")).toBe(1.5);
    expect(new ZoomStore(dir).get("https://b.test")).toBe(1);
  });

  it("forgets an origin when reset to 100%", () => {
    const dir = tmp();
    const store = new ZoomStore(dir);
    store.set("https://a.test", 2);
    store.set("https://a.test", 1);
    expect(new ZoomStore(dir).get("https://a.test")).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "helmstack-zoom.json"), "utf8")).origins).toEqual({});
  });

  it("tolerates a corrupt file and replaces it on the next save", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "helmstack-zoom.json"), "{not json");
    const store = new ZoomStore(dir);
    expect(store.get("https://a.test")).toBe(1);
    expect(store.set("https://a.test", 0.75)).toBe(true);
    expect(new ZoomStore(dir).get("https://a.test")).toBe(0.75);
  });

  it("drops nonsense values from a hand-edited file", () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, "helmstack-zoom.json"),
      JSON.stringify({ version: 1, origins: { "https://ok.test": 1.25, "https://big.test": 99, "https://str.test": "2", "javascript:x": 2 } })
    );
    const store = new ZoomStore(dir);
    expect(store.get("https://ok.test")).toBe(1.25);
    expect(store.get("https://big.test")).toBe(1);
    expect(store.get("https://str.test")).toBe(1);
    expect(store.get("javascript:x")).toBe(1);
  });

  it("creates a missing directory on save and never throws when it can't write", () => {
    const base = tmp();
    const nested = path.join(base, "missing", "deeper");
    const store = new ZoomStore(nested);
    expect(store.set("https://a.test", 1.1)).toBe(true);
    expect(fs.existsSync(path.join(nested, "helmstack-zoom.json"))).toBe(true);

    // A file where the directory should be: the write fails, the store keeps working in memory.
    const blocker = path.join(base, "blocker");
    fs.writeFileSync(blocker, "x");
    const blocked = new ZoomStore(path.join(blocker, "sub"));
    expect(blocked.set("https://a.test", 1.1)).toBe(false);
    expect(blocked.get("https://a.test")).toBe(1.1);
  });

  it("leaves no temp files behind", () => {
    const dir = tmp();
    const store = new ZoomStore(dir);
    store.set("https://a.test", 1.1);
    expect(fs.readdirSync(dir)).toEqual(["helmstack-zoom.json"]);
  });

  it("ignores origins without a zoom identity", () => {
    const dir = tmp();
    const store = new ZoomStore(dir);
    expect(store.set(null, 2)).toBe(true);
    expect(store.get(null)).toBe(1);
  });
});
