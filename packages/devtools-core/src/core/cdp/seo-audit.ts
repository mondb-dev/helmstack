import type {
  CdpTarget,
  NetworkRequestEntry,
  SeoAuditOptions,
  SeoAuditReport,
  SeoCanonicalStatus,
  SeoIssue,
  SeoJsonLdBlock,
  SeoLinkCheckResult,
  SeoSectionId,
  SeoSectionSummary,
  SeoSeverity,
  SeoSeverityCounts,
  SeoSkippedCheck,
  TabId
} from "../../../../shared/src/index.js";
import { SELECTOR_FOR_SOURCE } from "../../../../perception/src/page-selector.js";
import { evaluateRobots, parseRobotsTxt } from "../reports/robots-txt.js";

// ── Raw signals (collector output) ────────────────────────────────────────────

export type RawSeoHeading = { level: number; text: string; selector: string; empty: boolean };
export type RawSeoLink = {
  /** The `href` attribute as authored; null when the anchor has none. */
  href: string | null;
  /** The resolved absolute URL; null when there is no href or it cannot be resolved. */
  abs: string | null;
  text: string;
  rel: string;
  selector: string;
};

/** Everything the page-side collector reads from the document. */
export type RawSeoSignals = {
  url: string;
  origin: string;
  titles: string[];
  descriptions: string[];
  /** `<link rel="canonical">` hrefs as authored, with their resolved form. */
  canonicals: Array<{ href: string; resolved: string | null }>;
  lang: string | null;
  viewport: string | null;
  charset: { meta: string | null; httpEquiv: string | null; document: string | null };
  hreflang: Array<{ hreflang: string; href: string; resolved: string | null }>;
  robotsMeta: Array<{ name: string; content: string }>;
  headings: RawSeoHeading[];
  images: { total: number; missingAlt: number; missingAltSelectors: string[] };
  links: RawSeoLink[];
  linkTotal: number;
  wordCount: number;
  openGraph: Record<string, string>;
  twitter: Record<string, string>;
  jsonLd: string[];
  microdataItems: number;
  rdfaItems: number;
  navigation: { responseStatus: number | null; redirectCount: number | null };
};

export type RobotsFetchResult =
  | { ok: true; status: number; url: string; contentType: string; text: string }
  | { ok: false; error: string };

/** Out-of-page inputs to the evaluator. */
export type SeoAuditInputs = {
  /** Allowlisted response headers of the main document; null when it was not observed. */
  headers: Record<string, string> | null;
  /** Status of the main document from the network log; null when not observed. */
  logStatus: number | null;
  /** Robots.txt fetch outcome; null when it was not attempted (non-http page). */
  robots: RobotsFetchResult | null;
  /** Same-origin link results; null when `checkLinks` was off. */
  linkChecks: SeoLinkCheckResult[] | null;
  /** Links the network log already saw failing (4xx/5xx/failed). */
  observedBrokenLinks: Array<{ url: string; status: number | null }>;
  /** Skipped-check notes produced while gathering inputs. */
  skipped?: SeoSkippedCheck[];
  /** Whether the link check had to cut candidates at `maxLinks`. */
  linkCheckTruncated?: boolean;
  options: { checkLinks: boolean; maxLinks: number };
};

// ── Constants ─────────────────────────────────────────────────────────────────

export const SEO_LIST_CAP = 50;
export const SEO_DEFAULT_MAX_LINKS = 25;
export const SEO_MAX_LINKS = 100;
const LINK_CHECK_CONCURRENCY = 4;
const LINK_CHECK_TIMEOUT_MS = 5000;
const LINK_CHECK_DEADLINE_MS = 60_000;
const ROBOTS_TIMEOUT_MS = 4000;
const ROBOTS_MAX_CHARS = 512 * 1024; // Google parses the first 500 KiB.

const TITLE_MIN = 10;
const TITLE_MAX = 60;
const DESCRIPTION_MIN = 50;
const DESCRIPTION_MAX = 160;
const THIN_CONTENT_WORDS = 300;

/** Response headers retained from the main document. Never cookies or auth. */
export const SEO_HEADER_ALLOWLIST = ["x-robots-tag", "content-type", "link", "location"] as const;

const GENERIC_LINK_TEXT = new Set([
  "click here", "here", "read more", "more", "learn more", "this link", "link", "details", "click", "this"
]);

// Deduction per issue: see `SeoAuditReport` docs.
const ERROR_WEIGHT = 12;
const WARNING_WEIGHT = 4;

// ── Small helpers ─────────────────────────────────────────────────────────────

function normalizeUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

function hostKey(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

const isAbsoluteUrl = (value: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim());
const clip = (value: string, max = 120): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

function pickAllowlistedHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if ((SEO_HEADER_ALLOWLIST as readonly string[]).includes(lower)) out[lower] = String(value).slice(0, 2000);
  }
  return out;
}

/**
 * Finds the main document's response in the network log and returns only the
 * allowlisted headers (`x-robots-tag`, `content-type`, `link`, `location`) plus
 * its status. The log buffers every header (including `set-cookie`); nothing
 * outside the allowlist leaves this function.
 */
export function mainDocumentResponse(
  entries: NetworkRequestEntry[],
  documentUrl: string
): { headers: Record<string, string>; status: number | null } | null {
  const target = normalizeUrl(documentUrl);
  if (!target) return null;
  let best: NetworkRequestEntry | null = null;
  for (const entry of entries) {
    if (normalizeUrl(entry.url) !== target) continue;
    if (entry.statusCode === undefined || entry.failed) continue;
    const mime = (entry.mimeType ?? "").toLowerCase();
    if (mime && !/html|xml/.test(mime)) continue;
    if (!best || entry.timestamp >= best.timestamp) best = entry;
  }
  if (!best) return null;
  return { headers: pickAllowlistedHeaders(best.responseHeaders), status: best.statusCode ?? null };
}

/** Same-origin links the page itself already requested and that failed. */
export function observedBrokenLinks(
  entries: NetworkRequestEntry[],
  linkUrls: string[],
  documentUrl: string
): Array<{ url: string; status: number | null }> {
  const wanted = new Set(linkUrls.map((u) => normalizeUrl(u)).filter((u): u is string => !!u));
  const doc = normalizeUrl(documentUrl);
  const out = new Map<string, { url: string; status: number | null }>();
  for (const entry of entries) {
    const url = normalizeUrl(entry.url);
    if (!url || url === doc || !wanted.has(url)) continue;
    const status = entry.statusCode ?? null;
    if (entry.failed || (status !== null && status >= 400)) out.set(url, { url, status });
  }
  return [...out.values()];
}

/** Directives that apply to Google in a robots meta `content` or an X-Robots-Tag value. */
function parseDirectives(value: string, header: boolean): { directives: Set<string>; otherAgents: Map<string, Set<string>> } {
  const directives = new Set<string>();
  const otherAgents = new Map<string, Set<string>>();
  for (const line of value.split(/\n/)) {
    let agent = "*";
    let rest = line;
    if (header) {
      const m = /^\s*([a-z0-9_-]+)\s*:\s*(.*)$/i.exec(line);
      if (m && !/^(unavailable_after|max-snippet|max-image-preview|max-video-preview)$/i.test(m[1])) {
        agent = m[1].toLowerCase();
        rest = m[2];
      }
    }
    for (const part of rest.split(",")) {
      const token = part.trim().toLowerCase();
      if (!token) continue;
      if (agent === "*" || agent === "googlebot") directives.add(token);
      else {
        if (!otherAgents.has(agent)) otherAgents.set(agent, new Set());
        otherAgents.get(agent)!.add(token);
      }
    }
  }
  return { directives, otherAgents };
}

