/**
 * Vocabulary for the natural-language assertion evaluator: text normalisation,
 * quoted-literal extraction, number words, quantifiers and the element-noun
 * lexicon (synonyms → element type). Pure and deterministic.
 */

/** Element families the evaluator can find in a `PageGraph`. */
export type EntityType =
  | "heading"
  | "button"
  | "link"
  | "action"
  | "field"
  | "form"
  | "alert"
  | "dialog"
  | "image"
  | "video"
  | "audio"
  | "navigation";

/** Restriction an alert noun/adjective implies ("error message" → error). */
export type AlertTone = "error" | "warning" | "success";

export type NounInfo = { type: EntityType; tone?: AlertTone; fieldType?: string; headingLevel?: boolean };

/** Singular noun → element family. Plurals are derived in `lookupNoun`. */
const NOUNS: Record<string, NounInfo> = {
  heading: { type: "heading" }, headline: { type: "heading" }, header: { type: "heading" },
  subheading: { type: "heading" }, h1: { type: "heading", headingLevel: true },
  h2: { type: "heading", headingLevel: true }, h3: { type: "heading", headingLevel: true },
  h4: { type: "heading", headingLevel: true }, h5: { type: "heading", headingLevel: true },
  h6: { type: "heading", headingLevel: true },
  button: { type: "button" }, btn: { type: "button" }, cta: { type: "button" },
  link: { type: "link" }, hyperlink: { type: "link" }, anchor: { type: "link" },
  action: { type: "action" }, control: { type: "action" },
  field: { type: "field" }, input: { type: "field" }, textbox: { type: "field" },
  textfield: { type: "field" }, textarea: { type: "field", fieldType: "textarea" },
  checkbox: { type: "field", fieldType: "checkbox" }, radio: { type: "field", fieldType: "radio" },
  dropdown: { type: "field", fieldType: "select" }, select: { type: "field", fieldType: "select" },
  combobox: { type: "field", fieldType: "select" },
  form: { type: "form" },
  alert: { type: "alert" }, message: { type: "alert" }, notification: { type: "alert" },
  toast: { type: "alert" }, banner: { type: "alert" }, notice: { type: "alert" },
  snackbar: { type: "alert" },
  error: { type: "alert", tone: "error" }, warning: { type: "alert", tone: "warning" },
  dialog: { type: "dialog" }, modal: { type: "dialog" }, popup: { type: "dialog" },
  overlay: { type: "dialog" }, lightbox: { type: "dialog" }, alertdialog: { type: "dialog" },
  image: { type: "image" }, img: { type: "image" }, picture: { type: "image" },
  photo: { type: "image" }, logo: { type: "image" },
  video: { type: "video" }, audio: { type: "audio" },
  nav: { type: "navigation" }, navigation: { type: "navigation" }, navbar: { type: "navigation" }
};

export function lookupNoun(word: string): NounInfo | undefined {
  if (NOUNS[word]) return NOUNS[word];
  if (word.endsWith("es") && NOUNS[word.slice(0, -2)]) return NOUNS[word.slice(0, -2)];
  if (word.endsWith("s") && NOUNS[word.slice(0, -1)]) return NOUNS[word.slice(0, -1)];
  return undefined;
}

/** Strip a trailing plural "s" for display/text matching of unknown nouns. */
export function singular(word: string): string {
  return word.endsWith("s") && word.length > 3 ? word.slice(0, -1) : word;
}

export const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20
};

export function parseNumber(token: string | undefined): number | undefined {
  if (!token) return undefined;
  if (/^\d+$/.test(token)) return parseInt(token, 10);
  return NUMBER_WORDS[token];
}

export type QuantOp = "eq" | "gte" | "lte" | "gt" | "lt";
export type Quantifier = { op: QuantOp; n: number; explicit: boolean };

const NUM = "(\\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)";

const QUANT_PATTERNS: Array<[RegExp, (n: number) => Quantifier]> = [
  [new RegExp(`^(?:exactly|only|just|precisely)\\s+${NUM}\\b`), n => ({ op: "eq", n, explicit: true })],
  [new RegExp(`^(?:at least|a minimum of|no fewer than|no less than|not less than)\\s+${NUM}\\b`), n => ({ op: "gte", n, explicit: true })],
  [new RegExp(`^(?:at most|no more than|a maximum of|up to|not more than)\\s+${NUM}\\b`), n => ({ op: "lte", n, explicit: true })],
  [new RegExp(`^(?:more than|over|greater than)\\s+${NUM}\\b`), n => ({ op: "gt", n, explicit: true })],
  [new RegExp(`^(?:fewer than|less than|under)\\s+${NUM}\\b`), n => ({ op: "lt", n, explicit: true })],
  [new RegExp(`^${NUM}\\s+or\\s+more\\b`), n => ({ op: "gte", n, explicit: true })],
  [new RegExp(`^${NUM}\\s+or\\s+(?:fewer|less)\\b`), n => ({ op: "lte", n, explicit: true })],
  [/^(?:only one|a single|one single|just one|exactly one|a sole)\b/, () => ({ op: "eq", n: 1, explicit: true })],
  [/^(?:at least one|one or more)\b/, () => ({ op: "gte", n: 1, explicit: true })],
  [/^(?:no|zero|none of the|not any|not a single|not one)\b/, () => ({ op: "eq", n: 0, explicit: true })],
  [/^(?:multiple|several|many)\b/, () => ({ op: "gte", n: 2, explicit: true })],
  [new RegExp(`^${NUM}\\b`), n => ({ op: "eq", n, explicit: true })],
  [/^(?:a|an|any|some|the|this|that|these|those|all the|its)\b/, () => ({ op: "gte", n: 1, explicit: false })]
];

