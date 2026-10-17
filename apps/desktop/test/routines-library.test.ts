import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RoutineDoc, RoutineSummary } from "../../../packages/shared/src/index.js";
import { draftProblem, orderDocs } from "../src/renderer/panels/routine-library.js";
import { mountRoutines } from "../src/renderer/panels/routines.js";
import { createFakeBridge, flush, loadShellDom } from "./helpers/shell-fixtures.js";

const NOW = 1_700_000_000_000;
const EVIL = "<img src=x onerror=alert(1)>";

let seq = 0;
function routine(partial: Partial<RoutineSummary> = {}): RoutineSummary {
  seq += 1;
  return {
    id: `rl${seq}`,
    title: `Routine ${seq}`,
    intent: "Manage my lineup",
    state: "approved",
    createdAt: NOW - 100_000,
    updatedAt: NOW - 100_000,
    trigger: "every 6 hours",
    hosts: ["basketball.example.com"],
    specVersion: 1,
    preview: { headline: "h", lines: [], risks: [] },
    ...partial,
  };
}

function doc(partial: Partial<RoutineDoc> = {}): RoutineDoc {
  seq += 1;
  return {
    id: `doc${seq}`,
    routineId: "x",
    title: `Doc ${seq}`,
    origin: "human",
    status: "active",
    addedAt: NOW - 10_000,
    chars: 120,
    excerpt: "An excerpt.",
    ...partial,
  };
}

type Impl = Record<string, (...args: never[]) => unknown>;

function setup(list: RoutineSummary[], overrides: Impl = {}, hide: string[] = []) {
  const fake = createFakeBridge({ listRoutines: () => list, getRoutineEngineStatus: () => ({ enabled: true, running: [] }), ...overrides });
  const unsub = vi.fn();
  const holder: { cb?: (id: string) => void } = {};
  const bridge = new Proxy(fake.bridge, {
    get(target, prop: string) {
      if (hide.includes(prop)) return undefined;
      if (prop === "onRoutinesChanged") return vi.fn(() => () => undefined);
      if (prop === "onRoutineDocsChanged") {
        return vi.fn((cb: (id: string) => void) => {
          holder.cb = cb;
          return unsub;
        });
      }
      return (target as never)[prop];
    },
  });
  const onToReview = vi.fn();
  const ctrl = mountRoutines({ bridge, now: () => NOW, onDocsToReviewChange: onToReview });
  return { fake, ctrl, unsub, onToReview, changed: (id: string) => holder.cb?.(id) };
}

const body = (): HTMLElement => document.getElementById("routines-body")!;
const lib = (): HTMLElement | null => body().querySelector<HTMLElement>(".routine-lib");
const btn = (scope: ParentNode, label: string): HTMLButtonElement =>
  Array.from(scope.querySelectorAll("button")).find((b) => b.textContent === label)!;
const ctl = (name: string): HTMLInputElement & HTMLTextAreaElement => body().querySelector(`[data-lib="${name}"]`) as never;

async function openDetails(): Promise<void> {
  await flush();
  btn(body(), "Details").click();
  await flush();
}

function typeInto(name: string, value: string): void {
  const node = ctl(name);
  node.value = value;
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

function pickFile(file: File): void {
  const input = ctl("form-file");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

const waitFor = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 30 && !check(); i += 1) await flush();
};

