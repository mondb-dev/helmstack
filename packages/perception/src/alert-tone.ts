/**
 * Alert severity classification shared by the page-side extractor (preload and
 * CDP-injected bundle) and the assertion evaluator. Pure: no DOM access.
 *
 * Signals are weighted so that structure beats wording beats styling:
 *  - an invalid field pointing at the message (`aria-invalid` +
 *    `aria-errormessage` / `aria-describedby`) is decisive for "error";
 *  - text matches use whole words / phrases from a vetted list (never
 *    substrings: "consent" does not contain "sent", "Please complete …" is an
 *    instruction, not a completion);
 *  - `role=alert` leans error, `role=status` leans success, class names are
 *    weak hints only.
 * The winning tone must score at least {@link MIN_SCORE} and strictly beat
 * every other tone; anything else is "unknown" — never both.
 */
import type { ObservedAlertSignal, ObservedAlertTone } from "../../shared/src/index.js";

type Tone = Exclude<ObservedAlertTone, "unknown">;

const SIGNAL_WEIGHTS: Record<ObservedAlertSignal, Partial<Record<Tone, number>>> = {
  "field-invalid": { error: 4 },
  "role-alert": { error: 2 },
  "role-alertdialog": { error: 2 },
  "aria-live-assertive": { error: 1 },
  "role-status": { success: 1 },
  "aria-live-polite": {},
  "text-error": { error: 3 },
  "text-warning": { warning: 3 },
  "text-success": { success: 3 },
  "class-error": { error: 1 },
  "class-warning": { warning: 1 },
  "class-success": { success: 1 }
};

const MIN_SCORE = 2;

/** Whole-word / whole-phrase patterns. Each is wrapped in word boundaries. */
const ERROR_PHRASES = [
  "errors?", "invalid", "not valid", "is not valid", "isn't valid", "failed", "failure", "fails",
  "incorrect", "wrong", "unable to", "could not", "couldn't", "can not", "cannot be", "can't be",
  "denied", "not found", "(?:is|are|field is|fields are) required", "required field", "missing",
  "try again", "problem", "expired", "rejected", "not allowed", "too (?:short|long|many|few)",
  "do(?:es)? not match", "(?:don't|doesn't) match", "already (?:taken|exists|in use|registered)",
  "must (?:be|contain|include|have|match|not)", "please (?:enter|complete|fill(?: in| out)?|provide|select|choose|correct|fix|check|review|specify|agree|accept)",
  "something went wrong", "oops"
];
const WARNING_PHRASES = ["warnings?", "caution", "be careful", "heads up", "deprecated", "will expire", "is about to expire"];
const SUCCESS_PHRASES = [
  "success", "successful", "successfully", "succeeded", "saved", "sent", "submitted", "completed",
  "confirmed", "thank you", "thanks", "all set", "well done", "you're in", "welcome aboard",
  "(?:has|have|was|were) been (?:created|updated|added|saved|sent|submitted|published|deleted|removed)",
  "(?:created|updated|added|published) successfully"
];

function phraseRe(phrases: string[]): RegExp {
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_'])(?:${phrases.join("|")})(?=$|[^\\p{L}\\p{N}_'])`, "iu");
}

const ERROR_RE = phraseRe(ERROR_PHRASES);
const WARNING_RE = phraseRe(WARNING_PHRASES);
const SUCCESS_RE = phraseRe(SUCCESS_PHRASES);

/** Whole-word text signals for a message. */
export function textToneSignals(text: string): ObservedAlertSignal[] {
  const t = text.replace(/[‘’]/g, "'");
  const out: ObservedAlertSignal[] = [];
  if (ERROR_RE.test(t)) out.push("text-error");
  if (WARNING_RE.test(t)) out.push("text-warning");
  if (SUCCESS_RE.test(t)) out.push("text-success");
  return out;
}

const CLASS_TOKENS: Array<[RegExp, ObservedAlertSignal]> = [
  [/^(?:error|errors|danger|invalid|fail|failed|failure|negative|critical)$/, "class-error"],
  [/^(?:warning|warn|caution)$/, "class-warning"],
  [/^(?:success|successful|positive|ok|confirmation|confirmed)$/, "class-success"]
];

/**
 * Class / data-attribute hints, matched per token ("alert-danger" → ["alert",
 * "danger"]) so "errorless" or "unsuccessful-x" style substrings never match.
 */
export function classToneSignals(classNames: string): ObservedAlertSignal[] {
  const tokens = new Set(classNames.split(/[\s_-]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean).map((t) => t.toLowerCase()));
  const out: ObservedAlertSignal[] = [];
  for (const [re, signal] of CLASS_TOKENS) {
    for (const token of tokens) {
      if (re.test(token)) { out.push(signal); break; }
    }
  }
  return out;
}

/** Decide a tone from a signal set: strongest wins, ties and weak evidence → "unknown". */
export function decideAlertTone(signals: Iterable<ObservedAlertSignal>): ObservedAlertTone {
  const scores: Record<Tone, number> = { error: 0, warning: 0, success: 0 };
  for (const signal of new Set(signals)) {
    const weights = SIGNAL_WEIGHTS[signal];
    for (const tone of Object.keys(weights) as Tone[]) scores[tone] += weights[tone] ?? 0;
  }
  const ranked = (Object.entries(scores) as Array<[Tone, number]>).sort((a, b) => b[1] - a[1]);
  const [[top, best], [, second]] = ranked;
  if (best < MIN_SCORE || best === second) return "unknown";
  return top;
}

/** Text-only classification, for graphs captured before `alertDetails` existed. */
export function classifyAlertText(text: string): ObservedAlertTone {
  return decideAlertTone(textToneSignals(text));
}