/** Parse a leading quantifier; defaults to "at least one" when none is present. */
export function parseQuantifier(phrase: string): { quant: Quantifier; rest: string } {
  for (const [re, make] of QUANT_PATTERNS) {
    const m = phrase.match(re);
    if (m) {
      const n = m[1] !== undefined ? parseNumber(m[1]) ?? 1 : 1;
      return { quant: make(n), rest: phrase.slice(m[0].length).trim() };
    }
  }
  return { quant: { op: "gte", n: 1, explicit: false }, rest: phrase };
}

export function satisfies(count: number, q: Quantifier): boolean {
  switch (q.op) {
    case "eq": return count === q.n;
    case "gte": return count >= q.n;
    case "lte": return count <= q.n;
    case "gt": return count > q.n;
    case "lt": return count < q.n;
  }
}

export function describeQuantifier(q: Quantifier): string {
  if (q.op === "eq" && q.n === 0) return "no";
  const words: Record<QuantOp, string> = { eq: "exactly", gte: "at least", lte: "at most", gt: "more than", lt: "fewer than" };
  return `${words[q.op]} ${q.n}`;
}

/** Collapse whitespace and fold case/typographic quotes for text comparison. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fold common UI synonyms to one spelling so hint words line up with labels
 * ("Sign in" ↔ "login", "Create account" ↔ "signup", "e-mail" ↔ "email").
 */
export function canonicalize(text: string): string {
  return normalizeText(text)
    .replace(/[^\w\s/#.@:-]/g, " ")
    .replace(/\b(?:sign[\s-]?in|log[\s-]?in|log[\s-]?on)\b/g, "login")
    .replace(/\b(?:sign[\s-]?up|register|registration|create (?:an )?account)\b/g, "signup")
    .replace(/\b(?:sign[\s-]?out|log[\s-]?out|log[\s-]?off)\b/g, "logout")
    .replace(/\be-mail\b/g, "email")
    .replace(/\bpass[\s-]word\b/g, "password")
    .replace(/\s+/g, " ")
    .trim();
}

export type Prepared = {
  /** Lowercased, canonicalised assertion with quoted literals replaced by `__qN__`. */
  text: string;
  /** Quoted literals, original case. */
  quotes: string[];
};

const QUOTE_RE = /"([^"]*)"|`([^`]*)`|(?<![\w])'(.+?)'(?![\w])/g;

/** Extract quoted literals and normalise phrasing so the grammar sees one canonical form. */
export function prepareAssertion(raw: string): Prepared {
  const quotes: string[] = [];
  let t = raw.replace(/[‘’]/g, "'").replace(/[“”]/g, "\"").trim();
  t = t.replace(QUOTE_RE, (_m, a?: string, b?: string, c?: string) => {
    quotes.push((a ?? b ?? c ?? "").replace(/\s+/g, " ").trim());
    return ` __q${quotes.length - 1}__ `;
  });
  t = t.toLowerCase()
    .replace(/\b(\w+)n't\b/g, (_m, w: string) => (w === "ca" ? "can not" : w === "wo" ? "will not" : `${w} not`))
    .replace(/\bcannot\b/g, "can not")
    .replace(/\bthere's\b/g, "there is")
    .replace(/\bit's\b/g, "it is")
    .replace(/[,;!?]+/g, " ")
    .replace(/\.+(\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  t = t
    .replace(/^(?:please\s+)?(?:assert|verify|check|ensure|expect|confirm|make sure|validate|test|see)(?:\s+that)?\s+/, "")
    .replace(/^that\s+/, "")
    .replace(/\b(?:should|must|will|shall)\s+not\s+be\b/g, "is not")
    .replace(/\b(?:should|must|will|shall)\s+be\b/g, "is")
    .replace(/\b(?:should|must|will|shall)\s+not\b/g, "does not")
    .replace(/\b(?:should|must|will|shall)\s+/g, "")
    .replace(/\b(?:can|could)\s+be\s+(seen|found)\b/g, "is visible")
    .replace(/\bare\b/g, "is")
    .replace(/\b(is|are)\s+(?:on|in)\s+(?:the|this)\s+(?:page|screen|dom|document|ui|view)\b/g, "$1 present")
    .replace(/\b(?:on|in)\s+(?:the|this)\s+(?:current\s+)?(?:page|screen|dom|document|ui|view)\b/g, "")
    .replace(/\b(?:on screen|anywhere|currently|right now|still|now|somewhere)\b/g, "")
    .replace(/\btext box(es)?\b/g, "textbox$1")
    .replace(/\btext area(s)?\b/g, "textarea$1")
    .replace(/\btext fields?\b/g, "field")
    .replace(/\binput fields?\b/g, "field")
    .replace(/\bform fields?\b/g, "field")
    .replace(/\bcheck box(es)?\b/g, "checkbox$1")
    .replace(/\bradio buttons?\b/g, "radio")
    .replace(/\bdrop[\s-]down(s)?\b/g, "dropdown$1")
    .replace(/\bpop[\s-]up(s)?\b/g, "popup$1")
    .replace(/\bcall to action\b/g, "cta")
    .replace(/\bnav bar\b/g, "navbar")
    .replace(/\bimg\b/g, "image")
    .replace(/\s+/g, " ")
    .trim();
  return { text: canonicalize(t), quotes };
}

/** Words that carry no matching signal inside an element phrase. */
export const STOPWORDS = new Set([
  "the", "a", "an", "any", "some", "this", "that", "these", "those", "page", "its", "their", "of",
  "and", "or", "is", "be", "visible", "displayed", "shown", "present", "there", "element", "elements",
  "one", "currently", "on", "in", "it", "which", "who", "least", "most", "all", "every", "each"
]);