/** BCP 47-ish: primary language subtag followed by alphanumeric subtags. */
export function isValidLangTag(tag: string): boolean {
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(tag.trim());
}

const isValidHreflang = (tag: string): boolean =>
  tag.toLowerCase() === "x-default" || /^[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?$/i.test(tag);

// ── JSON-LD ───────────────────────────────────────────────────────────────────

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const hasValue = (v: unknown): boolean =>
  v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "") && !(Array.isArray(v) && v.length === 0);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const shortType = (t: string): string => t.replace(/^https?:\/\/schema\.org\//i, "");

function nodeTypes(node: JsonObject): string[] {
  return asArray(node["@type"]).filter((t): t is string => typeof t === "string").map(shortType);
}

/** Top-level nodes of a JSON-LD document, expanding `@graph`. */
function jsonLdNodes(doc: unknown): JsonObject[] {
  const out: JsonObject[] = [];
  for (const item of asArray(doc)) {
    if (!isObject(item)) continue;
    if (hasValue(item["@type"])) out.push(item);
    if (Array.isArray(item["@graph"])) out.push(...(item["@graph"] as unknown[]).filter(isObject));
  }
  return out;
}

type TypeRule = {
  /** Properties Google lists as required for rich-result eligibility. */
  required?: string[];
  /** At least one of these must be present. */
  anyOf?: string[];
  /** Properties Google lists as recommended. */
  recommended?: string[];
};

/**
 * Vetted subset of Google Search Central structured-data guidance
 * (developers.google.com/search/docs/appearance/structured-data):
 *
 * - Article (/article): no required properties; recommended `headline`,
 *   `image`, `datePublished`, `author`.
 * - Product (/product-snippet): required `name`, plus at least one of
 *   `review`, `aggregateRating` or `offers`; recommended `image`,
 *   `description`.
 * - Organization (/organization): no required properties; recommended
 *   `name`, `url`, `logo`.
 * - WebSite (/site-names): `name` and `url` identify the site name.
 * - BreadcrumbList (/breadcrumb): required `itemListElement` (≥1 ListItem
 *   with `position` and `name`); `item` required on all but the last.
 * - FAQPage (/faqpage): required `mainEntity` of Question items with `name`
 *   and `acceptedAnswer.text`. (FAQ rich results are limited to well-known
 *   government and health sites; markup is still validated as written.)
 */
const TYPE_RULES: Record<string, TypeRule> = {
  Article: { recommended: ["headline", "image", "datePublished", "author"] },
  NewsArticle: { recommended: ["headline", "image", "datePublished", "author"] },
  BlogPosting: { recommended: ["headline", "image", "datePublished", "author"] },
  Product: { required: ["name"], anyOf: ["review", "aggregateRating", "offers"], recommended: ["image", "description"] },
  Organization: { recommended: ["name", "url", "logo"] },
  WebSite: { required: ["name", "url"] },
  BreadcrumbList: { required: ["itemListElement"] },
  FAQPage: { required: ["mainEntity"] }
};

function listItemProblems(items: unknown[]): string[] {
  const problems: string[] = [];
  items.forEach((raw, i) => {
    if (!isObject(raw)) return void problems.push(`itemListElement[${i}] is not an object`);
    if (!hasValue(raw.position)) problems.push(`itemListElement[${i}] missing position`);
    const item = raw.item;
    const name = hasValue(raw.name) || (isObject(item) && hasValue(item.name));
    if (!name) problems.push(`itemListElement[${i}] missing name`);
    if (i < items.length - 1 && !hasValue(item)) problems.push(`itemListElement[${i}] missing item (required except on the last entry)`);
  });
  return problems;
}

function faqProblems(entities: unknown[]): string[] {
  const problems: string[] = [];
  entities.forEach((raw, i) => {
    if (!isObject(raw)) return void problems.push(`mainEntity[${i}] is not an object`);
    if (!hasValue(raw.name)) problems.push(`mainEntity[${i}] missing name`);
    const answers = asArray(raw.acceptedAnswer);
    if (!answers.some((a) => isObject(a) && hasValue(a.text))) problems.push(`mainEntity[${i}] missing acceptedAnswer.text`);
  });
  return problems;
}

// ── The evaluator ─────────────────────────────────────────────────────────────

type IssueDraft = {
  id: string;
  section: SeoSectionId;
  severity: SeoSeverity;
  message: string;
  fix: string;
  evidence?: string;
  selectors?: string[];
  /** Total occurrences (>= selectors.length). */
  total?: number;
};

function summarize<T>(issues: SeoIssue[], section: SeoSectionId, data: T): SeoSectionSummary<T> {
  const counts: SeoSeverityCounts = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) if (issue.section === section) counts[issue.severity]++;
  return { status: counts.error > 0 ? "fail" : counts.warning > 0 ? "warn" : "pass", counts, data };
}

/** Score formula (documented on `SeoAuditReport`). Exported for tests. */
export function seoScore(counts: SeoSeverityCounts): number {
  return Math.max(0, 100 - ERROR_WEIGHT * counts.error - WARNING_WEIGHT * counts.warning);
}

/**
 * Pure SEO rule engine over raw collected signals. No CDP/DOM access, so it is
 * unit-tested directly (like `buildA11yReport`).
 */
