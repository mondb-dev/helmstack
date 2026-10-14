/**
 * Deterministic natural-language assertion evaluation against a `PageGraph`
 * (ADR 0001 §4.3). No LLM calls: the assertion is normalised (synonyms,
 * plurals, quantifiers, negation, quoted literals) and matched against a small
 * grammar of supported forms. Anything outside that grammar yields an
 * `unsupported` result that never passes.
 *
 * Supported forms (see docs/agent-sdk.md "Natural Language Assertions"):
 *  - existence / counts:  "the page has a heading", "exactly 2 forms",
 *    "at least 3 links", "there are no error messages", "a 'Sign in' button"
 *  - visibility:          "the Save button is visible", "'Payment failed' is not shown"
 *  - state:               "the Export button is disabled", "the email field is required"
 *  - element text:        "the main heading is 'Dashboard'", "the error says 'Invalid'"
 *  - scoped:              "the login form has 2 fields"
 *  - page text:           "the page shows 'Welcome back'", "does not contain 'Error'"
 *  - title / URL:         "the title contains 'Acme'", "the URL ends with /login"
 *  - page kind:           "this is a login page"
 *  - accessible names:    "all buttons have accessible names"
 */
import type {
  AssertionConfidence,
  AssertionEvidence,
  AssertionResult,
  ObservedAlertTone,
  PageGraph,
  TabId
} from "../../../../shared/src/index.js";
import { classifyAlertText } from "../../../../perception/src/alert-tone.js";
import {
  canonicalize,
  describeQuantifier,
  lookupNoun,
  normalizeText,
  parseQuantifier,
  prepareAssertion,
  satisfies,
  singular,
  STOPWORDS,
  type AlertTone,
  type EntityType,
  type NounInfo,
  type Prepared,
  type Quantifier
} from "./assertion-lexicon.js";

export const SUPPORTED_ASSERTION_FORMS = [
  "the page has a heading",
  "there is a \"Sign in\" button",
  "exactly 2 forms / at least 3 links / no error messages",
  "the email field is required / the name field is empty",
  "the Export button is disabled",
  "the main heading is \"Dashboard\"",
  "the login form has 2 fields",
  "the page shows \"Welcome back\" / \"Payment failed\" is not visible",
  "the title contains \"Acme\" / the URL ends with /login"
];

type Verdict = {
  pass: boolean;
  confidence: AssertionConfidence;
  explanation: string;
  matched?: string[];
};

// ── Page items ───────────────────────────────────────────────────────────────

type Item = {
  type: EntityType;
  /** Visible label / accessible name / text. */
  label: string;
  /** Canonicalised text that hint words are matched against. */
  search: string;
  /** How the item is described in `matched`. */
  noun: string;
  disabled?: boolean;
  required?: boolean;
  fieldType?: string;
  formIndex?: number;
  /** Alerts: severity decided page-side from structure (see `perception/src/alert-tone.ts`). */
  tone?: ObservedAlertTone;
  /** Fields: whether a value is present (never the value). Undefined = not captured. */
  filled?: boolean;
};

/** Labels the DOM/AX extractors invent when an element has no accessible name. */
const FALLBACK_LABEL_RE = /^[a-z]+-\d+$/i;