beforeEach(() => {
  loadShellDom();
  document.getElementById("toast-region")?.remove();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("helpers", () => {
  it("puts proposed documents first, newest first within a group", () => {
    const a = doc({ addedAt: 1 });
    const b = doc({ addedAt: 3 });
    const c = doc({ addedAt: 2, status: "proposed" });
    expect(orderDocs([a, b, c]).map((d) => d.id)).toEqual([c.id, b.id, a.id]);
  });
  it("validates drafts", () => {
    expect(draftProblem({ title: "", source: "", text: "x" })).toContain("title");
    expect(draftProblem({ title: "t", source: "", text: "  " })).toContain("text");
    expect(draftProblem({ title: "t".repeat(121), source: "", text: "x" })).toContain("120");
    expect(draftProblem({ title: "t", source: "s".repeat(301), text: "x" })).toContain("300");
    expect(draftProblem({ title: "t", source: "", text: "x".repeat(20_001) })).toContain("over");
    expect(draftProblem({ title: "t", source: "", text: "x".repeat(20_000) })).toBe("");
  });
});

describe("reference library section", () => {
  it("shows an explanation, usage and the empty state", async () => {
    const r = routine();
    setup([r], { listRoutineDocs: () => [] });
    await openDetails();
    expect(lib()!.textContent).toContain("reference only; it can't be told what to do by them");
    expect(lib()!.textContent).toContain("0 of 30 documents");
    expect(lib()!.textContent).toContain("200,000");
    expect(lib()!.textContent).toContain("No documents yet.");
    expect(lib()!.textContent).toContain("Add a document");
  });

  it("lists human and agent documents with proposed ones first under a review heading", async () => {
    const r = routine();
    const mine = doc({ title: "My strategy", source: "my notes", origin: "human", chars: 1500 });
    const theirs = doc({ title: "Agent idea", origin: "agent", status: "proposed", chars: 400 });
    const { onToReview } = setup([r], {
      listRoutineDocs: () => [mine, theirs],
      getRoutineDoc: ((_id: string, docId: string) => ({ ...(docId === theirs.id ? theirs : mine), text: `Full text of ${docId}` })) as never,
    });
    await openDetails();
    await waitFor(() => lib()!.textContent!.includes("Full text of"));
    const text = lib()!.textContent!;
    expect(text).toContain("Waiting for your review (1)");
    expect(text.indexOf("Agent idea")).toBeLessThan(text.indexOf("My strategy"));
    expect(text).toContain("added by an agent");
    expect(text).toContain("added by you");
    expect(text).toContain("my notes");
    expect(text).toContain("1,500 characters");
    expect(text).toContain(`Full text of ${theirs.id}`);
    expect(lib()!.textContent).not.toContain(`Full text of ${mine.id}`);
    expect(btn(lib()!, "Use this")).toBeTruthy();
    expect(btn(lib()!, "Don't use")).toBeTruthy();
    expect(body().querySelector(".routine-row__state")!.textContent).toContain("1 to review");
    expect(onToReview).toHaveBeenLastCalledWith(1);
  });

  it("loads the full text only when a document is opened", async () => {
    const r = routine();
    const d = doc({ title: "Rules" });
    const { fake } = setup([r], { listRoutineDocs: () => [d], getRoutineDoc: (() => ({ ...d, text: "League rules in full" })) as never });
    await openDetails();
    expect(fake.fn("getRoutineDoc")).not.toHaveBeenCalled();
    btn(lib()!, "Read").click();
    await waitFor(() => lib()!.textContent!.includes("League rules in full"));
    expect(lib()!.querySelector(".routine-doc__text")!.textContent).toBe("League rules in full");
    btn(lib()!, "Hide").click();
    expect(lib()!.querySelector(".routine-doc__text")).toBeNull();
  });

  it("approves a proposed document", async () => {
    const r = routine();
    let status: RoutineDoc["status"] = "proposed";
    const d = doc({ title: "Idea", origin: "agent", status });
    const { fake } = setup([r], {
      listRoutineDocs: (() => [{ ...d, status }]) as never,
      getRoutineDoc: (() => ({ ...d, text: "t" })) as never,
      approveRoutineDoc: (() => {
        status = "active";
        return { ...d, status };
      }) as never,
    });
    await openDetails();
    btn(lib()!, "Use this").click();
    await waitFor(() => !lib()!.textContent!.includes("Waiting for your review"));
    expect(fake.fn("approveRoutineDoc")).toHaveBeenCalledWith(r.id, d.id);
    expect(lib()!.textContent).not.toContain("Waiting for your review");
    expect(lib()!.textContent).toContain("Idea");
  });

  it("asks before deleting, can cancel, then deletes", async () => {
    const r = routine();
    let docs = [doc({ title: "Old notes" })];
    const target = docs[0]!;
    const { fake } = setup([r], {
      listRoutineDocs: (() => docs) as never,
      deleteRoutineDoc: (() => {
        docs = [];
      }) as never,
    });
    await openDetails();
    btn(lib()!, "Delete").click();
    await flush();
    expect(fake.fn("deleteRoutineDoc")).not.toHaveBeenCalled();
    expect(lib()!.textContent).toContain("Remove this document from the library?");
    btn(lib()!, "Cancel").click();
    await flush();
    expect(lib()!.textContent).not.toContain("Remove this document");
    btn(lib()!, "Delete").click();
    await flush();
    btn(lib()!, "Delete").click();
    await waitFor(() => lib()!.textContent!.includes("No documents yet."));
    expect(fake.fn("deleteRoutineDoc")).toHaveBeenCalledWith(r.id, target.id);
    expect(lib()!.textContent).toContain("No documents yet.");
  });

  it("deleting a proposed document also asks first", async () => {
    const r = routine();
    const d = doc({ origin: "agent", status: "proposed" });
    const { fake } = setup([r], { listRoutineDocs: () => [d], getRoutineDoc: (() => ({ ...d, text: "t" })) as never });
    await openDetails();
    btn(lib()!, "Don't use").click();
    await flush();
    expect(fake.fn("deleteRoutineDoc")).not.toHaveBeenCalled();
    expect(lib()!.textContent).toContain("Delete this document?");
  });

  it("shows an inline alert when approving or deleting fails and re-enables the buttons", async () => {
    const r = routine();
    const d = doc({ origin: "agent", status: "proposed" });
    setup([r], {
      listRoutineDocs: () => [d],
      getRoutineDoc: (() => ({ ...d, text: "t" })) as never,
      approveRoutineDoc: (() => {
        throw new Error("nope");
      }) as never,
    });
    await openDetails();
    btn(lib()!, "Use this").click();
    await flush();
    expect(lib()!.querySelector('[role="alert"]')!.textContent).toContain("nope");
    expect(btn(lib()!, "Use this").disabled).toBe(false);
  });

  it("disables the buttons while an approval is in flight", async () => {
    const r = routine();
    const d = doc({ origin: "agent", status: "proposed" });
    let release: () => void = () => undefined;
    const { fake } = setup([r], {
      listRoutineDocs: () => [d],
      getRoutineDoc: (() => ({ ...d, text: "t" })) as never,
      approveRoutineDoc: (() => new Promise<void>((resolve) => (release = resolve))) as never,
    });
    await openDetails();
    btn(lib()!, "Use this").click();
    await flush();
    expect(btn(lib()!, "Working…").disabled).toBe(true);
    expect(btn(lib()!, "Don't use").disabled).toBe(true);
    btn(lib()!, "Working…").click();
    expect(fake.fn("approveRoutineDoc")).toHaveBeenCalledTimes(1);
    release();
    await flush();
  });

  it("escapes markup in titles, sources, excerpts and full text", async () => {
    const r = routine();
    const open = doc({ title: EVIL, source: EVIL, excerpt: EVIL });
    const prop = doc({ title: EVIL, source: EVIL, excerpt: EVIL, origin: "agent", status: "proposed" });
    setup([r], {
      listRoutineDocs: () => [open, prop],
      getRoutineDoc: ((_id: string, id: string) => ({ ...(id === prop.id ? prop : open), text: EVIL })) as never,
    });
    await openDetails();
    btn(lib()!, "Read").click();
    await waitFor(() => lib()!.querySelectorAll(".routine-doc__text").length === 2 && !lib()!.textContent!.includes("Loading the full"));
    expect(lib()!.querySelector("img")).toBeNull();
    expect(lib()!.textContent).toContain(EVIL);
    expect(lib()!.querySelector(".routine-doc__text")!.textContent).toBe(EVIL);
  });

  it("caps rendered documents at 30", async () => {
    const r = routine();
    const many = Array.from({ length: 35 }, (_, i) => doc({ title: `D${i}`, addedAt: i }));
    setup([r], { listRoutineDocs: () => many });
    await openDetails();
    expect(lib()!.querySelectorAll(".routine-doc").length).toBe(30);
    expect(lib()!.textContent).toContain("Showing 30 of 35");
    expect(btn(lib()!, "Add").disabled).toBe(true);
    expect(lib()!.textContent).toContain("library is full");
  });

  it("shows library counts in the Memory box", async () => {
    const r = routine();
    setup([r], { listRoutineDocs: () => [], getRoutineMemory: () => ({ routineId: r.id, sets: {}, values: {}, docs: 2 }) });
    await openDetails();
    expect(body().textContent).toContain("Reference library: 2 documents");
  });

  it("updates live when documents change", async () => {
    const r = routine();
    let docs: RoutineDoc[] = [];
    const { changed, onToReview } = setup([r], { listRoutineDocs: (() => docs) as never, getRoutineDoc: (() => ({ ...docs[0]!, text: "t" })) as never });
    await openDetails();
    expect(lib()!.textContent).toContain("No documents yet.");
    docs = [doc({ title: "Fresh", origin: "agent", status: "proposed" })];
    changed(r.id);
    await waitFor(() => lib()!.textContent!.includes("Fresh"));
    expect(lib()!.textContent).toContain("Waiting for your review");
    expect(onToReview).toHaveBeenLastCalledWith(1);
  });
});

describe("add a document", () => {
  const ready = async (overrides: Impl = {}) => {
    const r = routine();
    const s = setup([r], { listRoutineDocs: () => [], ...overrides });
    await openDetails();
    return { r, ...s };
  };

  it("keeps Add disabled until title and text are valid, with a live counter", async () => {
    await ready();
    const add = (): HTMLButtonElement => btn(lib()!, "Add");
    expect(add().disabled).toBe(true);
    typeInto("form-text", "hello");
    expect(lib()!.querySelector(".routine-lib__counter")!.textContent).toBe("5 / 20,000 characters");
    expect(lib()!.querySelector(".routine-lib__hint")!.textContent).toContain("title");
    expect(add().disabled).toBe(true);
    typeInto("form-title", "T");
    expect(add().disabled).toBe(false);
    typeInto("form-text", "x".repeat(20_001));
    expect(add().disabled).toBe(true);
    expect(lib()!.querySelector(".routine-lib__counter--over")).not.toBeNull();
    typeInto("form-text", "x".repeat(20_000));
    expect(add().disabled).toBe(false);
    typeInto("form-title", "t".repeat(121));
    expect(add().disabled).toBe(true);
    typeInto("form-title", "ok");
    typeInto("form-source", "s".repeat(301));
    expect(add().disabled).toBe(true);
  });

  it("adds the document, trims input, clears the form and reloads", async () => {
    let docs: RoutineDoc[] = [];
    const { fake, r } = await ready({ listRoutineDocs: (() => docs) as never, addRoutineDoc: (() => (docs = [doc({ title: "Plan" })])) as never });
    typeInto("form-title", "  Plan ");
    typeInto("form-source", " my notes ");
    typeInto("form-text", "Draft early");
    btn(lib()!, "Add").click();
    await waitFor(() => lib()!.textContent!.includes("1 of 30"));
    expect(fake.fn("addRoutineDoc")).toHaveBeenCalledWith(r.id, { title: "Plan", text: "Draft early", source: "my notes" });
    expect(ctl("form-title").value).toBe("");
    expect(lib()!.textContent).toContain("Plan");
  });

  it("omits an empty source", async () => {
    const { fake, r } = await ready();
    typeInto("form-title", "A");
    typeInto("form-text", "B");
    btn(lib()!, "Add").click();
    await flush();
    expect(fake.fn("addRoutineDoc")).toHaveBeenCalledWith(r.id, { title: "A", text: "B" });
  });

  it("disables Add while in flight and shows errors inline, keeping the draft", async () => {
    let release: (v?: unknown) => void = () => undefined;
    let fail = false;
    const { fake } = await ready({
      addRoutineDoc: (() =>
        new Promise((resolve, reject) => {
          release = fail ? () => reject(new Error("too many")) : resolve;
        })) as never,
    });
    typeInto("form-title", "A");
    typeInto("form-text", "B");
    fail = true;
    btn(lib()!, "Add").click();
    await flush();
    expect(btn(lib()!, "Adding…").disabled).toBe(true);
    btn(lib()!, "Adding…").click();
    expect(fake.fn("addRoutineDoc")).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(lib()!.querySelector('[role="alert"]')!.textContent).toContain("too many");
    expect(ctl("form-title").value).toBe("A");
    expect(btn(lib()!, "Add").disabled).toBe(false);
  });

  it("keeps typed text when the panel re-renders", async () => {
    const r = routine();
    const { changed } = setup([r], { listRoutineDocs: () => [] });
    await openDetails();
    typeInto("form-title", "Half typed");
    changed(r.id);
    await flush();
    expect(ctl("form-title").value).toBe("Half typed");
  });

  it("reads a valid text file into the form", async () => {
    await ready();
    pickFile(new File(["Line one\nLine two"], "strategy.md", { type: "text/markdown" }));
    await waitFor(() => ctl("form-text").value !== "");
    expect(ctl("form-text").value).toBe("Line one\nLine two");
    expect(ctl("form-title").value).toBe("strategy");
    expect(lib()!.textContent).toContain("Loaded strategy.md");
    expect(btn(lib()!, "Add").disabled).toBe(false);
  });

  it("keeps a title the human already typed", async () => {
    await ready();
    typeInto("form-title", "Mine");
    pickFile(new File(["x"], "a.txt", { type: "text/plain" }));
    await waitFor(() => ctl("form-text").value !== "");
    expect(ctl("form-title").value).toBe("Mine");
  });

  it("rejects files with too many characters", async () => {
    await ready();
    pickFile(new File(["x".repeat(20_001)], "big.txt", { type: "text/plain" }));
    await waitFor(() => !!lib()!.querySelector('[role="alert"]'));
    expect(lib()!.querySelector('[role="alert"]')!.textContent).toContain("20,000");
    expect(ctl("form-text").value).toBe("");
  });

  it("rejects huge files without reading them", async () => {
    await ready();
    const file = new File(["x"], "huge.txt", { type: "text/plain" });
    Object.defineProperty(file, "size", { value: 5_000_000 });
    pickFile(file);
    await flush();
    expect(lib()!.querySelector('[role="alert"]')!.textContent).toContain("too long");
  });

  it("rejects non-text and binary-looking files", async () => {
    await ready();
    pickFile(new File(["%PDF"], "doc.pdf", { type: "application/pdf" }));
    await flush();
    expect(lib()!.querySelector('[role="alert"]')!.textContent).toContain("plain text");
    pickFile(new File(["MZ\u0000\u0000\u0001"], "tool.txt", { type: "text/plain" }));
    await waitFor(() => !!lib()!.textContent!.includes("doesn't look like plain text"));
    expect(lib()!.querySelector('[role="alert"]')!.textContent).toContain("doesn't look like plain text");
    expect(ctl("form-text").value).toBe("");
  });

  it("never renders file content as HTML", async () => {
    await ready();
    pickFile(new File([EVIL], "x.txt", { type: "text/plain" }));
    await waitFor(() => ctl("form-text").value !== "");
    expect(lib()!.querySelector("img")).toBeNull();
    expect(ctl("form-text").value).toBe(EVIL);
  });
});

describe("fallbacks and cleanup", () => {
  it("hides the section when any library bridge method is missing", async () => {
    for (const missing of ["listRoutineDocs", "getRoutineDoc", "addRoutineDoc", "approveRoutineDoc", "deleteRoutineDoc"]) {
      loadShellDom();
      const r = routine();
      setup([r], {}, [missing]);
      await openDetails();
      expect(lib(), missing).toBeNull();
      expect(body().textContent).toContain("Memory");
    }
  });

  it("works without the change listener", async () => {
    const r = routine();
    setup([r], { listRoutineDocs: () => [] }, ["onRoutineDocsChanged"]);
    await openDetails();
    expect(lib()).not.toBeNull();
  });

  it("shows a load error inline", async () => {
    const r = routine();
    setup([r], {
      listRoutineDocs: (() => {
        throw new Error("offline");
      }) as never,
    });
    await openDetails();
    expect(lib()!.querySelector('[role="alert"]')!.textContent).toContain("offline");
  });

  it("removes its listener on destroy and ignores late events", async () => {
    const r = routine();
    const { ctrl, unsub, fake, changed } = setup([r], { listRoutineDocs: () => [] });
    await openDetails();
    const calls = fake.fn("listRoutineDocs").mock.calls.length;
    ctrl.destroy();
    expect(unsub).toHaveBeenCalledTimes(1);
    changed(r.id);
    await flush();
    expect(fake.fn("listRoutineDocs").mock.calls.length).toBe(calls);
  });
});