export function buildSeoReport(
  signals: RawSeoSignals,
  inputs: SeoAuditInputs,
  tabId: TabId,
  capturedAt: number
): SeoAuditReport {
  const issues: SeoIssue[] = [];
  let truncated = false;
  const skipped: SeoSkippedCheck[] = [...(inputs.skipped ?? [])];
  const unsupported: SeoSkippedCheck[] = [];

  const add = (d: IssueDraft): void => {
    const issue: SeoIssue = { id: d.id, section: d.section, severity: d.severity, message: d.message, fix: d.fix };
    if (d.evidence) issue.evidence = d.evidence;
    if (d.selectors && d.selectors.length > 0) {
      const total = d.total ?? d.selectors.length;
      issue.selectors = d.selectors.slice(0, SEO_LIST_CAP);
      issue.count = total;
      if (total > SEO_LIST_CAP) {
        issue.truncated = true;
        truncated = true;
      }
    } else if (d.total !== undefined) {
      issue.count = d.total;
    }
    issues.push(issue);
  };

  const docUrl = normalizeUrl(signals.url);
  const isHttp = /^https?:/i.test(signals.url);

  // ── Metadata ──────────────────────────────────────────────────────────────

  const title = signals.titles.length > 0 ? signals.titles[0] : null;
  if (signals.titles.length === 0) {
    add({ id: "title-missing", section: "metadata", severity: "error", message: "The page has no <title>.", fix: "Add a unique, descriptive <title> inside <head>." });
  } else if (title === "") {
    add({ id: "title-empty", section: "metadata", severity: "error", message: "The <title> is empty.", fix: "Write a descriptive title of roughly 10-60 characters." });
  } else {
    if (signals.titles.length > 1) {
      add({ id: "title-multiple", section: "metadata", severity: "warning", message: `The page has ${signals.titles.length} <title> elements.`, evidence: signals.titles.map((t) => clip(t, 60)).join(" | "), fix: "Keep exactly one <title> element in <head>." });
    }
    if (title!.length < TITLE_MIN) {
      add({ id: "title-short", section: "metadata", severity: "warning", message: `The title is short (${title!.length} characters).`, evidence: title!, fix: `Expand the title to at least ${TITLE_MIN} characters that describe the page.` });
    } else if (title!.length > TITLE_MAX) {
      add({ id: "title-long", section: "metadata", severity: "warning", message: `The title is long (${title!.length} characters) and may be truncated in results.`, evidence: clip(title!, 100), fix: `Shorten the title to ${TITLE_MAX} characters or fewer, leading with the key terms.` });
    }
    const h1 = signals.headings.find((h) => h.level === 1);
    if (h1 && h1.text.trim() !== "" && h1.text.trim().toLowerCase() === title!.toLowerCase()) {
      add({ id: "title-duplicates-h1", section: "metadata", severity: "info", message: "The title is identical to the h1.", evidence: clip(title!, 100), fix: "Consider a title that adds context (brand, qualifier) beyond the h1; identical is acceptable." });
    }
  }

  const description = signals.descriptions.length > 0 ? signals.descriptions[0] : null;
  if (signals.descriptions.length === 0 || description === "") {
    add({ id: "description-missing", section: "metadata", severity: "warning", message: signals.descriptions.length === 0 ? "The page has no meta description." : "The meta description is empty.", fix: `Add <meta name="description" content="..."> of ${DESCRIPTION_MIN}-${DESCRIPTION_MAX} characters.` });
  } else {
    if (signals.descriptions.length > 1) {
      add({ id: "description-multiple", section: "metadata", severity: "warning", message: `The page has ${signals.descriptions.length} meta descriptions.`, fix: "Keep a single meta description." });
    }
    if (description!.length < DESCRIPTION_MIN) {
      add({ id: "description-short", section: "metadata", severity: "warning", message: `The meta description is short (${description!.length} characters).`, evidence: description!, fix: `Expand it to at least ${DESCRIPTION_MIN} characters.` });
    } else if (description!.length > DESCRIPTION_MAX) {
      add({ id: "description-long", section: "metadata", severity: "warning", message: `The meta description is long (${description!.length} characters) and may be truncated.`, evidence: clip(description!, 100), fix: `Shorten it to ${DESCRIPTION_MAX} characters or fewer.` });
    }
  }

  // Canonical
  let canonicalStatus: SeoCanonicalStatus = "missing";
  const canon = signals.canonicals;
  const linkHeader = inputs.headers?.link ?? "";
  const headerCanonical = /<([^>]+)>\s*;[^,]*rel\s*=\s*"?canonical"?/i.exec(linkHeader)?.[1] ?? null;
  const firstCanon = canon[0] ?? null;
  if (canon.length === 0) {
    canonicalStatus = "missing";
    add({
      id: "canonical-missing", section: "metadata",
      severity: headerCanonical ? "info" : "warning",
      message: headerCanonical ? "No <link rel=\"canonical\"> in HTML; a canonical is declared in the Link response header." : "The page declares no canonical URL.",
      evidence: headerCanonical ?? undefined,
      fix: "Add <link rel=\"canonical\" href=\"https://…\"> pointing at the preferred absolute URL for this content."
    });
  } else {
    const distinct = new Set(canon.map((c) => c.resolved ?? c.href));
    if (canon.length > 1) {
      canonicalStatus = "multiple";
      add({
        id: "canonical-multiple", section: "metadata",
        severity: distinct.size > 1 ? "error" : "warning",
        message: distinct.size > 1 ? "The page declares conflicting canonical URLs; search engines will ignore them." : "The page declares the canonical URL more than once.",
        evidence: canon.map((c) => c.href).join(" | "),
        fix: "Keep exactly one <link rel=\"canonical\">."
      });
    } else {
      const c = firstCanon!;
      const resolved = normalizeUrl(c.resolved);
      if (!isAbsoluteUrl(c.href)) {
        canonicalStatus = resolved ? "relative" : "invalid";
        add({
          id: resolved ? "canonical-relative" : "canonical-invalid", section: "metadata", severity: "warning",
          message: resolved ? "The canonical URL is relative." : "The canonical URL cannot be parsed.",
          evidence: c.href,
          fix: "Use a fully qualified absolute URL (scheme and host) in the canonical link."
        });
      }
      if (resolved && docUrl) {
        const same = resolved === docUrl;
        if (canonicalStatus !== "relative") canonicalStatus = same ? "self" : "different";
        if (!same) {
          if (hostKey(resolved) !== hostKey(docUrl)) {
            add({ id: "canonical-offdomain", section: "metadata", severity: "warning", message: "The canonical URL is on a different host than the page.", evidence: `${docUrl} -> ${resolved}`, fix: "If this is a cross-domain syndication canonical, keep it; otherwise point the canonical at this site's own URL." });
          } else {
            add({ id: "canonical-different", section: "metadata", severity: "info", message: "The canonical points to a different URL on the same host (this page is a duplicate or variant).", evidence: `${docUrl} -> ${resolved}`, fix: "Confirm this is intentional; the page will be consolidated into the canonical URL." });
          }
        }
      }
    }
  }

  // lang / viewport / charset
  const lang = signals.lang;
  if (!lang || lang.trim() === "") {
    add({ id: "lang-missing", section: "metadata", severity: "warning", message: "The <html> element has no lang attribute.", selectors: ["html"], fix: "Set <html lang=\"en\"> (or the page's language) using a valid BCP 47 tag." });
  } else if (!isValidLangTag(lang)) {
    add({ id: "lang-invalid", section: "metadata", severity: "warning", message: "The <html lang> value is not a valid BCP 47 language tag.", evidence: lang, selectors: ["html"], fix: "Use a tag such as \"en\", \"en-US\" or \"zh-Hant\"." });
  }

  if (!signals.viewport) {
    add({ id: "viewport-missing", section: "metadata", severity: "warning", message: "The page has no viewport meta tag, so mobile rendering is not optimised.", fix: "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">." });
  } else if (!/width\s*=\s*device-width/i.test(signals.viewport)) {
    add({ id: "viewport-not-responsive", section: "metadata", severity: "info", message: "The viewport meta does not set width=device-width.", evidence: signals.viewport, fix: "Use content=\"width=device-width, initial-scale=1\" for responsive pages." });
  }

  const charset = signals.charset.meta ?? signals.charset.httpEquiv ?? null;
  const headerCharset = /charset\s*=\s*([^;\s]+)/i.exec(inputs.headers?.["content-type"] ?? "")?.[1] ?? null;
  if (!charset && !headerCharset) {
    add({ id: "charset-missing", section: "metadata", severity: "warning", message: "No character encoding is declared in the HTML or Content-Type header.", fix: "Add <meta charset=\"utf-8\"> as the first element in <head>." });
  } else {
    const declared = (charset ?? headerCharset)!;
    if (!/^utf-?8$/i.test(declared)) {
      add({ id: "charset-not-utf8", section: "metadata", severity: "info", message: `The declared encoding is ${declared}, not UTF-8.`, fix: "Prefer UTF-8 for the broadest compatibility." });
    }
  }

  // hreflang
  if (signals.hreflang.length > 0) {
    const seen = new Set<string>();
    const dupes: string[] = [];
    const invalid: string[] = [];
    const relative: string[] = [];
    let selfRef = false;
    for (const h of signals.hreflang) {
      const key = h.hreflang.toLowerCase();
      if (seen.has(key)) dupes.push(h.hreflang);
      seen.add(key);
      if (!isValidHreflang(h.hreflang)) invalid.push(h.hreflang);
      if (!isAbsoluteUrl(h.href)) relative.push(h.href);
      if (normalizeUrl(h.resolved) === docUrl) selfRef = true;
    }
    if (invalid.length) add({ id: "hreflang-invalid", section: "metadata", severity: "warning", message: "Some hreflang values are not valid language[-script][-region] codes.", evidence: invalid.join(", "), fix: "Use ISO 639-1 language codes with optional ISO 3166-1 region (en, en-GB) or x-default." });
    if (dupes.length) add({ id: "hreflang-duplicate", section: "metadata", severity: "warning", message: "Some hreflang values are declared more than once.", evidence: dupes.join(", "), fix: "Declare each language-region once." });
    if (relative.length) add({ id: "hreflang-relative", section: "metadata", severity: "warning", message: "Some hreflang URLs are relative.", evidence: relative.slice(0, 5).join(", "), fix: "Use fully qualified absolute URLs." });
    if (!selfRef) add({ id: "hreflang-no-self-reference", section: "metadata", severity: "warning", message: "The hreflang set does not include this page's own URL.", fix: "Include a self-referencing hreflang entry for this page." });
    add({ id: "hreflang-reciprocal-unverified", section: "metadata", severity: "info", message: "Reciprocal (return) hreflang links cannot be verified from a single page.", fix: "Verify each alternate links back to this page, e.g. with a site-wide crawl." });
    unsupported.push({ check: "hreflang reciprocal links", reason: "Requires fetching every alternate page; the audit does not crawl." });
  }

  // ── Indexability ──────────────────────────────────────────────────────────

  const metaDirectives = new Set<string>();
  const otherBotMeta: string[] = [];
  for (const m of signals.robotsMeta) {
    const name = m.name.toLowerCase();
    const parsed = parseDirectives(m.content, false).directives;
    if (name === "robots" || name === "googlebot") parsed.forEach((d) => metaDirectives.add(d));
    else otherBotMeta.push(`${name}: ${m.content}`);
  }
  const xRobots = inputs.headers?.["x-robots-tag"] ?? null;
  const headerParsed = xRobots ? parseDirectives(xRobots, true).directives : new Set<string>();

  const noindexSources: string[] = [];
  const nofollowSources: string[] = [];
  const consider = (set: Set<string>, source: string) => {
    if (set.has("noindex") || set.has("none")) noindexSources.push(source);
    if (set.has("nofollow") || set.has("none")) nofollowSources.push(source);
  };
  consider(metaDirectives, "meta robots");
  consider(headerParsed, "X-Robots-Tag header");

  if (noindexSources.length > 0) {
    add({ id: "noindex", section: "indexability", severity: "error", message: "The page tells search engines not to index it.", evidence: noindexSources.join(", "), fix: "Remove the noindex directive (meta robots / X-Robots-Tag) if this page should appear in search results." });
  }
  if (nofollowSources.length > 0) {
    add({ id: "nofollow", section: "indexability", severity: "warning", message: "The page tells search engines not to follow its links.", evidence: nofollowSources.join(", "), fix: "Remove nofollow/none unless you intend to withhold link equity from every link." });
  }
  if (otherBotMeta.length > 0) {
    add({ id: "bot-specific-robots", section: "indexability", severity: "info", message: "Robots directives target other crawlers.", evidence: otherBotMeta.join("; "), fix: "Confirm the crawler-specific directives are intended." });
  }

  if (inputs.headers === null) {
    skipped.push({ check: "X-Robots-Tag header", reason: "The main document's response was not found in the tab's network log (buffer cleared or logging started after load)." });
  }

  const statusCode = inputs.logStatus ?? signals.navigation.responseStatus;
  if (statusCode === null) {
    skipped.push({ check: "HTTP status", reason: "Neither the network log nor Navigation Timing exposed the document status." });
  } else if (statusCode >= 400) {
    add({ id: "http-error-status", section: "indexability", severity: "error", message: `The document responded with HTTP ${statusCode}.`, fix: "Serve indexable pages with a 200 status; fix or remove URLs that return errors." });
  } else if (statusCode >= 300) {
    add({ id: "http-redirect-status", section: "indexability", severity: "warning", message: `The document responded with HTTP ${statusCode}.`, fix: "Link and canonicalise to the final destination URL." });
  } else if (statusCode !== 200) {
    add({ id: "http-nonstandard-status", section: "indexability", severity: "info", message: `The document responded with HTTP ${statusCode}.`, fix: "Indexable pages should normally return 200." });
  }
  if ((signals.navigation.redirectCount ?? 0) > 0) {
    add({ id: "redirected", section: "indexability", severity: "info", message: `The page was reached through ${signals.navigation.redirectCount} redirect(s).`, fix: "Internal links and canonicals should reference the final URL to avoid redirect hops." });
  }

  // robots.txt
  const robotsSummary: { fetched: boolean; status: number | null; allowedForAll: boolean | null; allowedForGooglebot: boolean | null; sitemaps: string[] } =
    { fetched: false, status: null, allowedForAll: null, allowedForGooglebot: null, sitemaps: [] };
  if (!isHttp || inputs.robots === null) {
    skipped.push({ check: "robots.txt", reason: "Only evaluated for http(s) pages." });
  } else if (!inputs.robots.ok) {
    skipped.push({ check: "robots.txt", reason: `Could not fetch /robots.txt from the page (${inputs.robots.error}).` });
    add({ id: "robots-txt-unreachable", section: "indexability", severity: "info", message: "robots.txt could not be fetched, so crawl rules were not evaluated.", evidence: inputs.robots.error, fix: "Check that /robots.txt is reachable from the page origin and not blocked by CSP connect-src." });
  } else {
    const r = inputs.robots;
    robotsSummary.fetched = true;
    robotsSummary.status = r.status;
    if (r.status >= 500) {
      add({ id: "robots-txt-server-error", section: "indexability", severity: "warning", message: `robots.txt returned HTTP ${r.status}; Google treats this as a temporary full disallow.`, fix: "Fix the server error so /robots.txt returns 200 or 404." });
    } else if (r.status >= 400) {
      add({ id: "robots-txt-missing", section: "indexability", severity: "info", message: `robots.txt returned HTTP ${r.status}; crawlers treat the site as fully crawlable.`, fix: "Add a robots.txt if you want to declare crawl rules or a Sitemap." });
      robotsSummary.allowedForAll = true;
      robotsSummary.allowedForGooglebot = true;
    } else if (/html/i.test(r.contentType)) {
      add({ id: "robots-txt-not-text", section: "indexability", severity: "info", message: "/robots.txt returned HTML (likely a single-page-app fallback), so it was ignored.", fix: "Serve a plain-text robots.txt or return 404." });
      robotsSummary.allowedForAll = true;
      robotsSummary.allowedForGooglebot = true;
    } else {
      let path = "/";
      try {
        const u = new URL(signals.url);
        path = u.pathname + u.search;
      } catch { /* keep "/" */ }
      const parsed = parseRobotsTxt(r.text);
      robotsSummary.sitemaps = parsed.sitemaps.slice(0, SEO_LIST_CAP);
      if (parsed.sitemaps.length > SEO_LIST_CAP) truncated = true;
      const all = evaluateRobots(parsed, "*", path);
      const google = evaluateRobots(parsed, "googlebot", path);
      robotsSummary.allowedForAll = all.allowed;
      robotsSummary.allowedForGooglebot = google.allowed;
      if (!google.allowed || !all.allowed) {
        const who = !google.allowed && !all.allowed ? "all crawlers including Googlebot" : !google.allowed ? "Googlebot" : "crawlers using the * group";
        const rule = (!google.allowed ? google : all).rule;
        add({ id: "robots-txt-disallowed", section: "indexability", severity: "warning", message: `robots.txt disallows crawling of this path for ${who}.`, evidence: rule ? `Disallow: ${rule.pattern} (path ${path})` : undefined, fix: "Remove or narrow the matching Disallow rule, or add a more specific Allow, if this page should be crawled." });
      }
      if (parsed.sitemaps.length === 0) {
        add({ id: "sitemap-not-declared", section: "indexability", severity: "info", message: "robots.txt does not declare a Sitemap.", fix: "Add a `Sitemap: https://…/sitemap.xml` line to robots.txt." });
      }
    }
  }

  // ── Content structure ─────────────────────────────────────────────────────

  const h1s = signals.headings.filter((h) => h.level === 1);
  if (h1s.length === 0) {
    add({ id: "h1-missing", section: "content", severity: "error", message: "The page has no h1.", fix: "Add one h1 that states the page's main topic." });
  } else if (h1s.length > 1) {
    add({ id: "h1-multiple", section: "content", severity: "warning", message: `The page has ${h1s.length} h1 elements.`, selectors: h1s.map((h) => h.selector), fix: "Use a single h1 and demote the others to h2-h6." });
  }

  const skips: Array<{ selector: string; detail: string }> = [];
  let prev = 0;
  for (const h of signals.headings) {
    if (prev > 0 && h.level > prev + 1) skips.push({ selector: h.selector, detail: `h${prev} -> h${h.level}` });
    prev = h.level;
  }
  if (skips.length > 0) {
    add({ id: "heading-level-skip", section: "content", severity: "warning", message: `${skips.length} heading level skip(s).`, evidence: skips.slice(0, 5).map((s) => s.detail).join(", "), selectors: skips.map((s) => s.selector), fix: "Nest headings one level at a time (h2 under h1, h3 under h2)." });
  }

  const emptyHeadings = signals.headings.filter((h) => h.empty);
  if (emptyHeadings.length > 0) {
    add({ id: "heading-empty", section: "content", severity: "warning", message: `${emptyHeadings.length} heading(s) have no text.`, selectors: emptyHeadings.map((h) => h.selector), fix: "Give headings text content or remove the empty elements." });
  }

  if (signals.images.missingAlt > 0) {
    add({ id: "image-alt-missing", section: "content", severity: "warning", message: `${signals.images.missingAlt} of ${signals.images.total} image(s) have no alt attribute.`, selectors: signals.images.missingAltSelectors, total: signals.images.missingAlt, fix: "Add descriptive alt text, or alt=\"\" for purely decorative images." });
  }

  // Links
  const links = signals.links;
  const genericByText = new Map<string, { destinations: Set<string>; selectors: string[] }>();
  const noHref: string[] = [];
  const jsHref: string[] = [];
  let nofollow = 0;
  for (const link of links) {
    if (/\bnofollow\b/i.test(link.rel)) nofollow++;
    if (link.href === null || link.href.trim() === "") {
      noHref.push(link.selector);
      continue;
    }
    if (/^\s*javascript:/i.test(link.href)) {
      jsHref.push(link.selector);
      continue;
    }
    const text = link.text.trim().toLowerCase().replace(/[.!»›→>]+$/, "").trim();
    if (GENERIC_LINK_TEXT.has(text)) {
      const entry = genericByText.get(text) ?? { destinations: new Set<string>(), selectors: [] };
      entry.destinations.add(normalizeUrl(link.abs) ?? link.href);
      entry.selectors.push(link.selector);
      genericByText.set(text, entry);
    }
  }
  for (const [text, entry] of genericByText) {
    if (entry.destinations.size > 1) {
      add({ id: "link-text-generic-ambiguous", section: "content", severity: "warning", message: `Link text "${text}" is used for ${entry.destinations.size} different destinations.`, selectors: entry.selectors, fix: "Use descriptive anchor text that names each destination." });
    } else {
      add({ id: "link-text-generic", section: "content", severity: "info", message: `Link text "${text}" is not descriptive.`, selectors: entry.selectors, fix: "Replace generic anchor text with words describing the destination." });
    }
  }
  if (noHref.length > 0) add({ id: "link-no-href", section: "content", severity: "warning", message: `${noHref.length} anchor(s) have no href, so crawlers cannot follow them.`, selectors: noHref, fix: "Give anchors a real href, or use <button> for in-page actions." });
  if (jsHref.length > 0) add({ id: "link-javascript-href", section: "content", severity: "warning", message: `${jsHref.length} link(s) use a javascript: href, which crawlers do not follow.`, selectors: jsHref, fix: "Use a real URL in href and attach behaviour with event handlers." });
  if (nofollow > 0) add({ id: "link-nofollow-count", section: "content", severity: "info", message: `${nofollow} link(s) carry rel=nofollow.`, fix: "Verify that nofollow is only applied to untrusted or paid links." });
  if (signals.linkTotal > links.length) truncated = true;

  if (signals.wordCount < THIN_CONTENT_WORDS) {
    add({ id: "thin-content", section: "content", severity: "info", message: `The page has ${signals.wordCount} words of visible text (under ${THIN_CONTENT_WORDS}).`, fix: "Heuristic only: ensure the page has enough unique content to satisfy its search intent." });
  }

  // ── Social ────────────────────────────────────────────────────────────────

  const og = signals.openGraph;
  const ogKeys = ["og:title", "og:description", "og:image", "og:url", "og:type"];
  const ogPresent = ogKeys.filter((k) => hasValue(og[k]));
  if (ogPresent.length === 0) {
    add({ id: "og-missing", section: "social", severity: "warning", message: "The page has no Open Graph tags, so shared links get a generic preview.", fix: "Add og:title, og:description, og:image, og:url and og:type meta tags." });
  } else {
    const severityFor: Record<string, SeoSeverity> = { "og:title": "warning", "og:description": "warning", "og:image": "warning", "og:url": "info", "og:type": "info" };
    for (const key of ogKeys) {
      if (!hasValue(og[key])) {
        add({ id: `${key.replace(":", "-")}-missing`, section: "social", severity: severityFor[key], message: `${key} is missing.`, fix: `Add <meta property="${key}" content="...">.` });
      }
    }
    if (hasValue(og["og:image"]) && !isAbsoluteUrl(og["og:image"])) {
      add({ id: "og-image-relative", section: "social", severity: "warning", message: "og:image is not an absolute URL.", evidence: og["og:image"], fix: "Use a fully qualified https:// URL; crawlers do not resolve relative image paths." });
    }
    if (hasValue(og["og:url"]) && firstCanon && canonicalStatus !== "invalid") {
      const a = normalizeUrl(og["og:url"]);
      const b = normalizeUrl(firstCanon.resolved);
      if (a && b && a !== b) add({ id: "og-url-canonical-mismatch", section: "social", severity: "info", message: "og:url differs from the canonical URL.", evidence: `${og["og:url"]} vs ${firstCanon.href}`, fix: "Keep og:url consistent with the canonical URL." });
    }
  }

  const tw = signals.twitter;
  const twCard = tw["twitter:card"];
  const TW_CARDS = ["summary", "summary_large_image", "app", "player"];
  if (!hasValue(twCard)) {
    add({ id: "twitter-card-missing", section: "social", severity: "info", message: "No twitter:card tag; X/Twitter falls back to Open Graph without a large-image card.", fix: "Add <meta name=\"twitter:card\" content=\"summary_large_image\">." });
  } else if (!TW_CARDS.includes(twCard.trim().toLowerCase())) {
    add({ id: "twitter-card-invalid", section: "social", severity: "warning", message: "twitter:card has an unrecognised value.", evidence: twCard, fix: `Use one of: ${TW_CARDS.join(", ")}.` });
  }
  if (hasValue(tw["twitter:image"]) && !isAbsoluteUrl(tw["twitter:image"])) {
    add({ id: "twitter-image-relative", section: "social", severity: "warning", message: "twitter:image is not an absolute URL.", evidence: tw["twitter:image"], fix: "Use a fully qualified https:// image URL." });
  }

  // ── Structured data ───────────────────────────────────────────────────────

  const blocks: SeoJsonLdBlock[] = [];
  const allTypes = new Set<string>();
  signals.jsonLd.forEach((text, index) => {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      blocks.push({ index, valid: false, types: [], error: message });
      add({ id: "jsonld-parse-error", section: "structuredData", severity: "error", message: `JSON-LD block ${index} is not valid JSON.`, evidence: clip(message, 160), fix: "Fix the syntax (quotes, trailing commas) so the block parses as JSON." });
      return;
    }
    const nodes = jsonLdNodes(doc);
    const types = [...new Set(nodes.flatMap(nodeTypes))];
    types.forEach((t) => allTypes.add(t));
    blocks.push({ index, valid: true, types });

    const ctx = isObject(doc) ? doc["@context"] : Array.isArray(doc) && isObject(doc[0]) ? doc[0]["@context"] : undefined;
    if (!/schema\.org/i.test(JSON.stringify(ctx ?? ""))) {
      add({ id: "jsonld-context-missing", section: "structuredData", severity: "warning", message: `JSON-LD block ${index} has no schema.org @context.`, fix: "Add \"@context\": \"https://schema.org\"." });
    }
    if (nodes.length === 0) {
      add({ id: "jsonld-no-type", section: "structuredData", severity: "warning", message: `JSON-LD block ${index} declares no @type.`, fix: "Give each entity an @type such as Article or Product." });
    }
    for (const node of nodes) {
      for (const type of nodeTypes(node)) {
        const rule = TYPE_RULES[type];
        if (!rule) continue;
        const missing = (rule.required ?? []).filter((p) => !hasValue(node[p]));
        if (rule.anyOf && !rule.anyOf.some((p) => hasValue(node[p]))) missing.push(`one of ${rule.anyOf.join("/")}`);
        const problems: string[] = [];
        if (type === "BreadcrumbList" && hasValue(node.itemListElement)) problems.push(...listItemProblems(asArray(node.itemListElement)));
        if (type === "FAQPage" && hasValue(node.mainEntity)) problems.push(...faqProblems(asArray(node.mainEntity)));
        const all = [...missing, ...problems];
        if (all.length > 0) {
          add({ id: "jsonld-required-missing", section: "structuredData", severity: "warning", message: `${type} (JSON-LD block ${index}) is missing required data.`, evidence: all.slice(0, 8).join("; "), fix: `Add the missing ${type} properties per Google's structured data guidelines.` });
        }
        const recommended = (rule.recommended ?? []).filter((p) => !hasValue(node[p]));
        if (recommended.length > 0) {
          add({ id: "jsonld-recommended-missing", section: "structuredData", severity: "info", message: `${type} (JSON-LD block ${index}) lacks recommended properties.`, evidence: recommended.join(", "), fix: "Add the recommended properties to improve rich-result eligibility." });
        }
      }
    }
  });
  if (signals.jsonLd.length === 0 && signals.microdataItems === 0 && signals.rdfaItems === 0) {
    add({ id: "structured-data-none", section: "structuredData", severity: "info", message: "The page has no structured data (JSON-LD, microdata or RDFa).", fix: "Add JSON-LD for the entity the page represents if it qualifies for rich results." });
  }

  // ── Links section ─────────────────────────────────────────────────────────

  const internalLinks = links.filter((l) => l.abs !== null && /^https?:/i.test(l.abs) && hostKeyOrigin(l.abs) === signals.origin);
  const externalLinks = links.filter((l) => l.abs !== null && /^https?:/i.test(l.abs) && hostKeyOrigin(l.abs) !== signals.origin);
  const uniqueInternal = new Set(internalLinks.map((l) => normalizeUrl(l.abs))).size;

  for (const broken of inputs.observedBrokenLinks) {
    add({ id: "link-broken-observed", section: "links", severity: "error", message: `A linked URL already failed when the page requested it (${broken.status ?? "network error"}).`, evidence: broken.url, fix: "Fix or remove the broken link target." });
  }
  const checks = inputs.linkChecks;
  if (checks) {
    const bad4 = checks.filter((c) => c.status !== null && c.status >= 400 && c.status < 500);
    const bad5 = checks.filter((c) => c.status !== null && c.status >= 500);
    const failed = checks.filter((c) => c.status === null);
    const redirected = checks.filter((c) => c.redirectedTo);
    const fmt = (c: SeoLinkCheckResult) => `${c.status ?? c.error ?? "failed"} ${c.url}`;
    if (bad4.length) add({ id: "link-broken-4xx", section: "links", severity: "error", message: `${bad4.length} same-origin link(s) return a 4xx status.`, evidence: bad4.slice(0, 10).map(fmt).join("; "), total: bad4.length, fix: "Fix or remove links to missing pages." });
    if (bad5.length) add({ id: "link-broken-5xx", section: "links", severity: "warning", message: `${bad5.length} same-origin link(s) return a 5xx status.`, evidence: bad5.slice(0, 10).map(fmt).join("; "), total: bad5.length, fix: "Investigate the server errors; they may be transient." });
    if (failed.length) add({ id: "link-check-failed", section: "links", severity: "warning", message: `${failed.length} same-origin link(s) could not be fetched.`, evidence: failed.slice(0, 10).map(fmt).join("; "), total: failed.length, fix: "Check the targets for timeouts or network errors." });
    if (redirected.length) add({ id: "link-redirected", section: "links", severity: "info", message: `${redirected.length} same-origin link(s) redirect before resolving.`, evidence: redirected.slice(0, 10).map((c) => `${c.url} -> ${c.redirectedTo}`).join("; "), total: redirected.length, fix: "Link directly to the final URL. Only the final destination is observable from the page; intermediate hops are not reported." });
    if (inputs.linkCheckTruncated) {
      truncated = true;
      add({ id: "link-check-capped", section: "links", severity: "info", message: `Only the first ${inputs.options.maxLinks} same-origin links were checked.`, fix: "Raise maxLinks (up to 100) or crawl separately for full coverage." });
    }
  }

  // ── Assemble ──────────────────────────────────────────────────────────────

  const order: Record<SeoSeverity, number> = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);

  const counts: SeoSeverityCounts = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) counts[issue.severity]++;

  const headings = signals.headings.slice(0, SEO_LIST_CAP).map((h) => ({ level: h.level, text: clip(h.text, 100) }));
  if (signals.headings.length > SEO_LIST_CAP) truncated = true;

  const hreflang = signals.hreflang.slice(0, SEO_LIST_CAP).map((h) => ({ hreflang: h.hreflang, href: h.href }));
  if (signals.hreflang.length > SEO_LIST_CAP) truncated = true;

  const indexable = noindexSources.length === 0;
  const headers = inputs.headers ?? {};

  return {
    tabId,
    url: signals.url,
    capturedAt,
    score: seoScore(counts),
    pass: counts.error === 0,
    issues,
    counts,
    sections: {
      metadata: summarize(issues, "metadata", {
        title,
        titleLength: title?.length ?? 0,
        description,
        descriptionLength: description?.length ?? 0,
        canonical: { href: firstCanon?.href ?? null, resolved: firstCanon?.resolved ?? null, status: canonicalStatus },
        lang,
        viewport: signals.viewport,
        charset: charset ?? headerCharset,
        hreflang
      }),
      indexability: summarize(issues, "indexability", {
        statusCode,
        redirectCount: signals.navigation.redirectCount,
        metaRobots: signals.robotsMeta,
        xRobotsTag: xRobots,
        headers,
        indexable,
        robotsTxt: robotsSummary
      }),
      content: summarize(issues, "content", {
        h1Count: h1s.length,
        headingCount: signals.headings.length,
        headings,
        wordCount: signals.wordCount,
        imageCount: signals.images.total,
        imagesMissingAlt: signals.images.missingAlt,
        linkCount: signals.linkTotal
      }),
      social: summarize(issues, "social", { openGraph: og, twitter: tw }),
      structuredData: summarize(issues, "structuredData", {
        jsonLd: blocks,
        types: [...allTypes],
        microdataItems: signals.microdataItems,
        rdfaItems: signals.rdfaItems
      }),
      links: summarize(issues, "links", {
        total: signals.linkTotal,
        internal: internalLinks.length,
        external: externalLinks.length,
        uniqueInternal,
        nofollow,
        checked: checks
      })
    },
    skipped,
    unsupported,
    truncated,
    options: { ...inputs.options }
  };
}

function hostKeyOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// ── Page-side collectors ──────────────────────────────────────────────────────

/**
 * Single `Runtime.evaluate` script that reads every SEO signal from the live
 * document and returns a `RawSeoSignals`. Self-contained (DOM globals only).
 */
export function seoCollectorScript(): string {
  return String.raw`(() => {
    const CAP_LINKS = 3000, CAP_HEADINGS = 500, CAP_SELECTORS = 50, CAP_JSONLD = 50, CAP_HREFLANG = 100;
    const selectorFor = ${SELECTOR_FOR_SOURCE};
    const norm = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n || 300);
    const metas = Array.prototype.slice.call(document.querySelectorAll("meta"));
    const metaContent = (m) => (m.getAttribute("content") || "");
    const byName = (name) => metas.filter((m) => (m.getAttribute("name") || "").toLowerCase() === name).map(metaContent);
    const resolve = (href) => { try { return new URL(href, document.baseURI).href; } catch (e) { return null; } };

    const head = document.head || document.documentElement;
    const titles = Array.prototype.slice.call(head.querySelectorAll("title")).map((t) => norm(t.textContent, 500));
    const canonicals = Array.prototype.slice.call(document.querySelectorAll('link[rel~="canonical" i]'))
      .map((l) => ({ href: l.getAttribute("href") || "", resolved: l.getAttribute("href") ? resolve(l.getAttribute("href")) : null }));
    const hreflang = Array.prototype.slice.call(document.querySelectorAll('link[rel~="alternate" i][hreflang]'), 0, CAP_HREFLANG)
      .map((l) => ({ hreflang: l.getAttribute("hreflang") || "", href: l.getAttribute("href") || "", resolved: resolve(l.getAttribute("href") || "") }));

    const robotsMeta = [];
    metas.forEach((m) => {
      const n = (m.getAttribute("name") || "").toLowerCase();
      if (n === "robots" || n === "googlebot" || /bot$/.test(n)) robotsMeta.push({ name: n, content: metaContent(m) });
    });

    const og = {}, tw = {};
    metas.forEach((m) => {
      const key = (m.getAttribute("property") || m.getAttribute("name") || "").toLowerCase();
      const content = norm(metaContent(m), 500);
      if (key.indexOf("og:") === 0 && !(key in og)) og[key] = content;
      else if (key.indexOf("twitter:") === 0 && !(key in tw)) tw[key] = content;
    });

    const headings = Array.prototype.slice.call(document.querySelectorAll("h1,h2,h3,h4,h5,h6"), 0, CAP_HEADINGS).map((h) => {
      const text = norm(h.textContent, 160);
      const imgAlt = h.querySelector("img[alt]");
      return { level: Number(h.tagName.charAt(1)), text: text, selector: selectorFor(h), empty: text === "" && !(imgAlt && imgAlt.getAttribute("alt")) && !h.getAttribute("aria-label") };
    });

    const imgs = Array.prototype.slice.call(document.querySelectorAll("img"));
    const missing = imgs.filter((i) => !i.hasAttribute("alt"));
    const images = { total: imgs.length, missingAlt: missing.length, missingAltSelectors: missing.slice(0, CAP_SELECTORS).map(selectorFor) };

    const anchors = Array.prototype.slice.call(document.querySelectorAll("a"));
    const links = anchors.slice(0, CAP_LINKS).map((a) => {
      const href = a.getAttribute("href");
      const text = norm(a.textContent || a.getAttribute("aria-label") || (a.querySelector("img") && a.querySelector("img").getAttribute("alt")) || "", 120);
      return { href: href, abs: href == null ? null : resolve(href), text: text, rel: (a.getAttribute("rel") || "").toLowerCase(), selector: selectorFor(a) };
    });

    let bodyText = "";
    if (document.body) {
      bodyText = typeof document.body.innerText === "string" && document.body.innerText !== ""
        ? document.body.innerText
        : (function () {
            const c = document.body.cloneNode(true);
            Array.prototype.forEach.call(c.querySelectorAll("script,style,noscript,template"), (n) => n.remove());
            return c.textContent || "";
          })();
    }
    const words = bodyText.split(/\s+/).filter(Boolean);

    const jsonLd = Array.prototype.slice.call(document.querySelectorAll('script[type="application/ld+json" i]'), 0, CAP_JSONLD)
      .map((s) => (s.textContent || "").slice(0, 200000));

    let nav = { responseStatus: null, redirectCount: null };
    try {
      const e = performance.getEntriesByType("navigation")[0];
      if (e) nav = { responseStatus: typeof e.responseStatus === "number" && e.responseStatus > 0 ? e.responseStatus : null, redirectCount: typeof e.redirectCount === "number" ? e.redirectCount : null };
    } catch (e) {}

    const metaCharset = document.querySelector("meta[charset]");
    const httpEquiv = metas.filter((m) => (m.getAttribute("http-equiv") || "").toLowerCase() === "content-type")[0];
    const viewport = byName("viewport")[0];
    const vp = viewport === undefined ? null : viewport;
    const httpEquivCharset = httpEquiv ? /charset\s*=\s*([^;\s]+)/i.exec(metaContent(httpEquiv)) : null;

    return {
      url: location.href,
      origin: location.origin,
      titles: titles,
      descriptions: byName("description").map((d) => norm(d, 1000)),
      canonicals: canonicals,
      lang: document.documentElement ? document.documentElement.getAttribute("lang") : null,
      viewport: vp,
      charset: { meta: metaCharset ? metaCharset.getAttribute("charset") : null, httpEquiv: httpEquivCharset ? httpEquivCharset[1] : null, document: document.characterSet || null },
      hreflang: hreflang,
      robotsMeta: robotsMeta,
      headings: headings,
      images: images,
      links: links,
      linkTotal: anchors.length,
      wordCount: words.length,
      openGraph: og,
      twitter: tw,
      jsonLd: jsonLd,
      microdataItems: document.querySelectorAll("[itemscope]").length,
      rdfaItems: document.querySelectorAll("[typeof]").length,
      navigation: nav
    };
  })()`;
}