function dedupe<T>(values: T[], key: (v: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter(v => {
    const k = key(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function makeItem(type: EntityType, noun: string, label: string, extra: string[] = [], rest: Partial<Item> = {}): Item {
  return { type, noun, label, search: canonicalize([label, ...extra].join(" ")), ...rest };
}

function interactive(graph: PageGraph, roles: string[]) {
  return graph.accessibility.interactiveNodes.filter(n => roles.includes(n.role));
}

function collectItems(graph: PageGraph, type: EntityType, formIndexes?: number[]): Item[] {
  const inForms = (i: number) => !formIndexes || formIndexes.includes(i);
  switch (type) {
    case "heading":
      return dedupe([...graph.headings, ...graph.accessibility.headingTrail], h => normalizeText(h))
        .map(h => makeItem("heading", "heading", h));
    case "button":
    case "link":
    case "action": {
      const source = formIndexes
        ? graph.forms.filter((_, i) => inForms(i)).flatMap(f => f.submitActions)
        : graph.actions;
      const items: Item[] = [];
      for (const a of source) {
        const isLink = a.kind === "link" || (a.kind === "oauth" && !!a.href);
        if (type === "link" && !isLink) continue;
        if (type === "button" && isLink) continue;
        const noun = isLink ? "link" : "button";
        items.push(makeItem(noun, noun, a.label, [a.kind, a.provider ?? "", a.href ? safePath(a.href) : ""], { disabled: a.disabled }));
      }
      if (!formIndexes) {
        const roles = type === "button" ? ["button"] : type === "link" ? ["link"] : ["button", "link"];
        const known = new Set(items.map(i => normalizeText(i.label)));
        for (const n of interactive(graph, roles)) {
          if (n.name && known.has(normalizeText(n.name))) continue;
          items.push(makeItem(n.role === "link" ? "link" : "button", n.role, n.name ?? ""));
        }
      }
      return items;
    }
    case "field": {
      const fields = graph.forms.flatMap((f, i) => (inForms(i) ? f.fields.map(field => ({ field, i })) : []));
      if (fields.length > 0 || formIndexes) {
        return fields.map(({ field, i }) => makeItem("field", "field", field.label || field.name || field.id,
          [field.name ?? "", field.placeholder ?? "", field.fieldType, field.autocomplete ?? "", field.id],
          { required: field.required, fieldType: field.fieldType, formIndex: i, filled: field.filled }));
      }
      return interactive(graph, ["textbox", "checkbox", "comboBox", "radioButton", "searchbox"])
        .map(n => makeItem("field", "field", n.name ?? "", [n.role]));
    }
    case "form":
      return graph.forms.map((f, i) => makeItem("form", "form", f.name ?? f.purpose,
        [f.purpose, f.purpose === "auth" ? "login" : "", f.id], { formIndex: i }));
    case "alert":
      return alertItems(graph);
    case "dialog":
      return countItems("dialog", roleCount(graph, ["dialog", "alertdialog"]));
    case "image":
      return countItems("image", roleCount(graph, ["img", "image"]));
    case "navigation":
      return countItems("navigation", roleCount(graph, ["navigation"]));
    case "video":
    case "audio":
      return graph.media.filter(m => m.kind === type).map(m => makeItem(type, type, m.title ?? m.src ?? "", [m.src ?? ""]));
  }
}

/**
 * Alerts with their tone. Prefers the extractor's structural classification
 * (`alertDetails`); graphs from older extractors fall back to whole-word text
 * classification, never substring matching.
 */
function alertItems(graph: PageGraph): Item[] {
  const details = graph.alertDetails;
  if (details && details.length > 0) {
    return details.map(d => makeItem("alert", "alert", d.text, [], { tone: d.tone }));
  }
  return graph.alerts.map(a => makeItem("alert", "alert", a, [], { tone: classifyAlertText(a) }));
}

function countItems(type: EntityType, n: number): Item[] {
  return Array.from({ length: n }, () => makeItem(type, type, ""));
}

function roleCount(graph: PageGraph, roles: string[]): number {
  return roles.reduce((sum, r) => sum + (graph.accessibility.roleCounts[r] ?? 0), 0);
}

/** AX role counts that can exceed the (capped) extracted lists. */
const ROLE_COUNTS: Partial<Record<EntityType, string[]>> = {
  heading: ["heading"],
  button: ["button"],
  link: ["link"],
  field: ["textbox", "checkbox", "comboBox", "radioButton", "searchbox"]
};

/** Types whose items carry no label: hint words cannot be checked. */
const UNLABELLED: EntityType[] = ["dialog", "image", "navigation"];

function safePath(href: string): string {
  try { return new URL(href).pathname; } catch { return href; }
}

/** Every text snippet the graph captured, tagged with where it came from. */
function textCorpus(graph: PageGraph): Array<{ source: string; text: string }> {
  const out: Array<{ source: string; text: string }> = [];
  const add = (source: string, text: string | undefined) => { if (text && text.trim()) out.push({ source, text }); };
  add("title", graph.title);
  for (const h of graph.headings) add("heading", h);
  for (const h of graph.accessibility.headingTrail) add("heading", h);
  for (const a of graph.actions) add(a.kind === "link" ? "link" : "button", a.label);
  for (const a of graph.alerts) add("alert", a);
  for (const f of graph.forms) {
    add("form", f.name);
    for (const field of f.fields) { add("field", field.label); add("placeholder", field.placeholder); }
  }
  for (const n of graph.accessibility.interactiveNodes) add(n.role, n.name);
  for (const m of graph.media) add(m.kind, m.title);
  for (const p of graph.social?.posts ?? []) add("post", p.text);
  return dedupe(out, o => `${o.source}|${normalizeText(o.text)}`);
}

function textContains(haystack: string, needle: string): boolean {
  const n = normalizeText(needle);
  if (!n) return false;
  return normalizeText(haystack).includes(n) || canonicalize(haystack).includes(canonicalize(needle));
}

function describe(item: Item): string {
  const flags = [item.disabled ? "disabled" : "", item.required ? "required" : ""].filter(Boolean);
  const label = item.label ? ` "${item.label}"` : "";
  return `${item.noun}${label}${flags.length ? ` (${flags.join(", ")})` : ""}`;
}

// ── Element phrases ──────────────────────────────────────────────────────────

type EntityTarget = {
  kind: "entity";
  quant: Quantifier;
  noun: NounInfo;
  nounWord: string;
  plural: boolean;
  hints: string[];
  /** Quoted literal the label must contain. */
  literal?: string;
  tone?: AlertTone;
  required?: boolean;
  disabled?: boolean;
  first?: boolean;
};
type TextTarget = { kind: "text"; quant: Quantifier; text: string; quoted: boolean };
type UnknownNounTarget = { kind: "unknown"; quant: Quantifier; noun: string; words: string[] };
type Target = EntityTarget | TextTarget | UnknownNounTarget;

const INTRODUCERS = new Set([
  "labeled", "labelled", "named", "called", "titled", "entitled", "saying", "reading", "containing",
  "says", "reads", "contains", "with", "to", "for", "that", "which", "about", "showing", "displaying", "mentioning"
]);
const INTRODUCER_FILLERS = new Set([
  "the", "a", "an", "text", "label", "name", "accessible", "aria-label", "title", "caption", "says", "reads",
  "contains", "shows", "of", "is", "value", "wording", "copy"
]);
const QUOTE_TOKEN = /^__q(\d+)__$/;

function quoteOf(token: string, prep: Prepared): string | undefined {
  const m = token.match(QUOTE_TOKEN);
  return m ? prep.quotes[Number(m[1])] : undefined;
}

function resolveValue(words: string, prep: Prepared): { value: string; quoted: boolean } {
  const tokens = words.trim().split(" ").filter(Boolean);
  const quoted = tokens.map(t => quoteOf(t, prep)).filter((q): q is string => q !== undefined);
  if (quoted.length > 0) return { value: quoted.join(" "), quoted: true };
  return { value: tokens.join(" "), quoted: false };
}

/**
 * Parse an element phrase ("a required email field", "the 'Sign in' button",
 * "no error messages", "a link named Settings", "the text 'Hi'") into a target.
 * `allowBareText` lets unquoted phrases without an element noun be text checks.
 */
function parseTarget(phrase: string, prep: Prepared, allowBareText: boolean): Target | null {
  const { quant, rest } = parseQuantifier(phrase.trim());
  if (!rest) return null;

  const textMatch = rest.match(/^(?:the\s+)?(?:text|words?|string|copy|phrase|wording)\s+(.+)$/);
  if (textMatch) {
    const { value, quoted } = resolveValue(textMatch[1], prep);
    return value ? { kind: "text", quant, text: value, quoted } : null;
  }

  const tokens = rest.split(" ").filter(Boolean);
  const nounIndexes = tokens.map((t, i) => (lookupNoun(t) ? i : -1)).filter(i => i >= 0);
  let introIndex = -1;
  if (nounIndexes.length > 0) {
    introIndex = tokens.findIndex((t, i) => i > nounIndexes[0] && INTRODUCERS.has(t));
  }
  const pre = introIndex >= 0 ? tokens.slice(0, introIndex) : tokens;
  const post = introIndex >= 0 ? tokens.slice(introIndex + 1) : [];

  let head = -1;
  for (let i = pre.length - 1; i >= 0; i--) {
    if (lookupNoun(pre[i])) { head = i; break; }
  }

  if (head < 0) {
    const quotes = tokens.map(t => quoteOf(t, prep)).filter((q): q is string => q !== undefined);
    const plainWords = tokens.filter(t => !QUOTE_TOKEN.test(t) && !STOPWORDS.has(t));
    if (quotes.length > 0 && plainWords.length === 0) {
      return { kind: "text", quant, text: quotes.join(" "), quoted: true };
    }
    if (quant.explicit && plainWords.length > 0) {
      return { kind: "unknown", quant, noun: plainWords[plainWords.length - 1], words: plainWords };
    }
    if (allowBareText && plainWords.length > 0 && quotes.length === 0) {
      return { kind: "text", quant, text: plainWords.join(" "), quoted: false };
    }
    return null;
  }

  const nounWord = pre[head];
  const noun = lookupNoun(nounWord)!;
  const target: EntityTarget = {
    kind: "entity", quant, noun, nounWord, plural: nounWord.endsWith("s") && nounWord !== "status",
    hints: [], tone: noun.tone
  };
  const literals: string[] = [];
  const labelWords: string[] = [];

  const absorb = (word: string, asLabel: boolean) => {
    const q = quoteOf(word, prep);
    if (q !== undefined) { literals.push(q); return; }
    if (word === "required" || word === "mandatory") { target.required = true; return; }
    if (word === "optional") { target.required = false; return; }
    if (word === "disabled" || word === "inactive") { target.disabled = true; return; }
    if (word === "enabled" || word === "active" || word === "clickable") { target.disabled = false; return; }
    if (noun.type === "heading" && ["main", "primary", "first", "top", "page"].includes(word)) {
      if (word !== "page") target.first = true;
      return;
    }
    if (noun.type === "alert") {
      if (/^(errors?|validation|failure|failed|invalid)$/.test(word)) { target.tone = "error"; return; }
      if (/^warnings?$/.test(word)) { target.tone = "warning"; return; }
      if (/^(success|successful|confirmation|status)$/.test(word)) { if (word !== "status") target.tone = "success"; return; }
    }
    if (STOPWORDS.has(word) || /^(main|primary)$/.test(word)) return;
    if (!asLabel && lookupNoun(word)) return; // "form field" → field; "dialog's button" → button
    (asLabel ? labelWords : target.hints).push(word.replace(/'s$/, ""));
  };
  pre.slice(0, head).forEach(w => absorb(w, false));
  pre.slice(head + 1).forEach(w => absorb(w, true));
  const postWords = [...post];
  while (postWords.length && INTRODUCER_FILLERS.has(postWords[0])) postWords.shift();
  postWords.forEach(w => absorb(w, true));

  if (literals.length > 0) target.literal = literals.join(" ");
  target.hints.push(...labelWords);
  if (noun.headingLevel && nounWord.startsWith("h1")) target.first = true;
  return target;
}

function hintMatches(item: Item, hints: string[]): boolean {
  if (hints.length === 0) return true;
  if (hints.every(h => new RegExp(`(^|[^\\w])${escapeRe(h)}`).test(item.search))) return true;
  // "sign in" vs "signin", "new order" vs "neworder"
  return item.search.replace(/\s+/g, "").includes(hints.join(""));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type Resolution = { items: Item[]; count: number; notes: string[]; confidence: AssertionConfidence };

function resolveEntity(graph: PageGraph, t: EntityTarget, formIndexes?: number[]): Resolution {
  const notes: string[] = [];
  let confidence: AssertionConfidence = "high";
  let items = collectItems(graph, t.noun.type, formIndexes);
  if (t.noun.fieldType) items = items.filter(i => i.fieldType === t.noun.fieldType || i.search.includes(t.noun.fieldType!));
  if (t.tone) {
    const undecided = items.filter(i => i.tone === "unknown").length;
    items = items.filter(i => i.tone === t.tone);
    if (undecided > 0) {
      notes.push(`${undecided} message(s) could not be classified as error, warning or success and were not counted`);
      if (items.length === 0) confidence = "medium";
    }
  }
  if (t.first) {
    items = items.slice(0, 1);
    if (t.noun.headingLevel) { notes.push("heading levels are not captured; using the page's top heading"); confidence = "medium"; }
  } else if (t.noun.headingLevel) {
    notes.push("heading levels are not captured; counting all headings");
    confidence = "medium";
  }
  if (t.required !== undefined) items = items.filter(i => i.required === t.required);
  if (t.disabled !== undefined) items = items.filter(i => i.disabled === t.disabled);

  const labelled = t.literal !== undefined || t.hints.length > 0;
  if (UNLABELLED.includes(t.noun.type)) {
    if (labelled) { notes.push(`${t.noun.type} names are not captured; ignoring the description`); confidence = "medium"; }
  } else {
    if (t.literal !== undefined) items = items.filter(i => textContains(i.label, t.literal!));
    if (t.hints.length > 0) {
      items = items.filter(i => hintMatches(i, t.hints));
      confidence = "medium";
    }
  }

  let count = items.length;
  const filtered = labelled || t.tone || t.first || t.required !== undefined || t.disabled !== undefined || t.noun.fieldType;
  const roles = ROLE_COUNTS[t.noun.type];
  if (!filtered && !formIndexes && roles) count = Math.max(count, roleCount(graph, roles));
  return { items, count, notes, confidence };
}

function describeTarget(t: EntityTarget): string {
  const parts = [
    t.required === true ? "required" : t.required === false ? "optional" : "",
    t.disabled === true ? "disabled" : t.disabled === false ? "enabled" : "",
    t.tone && t.tone !== "error" ? t.tone : "",
    ...t.hints,
    t.tone === "error" ? "error" : t.noun.type === "action" ? "button/link" : t.noun.type,
    t.literal !== undefined ? `"${t.literal}"` : ""
  ].filter(Boolean);
  return parts.join(" ");
}

function joinNotes(notes: string[]): string {
  return notes.length ? ` (${notes.join("; ")})` : "";
}

// ── Target evaluation ────────────────────────────────────────────────────────

function evaluateTarget(graph: PageGraph, t: Target, formIndexes?: number[]): Verdict {
  if (t.kind === "entity") {
    const r = resolveEntity(graph, t, formIndexes);
    const ok = satisfies(r.count, t.quant);
    const what = describeTarget(t);
    const scope = formIndexes ? " in the form" : "";
    const expectation = describeQuantifier(t.quant);
    return {
      pass: ok,
      confidence: r.confidence,
      explanation: `Expected ${expectation} ${what}${t.literal === undefined ? "(s)" : ""}${scope}; found ${r.count}.${joinNotes(r.notes)}`,
      matched: r.items.slice(0, 8).map(describe)
    };
  }
  if (t.kind === "text") {
    const hits = textCorpus(graph).filter(c => textContains(c.text, t.text));
    const ok = satisfies(hits.length, t.quant);
    const shown = `"${t.text}"`;
    const matched = hits.slice(0, 8).map(h => `${h.source} "${h.text}"`);
    const confidence: AssertionConfidence = t.quoted ? (hits.length > 0 ? "high" : "medium") : "medium";
    const where = hits.length > 0 ? `found in ${matched.slice(0, 3).join(", ")}` : "not found in the captured page text (title, headings, buttons, links, labels, alerts; body copy is not captured)";
    return { pass: ok, confidence, explanation: `Text ${shown} ${where}.`, matched };
  }
  // Unknown noun: fall back to the page text, e.g. "3 items" in "3 items in your cart".
  const noun = singular(t.noun);
  const corpus = textCorpus(graph);
  if (t.quant.op === "eq" && t.quant.n > 0) {
    const re = new RegExp(`(^|[^\\d])${t.quant.n}\\s+${escapeRe(noun)}`, "i");
    const hit = corpus.find(c => re.test(normalizeText(c.text)));
    if (hit) return { pass: true, confidence: "medium", explanation: `Text "${hit.text}" (${hit.source}) states ${t.quant.n} ${t.noun}.`, matched: [`${hit.source} "${hit.text}"`] };
    return { pass: false, confidence: "low", explanation: `"${t.noun}" is not an element type the evaluator can count, and no text like "${t.quant.n} ${t.noun}" was captured.`, matched: [] };
  }
  const words = t.words.join(" ");
  const hits = corpus.filter(c => textContains(c.text, words) || textContains(c.text, noun));
  const ok = satisfies(hits.length > 0 ? Math.max(1, hits.length) : 0, t.quant);
  return {
    pass: ok,
    confidence: "low",
    explanation: `"${t.noun}" is not an element type the evaluator recognises; checked captured page text for "${words}" (${hits.length} match(es)).`,
    matched: hits.slice(0, 8).map(h => `${h.source} "${h.text}"`)
  };
}

function negate(v: Verdict): Verdict {
  return { ...v, pass: !v.pass, explanation: `Negated: ${v.explanation}` };
}

/** "X is not visible" / "does not show X": "none" when no count was given, else NOT(count). */
function evaluateNegated(graph: PageGraph, t: Target): Verdict {
  if (!t.quant.explicit) return evaluateTarget(graph, { ...t, quant: { op: "eq", n: 0, explicit: true } } as Target);
  return negate(evaluateTarget(graph, t));
}

// ── String predicates (title / URL) ──────────────────────────────────────────

function evaluateStringPredicate(subject: string, actual: string, predicate: string, prep: Prepared, isUrl: boolean): Verdict | null {
  const p = predicate.trim();
  const shown = `${subject} is "${actual}"`;
  if (/^(?:exists|is present|is set|is not empty|has a value)$/.test(p)) {
    return { pass: actual.trim().length > 0, confidence: "high", explanation: actual.trim() ? `${shown}.` : `The page has no ${subject}.`, matched: [actual] };
  }
  if (/^(?:is empty|is missing|is blank|does not exist)$/.test(p)) {
    return { pass: actual.trim().length === 0, confidence: "high", explanation: actual.trim() ? `${shown}, not empty.` : `The page has no ${subject}.`, matched: [actual] };
  }
  const m = p.match(/^(does not\s+|do not\s+|is not\s+)?(is|equals?|=|reads?|says?|contains?|includes?|has|shows?|mentions?|matches|match|starts with|start with|begins with|begin with|ends with|end with)\s+(?:exactly\s+)?(.+)$/)
    ?? p.match(/^(is not\s+|isnt\s+)()(.+)$/);
  if (!m) return null;
  const negated = !!m[1];
  const verb = m[2] || "is";
  const { value } = resolveValue(m[3], prep);
  if (!value) return null;

  const a = normalizeText(actual);
  const v = normalizeText(value);
  const ca = canonicalize(actual);
  const cv = canonicalize(value);
  let pass: boolean;
  let confidence: AssertionConfidence = "high";
  let how: [string, string];
  if (/^(starts|start|begins|begin) with$/.test(verb)) {
    const path = isUrl ? normalizeText(safePath(actual)) : a;
    pass = a.startsWith(v) || path.startsWith(v) || ca.startsWith(cv);
    how = ["starts with", "does not start with"];
  } else if (/^(ends|end) with$/.test(verb)) {
    const trimmed = a.replace(/\/+$/, "");
    pass = a.endsWith(v) || trimmed.endsWith(v.replace(/\/+$/, "")) || ca.endsWith(cv);
    how = ["ends with", "does not end with"];
  } else if (/^(is|equals?|=|reads?|says?)$/.test(verb)) {
    const path = isUrl ? normalizeText(safePath(actual)).replace(/\/+$/, "") : "";
    const exact = a === v || ca === cv || (isUrl && path !== "" && path === v.replace(/\/+$/, ""));
    if (exact) {
      pass = true;
      how = ["equals", "does not equal"];
    } else if (a.includes(v) || ca.includes(cv)) {
      // "title is 'Dashboard'" on "Dashboard | Acme": agents rarely mean strict equality.
      pass = !negated;
      confidence = "medium";
      return {
        pass,
        confidence,
        explanation: `${shown}: contains "${value}" but is not an exact match${negated ? " (assertion is negated)" : ""}.`,
        matched: [actual]
      };
    } else {
      pass = false;
      how = ["equals", "does not equal"];
    }
  } else {
    pass = a.includes(v) || ca.includes(cv);
    how = ["contains", "does not contain"];
  }
  return {
    pass: negated ? !pass : pass,
    confidence,
    explanation: `${shown}; it ${pass ? how[0] : how[1]} "${value}"${negated ? " (assertion is negated)" : ""}.`,
    matched: [actual]
  };
}

// ── Grammar ──────────────────────────────────────────────────────────────────

type Ctx = { graph: PageGraph; prep: Prepared };
type Handler = (s: string, ctx: Ctx) => Verdict | null;

const ENTITY_VERBS = "has|have|contains?|includes?|shows?|displays?|lists?|renders?|presents?|features?";

function asEntity(phrase: string, prep: Prepared): EntityTarget | null {
  const t = parseTarget(phrase, prep, false);
  return t && t.kind === "entity" ? t : null;
}

const titleHandler: Handler = (s, { graph, prep }) => {
  const m = s.match(/^(?:the\s+)?(?:page\s+|document\s+|tab\s+|browser\s+|window\s+)?title(?:\s+of\s+the\s+(?:page|document|tab))?(?:\s+(.+))?$/);
  if (m) return evaluateStringPredicate("the page title", graph.title, m[1] ?? "exists", prep, false);
  const titled = s.match(/^(?:the\s+)?(?:page|document|tab)\s+(is\s+not\s+|is\s+)?(?:titled|entitled)\s+(.+)$/);
  if (titled) return evaluateStringPredicate("the page title", graph.title, `${titled[1]?.includes("not") ? "is not " : "is "}${titled[2]}`, prep, false);
  const has = s.match(/^(?:the\s+)?(?:page|document)\s+(has|does not have)\s+(?:a|an|the|no)\s+title$/);
  if (has) {
    const wantTitle = has[1] === "has" && !/\bno title$/.test(s);
    return evaluateStringPredicate("the page title", graph.title, wantTitle ? "exists" : "is empty", prep, false);
  }
  return null;
};

const urlHandler: Handler = (s, { graph, prep }) => {
  const m = s.match(/^(?:the\s+)?(?:current\s+|page\s+|browser\s+|page's\s+)?(?:url|address|location|path|pathname|route)\s+(.+)$/);
  if (m) return evaluateStringPredicate("the URL", graph.url, m[1], prep, true);
  const on = s.match(/^(?:the\s+)?(?:page|browser|user|we|i|it|app)\s+(?:is|am|has|was)\s+(not\s+)?(?:on|at|navigated to|redirected to|been redirected to)\s+(?:the\s+)?(\S+)(?:\s+page)?$/);
  if (on && /^(\/|https?:|__q)/.test(on[2])) {
    return evaluateStringPredicate("the URL", graph.url, `${on[1] ? "does not " : ""}contains ${on[2]}`, prep, true);
  }
  return null;
};

const PAGE_KINDS = new Set(["landing", "signup", "login", "checkout", "form", "dashboard"]);
const pageKindHandler: Handler = (s, { graph }) => {
  const m = s.match(/^(?:this|the page|the current page|it)\s+is\s+(not\s+)?(?:a|an|the)\s+([\w-]+)\s+page$/);
  if (!m || !PAGE_KINDS.has(m[2])) return null;
  const isKind = graph.kind === m[2];
  return {
    pass: m[1] ? !isKind : isKind,
    confidence: "medium",
    explanation: `The page is classified as "${graph.kind}".`,
    matched: [`page kind "${graph.kind}"`]
  };
};

const accessibleNamesHandler: Handler = (s, { graph, prep }) => {
  const all = s.match(/^(?:all|every|each)\s+(?:of\s+the\s+)?(\w+)\s+(?:has|have|is)\s+(?:an?\s+)?(?:accessible\s+names?|accessible\s+labels?|labels?|names?|aria-labels?|text|labell?ed)$/);
  if (all) {
    const noun = lookupNoun(all[1]);
    if (!noun || !["button", "link", "field", "action"].includes(noun.type)) return null;
    const items = collectItems(graph, noun.type);
    const roles = noun.type === "field" ? ["textbox", "checkbox", "comboBox", "radioButton", "searchbox"]
      : noun.type === "action" ? ["button", "link"] : [noun.type];
    const unnamed = items.filter(i => !i.label.trim() || FALLBACK_LABEL_RE.test(i.label.trim()));
    const unnamedAx = interactive(graph, roles).filter(n => !n.name?.trim()).length;
    const bad = Math.max(unnamed.length, unnamedAx);
    return {
      pass: bad === 0,
      confidence: "high",
      explanation: bad === 0
        ? `All ${items.length} ${noun.type}(s) have an accessible name.`
        : `${bad} ${noun.type}(s) have no accessible name.`,
      matched: unnamed.slice(0, 8).map(describe)
    };
  }
  const one = s.match(/^(.+?)\s+(has|have|does not have|lacks)\s+(?:an?\s+)?(?:accessible\s+name|aria-label)$/);
  if (one) {
    const t = asEntity(one[1], prep);
    if (!t) return null;
    const r = resolveEntity(graph, t);
    const named = r.items.filter(i => i.label.trim() && !FALLBACK_LABEL_RE.test(i.label.trim()));
    const positive = named.length > 0;
    const negated = one[2] !== "has" && one[2] !== "have";
    return {
      pass: negated ? r.items.length > 0 && !positive : positive,
      confidence: r.confidence,
      explanation: r.items.length === 0 ? `No ${describeTarget(t)} found.` : `${named.length} of ${r.items.length} matching ${t.noun.type}(s) have an accessible name.`,
      matched: r.items.slice(0, 8).map(describe)
    };
  }
  return null;
};

/** Pick the item a singular subject refers to: exact label match first. */
function pickSubject(r: Resolution, t: EntityTarget): Item[] {
  if (t.plural) return r.items;
  if (t.literal) {
    const exact = r.items.find(i => normalizeText(i.label) === normalizeText(t.literal!));
    if (exact) return [exact];
  }
  return r.items.slice(0, 1);
}

function subjectTarget(phrase: string, prep: Prepared, defaultType: EntityType): EntityTarget | null {
  const t = parseTarget(phrase, prep, true);
  if (!t) return null;
  if (t.kind === "entity") return t;
  // "Save is disabled" / "'Email' is required": the subject is a bare label.
  const literal = t.kind === "text" && t.quoted ? t.text : undefined;
  const hints = t.kind === "text" && !t.quoted ? t.text.split(" ") : t.kind === "unknown" ? t.words : [];
  return {
    kind: "entity", quant: t.quant, noun: { type: defaultType }, nounWord: defaultType, plural: false,
    hints, literal
  };
}

const stateHandler: Handler = (s, { graph, prep }) => {
  const m = s.match(/^(.+?)\s+is\s+(not\s+)?(disabled|enabled|clickable|active|inactive|greyed out|grayed out|interactive|usable)$/);
  if (!m) return null;
  const t = subjectTarget(m[1], prep, "action");
  if (!t || !["button", "link", "action", "field"].includes(t.noun.type)) return null;
  const r = resolveEntity(graph, t);
  const subjects = pickSubject(r, t);
  const wantDisabled = /disabled|inactive|out/.test(m[3]) !== !!m[2];
  if (subjects.length === 0) {
    return { pass: false, confidence: "medium", explanation: `No ${describeTarget(t)} was found, so its state cannot be ${wantDisabled ? "disabled" : "enabled"}.`, matched: [] };
  }
  if (t.noun.type === "field") return null; // field disabled state is not captured
  const ok = subjects.every(i => i.disabled === wantDisabled);
  return {
    pass: ok,
    confidence: r.confidence === "high" || t.literal ? "high" : "medium",
    explanation: subjects.map(i => `${describe(i)} is ${i.disabled ? "disabled" : "enabled"}`).join("; ") + `; expected ${wantDisabled ? "disabled" : "enabled"}.`,
    matched: subjects.map(describe)
  };
};

const requiredHandler: Handler = (s, { graph, prep }) => {
  const m = s.match(/^(.+?)\s+is\s+(not\s+)?(?:a\s+|an\s+|marked\s+(?:as\s+)?)?(required|optional|mandatory)(?:\s+(?:field|input))?$/);
  if (!m) return null;
  const t = subjectTarget(m[1], prep, "field");
  if (!t || t.noun.type !== "field") return null;
  const r = resolveEntity(graph, t);
  const subjects = pickSubject(r, t);
  const wantRequired = (m[3] !== "optional") !== !!m[2];
  if (subjects.length === 0) {
    return { pass: false, confidence: "medium", explanation: `No ${describeTarget(t)} was found.`, matched: [] };
  }
  const ok = subjects.every(i => i.required === wantRequired);
  return {
    pass: ok,
    confidence: r.confidence,
    explanation: subjects.map(i => `${describe(i)} is ${i.required ? "required" : "optional"}`).join("; ") + `; expected ${wantRequired ? "required" : "optional"}.`,
    matched: subjects.map(describe)
  };
};

const emptinessHandler: Handler = (s, { graph, prep }) => {
  const m = s.match(/^(.+?)\s+(?:is|has)\s+(not\s+|no\s+)?(empty|blank|filled(?:\s+in)?|a value|populated|unset)$/);
  if (!m) return null;
  const wantEmpty = (m[3] === "empty" || m[3] === "blank" || m[3] === "unset") !== !!m[2];
  const t = subjectTarget(m[1], prep, "field");
  if (!t || t.noun.type !== "field") return null;
  const r = resolveEntity(graph, t);
  const subjects = pickSubject(r, t);
  if (subjects.length === 0) {
    return { pass: false, confidence: "medium", explanation: `No ${describeTarget(t)} was found.`, matched: [] };
  }
  if (subjects.some(i => i.filled === undefined)) {
    return {
      pass: false,
      confidence: "low",
      explanation: `Whether ${describeTarget(t)} holds a value was not captured by this observation (older extractor); ` +
        `use browser_evaluate on the field if you need it. Field values are never included in the page graph.`,
      matched: subjects.map(describe)
    };
  }
  const ok = subjects.every(i => i.filled === !wantEmpty);
  return {
    pass: ok,
    confidence: r.confidence,
    explanation: subjects.map(i => `${describe(i)} is ${i.filled ? "filled" : "empty"}`).join("; ") + `; expected ${wantEmpty ? "empty" : "filled"}.`,
    matched: subjects.map(describe)
  };
};

const VISIBLE = "visible|shown|displayed|present|rendered|showing|open|opened|available|in view|there|listed|on the page";
const HIDDEN = "hidden|gone|absent|missing|closed|invisible|not there";
const visibilityHandler: Handler = (s, { graph, prep }) => {
  const m = s.match(new RegExp(`^(.+?)\\s+(?:is\\s+(not\\s+)?(?:${VISIBLE})|(does not\\s+|do not\\s+)?(?:appears?|exists?|shows? up)|is\\s+(${HIDDEN}))$`));
  if (!m) return null;
  const negated = !!m[2] || !!m[3] || !!m[4];
  const subject = m[1].replace(/^there\s+is\s+/, "");
  const t = parseTarget(subject, prep, true);
  if (!t) return null;
  return negated ? evaluateNegated(graph, t) : evaluateTarget(graph, t);
};

const scopedFormHandler: Handler = (s, { graph, prep }) => {
  const m = s.match(new RegExp(`^(.+?)\\s+(does not\\s+|do not\\s+)?(?:${ENTITY_VERBS})\\s+(.+)$`));
  if (!m) return null;
  const subject = asEntity(m[1], prep);
  if (!subject || subject.noun.type !== "form") return null;
  const target = parseTarget(m[3], prep, false);
  if (!target || target.kind !== "entity") return null;
  const forms = resolveEntity(graph, { ...subject, quant: { op: "gte", n: 1, explicit: false } });
  const indexes = forms.items.map(f => f.formIndex!).filter(i => i !== undefined);
  if (indexes.length === 0) {
    return { pass: !!m[2], confidence: forms.confidence, explanation: `No ${describeTarget(subject)} was found.`, matched: [] };
  }
  const perForm = indexes.map(i => ({ i, v: evaluateTarget(graph, target, [i]) }));
  const hit = perForm.find(p => p.v.pass);
  const chosen = hit ?? perForm[0];
  const formName = describe(forms.items[indexes.indexOf(chosen.i)]);
  const v: Verdict = { ...chosen.v, explanation: `${formName}: ${chosen.v.explanation}` };
  return m[2] ? negate(v) : v;
};

const CONTAINER_TYPES: EntityType[] = ["heading", "button", "link", "action", "alert", "field"];
const containerTextHandler: Handler = (s, { graph, prep }) => {
  const m = s.match(/^(.+?)\s+(does not\s+|is not\s+)?(says?|reads?|shows?|displays?|contains?|includes?|is|equals?|matches|mentions?|has text|has the text|text is)\s+(.+)$/);
  if (!m) return null;
  const t = asEntity(m[1], prep);
  if (!t || !CONTAINER_TYPES.includes(t.noun.type) || t.literal) return null;
  let negated = !!m[2];
  let valuePhrase = m[4];
  if (m[3] === "is" && valuePhrase.startsWith("not ")) { negated = !negated; valuePhrase = valuePhrase.slice(4); }
  const valueTarget = parseTarget(valuePhrase, prep, true);
  if (!valueTarget || valueTarget.kind !== "text") return null;
  const value = valueTarget.text;
  const r = resolveEntity(graph, t);
  const exactVerb = /^(is|equals?)$/.test(m[3]);
  const exact = r.items.filter(i => normalizeText(i.label) === normalizeText(value));
  const contains = r.items.filter(i => textContains(i.label, value));
  const hits = exactVerb && exact.length > 0 ? exact : contains;
  const positive = hits.length > 0;
  const what = describeTarget(t);
  const confidence: AssertionConfidence = exactVerb && exact.length === 0 && positive ? "medium" : r.confidence;
  const explanation = r.items.length === 0
    ? `No ${what} was found.`
    : positive
      ? `${describe(hits[0])} ${exactVerb && exact.length === 0 ? "contains" : "matches"} "${value}".`
      : `No ${what} has text "${value}" (candidates: ${r.items.slice(0, 4).map(i => `"${i.label}"`).join(", ")}).`;
  return {
    pass: negated ? !positive : positive,
    confidence,
    explanation: negated ? `Negated: ${explanation}` : explanation,
    matched: (positive ? hits : r.items).slice(0, 8).map(describe)
  };
};

const existenceHandler: Handler = (s, { graph, prep }) => {
  let negated = false;
  let phrase: string | null = null;
  let textVerb = false;

  const there = s.match(/^there\s+(?:is|exists?)\s+(not\s+)?(.+)$/);
  const see = s.match(/^(?:i|we|you|the user|user)\s+(?:can\s+|do\s+|does\s+)?(not\s+)?see\s+(.+)$/);
  const verb = s.match(new RegExp(`^(?:(.+?)\\s+)?(does not\\s+|do not\\s+|can not\\s+)?(${ENTITY_VERBS})\\s+(.+)$`));
  if (there) { negated = !!there[1]; phrase = there[2]; textVerb = true; }
  else if (see) { negated = !!see[1]; phrase = see[2]; textVerb = true; }
  else if (verb) {
    const subject = verb[1];
    if (subject) {
      if (subject.split(" ").length > 4) return null;
      const st = parseTarget(subject, prep, false);
      if (st && st.kind === "entity") return null; // element subjects are handled by the scoped/text forms
    }
    negated = !!verb[2];
    phrase = verb[4];
    textVerb = !/^(has|have)$/.test(verb[3]);
  }
  if (phrase === null) {
    // A bare phrase with a verb/negation we did not recognise is a predicate we
    // cannot check: never silently drop it ("the heading is long").
    if (/\b(?:is|not|does|do|has|have|was|were|be|feels?|looks?|seems?)\b/.test(s)) return null;
    const t = parseTarget(s, prep, false);
    if (!t || t.kind === "unknown") return null;
    return evaluateTarget(graph, t);
  }
  const t = parseTarget(phrase, prep, textVerb);
  if (!t) return null;
  if (t.kind === "unknown" && !textVerb && !t.quant.explicit) return null;
  return negated ? evaluateNegated(graph, t) : evaluateTarget(graph, t);
};

const HANDLERS: Handler[] = [
  titleHandler,
  urlHandler,
  pageKindHandler,
  accessibleNamesHandler,
  stateHandler,
  requiredHandler,
  emptinessHandler,
  visibilityHandler,
  scopedFormHandler,
  containerTextHandler,
  existenceHandler
];

function evaluateClause(s: string, ctx: Ctx): Verdict | null {
  for (const handler of HANDLERS) {
    const verdict = handler(s, ctx);
    if (verdict) return verdict;
  }
  return null;
}

/**
 * "the email field is required and the password field is required": split on
 * "and" only when every part is a supported clause on its own, so labels such
 * as "Terms and conditions" stay intact. All parts must pass.
 */
function evaluateConjunction(s: string, ctx: Ctx): Verdict | null {
  const parts = s.split(/\s+and\s+(?:also\s+)?/);
  if (parts.length < 2) return null;
  const verdicts = parts.map(p => evaluateClause(p.trim(), ctx));
  if (verdicts.some(v => v === null)) return null;
  const all = verdicts as Verdict[];
  const failed = all.filter(v => !v.pass);
  const rank: AssertionConfidence[] = ["low", "medium", "high"];
  const confidence = all.map(v => v.confidence).reduce((lo, c) => (rank.indexOf(c) < rank.indexOf(lo) ? c : lo), "high" as AssertionConfidence);
  return {
    pass: failed.length === 0,
    confidence,
    explanation: all.map((v, i) => `(${i + 1}) ${v.pass ? "pass" : "fail"}: ${v.explanation}`).join(" "),
    matched: all.flatMap(v => v.matched ?? []).slice(0, 8)
  };
}

// ── Entry point ──────────────────────────────────────────────────────────────

function buildEvidence(graph: PageGraph): AssertionEvidence {
  const allFields = graph.forms.flatMap(f => f.fields.map(ff => ff.id ?? ff.label ?? ""));
  return {
    url: graph.url,
    title: graph.title,
    headings: graph.headings,
    actionLabels: graph.actions.map(a => a.label),
    alertTexts: graph.alerts,
    formSummaries: graph.forms.map(f =>
      `${f.purpose}: ${f.fields.map(ff => ff.id ?? ff.label ?? "field").join(", ")}`
    ),
    counts: {
      headings: graph.headings.length,
      actions: graph.actions.length,
      forms: graph.forms.length,
      alerts: graph.alerts.length,
      fields: allFields.length,
      mediaItems: graph.media.length
    }
  };
}

/**
 * Pure, synchronous evaluator: takes a pre-captured `PageGraph` and a free-text
 * assertion and returns an `AssertionResult` whose `explanation` and `matched`
 * say why. Assertions outside the supported grammar return
 * `{ pass: false, unsupported: true }` with a hint of supported forms.
 */
export function evaluateAssertionAgainstGraph(
  tabId: TabId,
  assertion: string,
  graph: PageGraph
): AssertionResult {
  const evidence = buildEvidence(graph);
  const prep = prepareAssertion(assertion);
  if (prep.text) {
    const verdict = evaluateConjunction(prep.text, { graph, prep }) ?? evaluateClause(prep.text, { graph, prep });
    if (verdict) {
      return {
        tabId, assertion,
        pass: verdict.pass,
        confidence: verdict.confidence,
        explanation: verdict.explanation,
        evidence,
        matched: verdict.matched ?? []
      };
    }
  }
  return {
    tabId, assertion,
    pass: false,
    confidence: "low",
    explanation:
      "Unsupported assertion: it could not be mapped to headings, buttons, links, fields, forms, alerts, dialogs, " +
      "media, page text, the title or the URL. Supported forms include: " +
      SUPPORTED_ASSERTION_FORMS.map(f => `'${f}'`).join(", ") + ". " +
      "Forward `evidence` to an LLM if you need a judgement outside these forms.",
    evidence,
    matched: [],
    unsupported: true
  };
}
