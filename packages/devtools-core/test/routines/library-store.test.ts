import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ROUTINE_LIBRARY_LIMITS } from "../../../shared/src/index.js";
import { RoutineDataStore } from "../../src/core/stores/routine-data-store.js";
import { RoutineLibraryStore, isValidDocId, normalizeDocText } from "../../src/core/stores/routine-library-store.js";
import { RoutineError } from "../../src/core/stores/routine-store.js";

const RID = "rt-20261017-093000-1a2b3c4d";
const L = ROUTINE_LIBRARY_LIMITS;

let dir: string;
let n: number;
let clock: number;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "helmstack-library-"));
  n = 0;
  clock = 1_700_000_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const open = () => new RoutineLibraryStore(dir, { now: () => (clock += 1000), random: () => (++n).toString(16).padStart(8, "0"), log: () => {} });
const doc = (title: string, text = `text of ${title}`) => ({ title, text });
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof RoutineError ? e.code : "other";
  }
  return undefined;
};
const libDir = () => path.join(dir, "routines", RID, "library");

describe("library store", () => {
  it("human documents are active at once, agent documents are proposed", () => {
    const lib = open();
    const human = lib.add(RID, doc("Rules"), "human");
    const agent = lib.add(RID, doc("Notes"), "agent", { agentId: "claude" });
    expect(human).toMatchObject({ status: "active", origin: "human", title: "Rules", chars: 13 });
    expect(agent).toMatchObject({ status: "proposed", origin: "agent" });
    expect(isValidDocId(human.id)).toBe(true);
    expect(lib.list(RID).map((d) => d.title)).toEqual(["Notes", "Rules"]); // newest first
    expect(lib.activeDocs(RID).map((d) => d.title)).toEqual(["Rules"]);
    expect(lib.pendingCount(RID)).toBe(1);
  });

  it("a proposed document is never active until approved; approving twice or a missing id fails", () => {
    const lib = open();
    const agent = lib.add(RID, doc("Notes"), "agent");
    expect(lib.activeDocs(RID)).toEqual([]);
    expect(lib.approve(RID, agent.id).status).toBe("active");
    expect(lib.activeDocs(RID).map((d) => d.id)).toEqual([agent.id]);
    expect(code(() => lib.approve(RID, agent.id))).toBe("bad_state");
    expect(code(() => lib.approve(RID, "doc-zzzzzz-00000000"))).toBe("not_found");
    expect(code(() => lib.approve(RID, "../../etc/passwd"))).toBe("not_found");
  });

  it("delete removes the file; get returns the full text only for a valid id", () => {
    const lib = open();
    const d = lib.add(RID, doc("A", "full text here"), "human");
    expect(lib.get(RID, d.id)?.text).toBe("full text here");
    expect(lib.get(RID, "nope")).toBeNull();
    lib.delete(RID, d.id);
    expect(lib.get(RID, d.id)).toBeNull();
    expect(readdirSync(libDir())).toEqual([]);
    expect(code(() => lib.delete(RID, d.id))).toBe("not_found");
  });

  it("normalises text and titles, and validates input", () => {
    const lib = open();
    const d = lib.add(RID, { title: "  A\u0000  title\n here ", text: "one\u0007 two\r\n\r\n\r\n\r\nthree   four​", source: " https://x.example/a " }, "human");
    expect(d.title).toBe("A title here");
    expect(d.source).toBe("https://x.example/a");
    expect(lib.get(RID, d.id)!.text).toBe("one two\n\nthree four");
    expect(normalizeDocText("a\u0000b")).toBe("a b");
    expect(code(() => lib.add(RID, { title: "", text: "x" }, "human"))).toBe("invalid");
    expect(code(() => lib.add(RID, { title: "x", text: "   " }, "human"))).toBe("invalid");
    expect(code(() => lib.add(RID, { title: "x".repeat(L.titleChars + 1), text: "x" }, "human"))).toBe("invalid");
    expect(code(() => lib.add(RID, { title: "x", text: "x", source: "s".repeat(L.sourceChars + 1) }, "human"))).toBe("invalid");
    expect(code(() => lib.add(RID, { title: 1, text: "x" } as never, "human"))).toBe("invalid");
    expect(code(() => lib.add("not-an-id", doc("x"), "human"))).toBe("invalid_id");
  });

  it("enforces per-document, count, total and pending limits", () => {
    const lib = open();
    expect(code(() => lib.add(RID, doc("big", "x".repeat(L.docChars + 1)), "human"))).toBe("limit");
    lib.add(RID, doc("max", "y".repeat(L.docChars)), "human");
    // total chars
    for (let i = 0; i < 9; i++) lib.add(RID, doc(`t${i}`, `${i}`.repeat(L.docChars)), "human");
    expect(code(() => lib.add(RID, doc("over", "z".repeat(L.docChars)), "human"))).toBe("limit");
  });

  it("caps the number of documents and the pending proposals", () => {
    const lib = open();
    for (let i = 0; i < L.pendingPerRoutine; i++) lib.add(RID, doc(`p${i}`), "agent");
    expect(code(() => lib.add(RID, doc("one more"), "agent"))).toBe("limit");
    expect(() => lib.add(RID, doc("human still ok"), "human")).not.toThrow();
    const lib2 = open();
    const other = "rt-20261017-093000-aaaaaaaa";
    for (let i = 0; i < L.docsPerRoutine; i++) lib2.add(other, doc(`d${i}`), "human");
    expect(code(() => lib2.add(other, doc("overflow"), "human"))).toBe("limit");
  });

  it("an exact duplicate (same title and text) is not stored twice", () => {
    const lib = open();
    const a = lib.add(RID, doc("Rules", "same"), "human");
    const b = lib.add(RID, doc("rules", "same"), "agent");
    expect(b.id).toBe(a.id);
    expect(lib.list(RID)).toHaveLength(1);
    expect(lib.add(RID, doc("Rules", "different"), "human").id).not.toBe(a.id);
  });

  it("writes owner-only files atomically and ignores corrupt or foreign files", () => {
    const lib = open();
    const d = lib.add(RID, doc("A"), "human");
    const file = path.join(libDir(), `${d.id}.json`);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(libDir()).mode & 0o777).toBe(0o700);
    }
    expect(readdirSync(libDir()).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    writeFileSync(path.join(libDir(), "doc-zzzzzz-deadbeef.json"), "{not json");
    writeFileSync(path.join(libDir(), "stray.txt"), "x");
    expect(lib.list(RID).map((x) => x.id)).toEqual([d.id]);
    // A file whose routineId does not match is ignored.
    const stored = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(path.join(libDir(), "doc-zzzzzz-cafebabe.json"), JSON.stringify({ ...stored, id: "doc-zzzzzz-cafebabe", routineId: "rt-20261017-093000-bbbbbbbb" }));
    expect(lib.list(RID)).toHaveLength(1);
  });

  it("is removed with the routine's data, and an edit's replacement starts empty", () => {
    const lib = open();
    const data = new RoutineDataStore(dir, { log: () => {} });
    lib.add(RID, doc("A"), "human");
    data.remove(RID);
    expect(lib.list(RID)).toEqual([]);
    const next = "rt-20261017-093000-cccccccc";
    expect(lib.list(next)).toEqual([]);
  });
});
