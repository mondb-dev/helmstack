import { describe, expect, it } from "vitest";

import { classifyAlertText, classToneSignals, decideAlertTone } from "../src/alert-tone.js";
import { extractPageObservation } from "../src/dom-extractor.js";
import { loadPage } from "./test-helpers.js";

describe("alert tone classification", () => {
  it.each([
    ["Please complete the name, email, and message fields.", "error"],
    ["Please enter a valid email address.", "error"],
    ["Consent is required before submitting the form.", "error"],
    ["Thanks, your message was sent.", "success"],
    ["Your changes have been saved.", "success"],
    ["Review your consent preferences below.", "unknown"],
    ["Your profile is 80% complete.", "unknown"],
    ["Please enter your name. Thank you.", "unknown"]
  ])("text %j -> %s", (text, tone) => {
    expect(classifyAlertText(text)).toBe(tone);
  });

  it("matches class hints per token, never as substrings", () => {
    expect(classToneSignals("alert alert-danger")).toEqual(["class-error"]);
    expect(classToneSignals("errorless unsuccessful")).toEqual([]);
  });

  it("lets structure outweigh a single weak hint and resolves ties to unknown", () => {
    expect(decideAlertTone(["role-alert"])).toBe("error");
    expect(decideAlertTone(["class-error"])).toBe("unknown");
    expect(decideAlertTone(["role-alert", "text-success"])).toBe("success");
    expect(decideAlertTone(["text-error", "text-success"])).toBe("unknown");
  });
});

describe("extractPageObservation alert tones", () => {
  const form = `
    <form>
      <label>Name<input id="name" name="name" required></label>
      <label>Email<input id="email" name="email" type="email" value="a@b.co"></label>
      <label><input id="consent" name="consent" type="checkbox" required> I agree</label>
    </form>`;

  it("classifies the contact-form markup by structure and whole words", () => {
    loadPage(
      `${form}<div class="error" id="form-error" role="alert" aria-live="polite">Consent is required before submitting the form.</div>
       <div class="success" id="form-success" role="status" aria-live="polite"></div>`,
      { url: "https://example.com/x", title: "Contact" }
    );
    const obs = extractPageObservation("t");
    expect(obs.alerts).toEqual(["Consent is required before submitting the form."]);
    expect(obs.alertDetails).toHaveLength(1);
    expect(obs.alertDetails![0].tone).toBe("error");
  });

  it("treats a role=alert success as success and plain copy as unknown", () => {
    loadPage(
      `<div role="alert">Your changes have been saved.</div><div role="status">Review your consent preferences.</div>`,
      { url: "https://example.com/x", title: "X" }
    );
    const tones = Object.fromEntries(extractPageObservation("t").alertDetails!.map((a) => [a.text, a.tone]));
    expect(tones["Your changes have been saved."]).toBe("success");
    expect(tones["Review your consent preferences."]).toBe("unknown");
  });

  it("reports whether fields are filled, never their values", () => {
    loadPage(`${form}`, { url: "https://example.com/x", title: "X" });
    const obs = extractPageObservation("t");
    const fields = obs.forms[0].fields;
    expect(fields.map((f) => f.filled)).toEqual([false, true, false]);
    expect(JSON.stringify(obs)).not.toContain("a@b.co");
  });
});
