import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RoutineState } from "../../../shared/src/index.js";
import { buildPreview, triggerText } from "../../src/core/routines/preview.js";
import {
  DEFAULT_MAX_ROUTINES,
  ROUTINE_ID_PATTERN,
  RoutineError,
  RoutineStateError,
  RoutineStore,
  isValidRoutineId,
  newRoutineId,
  type RoutineAction
} from "../../src/core/stores/routine-store.js";
import { canonical, minimal } from "./fixtures.js";

let dir: string;
let clock: number;
let n: number;
const logs: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "helmstack-routines-"));
  clock = Date.UTC(2026, 9, 17, 9, 30, 0);
  n = 0;
  logs.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const open = (opts: { maxRoutines?: number } = {}) =>
  new RoutineStore(dir, {
    ...opts,
    now: () => (clock += 1000),
    random: () => (++n).toString(16).padStart(8, "0"),
    log: (m) => logs.push(m)
  });

function propose(store: RoutineStore, extra: { proposedBy?: string; replaces?: string; spec?: ReturnType<typeof canonical> } = {}) {
  const spec = extra.spec ?? canonical();
  return store.propose({ spec, preview: buildPreview(spec), trigger: triggerText(spec.trigger), ...extra });
}

/** Drive a fresh routine into `state` through legal moves. */
function inState(store: RoutineStore, state: RoutineState): string {
  const { id } = propose(store);
  const path: Record<RoutineState, RoutineAction[]> = {
    proposed: [],
    approved: ["approve"],
    paused: ["approve", "pause"],
    stopped: ["approve", "stop"],
    rejected: ["reject"]
  };
  for (const action of path[state]) store.transition(id, action);
  return id;
}

describe("routine ids", () => {
  it("are rt-YYYYMMDD-HHMMSS-8hex and validated strictly", () => {
    const id = newRoutineId(Date.UTC(2026, 9, 17, 9, 30, 5), () => "0123abcd");
    expect(id).toBe("rt-20261017-093005-0123abcd");
    expect(ROUTINE_ID_PATTERN.test(id)).toBe(true);
    for (const bad of ["", "rt-1", "../etc/passwd", "rt-20261017-093005-0123ABCD", "rt-20261017-093005-0123abcd.json", "rt-20261017-093005-0123abcd/..", `${id}\n`, 5, null, undefined]) {
      expect(isValidRoutineId(bad), String(bad)).toBe(false);
    }
  });
});

