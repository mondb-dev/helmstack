/**
 * Heuristic free-text assertion evaluation against a `PageGraph` (ADR 0001 §4.3).
 * Moved verbatim from `apps/desktop/src/main/tab-manager.ts`.
 */
import type { AssertionResult, PageGraph, TabId } from "../../../../shared/src/index.js";

/**
 * Pure, synchronous heuristic evaluator.  Takes a pre-captured `PageGraph`
 * and a free-text assertion and returns an `AssertionResult`.
 *
 * Strategy (in order of confidence):
 *  1. Quantitative  "N items/results/errors/buttons/fields/forms/links"patterns 
 *  2. Absence  "no X", "not visible", "does not exist"patterns 
 *  3. Presence  label/text appears in actions/headings/alerts/formspatterns 
 *  4. Title / URL exact or contains checks
 *  5. Disabled-state  "X is disabled / enabled"checks 
 *  6. Count  "at least N", "more than N", "fewer than N"comparisons 
 *  7.  low-confidence pass/fail based on keyword scanFallback 
 */
export function evaluateAssertionAgainstGraph(
  tabId: TabId,
  assertion: string,
  graph: PageGraph
): AssertionResult {
  const norm = assertion.toLowerCase().trim();

  // Build evidence bundle
  const allFields = graph.forms.flatMap(f => f.fields.map(ff => ff.id ?? ff.label ?? ""));
  const evidence: import("../../../../shared/src/index.js").AssertionEvidence = {
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

  // Helpers
  /** All searchable text on the page as a single lowercase string. */
  const fullText = [
    graph.title,
    ...graph.headings,
    ...graph.actions.map(a => a.label),
    ...graph.alerts,
    ...allFields,
    ...graph.forms.map(f => f.name ?? ""),
    graph.url
  ].join(" ").toLowerCase();

  function pass(explanation: string, confidence: import("../../../../shared/src/index.js").AssertionConfidence = "high"): AssertionResult {
    return { tabId, assertion, pass: true, confidence, explanation, evidence };
  }
  function fail(explanation: string, confidence: import("../../../../shared/src/index.js").AssertionConfidence = "high"): AssertionResult {
    return { tabId, assertion, pass: false, confidence, explanation, evidence };
  }

  // 1. Quantitative: "shows N items / results / " errors
  const qtyMatch = norm.match(/\b(\d+)\s+(item|result|error|warning|button|link|field|form|message|alert|heading|image|video)s?\b/);
  if (qtyMatch) {
    const expected = parseInt(qtyMatch[1], 10);
    const noun = qtyMatch[2];
    const nounCounts: Record<string, number> = {
      item:    graph.actions.length,   // best  no cart-specific fieldproxy 
      result:  graph.headings.length,
      error:   graph.alerts.filter(a => /error|invalid|fail/i.test(a)).length,
      warning: graph.alerts.filter(a => /warn/i.test(a)).length,
      button:  graph.actions.filter(a => a.kind === "button" || a.kind === "submit").length,
      link:    graph.actions.filter(a => a.kind === "link").length,
      field:   allFields.length,
      form:    graph.forms.length,
      message: graph.alerts.length,
      alert:   graph.alerts.length,
      heading: graph.headings.length,
      image:   (graph.accessibility.roleCounts.img ?? 0) + (graph.accessibility.roleCounts.image ?? 0),
      video:   graph.media.filter(m => m.kind === "video").length
    };
    // Also check if the exact number appears in visible text (e.g. "3 items in cart")
    const numInText = fullText.includes(String(expected)) && fullText.includes(noun);
    const actual = nounCounts[noun] ?? 0;
    if (numInText) {
      return pass(`The text "${expected} ${noun}" was found on the page.`);
    }
    if (actual === expected) {
      return pass(`Found exactly ${actual} ${noun}(s) matches expected ${expected}.`);
    }
    if (Math.abs(actual - expected) <= 1) {
      return fail(`Expected ${expected} ${noun}(s) but found ${actual}, close but not matching.`, "medium");
    }
    return fail(`Expected ${expected} ${noun}(s) but found ${actual}.`);
  }

  // 2. Absence: "no X", "not visible", "does not exist", "hidden"
  const absenceMatch = norm.match(/\b(no |not |doesn't |does not |isn't |is not |never |hidden |absent )([\w\s]{2,40})/);
  if (absenceMatch) {
    const subject = absenceMatch[2].trim();
    const found = fullText.includes(subject);
    if (!found) {
      return pass(`"${subject}" was not found on the page, absence confirmed.`);
    }
    return fail(`"${subject}" was found on the page but the assertion expects it to be absent.`);
  }

  // 3. Disabled / enabled state
  const disabledMatch = norm.match(/\b([\w\s]{2,30})\s+is\s+(disabled|enabled|clickable|active|inactive)\b/);
  if (disabledMatch) {
    const label = disabledMatch[1].trim();
    const state = disabledMatch[2];
    const action = graph.actions.find(a => a.label.toLowerCase().includes(label));
    if (!action) {
      return fail(`Could not find an action with label matching "${label}".`, "medium");
    }
    const expectDisabled = state === "disabled" || state === "inactive";
    if (action.disabled === expectDisabled) {
      return pass(`Action "${action.label}" is ${state} as expected.`);
    }
    return fail(`Action "${action.label}" is ${action.disabled ? "disabled" : "enabled"} but assertion expects ${state}.`);
  }

  // 4. Title assertion
  if (norm.includes("title") || norm.includes("page is") || norm.includes("page title")) {
    const quoted = norm.match(/["']([^"']+)["']/);
    const titleLower = graph.title.toLowerCase();
    if (quoted) {
      const q = quoted[1].toLowerCase();
      if (titleLower.includes(q)) return pass(`Page title "${graph.title}" contains "${quoted[1]}".`);
      return fail(`Page title is "${graph.title}" does not contain "${quoted[1]}".`);
    }
    // No quote, just check that title is non-empty
    if (graph.title.trim()) return pass(`Page title is "${graph.title}".`, "medium");
    return fail("Page has no title.", "medium");
  }

  // 5. At-least / more-than / fewer-than
  const compMatch = norm.match(/\b(at least|more than|fewer than|less than|at most)\s+(\d+)\s+([\w]+)s?\b/);
  if (compMatch) {
    const op = compMatch[1];
    const n = parseInt(compMatch[2], 10);
    const noun = compMatch[3];
    const count = evidence.counts[noun as keyof typeof evidence.counts] ?? 0;
    const ok = (op === "at least" || op === "more than")
      ? (op === "at least" ? count >= n : count > n)
      : (op === "at most" ? count <= n : count < n);
    if (ok) return pass(`There are ${count} ${noun}(s) that satisfy "${op} ${n}".`);
    return fail(`There are ${count} ${noun}(s) that do not satisfy "${op} ${n}".`);
  }

  // 6. Presence: label/text appears anywhere
  // Strip common filler words to get the core subject
  const stripped = norm
    .replace(/\b(the|a|an|is|are|shows?|displays?|contains?|has|have|visible|present|exists?|on the page)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (stripped.length >= 3) {
    if (fullText.includes(stripped)) {
      return pass(`"${stripped}" was found in the page content.`, "medium");
    }
    // Try word-by-word: all significant words present?
    const words = stripped.split(" ").filter(w => w.length > 2);
    const allPresent = words.length > 0 && words.every(w => fullText.includes(w));
    if (allPresent) {
      return pass(`All key terms (${words.join(", ")}) were found on the page.`, "medium");
    }
    const anyPresent = words.some(w => fullText.includes(w));
    if (!anyPresent) {
      return fail(`None of the key terms (${words.join(", ")}) were found on the page.`, "low");
    }
    return fail(`Only some key terms were found. Assertion may not hold. Review evidence.`, "low");
  }

  // 7. Fallback
  return {
    tabId, assertion, pass: false,
    confidence: "low",
    explanation: "Could not determine truth of assertion from page graph alone. Provide the evidence bundle to an LLM for a second opinion.",
    evidence
  };
}
