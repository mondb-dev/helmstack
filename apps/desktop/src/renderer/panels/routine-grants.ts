/**
 * "What it may do without asking": the grant editor shared by the review dialog and the
 * routine row, plus the small pure helpers around it. Everything shown that came from a
 * spec (requested grants, names) is set with textContent only. Nothing here is ever
 * preselected "auto" from what a routine requested: the human starts from "ask".
 */

import type { RoutineEffectGrant, RoutineEffectName, RoutineGrants } from "../../../../../packages/shared/src/index.js";

export const GRANT_EFFECTS: ReadonlyArray<{ id: RoutineEffectName; label: string; hint: string; auto: boolean }> = [
  { id: "rearrange", label: "Rearrange", hint: "set lineups or orders", auto: true },
  { id: "add_item", label: "Add items", hint: "e.g. pick up a player", auto: true },
  { id: "remove_item", label: "Remove items", hint: "e.g. drop a player", auto: true },
  { id: "offer", label: "Offer to others", hint: "send a proposal, e.g. a trade offer", auto: false },
  { id: "respond", label: "Respond to others", hint: "accept or decline, e.g. a trade", auto: false },
  { id: "other", label: "Anything else", hint: "", auto: false },
];

export const PROTECT_MAX_NAMES = 50;
export const PROTECT_MAX_LENGTH = 80;
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 50;
export const LIMIT_DEFAULT = 3;
export const ASK_ANYWAY_NOTE = "HelmStack still asks you about purchases, personal details and account changes, whatever you choose here.";

/** One name per line: trimmed, whitespace collapsed, clipped, de-duplicated (case-insensitive), capped. */
export function parseProtect(text: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const name = raw.replace(/\s+/g, " ").trim().slice(0, PROTECT_MAX_LENGTH).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length >= PROTECT_MAX_NAMES) break;
  }
  return names;
}

export function clampLimit(value: unknown, fallback = LIMIT_DEFAULT): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, Math.round(n)));
}

const limitsText = (grant: RoutineEffectGrant): string =>
  `${clampLimit(grant.perDay)} per day, ${clampLimit(grant.perRun)} per run`;

/** Plain lines for the effects a grant set lets through without asking. */
export function autoGrantLines(grants: RoutineGrants | undefined): string[] {
  if (!grants || typeof grants !== "object") return [];
  const lines: string[] = [];
  for (const effect of GRANT_EFFECTS) {
    const grant = grants.effects?.[effect.id];
    if (effect.auto && grant && grant.mode === "auto") lines.push(`${effect.label} (at most ${limitsText(grant)})`);
  }
  return lines;
}

export function protectedNames(grants: RoutineGrants | undefined): string[] {
  return Array.isArray(grants?.protect) ? grants.protect.filter((name) => typeof name === "string") : [];
}

/** What the routine asked for, in a sentence. Display only. */
export function requestedText(requested: RoutineGrants | undefined): string {
  const lines = autoGrantLines(requested);
  const names = protectedNames(requested);
  const parts: string[] = [];
  parts.push(lines.length > 0 ? `to do these without asking: ${lines.join("; ")}` : "to do nothing without asking");
  if (names.length > 0) parts.push(`to never remove or give away: ${names.join(", ")}`);
  return `The routine asked for: ${parts.join("; ")}.`;
}

export interface GrantEditor {
  root: HTMLElement;
  /** The grants as currently chosen. */
  read(): RoutineGrants;
  /** Show what the routine requested. It never changes the chosen modes. */
  setRequested(requested: RoutineGrants | undefined): void;
  /** Prefill the protect list unless the human already typed in it. */
  prefillProtect(names: string[]): void;
  setDisabled(disabled: boolean): void;
}

export interface GrantEditorOptions {
  /** Unique per editor instance on the page. */
  idPrefix: string;
  /** Existing grants (editing later). Absent means everything asks. */
  initial?: RoutineGrants;
  requested?: RoutineGrants;
  heading?: string;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  if (className) created.className = className;
  if (text !== undefined) created.textContent = text;
  return created;
}