/** Same-origin `/robots.txt` fetch with a hard timeout; resolves to a `RobotsFetchResult`. */
export function seoRobotsFetchScript(timeoutMs = ROBOTS_TIMEOUT_MS): string {
  return String.raw`(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ${Math.max(100, Math.floor(timeoutMs))});
    try {
      const res = await fetch("/robots.txt", { credentials: "same-origin", redirect: "follow", cache: "no-store", signal: ctrl.signal });
      const text = await res.text();
      return { ok: true, status: res.status, url: res.url, contentType: res.headers.get("content-type") || "", text: text.slice(0, ${ROBOTS_MAX_CHARS}) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
    } finally {
      clearTimeout(timer);
    }
  })()`;
}

/**
 * Bounded same-origin link check through the page's own `fetch` (HEAD, GET on
 * 405/501), concurrency 4, per-request timeout. Resolves to `SeoLinkCheckResult[]`.
 */
export function seoLinkCheckScript(urls: string[], timeoutMs = LINK_CHECK_TIMEOUT_MS, concurrency = LINK_CHECK_CONCURRENCY): string {
  return String.raw`(async () => {
    const urls = ${JSON.stringify(urls)};
    const results = new Array(urls.length);
    let next = 0;
    const attempt = async (url, method) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ${Math.max(100, Math.floor(timeoutMs))});
      try {
        const res = await fetch(url, { method: method, credentials: "same-origin", redirect: "follow", cache: "no-store", signal: ctrl.signal });
        try { if (res.body && res.body.cancel) res.body.cancel(); } catch (e) {}
        return res;
      } finally {
        clearTimeout(timer);
      }
    };
    const one = async (url) => {
      try {
        let res = await attempt(url, "HEAD");
        if (res.status === 405 || res.status === 501) res = await attempt(url, "GET");
        const out = { url: url, status: res.status };
        if (res.redirected && res.url && res.url !== url) out.redirectedTo = res.url;
        return out;
      } catch (e) {
        return { url: url, status: null, error: String((e && e.message) || e).slice(0, 120) };
      }
    };
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= urls.length) return;
        results[i] = await one(urls[i]);
      }
    };
    await Promise.all(Array.from({ length: ${Math.max(1, Math.floor(concurrency))} }, worker));
    return results;
  })()`;
}

