/**
 * The pure half of routine actions: matching a control on a page, the protect list, what always
 * asks, verifying the page afterwards, and the fixed sentences that describe an action.
 *
 * Nothing here touches a browser, a store or a clock. The executor (runs) and the action service
 * (a human approving a queued action) both call these, so the two paths cannot drift apart.
 *
 * Page text (control names, a row's text, a subject) is untrusted. It is compared, clipped and
 * shown as text; it is never interpreted.
 */
import type {
  RoutineAction,
  RoutineActAction,
  RoutineEffect,
  RoutineGrants,
  RoutineStrategy
} from "../../../../shared/src/index.js";
import { normalizeForMatch } from "./inference.js";

/** One action per routine at most this often. */
export const ACT_MIN_GAP_MS = 2_000;
/** A queued action lapses this long after it was queued. */
export const PENDING_TTL_MS = 12 * 3_600_000;
export const MAX_ACTIONS_STORED = 100;
/** Effects whose automatic attempts are counted per day. */
export const ACT_COUNTER_EFFECTS: readonly RoutineEffect[] = ["rearrange", "add_item", "remove_item"];
/** Controls offered to the model when it has to choose. */
export const MAX_MODEL_CANDIDATES = 40;
/** Confidence given to a unique deterministic match, by strategy. */
export const ACT_CONFIDENCE = { structured_data: 0.95, repeating_blocks: 0.85 } as const;

// ── what the browser gives back ──────────────────────────────────────────────

/** A control on the open page. `id` is only meaningful to the browser that returned it, until the next `controls()`. */
export type RoutineControl = {
  id: string;
  role: string;
  /** Accessible name. */
  name: string;
  /** Text of the row/container the control sits in (clipped). */
  context: string;
  disabled: boolean;
};

export type ActPerformRequest = { controlId: string; action: RoutineActAction; value?: string };

export type ActPerformResult =
  | { status: "done" }
  /** HelmStack's own approval is needed (personal data, account creation, terms, payment...). `kinds` are words, not page text. */
  | { status: "needs_approval"; kinds: string[] }
  | { status: "blocked"; reason: string }
  | { status: "failed"; reason: string };

export type PageState = { url: string; text: string };

// ── what is stored with an action ────────────────────────────────────────────

/** Needed to redo an action after a human approves it. Never leaves the data directory. */
export type ActionPrivate = {
  target: string;
  strategies: RoutineStrategy[];
  minConfidence: number;
  controlName: string;
  controlRole: string;
  /** fill/select only. Used when the action runs; never logged or shown. */
  value?: string;
  verify: { present: string[]; absent: string[] };
};

export type StoredAction = RoutineAction & { secret?: ActionPrivate };

export type ActionDraft = {
  runId: string;
  effect: RoutineEffect;
  action: RoutineActAction;
  description: string;
  host: string;
  url: string;
  subject?: string;
  status: RoutineAction["status"];
  note?: string;
  allowedBy?: "human" | "grant";
  secret?: ActionPrivate;
};

export type ActionPatch = Partial<Pick<RoutineAction, "status" | "note" | "allowedBy" | "decidedAt">>;

/** What the executor needs from the action service for one run. */
export interface ActGate {
  /** null while the routine may act; otherwise why not (kill switch, paused, stopped...). */
  mayAct(): string | null;
  /** Read from the store on every call: a change by the human applies to the next action. */
  grants(): RoutineGrants;
  /** Counts one attempt against today's limit; false when the limit is already used up. Persisted. */
  reserveDaily(effect: RoutineEffect, limit: number): boolean;
  record(draft: ActionDraft): RoutineAction;
  update(id: string, patch: ActionPatch): void;
  /** Waits so that this routine never acts more often than every {@link ACT_MIN_GAP_MS}. */
  throttle(signal: AbortSignal): Promise<void>;
}

// ── text helpers ─────────────────────────────────────────────────────────────

