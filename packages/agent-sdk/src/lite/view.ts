/**
 * Numbered page view: the one thing a small model reads to know what is on
 * screen. Pure function of what perception already provides; never includes
 * field values (only empty/filled), never includes ids or selectors.
 */

import type { ObservedAction, ObservedAlert, ObservedField } from "../../../shared/src/index.js";
import { clip, q } from "./text.js";
import { DEFAULT_VIEW_CHARS, type LiteElement, type LitePageSource, type LitePageView } from "./types.js";

export type RenderPageViewOptions = {
  /** View counter shown in the header. Default 1. */
  view?: number;
  /** Character cap. Default {@link DEFAULT_VIEW_CHARS}. */
  maxChars?: number;
  /** `look all`: raise the cap (to 6x) and list as much as fits. */
  all?: boolean;
};

const MAX_MESSAGES = 4;
const MAX_ALL_ELEMENTS = 150;
const FOOTER_RESERVE = 96;

type Candidate = { group: "field" | "button" | "link"; element: Omit<LiteElement, "n">; line: (n: number) => string };

function fieldRole(type: ObservedField["fieldType"]): string {
  if (type === "checkbox") return "checkbox";
  if (type === "radio") return "radio";
  if (type === "select") return "combobox";
  return "textbox";
}

function fieldStates(field: ObservedField): string[] {
  const states: string[] = [];
  if (field.required) states.push("required");
  if (field.invalid) states.push("invalid");
  if (field.filled !== undefined) {
    if (field.fieldType === "checkbox" || field.fieldType === "radio") states.push(field.filled ? "checked" : "unchecked");
    else states.push(field.filled ? "filled" : "empty");
  }
  return states;
}

function actionLabel(action: ObservedAction): string {
  const label = clip(action.label, 60);
  if (label) return label;
  if (action.href) {
    try {
      return clip(new URL(action.href, "http://x").pathname, 60);
    } catch {
      return clip(action.href, 60);
    }
  }
  return "";
}

/** Every actionable element of a page in view order, uncapped and unnumbered. */
export function collectLiteElements(source: LitePageSource): Array<Omit<LiteElement, "n">> {
  return buildCandidates(source).map((candidate) => candidate.element);
}

function buildCandidates(source: LitePageSource): Candidate[] {
  const fields: Candidate[] = [];
  const submits: Candidate[] = [];
  const buttons: Candidate[] = [];
  const links: Candidate[] = [];
  const submitIds = new Map<string, string>();

  for (const form of source.forms ?? []) {
    for (const field of form.fields ?? []) {
      const label = clip(field.label || field.name || field.placeholder || field.id, 60);
      const role = fieldRole(field.fieldType);
      const states = fieldStates(field);
      fields.push({
        group: "field",
        element: {
          kind: "field",
          role,
          label,
          id: field.id,
          selectorHint: field.selectorHint,
          fieldType: field.fieldType,
          formId: form.id,
          ...(field.filled !== undefined ? { filled: field.filled } : {})
        },
        line: (n) => `[${n}] ${role} ${q(label)}${states.length ? ` (${states.join(", ")})` : ""}`
      });
    }
    for (const action of form.submitActions ?? []) {
      submitIds.set(action.id, form.id);
      const label = actionLabel(action);
      if (!label) continue;
      submits.push({
        group: "button",
        element: {
          kind: "action",
          role: "button",
          label,
          id: action.id,
          selectorHint: action.selectorHint,
          submitsFormId: form.id
        },
        line: (n) => `[${n}] button ${q(label)}${action.disabled ? " (disabled)" : ""}`
      });
    }
  }

  const seen = new Set<string>();
  const actions = source.actions ?? source.primaryActions ?? [];
  for (const action of actions) {
    if (submitIds.has(action.id)) continue;
    const label = actionLabel(action);
    if (!label) continue;
    const isLink = action.kind === "link";
    const key = `${isLink ? "l" : "b"}|${label.toLowerCase()}|${action.href ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const role = isLink ? "link" : "button";
    const candidate: Candidate = {
      group: isLink ? "link" : "button",
      element: {
        kind: "action",
        role,
        label,
        id: action.id,
        selectorHint: action.selectorHint,
        ...(action.href ? { href: action.href } : {})
      },
      line: (n) => `[${n}] ${role} ${q(label)}${action.disabled ? " (disabled)" : ""}`
    };
    (isLink ? links : buttons).push(candidate);
  }

  return [...fields, ...submits, ...buttons, ...links];
}

function messageLines(source: LitePageSource): string {
  const details: ObservedAlert[] =
    source.alertDetails && source.alertDetails.length > 0
      ? source.alertDetails
      : (source.alerts ?? []).map((text) => ({ text, tone: "unknown" as const, signals: [] }));
  const rank = { error: 0, warning: 1, success: 2, unknown: 3 } as const;
  const kept = details
    .map((alert, index) => ({ alert, index, text: clip(alert.text, 160) }))
    .filter((entry) => entry.text.length > 0)
    .sort((a, b) => rank[a.alert.tone] - rank[b.alert.tone] || a.index - b.index);
  if (kept.length === 0) return "";
  const shown = kept.slice(0, MAX_MESSAGES).map(({ alert, text }) => `${alert.tone === "unknown" ? "notice" : alert.tone} ${q(text, 160)}`);
  const extra = kept.length - shown.length;
  return `Messages: ${shown.join("; ")}${extra > 0 ? ` (+${extra} more)` : ""}`;
}

function headingLine(source: LitePageSource): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const heading of source.headings ?? []) {
    const text = clip(heading, 60);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
    if (out.length === 4) break;
  }
  return out.length ? `Headings: ${out.join(" > ")}` : "";
}

/**
 * Visible prose that is not already shown as a heading, message, field label
 * or button/link label. Lets a model read plain content ("our motto is ...").
 */
function contentLine(source: LitePageSource, budget: number): string {
  if (!source.text || budget < 40) return "";
  const known = new Set<string>();
  const add = (value: string | undefined) => {
    const key = (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    if (key) known.add(key);
  };
  (source.headings ?? []).forEach(add);
  (source.alerts ?? []).forEach(add);
  (source.forms ?? []).forEach((form) => {
    (form.fields ?? []).forEach((field) => add(field.label));
    (form.submitActions ?? []).forEach((action) => add(action.label));
  });
  (source.actions ?? source.primaryActions ?? []).forEach((action) => add(action.label));
  const kept: string[] = [];
  for (const raw of source.text.split(/\n+/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line || known.has(line.toLowerCase())) continue;
    kept.push(line);
  }
  const joined = kept.join(" ");
  if (!joined) return "";
  const room = budget - 'Text: ""'.length - 1;
  return joined.length <= room ? `Text: ${q(joined, room + 2)}` : `Text: "${joined.slice(0, room).replace(/"/g, "'").trimEnd()}…"`;
}