// ── Orchestration over CDP ────────────────────────────────────────────────────

type EvalResult<T> = { result: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } };

async function evaluate<T>(target: CdpTarget, expression: string, awaitPromise: boolean): Promise<T | undefined> {
  const out = await target.send<EvalResult<T>>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
  if (out.exceptionDetails) {
    throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text ?? "SEO collector threw");
  }
  return out.result.value;
}

const clampLinks = (n: number | undefined): number => {
  if (typeof n !== "number" || !Number.isFinite(n)) return SEO_DEFAULT_MAX_LINKS;
  return Math.max(1, Math.min(SEO_MAX_LINKS, Math.floor(n)));
};

/**
 * Run the SEO audit over CDP. Page-side reads go through `Runtime.evaluate`;
 * the only requests issued are same-origin `fetch` calls from the page
 * (`/robots.txt` always, plus up to `maxLinks` links when `checkLinks` is set).
 * `networkRequests` is the tab's buffered network log (header/status source).
 */
export async function runSeoAudit(
  target: CdpTarget,
  tabId: TabId,
  networkRequests: NetworkRequestEntry[],
  opts: SeoAuditOptions = {}
): Promise<SeoAuditReport> {
  const checkLinks = opts.checkLinks === true;
  const maxLinks = clampLinks(opts.maxLinks);

  const signals = await evaluate<RawSeoSignals>(target, seoCollectorScript(), false);
  if (!signals) throw new Error("SEO collector returned no data (the page may still be navigating).");

  const skipped: SeoSkippedCheck[] = [];
  const isHttp = /^https?:/i.test(signals.url);

  let robots: RobotsFetchResult | null = null;
  if (isHttp) {
    try {
      robots = (await evaluate<RobotsFetchResult>(target, seoRobotsFetchScript(), true)) ?? { ok: false, error: "no result" };
    } catch (error) {
      robots = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const doc = mainDocumentResponse(networkRequests, signals.url);

  const internalUrls = signals.links
    .filter((l) => l.abs !== null && /^https?:/i.test(l.abs) && hostKeyOrigin(l.abs) === signals.origin)
    .map((l) => normalizeUrl(l.abs))
    .filter((u): u is string => !!u);
  const observed = observedBrokenLinks(networkRequests, internalUrls, signals.url);

  let linkChecks: SeoLinkCheckResult[] | null = null;
  let linkCheckTruncated = false;
  if (checkLinks) {
    const docUrl = normalizeUrl(signals.url);
    const candidates = [...new Set(internalUrls)].filter((u) => u !== docUrl);
    linkCheckTruncated = candidates.length > maxLinks;
    const batch = candidates.slice(0, maxLinks);
    if (batch.length === 0) {
      linkChecks = [];
    } else {
      const deadline = new Promise<"deadline">((resolve) => setTimeout(() => resolve("deadline"), LINK_CHECK_DEADLINE_MS).unref?.());
      const run = evaluate<SeoLinkCheckResult[]>(target, seoLinkCheckScript(batch), true).catch((error: unknown) => error as Error);
      const outcome = await Promise.race([run, deadline]);
      if (outcome === "deadline") {
        skipped.push({ check: "link check", reason: `Timed out after ${LINK_CHECK_DEADLINE_MS / 1000}s.` });
      } else if (outcome instanceof Error) {
        skipped.push({ check: "link check", reason: outcome.message });
      } else {
        linkChecks = outcome ?? [];
      }
    }
  }

  return buildSeoReport(
    signals,
    {
      headers: doc ? doc.headers : null,
      logStatus: doc ? doc.status : null,
      robots,
      linkChecks,
      observedBrokenLinks: observed,
      skipped,
      linkCheckTruncated,
      options: { checkLinks, maxLinks }
    },
    tabId,
    Date.now()
  );
}