describe("RoutineStore", () => {
  it("stores a proposal as proposed, with files on disk and a summary built from the spec", () => {
    const store = open();
    const events: string[] = [];
    store.onEvent((e) => events.push(`${e.type}:${e.routine.state}`));
    const r = propose(store, { proposedBy: "agent-a" });
    expect(r).toMatchObject({ state: "proposed", proposedBy: "agent-a", trigger: "every 6 hours", hosts: ["news.example.com"], specVersion: 1 });
    expect(r.intent).toBe(canonical().intent);
    expect(r.createdAt).toBe(r.updatedAt);
    expect(events).toEqual(["proposed:proposed"]);
    const files = readdirSync(path.join(dir, "routines")).sort();
    expect(files).toEqual(["index.json", `${r.id}.json`].sort());
    const index = JSON.parse(readFileSync(path.join(dir, "routines", "index.json"), "utf8"));
    expect(index.routines.map((x: { id: string }) => x.id)).toEqual([r.id]);
    const detail = store.detail(r.id)!;
    expect(JSON.parse(detail.specJson)).toEqual(canonical());
    expect(store.spec(r.id)).toEqual(canonical());
  });

  it("lists newest first and survives a restart with state intact", () => {
    const a = open();
    const first = propose(a);
    const second = propose(a);
    a.transition(second.id, "approve");
    const b = open();
    expect(b.list().map((x) => x.id)).toEqual([second.id, first.id]);
    expect(b.get(second.id)?.state).toBe("approved");
    expect(b.get(first.id)?.state).toBe("proposed");
  });

  it("returns copies, so a caller cannot edit stored state", () => {
    const store = open();
    const r = propose(store);
    r.hosts.push("evil.example");
    r.preview.lines.length = 0;
    expect(store.get(r.id)!.hosts).toEqual(["news.example.com"]);
    expect(store.get(r.id)!.preview.lines.length).toBeGreaterThan(0);
  });

  const LEGAL: Array<[RoutineAction, RoutineState, RoutineState]> = [
    ["approve", "proposed", "approved"],
    ["reject", "proposed", "rejected"],
    ["withdraw", "proposed", "rejected"],
    ["pause", "approved", "paused"],
    ["resume", "paused", "approved"],
    ["stop", "approved", "stopped"],
    ["stop", "paused", "stopped"]
  ];
  const ALL_STATES: RoutineState[] = ["proposed", "approved", "paused", "stopped", "rejected"];
  const ACTIONS: RoutineAction[] = ["approve", "reject", "withdraw", "pause", "resume", "stop"];

  it("follows the state machine exactly: every legal move works", () => {
    for (const [action, from, to] of LEGAL) {
      const store = open();
      const id = inState(store, from);
      const before = store.get(id)!.updatedAt;
      const out = store.transition(id, action);
      expect(out.state, `${action} from ${from}`).toBe(to);
      expect(out.updatedAt).toBeGreaterThanOrEqual(before);
      expect(store.get(id)!.state).toBe(to);
    }
  });

  it("and every illegal move throws a clear error and changes nothing", () => {
    for (const action of ACTIONS) {
      for (const from of ALL_STATES) {
        if (LEGAL.some(([a, f]) => a === action && f === from)) continue;
        const store = open();
        const id = inState(store, from);
        expect(() => store.transition(id, action), `${action} from ${from}`).toThrow(RoutineStateError);
        expect(() => store.transition(id, action)).toThrow(new RegExp(`Can't ${action} a routine that is ${from}`));
        expect(store.get(id)!.state).toBe(from);
      }
    }
  });

  it("rejects malformed and unknown ids", () => {
    const store = open();
    expect(() => store.transition("../x", "approve")).toThrow(RoutineError);
    expect(() => store.transition("rt-20990101-000000-00000000", "approve")).toThrow(/no longer exists/);
    expect(() => store.delete("nope")).toThrow(/invalid routine id/);
    expect(store.delete("rt-20990101-000000-00000000")).toBe(false);
    expect(store.get("../../etc/passwd")).toBeUndefined();
    expect(store.detail("nope")).toBeUndefined();
  });

  it("deletes a routine of any state, and its file", () => {
    const store = open();
    const id = inState(store, "approved");
    const events: string[] = [];
    store.onEvent((e) => events.push(e.type));
    expect(store.delete(id)).toBe(true);
    expect(store.get(id)).toBeUndefined();
    expect(readdirSync(path.join(dir, "routines"))).toEqual(["index.json"]);
    expect(events).toEqual(["deleted"]);
    expect(open().list()).toEqual([]);
  });

  describe("replaces", () => {
    it("stops the old approved routine when the replacement is approved", () => {
      const store = open();
      const old = inState(store, "approved");
      const next = propose(store, { replaces: old });
      expect(next.replaces).toBe(old);
      expect(store.get(old)!.state).toBe("approved"); // untouched until the human decides
      const events: string[] = [];
      store.onEvent((e) => events.push(`${e.type}:${e.routine.id === old ? "old" : "new"}:${e.routine.state}`));
      store.transition(next.id, "approve");
      expect(store.get(old)!.state).toBe("stopped");
      expect(events).toEqual(["changed:new:approved", "changed:old:stopped"]);
    });

    it("stops a paused predecessor, rejects a still-proposed one, leaves finished ones alone", () => {
      const store = open();
      const paused = inState(store, "paused");
      const proposed = inState(store, "proposed");
      const stopped = inState(store, "stopped");
      for (const old of [paused, proposed, stopped]) store.transition(propose(store, { replaces: old }).id, "approve");
      expect(store.get(paused)!.state).toBe("stopped");
      expect(store.get(proposed)!.state).toBe("rejected");
      expect(store.get(stopped)!.state).toBe("stopped");
    });

    it("does nothing to the old routine when the replacement is rejected", () => {
      const store = open();
      const old = inState(store, "approved");
      const next = propose(store, { replaces: old });
      store.transition(next.id, "reject");
      expect(store.get(old)!.state).toBe("approved");
    });

    it("refuses an unknown or malformed replaces", () => {
      const store = open();
      expect(() => propose(store, { replaces: "rt-20990101-000000-00000000" })).toThrow(/no routine/);
      expect(() => propose(store, { replaces: "../x" })).toThrow(/not a valid routine id/);
      expect(store.size).toBe(0);
    });
  });

  it("caps the store at 50 routines and never deletes to make room", () => {
    const store = open();
    expect(DEFAULT_MAX_ROUTINES).toBe(50);
    const small = open({ maxRoutines: 3 });
    for (let i = 0; i < 3; i += 1) propose(small, { spec: minimal() });
    const ids = small.list().map((r) => r.id);
    expect(() => propose(small)).toThrow(/already 3 routines.*delete some/s);
    try {
      propose(small);
    } catch (err) {
      expect(err).toBeInstanceOf(RoutineError);
      expect((err as RoutineError).code).toBe("limit");
    }
    expect(small.list().map((r) => r.id)).toEqual(ids);
    // Rejected and stopped routines count too: only the human deleting frees a slot.
    small.transition(ids[0]!, "reject");
    expect(() => propose(small)).toThrow(/already 3/);
    small.delete(ids[0]!);
    expect(() => propose(small)).not.toThrow();
    expect(store.size).toBe(0);
  });

  describe("corrupt data", () => {
    it("quarantines an unreadable routine file and loads the rest", () => {
      const store = open();
      const good = propose(store);
      const bad = propose(store);
      writeFileSync(path.join(dir, "routines", `${bad.id}.json`), "{ not json");
      const again = open();
      expect(again.list().map((r) => r.id)).toEqual([good.id]);
      const names = readdirSync(path.join(dir, "routines"));
      expect(names.some((x) => x.startsWith(`${bad.id}.json.corrupt-`))).toBe(true);
      expect(logs.some((l) => l.includes("unreadable"))).toBe(true);
      // The index no longer lists the bad one.
      expect(JSON.parse(readFileSync(path.join(dir, "routines", "index.json"), "utf8")).routines).toHaveLength(1);
    });

    it("quarantines a file whose contents do not match its name or shape", () => {
      const store = open();
      const a = propose(store);
      const b = propose(store);
      const file = path.join(dir, "routines", `${a.id}.json`);
      const content = JSON.parse(readFileSync(file, "utf8"));
      content.summary.id = b.id; // wrong id inside
      writeFileSync(file, JSON.stringify(content));
      const again = open();
      expect(again.list().map((r) => r.id)).toEqual([b.id]);
      writeFileSync(path.join(dir, "routines", `${b.id}.json`), JSON.stringify({ version: 1, summary: { id: b.id, state: "weird" }, spec: {} }));
      expect(open().list()).toEqual([]);
    });

    it("replaces a corrupt index from the files, keeping a copy of the bad one", () => {
      const store = open();
      const a = propose(store);
      writeFileSync(path.join(dir, "routines", "index.json"), "<<<");
      const again = open();
      expect(again.list().map((r) => r.id)).toEqual([a.id]);
      const names = readdirSync(path.join(dir, "routines"));
      expect(names.some((x) => x.startsWith("index.json.corrupt-"))).toBe(true);
      expect(JSON.parse(readFileSync(path.join(dir, "routines", "index.json"), "utf8")).routines).toHaveLength(1);
    });

    it("ignores stray files, removes interrupted temp files and starts empty when the folder is new", () => {
      const store = open();
      const a = propose(store);
      writeFileSync(path.join(dir, "routines", "notes.txt"), "hi");
      writeFileSync(path.join(dir, "routines", `${a.id}.json.1234.tmp`), "half");
      const again = open();
      expect(again.list()).toHaveLength(1);
      expect(readdirSync(path.join(dir, "routines")).some((x) => x.endsWith(".tmp"))).toBe(false);
      expect(readdirSync(path.join(dir, "routines"))).toContain("notes.txt");
      const fresh = new RoutineStore(path.join(dir, "elsewhere"));
      expect(fresh.list()).toEqual([]);
    });
  });

  it("does not leave temp files behind after writes", () => {
    const store = open();
    const id = propose(store).id;
    store.transition(id, "approve");
    store.transition(id, "pause");
    expect(readdirSync(path.join(dir, "routines")).filter((x) => x.endsWith(".tmp"))).toEqual([]);
  });

  it("a throwing listener does not break the store", () => {
    const store = open();
    store.onEvent(() => {
      throw new Error("boom");
    });
    expect(() => propose(store)).not.toThrow();
  });
});