export function createGrantEditor(options: GrantEditorOptions): GrantEditor {
  const { idPrefix } = options;
  const root = node("section", "routine-grants");
  root.setAttribute("aria-labelledby", `${idPrefix}-heading`);
  const heading = node("h3", "routine-review__heading", options.heading ?? "What it may do without asking");
  heading.id = `${idPrefix}-heading`;
  const requestedLine = node("p", "routine-row__meta routine-grants__requested");
  requestedLine.hidden = true;
  const always = node("p", "routine-row__meta", ASK_ANYWAY_NOTE);
  root.append(heading, requestedLine, always);

  interface Row {
    id: RoutineEffectName;
    autoRadio: HTMLInputElement | null;
    askRadio: HTMLInputElement;
    day: HTMLInputElement | null;
    run: HTMLInputElement | null;
    limits: HTMLElement | null;
  }
  const rows: Row[] = [];
  const controls: Array<HTMLInputElement | HTMLTextAreaElement> = [];

  const syncLimits = (row: Row): void => {
    if (row.limits && row.autoRadio) row.limits.hidden = !row.autoRadio.checked;
  };

  for (const effect of GRANT_EFFECTS) {
    const initial = options.initial?.effects?.[effect.id];
    const startAuto = effect.auto && initial?.mode === "auto";
    const fieldset = node("fieldset", "routine-grants__effect");
    const legend = node("legend", "routine-grants__legend", effect.label);
    if (effect.hint) legend.append(node("span", "routine-row__meta", ` — ${effect.hint}`));
    fieldset.append(legend);
    const name = `${idPrefix}-${effect.id}`;
    const radio = (value: "ask" | "auto", label: string, checked: boolean, disabled: boolean): HTMLInputElement => {
      const wrap = node("label", "routine-grants__choice");
      const input = node("input");
      input.type = "radio";
      input.name = name;
      input.value = value;
      input.checked = checked;
      input.disabled = disabled;
      wrap.append(input, label);
      fieldset.append(wrap);
      if (!disabled) controls.push(input);
      return input;
    };
    const row: Row = { id: effect.id, autoRadio: null, askRadio: null as unknown as HTMLInputElement, day: null, run: null, limits: null };
    if (effect.auto) {
      row.askRadio = radio("ask", "Ask me each time", !startAuto, false);
      row.autoRadio = radio("auto", "Allow automatically", startAuto, false);
      const limits = node("div", "routine-grants__limits");
      const limitInput = (label: string, value: number): HTMLInputElement => {
        const wrap = node("label", "routine-grants__limit");
        const input = node("input");
        input.type = "number";
        input.min = String(LIMIT_MIN);
        input.max = String(LIMIT_MAX);
        input.step = "1";
        input.value = String(value);
        wrap.append(label, input);
        limits.append(wrap);
        controls.push(input);
        return input;
      };
      const [before, after] = ["At most ", " per day"];
      row.day = limitInput(`${before}`, clampLimit(initial?.perDay));
      row.day.setAttribute("aria-label", `${effect.label}: at most how many per day`);
      row.run = limitInput(`${before}`, clampLimit(initial?.perRun));
      row.run.setAttribute("aria-label", `${effect.label}: at most how many per run`);
      row.day.parentElement?.append(after);
      row.run.parentElement?.append(" per run");
      row.limits = limits;
      fieldset.append(limits);
      for (const input of [row.askRadio, row.autoRadio]) input.addEventListener("change", () => syncLimits(row));
      for (const input of [row.day, row.run]) {
        input.addEventListener("change", () => {
          input.value = String(clampLimit(input.value));
        });
      }
      syncLimits(row);
    } else {
      row.askRadio = radio("ask", "Always asks you", true, true);
    }
    rows.push(row);
    root.append(fieldset);
  }

  const protectId = `${idPrefix}-protect`;
  const protectWrap = node("div", "routine-grants__protect");
  const protectLabel = node("label", "routine-review__heading", "Never remove or give away");
  protectLabel.htmlFor = protectId;
  const protectHint = node("p", "routine-row__meta", `One name per line, up to ${PROTECT_MAX_NAMES} names.`);
  protectHint.id = `${protectId}-hint`;
  const protect = node("textarea", "routine-grants__textarea");
  protect.id = protectId;
  protect.rows = 3;
  protect.setAttribute("aria-describedby", protectHint.id);
  protect.value = protectedNames(options.initial).join("\n");
  controls.push(protect);
  let protectTouched = protect.value !== "";
  protect.addEventListener("input", () => {
    protectTouched = true;
  });
  protectWrap.append(protectLabel, protectHint, protect);
  root.append(protectWrap);

  const setRequested = (requested: RoutineGrants | undefined): void => {
    if (!requested) {
      requestedLine.hidden = true;
      requestedLine.textContent = "";
      return;
    }
    requestedLine.textContent = requestedText(requested);
    requestedLine.hidden = false;
  };
  setRequested(options.requested);

  return {
    root,
    read() {
      const effects: Partial<Record<RoutineEffectName, RoutineEffectGrant>> = {};
      for (const row of rows) {
        if (row.autoRadio?.checked && row.day && row.run) {
          effects[row.id] = { mode: "auto", perDay: clampLimit(row.day.value), perRun: clampLimit(row.run.value) };
        } else {
          effects[row.id] = { mode: "ask" };
        }
      }
      return { effects, protect: parseProtect(protect.value) };
    },
    setRequested,
    prefillProtect(names) {
      if (protectTouched) return;
      protect.value = names.join("\n");
    },
    setDisabled(disabled) {
      for (const control of controls) control.disabled = disabled;
    },
  };
}
