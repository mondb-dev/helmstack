/**
 * A routine's reference library, shown in its Details: text the routine can draw on when it
 * makes judgment calls. Titles, sources, excerpts and full text are set with textContent only
 * (never HTML), files are read client-side as plain text, and nothing here is ever executed.
 * The module owns its own state and handlers; the panel only asks it to build a section.
 */

import {
  ROUTINE_LIBRARY_LIMITS,
  type BrowserShellBridge,
  type RoutineDoc,
  type RoutineDocDetail,
  type RoutineSummary,
} from "../../../../../packages/shared/src/index.js";

export type LibraryBridge = Partial<
  Pick<
    BrowserShellBridge,
    "listRoutineDocs" | "getRoutineDoc" | "addRoutineDoc" | "approveRoutineDoc" | "deleteRoutineDoc" | "onRoutineDocsChanged"
  >
>;

export const LIBRARY_EXPLANATION =
  "Text this routine can draw on when it makes judgment calls: your strategy, rules, research. It reads these passages as reference only; it can't be told what to do by them.";
export const DOC_CAP = ROUTINE_LIBRARY_LIMITS.docsPerRoutine;
export const FILE_EXTENSIONS = /\.(txt|md|csv|json)$/i;
const TITLE_CLIP = 80;
const SOURCE_CLIP = 80;
const PRELOAD_CAP = ROUTINE_LIBRARY_LIMITS.pendingPerRoutine;
const FILE_BYTE_CEILING = ROUTINE_LIBRARY_LIMITS.docChars * 4;

export interface LibraryOptions {
  bridge: LibraryBridge;
  now: () => number;
  /** Re-draw the panel. */
  rerender: () => void;
  routines: () => RoutineSummary[];
  /** Total agent documents waiting for review, across routines. */
  onToReviewChange?: (count: number) => void;
  /** A routine's library changed: its memory counts are stale. */
  onChanged?: (routineId: string) => void;
}

export interface Library {
  supported(): boolean;
  toReview(id: string): number;
  total(): number;
  prune(): void;
  prefetch(force: boolean): void;
  load(id: string): Promise<void>;
  build(routine: RoutineSummary): HTMLElement;
  destroy(): void;
}

interface Draft {
  title: string;
  source: string;
  text: string;
  note: string;
  error: string;
  busy: boolean;
  reading: boolean;
}

interface Full {
  loading: boolean;
  doc?: RoutineDocDetail | null;
  error?: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function btn(label: string, className: string, lib: string, ariaLabel?: string): HTMLButtonElement {
  const node = el("button", `btn btn--sm ${className}`, label);
  node.type = "button";
  node.dataset.lib = lib;
  if (ariaLabel) node.setAttribute("aria-label", ariaLabel);
  return node;
}

const clip = (value: string, max: number): string => (value.length <= max ? value : `${value.slice(0, max).trimEnd()}…`);
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const num = (n: number): string => n.toLocaleString("en-US");

function sane(listed: unknown): RoutineDoc[] {
  if (!Array.isArray(listed)) return [];
  return listed.filter(
    (doc): doc is RoutineDoc => !!doc && typeof doc === "object" && typeof (doc as RoutineDoc).id === "string" && typeof (doc as RoutineDoc).title === "string"
  );
}

/** Review-first: proposed documents, then active ones, newest first. */
export function orderDocs(docs: RoutineDoc[]): RoutineDoc[] {
  const rank = (doc: RoutineDoc): number => (doc.status === "proposed" ? 0 : 1);
  return [...docs].sort((a, b) => rank(a) - rank(b) || (b.addedAt ?? 0) - (a.addedAt ?? 0));
}

/** What is wrong with a draft, in plain words, or "" when it can be added. */
export function draftProblem(draft: Pick<Draft, "title" | "source" | "text">): string {
  const title = draft.title.trim();
  if (!title) return "Give it a title.";
  if (title.length > ROUTINE_LIBRARY_LIMITS.titleChars) return `The title is limited to ${num(ROUTINE_LIBRARY_LIMITS.titleChars)} characters.`;
  if (draft.source.trim().length > ROUTINE_LIBRARY_LIMITS.sourceChars) return `The source is limited to ${num(ROUTINE_LIBRARY_LIMITS.sourceChars)} characters.`;
  if (!draft.text.trim()) return "Add some text.";
  if (draft.text.length > ROUTINE_LIBRARY_LIMITS.docChars) {
    return `The text is ${num(draft.text.length - ROUTINE_LIBRARY_LIMITS.docChars)} characters over the ${num(ROUTINE_LIBRARY_LIMITS.docChars)} limit.`;
  }
  return "";
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("couldn't read that file"));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsText(file);
  });
}