/** Single line, no control characters, at most `max` characters. */
export function plain(text: string, max: number): string {
  const one = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

const quote = (text: string, max: number): string => `"${plain(text, max).replace(/"/g, "'")}"`;
const norm = normalizeForMatch;

/** Calendar day in local time, `YYYY-MM-DD`. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── protect list ─────────────────────────────────────────────────────────────

/** The protected name `subject` matches (case-insensitive substring in either direction), or null. */
export function protectedMatch(protect: readonly string[], subject: string | undefined): string | null {
  const s = norm(subject ?? "");
  if (!s) return null;
  for (const name of protect) {
    const p = norm(name);
    if (p && (s.includes(p) || p.includes(s))) return name;
  }
  return null;
}

const OUT_OF_PLAY = /\b(bench|bn|ir|il|dl|reserve|reserves|out|minors?|taxi|injured reserve|disabled list|inactive)\b/i;

/**
 * Whether the protect list applies to an action: removing, offering or answering always; a
 * rearrange only when it moves the subject out of play (a bench, reserve or injured slot).
 */
export function protectApplies(effect: RoutineEffect, target: string, value: string | undefined): boolean {
  if (effect === "remove_item" || effect === "offer" || effect === "respond") return true;
  if (effect === "rearrange") return OUT_OF_PLAY.test(`${value ?? ""} ${target}`);
  return false;
}

// ── what always asks ─────────────────────────────────────────────────────────

const SENSITIVE_NAMES: Array<[RegExp, string]> = [
  [/\b(buy|purchase|pay|payment|checkout|check out|place order|subscribe|donate|upgrade)\b/i, "a purchase"],
  [/\b(sign ?up|register|create (an? )?account)\b/i, "creating an account"],
  [/\b(accept|agree|i agree|terms)\b/i, "accepting terms"],
  [/\b(send|post|publish|comment|reply)\b/i, "sending a message"],
  [/\b(upload|attach)\b/i, "uploading a file"],
  [/\b(download|export)\b/i, "downloading a file"],
  [/\b(delete|erase|close account|deactivate)\b/i, "deleting"]
];

/** What HelmStack always asks about, judged from the control's own name (not its row). Null when it looks ordinary. */
export function sensitiveKind(controlName: string): string | null {
  for (const [re, kind] of SENSITIVE_NAMES) if (re.test(controlName)) return kind;
  return null;
}

/** Words for the effect kinds HelmStack's command pipeline asks about. */
export function approvalKindWords(effectTypes: readonly string[]): string[] {
  const words = effectTypes.map((t) =>
    t === "create_account" ? "creating an account" : t === "share_personal_data" ? "sharing personal data" : t === "accept_legal_terms" ? "accepting terms" : t === "submit_payment" ? "a payment" : "something HelmStack always asks about"
  );
  return [...new Set(words)];
}

/** Effects that always wait for a human, whatever was granted. */
export const ALWAYS_ASK: readonly RoutineEffect[] = ["offer", "respond", "other"];

// ── finding the control ──────────────────────────────────────────────────────

const ROLES: Record<RoutineActAction, ReadonlySet<string>> = {
  click: new Set(["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "checkbox", "radio", "switch", "tab", "option", "treeitem"]),
  fill: new Set(["textbox", "searchbox", "spinbutton"]),
  select: new Set(["combobox", "listbox"])
};

/** Every role a control can have for some action: the roles the browser adapter reads from the accessibility tree. */
export const ACT_ROLES: ReadonlySet<string> = new Set([...ROLES.click, ...ROLES.fill, ...ROLES.select]);
export const MAX_CONTROLS = 150;

/** Enabled controls that can do `action`, in page order. */
export function candidatesFor(action: RoutineActAction, controls: readonly RoutineControl[]): RoutineControl[] {
  return controls.filter((c) => ROLES[action].has(c.role) && !c.disabled && (c.name.trim() !== "" || c.context.trim() !== ""));
}

const ROLE_HINT: Record<string, RegExp> = {
  combobox: /\b(menu|dropdown|drop-down|select|slot|position|choose)\b/i,
  listbox: /\b(list|menu|select|slot|choose)\b/i,
  textbox: /\b(field|box|input|text|note|message|comment)\b/i,
  searchbox: /\b(search|field|box|input)\b/i,
  spinbutton: /\b(number|amount|quantity|field|input)\b/i
};

/** The control's own name with the subject taken out ("Add Jalen Smith" -> "add"). */
function bareName(name: string, subject: string | undefined): string {
  let n = norm(name);
  const s = norm(subject ?? "");
  if (s) n = n.split(s).join(" ");
  return n.replace(/[^a-z0-9]+/g, " ").trim();
}

/** Whether the control's name appears (as whole words) in the target description. */
export function nameFitsTarget(control: RoutineControl, target: string, subject: string | undefined): boolean {
  const name = bareName(control.name, subject);
  const t = ` ${norm(target).replace(/[^a-z0-9]+/g, " ")} `;
  if (name) return t.includes(` ${name} `);
  const hint = ROLE_HINT[control.role];
  return hint ? hint.test(target) : false;
}

export type DeterministicStrategy = "structured_data" | "repeating_blocks";

/**
 * Controls matching the target by one deterministic strategy:
 * - `structured_data`: the control's own accessible name must fit the target, and mention the subject.
 * - `repeating_blocks`: the name fits the target and the subject is in the control's row.
 * Without a subject, only the name has to fit.
 */
export function matchControls(strategy: DeterministicStrategy, target: string, subject: string | undefined, controls: readonly RoutineControl[]): RoutineControl[] {
  const s = norm(subject ?? "");
  return controls.filter((c) => {
    if (!nameFitsTarget(c, target, subject)) return false;
    if (!s) return true;
    return strategy === "structured_data" ? norm(c.name).includes(s) : norm(c.name).includes(s) || norm(c.context).includes(s);
  });
}

export type LocateOutcome =
  | { found: true; control: RoutineControl; confidence: number; via: RoutineStrategy }
  | { found: false; why: "none" | "ambiguous" | "low"; best: number };

/** Try the deterministic strategies in the step's order. `infer` is left to the caller (it needs a model). */
export function locateDeterministic(
  strategies: readonly RoutineStrategy[],
  target: string,
  subject: string | undefined,
  controls: readonly RoutineControl[],
  minConfidence: number
): LocateOutcome {
  let best = 0;
  let why: "none" | "ambiguous" | "low" = "none";
  for (const strategy of strategies) {
    if (strategy !== "structured_data" && strategy !== "repeating_blocks") continue;
    const matches = matchControls(strategy, target, subject, controls);
    if (matches.length === 0) continue;
    if (matches.length > 1) {
      why = "ambiguous";
      continue;
    }
    const confidence = ACT_CONFIDENCE[strategy];
    best = Math.max(best, confidence);
    if (confidence >= minConfidence) return { found: true, control: matches[0]!, confidence, via: strategy };
    why = "low";
  }
  return { found: false, why, best };
}

/** A numbered, sanitized list for the model, and the controls in the same order. */
export function numberedList(candidates: readonly RoutineControl[]): { text: string; controls: RoutineControl[] } {
  const controls = candidates.slice(0, MAX_MODEL_CANDIDATES);
  const text = controls.map((c, i) => `${i + 1}. ${c.role} ${quote(c.name, 80)} in: ${plain(c.context, 160)}`).join("\n");
  return { text, controls };
}

/** The question for the model: pick a number from the list, or none. The labels are the numbers and "none". */
export function chooserQuestion(target: string, subject: string | undefined, count: number): { question: string; labels: string[] } {
  const labels = [...Array.from({ length: count }, (_, i) => String(i + 1)), "none"];
  const subjectText = subject ? ` for "${plain(subject, 80)}"` : "";
  return {
    question: `Which numbered control is this: "${plain(target, 300)}"${subjectText}? Answer with its number only if one entry clearly is that control; answer "none" if none clearly is or if two or more could be.`,
    labels
  };
}

/** Controls worth offering the model: those that mention the subject (name or row), if there is one. */
export function shortlist(candidates: readonly RoutineControl[], subject: string | undefined): RoutineControl[] {
  const s = norm(subject ?? "");
  if (!s) return [...candidates];
  return candidates.filter((c) => norm(c.name).includes(s) || norm(c.context).includes(s));
}

/** After a human approves a queued action: the one control that still looks exactly like the one that was queued. */
export function relocate(secret: ActionPrivate, subject: string | undefined, action: RoutineActAction, controls: readonly RoutineControl[]): RoutineControl | null {
  const s = norm(subject ?? "");
  const name = norm(secret.controlName);
  const found = candidatesFor(action, controls).filter(
    (c) => c.role === secret.controlRole && norm(c.name) === name && (!s || norm(c.name).includes(s) || norm(c.context).includes(s))
  );
  return found.length === 1 ? found[0]! : null;
}

// ── verifying ────────────────────────────────────────────────────────────────

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/** `present` strings must be on the page, `absent` strings must not be. Case-insensitive, whitespace-insensitive. */
export function checkVerify(pageText: string, verify: { present: readonly string[]; absent: readonly string[] }): VerifyResult {
  const page = norm(pageText);
  for (let i = 0; i < verify.present.length; i += 1) {
    if (!page.includes(norm(verify.present[i]!))) return { ok: false, reason: `an expected message or value was not on the page (check ${i + 1} of "present")` };
  }
  for (let i = 0; i < verify.absent.length; i += 1) {
    if (page.includes(norm(verify.absent[i]!))) return { ok: false, reason: `something that should be gone or absent was still on the page (check ${i + 1} of "absent")` };
  }
  return { ok: true };
}

// ── sentences ────────────────────────────────────────────────────────────────

export const SUBJECT_CHARS = 80;

/**
 * One plain sentence for the human and the log. The control's name and the subject are page text and
 * are shown as text; a typed value is never shown, only its length. A chosen option (a menu entry the
 * page itself offers) is shown, clipped.
 */
export function describeAction(a: { action: RoutineActAction; controlName: string; subject?: string; host: string; value?: string }): string {
  const who = a.subject ? ` for ${plain(a.subject, SUBJECT_CHARS)}` : "";
  const name = quote(a.controlName || "control", 60);
  switch (a.action) {
    case "click":
      return `Click ${name}${who} on ${a.host}.`;
    case "fill":
      return `Type ${a.value === undefined ? "text" : `${a.value.length} character${a.value.length === 1 ? "" : "s"}`} into ${name}${who} on ${a.host}.`;
    case "select":
      return `Choose ${a.value ? quote(a.value, 40) : "an option"} in ${name}${who} on ${a.host}.`;
  }
}

/** The merged protect list: the spec's names plus the human's. Both only ever make an action more likely to be blocked. */
export function mergedProtect(specProtect: readonly string[] | undefined, grants: RoutineGrants): string[] {
  return [...new Set([...(specProtect ?? []), ...grants.protect].map((n) => n.trim()).filter(Boolean))];
}

// ── doing it ─────────────────────────────────────────────────────────────────

/** What acting needs from a browser. The core adapts a `BrowserBackend`; tests use a fake page. */
export interface ActBrowser {
  /** Controls on the open page, from a fresh read of the page's accessibility tree. Replaces earlier ids. */
  controls(tabId: string): Promise<RoutineControl[]>;
  /** Do it through HelmStack's command pipeline (its approvals included). Never touches anything but the named control. */
  perform(tabId: string, request: ActPerformRequest): Promise<ActPerformResult>;
  /** A fresh read of the page: where it is and the text a person would see. */
  pageState(tabId: string): Promise<PageState>;
}

export type PerformOutcome =
  | { status: "done" }
  | { status: "needs_approval"; kinds: string[] }
  | { status: "blocked"; reason: string }
  | { status: "failed"; reason: string };

export const VERIFY_ATTEMPTS = 4;
export const VERIFY_WAIT_MS = 300;

/**
 * Perform one action and check the page afterwards. The page may take a moment to show the result,
 * so the check is repeated a few times; a page that ends up outside the scope fails at once. An
 * action is never performed twice.
 */
export async function performAndVerify(d: {
  browser: ActBrowser;
  tab: string;
  control: RoutineControl;
  action: RoutineActAction;
  value?: string;
  verify: { present: readonly string[]; absent: readonly string[] };
  inScope: (url: string) => boolean;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
}): Promise<PerformOutcome> {
  let did: ActPerformResult;
  try {
    did = await d.browser.perform(d.tab, { controlId: d.control.id, action: d.action, ...(d.value !== undefined ? { value: d.value } : {}) });
  } catch {
    return { status: "failed", reason: "The page could not be changed." };
  }
  if (did.status === "needs_approval") return did;
  if (did.status === "blocked") return { status: "blocked", reason: did.reason };
  if (did.status === "failed") return { status: "failed", reason: did.reason };
  let last = "The page did not show the expected result afterwards.";
  for (let i = 0; i < VERIFY_ATTEMPTS; i += 1) {
    if (d.signal.aborted) return { status: "failed", reason: "Cancelled while checking the result." };
    let state: PageState;
    try {
      state = await d.browser.pageState(d.tab);
    } catch {
      return { status: "failed", reason: "The page could not be read afterwards." };
    }
    if (!d.inScope(state.url)) return { status: "failed", reason: "The page went outside the routine's scope after the action." };
    const checked = checkVerify(state.text, d.verify);
    if (checked.ok) return { status: "done" };
    last = `The page did not show the expected result afterwards: ${checked.reason}.`;
    if (i < VERIFY_ATTEMPTS - 1) await d.sleep(VERIFY_WAIT_MS, d.signal);
  }
  return { status: "failed", reason: last };
}