const GROUP_NOUN = { field: "field", button: "button", link: "link" } as const;

export function renderPageView(source: LitePageSource, options: RenderPageViewOptions = {}): LitePageView {
  const view = options.view ?? 1;
  const base = Math.max(300, Math.floor(options.maxChars ?? DEFAULT_VIEW_CHARS));
  const cap = options.all ? base * 6 : base;

  const title = clip(source.title, 80) || "(untitled)";
  const textBudget = Math.min(options.all ? 1500 : 300, Math.floor(cap * 0.15));
  const headerBody = [
    `Page: ${title} (${clip(source.url, 100)})`,
    headingLine(source),
    messageLines(source),
    contentLine(source, textBudget)
  ].filter(Boolean);

  const candidates = buildCandidates(source);
  const listed: Candidate[] = [];
  const omittedByGroup: Record<"field" | "button" | "link", number> = { field: 0, button: 0, link: 0 };

  // Header carries the `· view N` suffix on the first line; budget for it.
  let used = headerBody.join("\n").length + ` · view ${view}`.length;
  let full = false;
  const maxElements = options.all ? MAX_ALL_ELEMENTS : Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (!full) {
      const line = candidate.line(listed.length + 1);
      const wouldUse = used + 1 + line.length;
      if (wouldUse + FOOTER_RESERVE > cap || listed.length >= maxElements) full = true;
      else {
        listed.push(candidate);
        used = wouldUse;
        continue;
      }
    }
    omittedByGroup[candidate.group] += 1;
  }

  const elements: LiteElement[] = listed.map((candidate, index) => ({ ...candidate.element, n: index + 1 }));
  const omitted = omittedByGroup.field + omittedByGroup.button + omittedByGroup.link;

  const bodyLines = [...headerBody];
  if (elements.length === 0 && omitted === 0) bodyLines.push("No interactive elements on this page.");
  listed.forEach((candidate, index) => bodyLines.push(candidate.line(index + 1)));
  if (omitted > 0) {
    const parts = (["field", "button", "link"] as const)
      .filter((group) => omittedByGroup[group] > 0)
      .map((group) => `${omittedByGroup[group]} more ${GROUP_NOUN[group]}${omittedByGroup[group] === 1 ? "" : "s"}`);
    bodyLines.push(`… ${parts.join(", ")}${options.all ? " not shown (too many to list)" : " (look all)"}`);
  }

  const fingerprint = bodyLines.join("\n");
  const [first = "", ...rest] = bodyLines;
  const text = [`${first} · view ${view}`, ...rest].join("\n");
  return { text, elements, omitted, fingerprint };
}

/**
 * One-line, deterministic description of what is on screen, derived from the
 * page view's source (small models cannot look at an image).
 */
export function describePage(source: LitePageSource): string {
  const title = clip(source.title, 60) || "Untitled page";
  const fields = (source.forms ?? []).flatMap((form) => form.fields ?? []);
  const forms = (source.forms ?? []).length;
  const filled = fields.filter((field) => field.filled === true).length;
  const actions = source.actions ?? source.primaryActions ?? [];
  const links = actions.filter((action) => action.kind === "link").length;
  const buttons = actions.length - links + (source.forms ?? []).reduce((sum, form) => sum + (form.submitActions?.length ?? 0), 0);
  const parts: string[] = [];
  if (forms > 0) parts.push(`${forms} form${forms === 1 ? "" : "s"} with ${fields.length} field${fields.length === 1 ? "" : "s"} (${filled} filled)`);
  if (buttons > 0) parts.push(`${buttons} button${buttons === 1 ? "" : "s"}`);
  if (links > 0) parts.push(`${links} link${links === 1 ? "" : "s"}`);
  const heading = clip((source.headings ?? [])[0], 60);
  const message = messageLines(source).replace(/^Messages: /, "");
  return [
    `A page titled ${q(title)}`,
    heading && heading.toLowerCase() !== title.toLowerCase() ? `with heading ${q(heading)}` : "",
    parts.length ? `showing ${parts.join(", ")}` : "with no form or buttons",
    message ? `and message ${message}` : ""
  ]
    .filter(Boolean)
    .join(" ")
    .concat(".");
}
