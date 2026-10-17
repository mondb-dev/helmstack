import { describe, expect, it } from "vitest";

import { CHUNK_CHARS, RECALL_TOTAL_CHARS, chunkText, recall, tokenize } from "../../src/core/routines/recall.js";

const doc = (id: string, title: string, text: string) => ({ id, title, text });

const STRATEGY = doc(
  "d1",
  "Roster strategy",
  "We never drop players on the protected list unless injured for the season. Protected players include the franchise guard and the two rookies. Waiver claims should target bench depth at center."
);
const SCHEDULE = doc("d2", "Schedule notes", "The league plays on weekends. Playoffs begin in April and the trade deadline is in February.");

describe("tokenize", () => {
  it("lower-cases, drops stopwords and short words, trims plurals", () => {
    expect(tokenize("The Players are on the Protected list!")).toEqual(["player", "protected", "list"]);
    expect(tokenize("a an of 7 x")).toEqual([]);
  });
});

describe("chunkText", () => {
  it("keeps short text whole and splits long text into overlapping windows", () => {
    expect(chunkText("short text")).toEqual(["short text"]);
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkText(long);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CHUNK_CHARS);
    // overlap: the end of one chunk reappears at the start of the next
    const tail = chunks[0]!.split(" ").slice(-3).join(" ");
    expect(chunks[1]!).toContain(tail.split(" ")[2]!);
    // nothing lost
    expect(chunks.join(" ")).toContain("word399");
  });
});

describe("recall", () => {
  it("ranks the relevant document first and labels passages with the document title", () => {
    const out = recall([SCHEDULE, STRATEGY], "Should we drop this protected player who is injured?", { topK: 2 });
    expect(out[0]).toMatchObject({ docId: "d1", title: "Roster strategy" });
    expect(out[0]!.text).toContain("protected list");
    expect(out.length).toBeGreaterThanOrEqual(1);
  });

  it("returns nothing when no keyword matches, for an empty library or an all-stopword query", () => {
    expect(recall([STRATEGY], "quantum chromodynamics", { topK: 3 })).toEqual([]);
    expect(recall([], "protected", { topK: 3 })).toEqual([]);
    expect(recall([STRATEGY], "the and of", { topK: 3 })).toEqual([]);
  });

  it("honours top_k, and finds the right chunk inside a long document", () => {
    const filler = Array.from({ length: 300 }, (_, i) => `filler${i % 7} text`).join(" ");
    const long = doc("d3", "Long", `${filler} The zebra waiver rule applies to centers only. ${filler}`);
    const out = recall([long, STRATEGY, SCHEDULE], "zebra waiver rule", { topK: 1 });
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toContain("zebra waiver rule");
    const many = recall([long, STRATEGY, SCHEDULE], "players league waiver", { topK: 5 });
    expect(many.length).toBeLessThanOrEqual(5);
  });

  it("is deterministic with a stable tie-break by document order", () => {
    const a = doc("a", "A", "alpha beta gamma");
    const b = doc("b", "B", "alpha beta gamma");
    const first = recall([a, b], "alpha", { topK: 2 }).map((p) => p.docId);
    const again = recall([a, b], "alpha", { topK: 2 }).map((p) => p.docId);
    expect(first).toEqual(["a", "b"]);
    expect(again).toEqual(first);
    expect(recall([b, a], "alpha", { topK: 2 }).map((p) => p.docId)).toEqual(["b", "a"]);
  });

  it("caps the total passage text", () => {
    const docs = Array.from({ length: 5 }, (_, i) => doc(`d${i}`, `Doc ${i}`, `keyword ${"lorem ipsum dolor ".repeat(60)} ${i}`));
    const out = recall(docs, "keyword", { topK: 5 });
    expect(out.reduce((s, p) => s + p.text.length, 0)).toBeLessThanOrEqual(RECALL_TOTAL_CHARS);
    expect(out.length).toBeGreaterThan(1);
    const tight = recall(docs, "keyword", { topK: 5, maxChars: 700 });
    expect(tight.reduce((s, p) => s + p.text.length, 0)).toBeLessThanOrEqual(700);
  });

  it("only searches the documents it is given (proposed documents are filtered out by the caller)", () => {
    expect(recall([SCHEDULE], "protected players injured", { topK: 3 })).toEqual([]);
  });
});
