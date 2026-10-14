/**
 * Table-driven accuracy check for the natural-language assertion evaluator
 * against a corpus of realistic agent assertions (see `assertion-corpus.ts`).
 *
 * Baseline before the deterministic grammar rewrite: 37/76 (49%) correct.
 */
import { describe, expect, it } from "vitest";

import { evaluateAssertionAgainstGraph } from "../../src/core/perception/assertions.js";
import { ASSERTION_CORPUS, UNSUPPORTED_ASSERTIONS } from "./assertion-corpus.js";

describe("NL assertion corpus", () => {
  it.each(ASSERTION_CORPUS)("$assertion [$pageName] → $expected", ({ assertion, page, expected }) => {
    const result = evaluateAssertionAgainstGraph("t", assertion, page);
    expect(result.pass, result.explanation).toBe(expected);
    expect(result.explanation.length).toBeGreaterThan(0);
  });

  it("is fully accurate on the corpus", () => {
    const wrong = ASSERTION_CORPUS.filter(c => evaluateAssertionAgainstGraph("t", c.assertion, c.page).pass !== c.expected);
    expect(wrong.map(c => `${c.assertion} [${c.pageName}]`)).toEqual([]);
  });

  it("flags assertions it cannot evaluate as unsupported, never as a pass", () => {
    for (const c of ASSERTION_CORPUS.filter(c => UNSUPPORTED_ASSERTIONS.includes(c.assertion))) {
      const result = evaluateAssertionAgainstGraph("t", c.assertion, c.page);
      expect(result.pass).toBe(false);
      expect(result.unsupported).toBe(true);
      expect(result.confidence).toBe("low");
      expect(result.explanation).toMatch(/Unsupported assertion.*Supported forms include/);
    }
    const supported = ASSERTION_CORPUS.filter(c => !UNSUPPORTED_ASSERTIONS.includes(c.assertion));
    for (const c of supported) {
      expect(evaluateAssertionAgainstGraph("t", c.assertion, c.page).unsupported, c.assertion).toBeUndefined();
    }
  });

  it("carries the matched page items as evidence", () => {
    const page = ASSERTION_CORPUS.find(c => c.pageName === "dashboard")!.page;
    const disabled = evaluateAssertionAgainstGraph("t", "the export button is disabled", page);
    expect(disabled.matched).toEqual(["button \"Export\" (disabled)"]);
    const heading = evaluateAssertionAgainstGraph("t", "the main heading is 'Dashboard'", page);
    expect(heading.matched).toEqual(["heading \"Dashboard\""]);
  });

  it("requires every part of an 'and' conjunction to hold", () => {
    const login = ASSERTION_CORPUS.find(c => c.pageName === "login")!.page;
    expect(evaluateAssertionAgainstGraph("t", "the email field is required and there is a sign in button", login).pass).toBe(true);
    expect(evaluateAssertionAgainstGraph("t", "the email field is required and there is an error", login).pass).toBe(false);
  });

  it("does not drop an unrecognised predicate", () => {
    const login = ASSERTION_CORPUS.find(c => c.pageName === "login")!.page;
    const r = evaluateAssertionAgainstGraph("t", "the heading is too long", login);
    expect(r.pass).toBe(false);
  });
});