export function createLibrary(options: LibraryOptions): Library {
  const { bridge } = options;
  const lists = new Map<string, RoutineDoc[]>();
  const loadErrors = new Map<string, string>();
  const fulls = new Map<string, Full>();
  const open = new Set<string>();
  const drafts = new Map<string, Draft>();
  const busy = new Set<string>();
  const docErrors = new Map<string, string>();
  let confirming: { routineId: string; docId: string } | null = null;
  let destroyed = false;
  let lastTotal = 0;
  let serial = 0;

  const supported = (): boolean =>
    typeof bridge.listRoutineDocs === "function" &&
    typeof bridge.getRoutineDoc === "function" &&
    typeof bridge.addRoutineDoc === "function" &&
    typeof bridge.approveRoutineDoc === "function" &&
    typeof bridge.deleteRoutineDoc === "function";

  const draftFor = (id: string): Draft => {
    let draft = drafts.get(id);
    if (!draft) {
      draft = { title: "", source: "", text: "", note: "", error: "", busy: false, reading: false };
      drafts.set(id, draft);
    }
    return draft;
  };

  const toReview = (id: string): number => (lists.get(id) ?? []).filter((doc) => doc.status === "proposed").length;
  const eligible = (): RoutineSummary[] => options.routines().filter((routine) => routine.state === "approved" || routine.state === "paused");
  const total = (): number => eligible().reduce((sum, routine) => sum + toReview(routine.id), 0);
  const updateTotal = (): void => {
    const next = total();
    if (next !== lastTotal) {
      lastTotal = next;
      options.onToReviewChange?.(next);
    }
  };

  /** Re-draw while keeping keyboard focus on the same control. */
  const redraw = (): void => {
    const active = document.activeElement as HTMLElement | null;
    const key = active?.dataset?.lib;
    const isField = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
    const selection = isField && active.type !== "file" ? active.selectionStart : null;
    options.rerender();
    if (!key) return;
    const again = Array.from(document.querySelectorAll<HTMLElement>("[data-lib]")).find((node) => node.dataset.lib === key && !(node as HTMLButtonElement).disabled);
    if (!again || again === document.activeElement) return;
    again.focus();
    if (selection !== null && (again instanceof HTMLInputElement || again instanceof HTMLTextAreaElement)) {
      try {
        again.setSelectionRange(selection, selection);
      } catch {
        // not a text control
      }
    }
  };

  async function loadFull(routineId: string, docId: string): Promise<void> {
    if (typeof bridge.getRoutineDoc !== "function" || destroyed) return;
    const existing = fulls.get(docId);
    if (existing?.loading) return;
    fulls.set(docId, { loading: true });
    redraw();
    try {
      const doc = await bridge.getRoutineDoc(routineId, docId);
      if (destroyed) return;
      fulls.set(docId, { loading: false, doc: doc && typeof doc === "object" && typeof doc.text === "string" ? doc : null });
    } catch (error) {
      if (destroyed) return;
      fulls.set(docId, { loading: false, error: errorText(error) });
    }
    redraw();
  }

  async function load(id: string): Promise<void> {
    if (typeof bridge.listRoutineDocs !== "function" || destroyed) return;
    try {
      const docs = sane(await bridge.listRoutineDocs(id));
      if (destroyed) return;
      lists.set(id, docs);
      loadErrors.delete(id);
      const ids = new Set(docs.map((doc) => doc.id));
      for (const key of Array.from(fulls.keys())) {
        if (!ids.has(key) && !Array.from(lists.values()).some((list) => list.some((doc) => doc.id === key))) fulls.delete(key);
      }
      for (const key of Array.from(open)) if (!ids.has(key) && !Array.from(lists.values()).some((list) => list.some((doc) => doc.id === key))) open.delete(key);
      if (confirming?.routineId === id && !ids.has(confirming.docId)) confirming = null;
      for (const doc of orderDocs(docs).filter((d) => d.status === "proposed").slice(0, PRELOAD_CAP)) {
        if (!fulls.has(doc.id)) void loadFull(id, doc.id);
      }
    } catch (error) {
      if (destroyed) return;
      loadErrors.set(id, errorText(error));
      if (!lists.has(id)) lists.set(id, []);
    }
    updateTotal();
    redraw();
  }

  const prune = (): void => {
    const ids = new Set(options.routines().map((routine) => routine.id));
    for (const id of Array.from(lists.keys())) {
      if (!ids.has(id)) {
        lists.delete(id);
        drafts.delete(id);
        loadErrors.delete(id);
      }
    }
    updateTotal();
  };

  const prefetch = (force: boolean): void => {
    if (!supported()) return;
    for (const routine of eligible().slice(0, 30)) if (force || !lists.has(routine.id)) void load(routine.id);
  };

  const unsubscribe =
    typeof bridge.onRoutineDocsChanged === "function"
      ? bridge.onRoutineDocsChanged((routineId) => {
          if (destroyed || typeof routineId !== "string") return;
          void load(routineId).then(() => {
            if (!destroyed) options.onChanged?.(routineId);
          });
        })
      : undefined;

  // ── actions ───────────────────────────────────────────────────────────────
  async function decide(routine: RoutineSummary, doc: RoutineDoc, kind: "approve" | "delete"): Promise<void> {
    if (busy.has(doc.id)) return;
    const call: ((id: string, docId: string) => Promise<unknown>) | undefined =
      kind === "approve" ? bridge.approveRoutineDoc?.bind(bridge) : bridge.deleteRoutineDoc?.bind(bridge);
    if (typeof call !== "function") return;
    docErrors.delete(doc.id);
    busy.add(doc.id);
    redraw();
    try {
      await call(routine.id, doc.id);
      busy.delete(doc.id);
      if (destroyed) return;
      confirming = null;
      const list = lists.get(routine.id) ?? [];
      lists.set(routine.id, kind === "delete" ? list.filter((d) => d.id !== doc.id) : list.map((d) => (d.id === doc.id ? { ...d, status: "active" as const } : d)));
      updateTotal();
      redraw();
      await load(routine.id);
      options.onChanged?.(routine.id);
    } catch (error) {
      busy.delete(doc.id);
      if (destroyed) return;
      docErrors.set(doc.id, `Couldn't ${kind === "approve" ? "approve" : "delete"} this — ${errorText(error)}`);
      redraw();
    }
  }

  async function submit(routine: RoutineSummary): Promise<void> {
    const draft = draftFor(routine.id);
    if (draft.busy || draft.reading || draftProblem(draft) || typeof bridge.addRoutineDoc !== "function") return;
    if ((lists.get(routine.id) ?? []).length >= DOC_CAP) return;
    draft.busy = true;
    draft.error = "";
    redraw();
    const input = { title: draft.title.trim(), text: draft.text, ...(draft.source.trim() ? { source: draft.source.trim() } : {}) };
    try {
      await bridge.addRoutineDoc(routine.id, input);
      if (destroyed) return;
      drafts.delete(routine.id);
      redraw();
      await load(routine.id);
      options.onChanged?.(routine.id);
    } catch (error) {
      draft.busy = false;
      if (destroyed) return;
      draft.error = `Couldn't add this — ${errorText(error)}`;
      redraw();
    }
  }

  async function pickFile(routine: RoutineSummary, file: File): Promise<void> {
    const draft = draftFor(routine.id);
    const reject = (message: string): void => {
      draft.reading = false;
      draft.note = "";
      draft.error = message;
      redraw();
    };
    const type = (file.type ?? "").toLowerCase();
    if (!FILE_EXTENSIONS.test(file.name ?? "") || (type && !type.startsWith("text/") && type !== "application/json")) {
      reject("Only plain text files can be added (.txt, .md, .csv or .json).");
      return;
    }
    if (file.size > FILE_BYTE_CEILING) {
      reject(`That file is too long. A document can be at most ${num(ROUTINE_LIBRARY_LIMITS.docChars)} characters.`);
      return;
    }
    draft.reading = true;
    draft.error = "";
    draft.note = "Reading the file…";
    redraw();
    let text: string;
    try {
      text = await readAsText(file);
    } catch (error) {
      if (!destroyed) reject(`Couldn't read that file — ${errorText(error)}`);
      return;
    }
    if (destroyed) return;
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const bad = (text.match(/�/g) ?? []).length;
    if (text.includes("\u0000") || bad > Math.max(2, text.length * 0.01)) {
      reject("That file doesn't look like plain text, so it wasn't added.");
      return;
    }
    if (text.length > ROUTINE_LIBRARY_LIMITS.docChars) {
      reject(`That file is ${num(text.length)} characters. A document can be at most ${num(ROUTINE_LIBRARY_LIMITS.docChars)}.`);
      return;
    }
    if (!text.trim()) {
      reject("That file is empty.");
      return;
    }
    draft.reading = false;
    draft.text = text;
    if (!draft.title.trim()) draft.title = file.name.replace(FILE_EXTENSIONS, "").slice(0, ROUTINE_LIBRARY_LIMITS.titleChars);
    draft.note = `Loaded ${clip(file.name, 60)}. Check it below, then add it.`;
    redraw();
  }

  // ── view ──────────────────────────────────────────────────────────────────
  const alertLine = (message: string): HTMLElement => {
    const err = el("p", "routine-row__error", message);
    err.setAttribute("role", "alert");
    return err;
  };

  const buildDoc = (routine: RoutineSummary, doc: RoutineDoc): HTMLElement => {
    const proposed = doc.status === "proposed";
    const item = el("li", `routine-doc routine-doc--${proposed ? "proposed" : "active"}`);
    item.dataset.docId = doc.id;
    const title = String(doc.title ?? "");
    const heading = el("p", "routine-doc__title", clip(title, TITLE_CLIP));
    if (title.length > TITLE_CLIP) heading.title = clip(title, 1000);
    item.append(heading);

    const meta = el("p", "routine-row__meta routine-doc__meta");
    const source = typeof doc.source === "string" ? doc.source.trim() : "";
    const parts: Array<string | HTMLElement> = [];
    if (source) {
      const node = el("span", "routine-doc__source", clip(source, SOURCE_CLIP));
      if (source.length > SOURCE_CLIP) node.title = clip(source, 1000);
      parts.push(node);
    }
    parts.push(doc.origin === "human" ? "added by you" : "added by an agent");
    const chars = Number(doc.chars) || 0;
    parts.push(`${num(chars)} ${chars === 1 ? "character" : "characters"}`);
    const when = el("time", undefined, new Date(doc.addedAt).toLocaleDateString());
    when.title = new Date(doc.addedAt).toLocaleString();
    parts.push(when);
    parts.forEach((part, index) => {
      if (index > 0) meta.append(" · ");
      meta.append(part);
    });
    item.append(meta);

    const isBusy = busy.has(doc.id);
    const expanded = proposed || open.has(doc.id);
    if (expanded) {
      const full = fulls.get(doc.id);
      const block = el("pre", "routine-doc__text");
      block.tabIndex = 0;
      block.setAttribute("role", "region");
      block.setAttribute("aria-label", `Text of ${clip(title, 60)}`);
      if (full?.doc) block.textContent = full.doc.text;
      else block.textContent = String(doc.excerpt ?? "");
      item.append(block);
      if (!full || full.loading) {
        const status = el("p", "routine-row__meta", "Loading the full text…");
        status.setAttribute("role", "status");
        item.append(status);
      } else if (full.error) {
        item.append(alertLine(`Couldn't load the text — ${full.error}`));
      } else if (!full.doc) {
        item.append(el("p", "routine-row__meta", "The full text isn't available."));
      }
    }

    const wrap = el("div", "routine-row__actions");
    if (confirming?.docId === doc.id) {
      const confirmId = `routine-doc-confirm-${doc.id}`;
      const question = el("p", "routine-row__confirm", proposed ? "Delete this document? You won't be able to get it back." : "Remove this document from the library? It won't be used again.");
      question.id = confirmId;
      const yes = btn(isBusy ? "Working…" : "Delete", "btn--danger", `doc-confirm:${doc.id}`, `Confirm: delete ${clip(title, 60)}`);
      yes.disabled = isBusy;
      const no = btn("Cancel", "btn--quiet", `doc-cancel:${doc.id}`);
      no.setAttribute("aria-describedby", confirmId);
      no.disabled = isBusy;
      yes.addEventListener("click", () => void decide(routine, doc, "delete"));
      no.addEventListener("click", () => {
        confirming = null;
        redraw();
        const back = Array.from(document.querySelectorAll<HTMLElement>("[data-lib]")).find((node) => node.dataset.lib === `doc-delete:${doc.id}`);
        back?.focus();
      });
      item.addEventListener("keydown", (event) => {
        if ((event as KeyboardEvent).key === "Escape" && confirming?.docId === doc.id) {
          event.preventDefault();
          event.stopPropagation();
          no.click();
        }
      });
      item.append(question, wrap);
      wrap.append(yes, no);
    } else {
      if (proposed) {
        const use = btn(isBusy ? "Working…" : "Use this", "btn--primary", `doc-approve:${doc.id}`, `Use this document: ${clip(title, 60)}`);
        use.disabled = isBusy;
        use.addEventListener("click", () => void decide(routine, doc, "approve"));
        wrap.append(use);
      } else {
        const read = btn(open.has(doc.id) ? "Hide" : "Read", "btn--quiet", `doc-read:${doc.id}`, `${open.has(doc.id) ? "Hide" : "Read"} ${clip(title, 60)}`);
        read.setAttribute("aria-expanded", String(open.has(doc.id)));
        read.addEventListener("click", () => {
          if (open.has(doc.id)) open.delete(doc.id);
          else {
            open.add(doc.id);
            if (!fulls.get(doc.id)?.doc) void loadFull(routine.id, doc.id);
          }
          redraw();
        });
        wrap.append(read);
      }
      const del = btn(proposed ? "Don't use" : "Delete", proposed ? "btn--ghost" : "btn--quiet", `doc-delete:${doc.id}`, `${proposed ? "Don't use" : "Delete"}: ${clip(title, 60)}`);
      del.disabled = isBusy;
      del.addEventListener("click", () => {
        confirming = { routineId: routine.id, docId: doc.id };
        redraw();
        const first = Array.from(document.querySelectorAll<HTMLElement>("[data-lib]")).find((node) => node.dataset.lib === `doc-cancel:${doc.id}`);
        first?.focus();
      });
      wrap.append(del);
      item.append(wrap);
    }
    const failure = docErrors.get(doc.id);
    if (failure) item.append(alertLine(failure));
    return item;
  };

  const buildForm = (routine: RoutineSummary, count: number): HTMLElement => {
    const draft = draftFor(routine.id);
    serial += 1;
    const base = `routine-lib-${serial}`;
    const form = el("div", "routine-lib__form");
    form.setAttribute("role", "group");
    form.setAttribute("aria-label", "Add a document");
    form.append(el("h6", "routine-lib__subheading", "Add a document"));

    const field = (labelText: string, id: string, control: HTMLElement): HTMLElement => {
      const wrap = el("div", "routine-lib__field");
      const label = el("label", undefined, labelText);
      label.htmlFor = id;
      control.id = id;
      wrap.append(label, control);
      return wrap;
    };

    const title = el("input");
    title.type = "text";
    title.maxLength = ROUTINE_LIBRARY_LIMITS.titleChars;
    title.value = draft.title;
    title.dataset.lib = "form-title";
    title.autocomplete = "off";
    const source = el("input");
    source.type = "text";
    source.maxLength = ROUTINE_LIBRARY_LIMITS.sourceChars;
    source.value = draft.source;
    source.dataset.lib = "form-source";
    source.autocomplete = "off";
    const text = el("textarea");
    text.rows = 6;
    text.value = draft.text;
    text.dataset.lib = "form-text";
    const file = el("input");
    file.type = "file";
    file.accept = ".txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json";
    file.dataset.lib = "form-file";
    file.disabled = draft.busy || draft.reading;

    const counter = el("p", "routine-row__meta routine-lib__counter");
    counter.setAttribute("aria-live", "polite");
    const hint = el("p", "routine-row__meta routine-lib__hint");
    const add = btn(draft.busy ? "Adding…" : "Add", "btn--primary", "form-add");
    const full = count >= DOC_CAP;

    const sync = (): void => {
      const length = draft.text.length;
      counter.textContent = `${num(length)} / ${num(ROUTINE_LIBRARY_LIMITS.docChars)} characters`;
      counter.classList.toggle("routine-lib__counter--over", length > ROUTINE_LIBRARY_LIMITS.docChars);
      const problem = draftProblem(draft);
      const touched = draft.title !== "" || draft.text !== "" || draft.source !== "";
      hint.textContent = full ? `This library is full (${DOC_CAP} documents). Delete one to add another.` : touched ? problem : "";
      text.setAttribute("aria-invalid", String(length > ROUTINE_LIBRARY_LIMITS.docChars));
      add.disabled = !!problem || full || draft.busy || draft.reading;
    };

    title.addEventListener("input", () => {
      draft.title = title.value;
      sync();
    });
    source.addEventListener("input", () => {
      draft.source = source.value;
      sync();
    });
    text.addEventListener("input", () => {
      draft.text = text.value;
      sync();
    });
    file.addEventListener("change", () => {
      const picked = file.files?.[0];
      if (picked) void pickFile(routine, picked);
    });
    add.addEventListener("click", () => void submit(routine));

    form.append(
      field("Title (required)", `${base}-title`, title),
      field("Source (optional, e.g. a link or where it came from)", `${base}-source`, source),
      field("Text", `${base}-text`, text),
      counter,
      field("Or load a text file (.txt, .md, .csv, .json)", `${base}-file`, file)
    );
    if (draft.note) {
      const note = el("p", "routine-row__meta", draft.note);
      note.setAttribute("role", "status");
      form.append(note);
    }
    if (draft.error) form.append(alertLine(draft.error));
    form.append(hint, add);
    sync();
    return form;
  };

  const build = (routine: RoutineSummary): HTMLElement => {
    const docs = orderDocs(lists.get(routine.id) ?? []);
    const section = el("section", "routine-detail__section routine-lib");
    section.dataset.library = routine.id;
    section.append(el("h5", "routine-detail__heading", "Reference library"));
    section.append(el("p", "routine-row__meta routine-lib__explain", LIBRARY_EXPLANATION));

    const loadError = loadErrors.get(routine.id);
    if (loadError) section.append(alertLine(`Couldn't load the library — ${loadError}`));
    if (!lists.has(routine.id) && !loadError) {
      const loading = el("p", "routine-row__meta", "Loading…");
      loading.setAttribute("role", "status");
      section.append(loading);
    } else {
      const chars = docs.reduce((sum, doc) => sum + (Number(doc.chars) || 0), 0);
      section.append(
        el(
          "p",
          "routine-row__meta routine-lib__usage",
          `${num(docs.length)} of ${DOC_CAP} documents · ${num(chars)} of ${num(ROUTINE_LIBRARY_LIMITS.totalChars)} characters used`
        )
      );
      const proposed = docs.filter((doc) => doc.status === "proposed");
      const active = docs.filter((doc) => doc.status !== "proposed");
      const drawn = [...proposed, ...active].slice(0, DOC_CAP);
      const shownProposed = drawn.filter((doc) => doc.status === "proposed");
      const shownActive = drawn.filter((doc) => doc.status !== "proposed");
      if (shownProposed.length > 0) {
        const wait = el("div", "routine-lib__review");
        wait.append(el("h6", "routine-lib__subheading", `Waiting for your review (${shownProposed.length})`));
        wait.append(el("p", "routine-row__meta", "An agent suggested these. A routine only uses a document after you approve it."));
        const list = el("ul", "routine-lib__list");
        for (const doc of shownProposed) list.append(buildDoc(routine, doc));
        wait.append(list);
        section.append(wait);
      }
      if (shownActive.length > 0) {
        const list = el("ul", "routine-lib__list");
        for (const doc of shownActive) list.append(buildDoc(routine, doc));
        section.append(list);
      } else if (shownProposed.length === 0) {
        section.append(el("p", "routine-row__meta", "No documents yet."));
      }
      if (docs.length > drawn.length) section.append(el("p", "routine-row__meta", `Showing ${drawn.length} of ${docs.length} documents.`));
      section.append(buildForm(routine, docs.length));
    }
    return section;
  };

  return {
    supported,
    toReview,
    total,
    prune,
    prefetch,
    load,
    build,
    destroy() {
      destroyed = true;
      unsubscribe?.();
      lists.clear();
      fulls.clear();
      drafts.clear();
      open.clear();
      busy.clear();
    },
  };
}
