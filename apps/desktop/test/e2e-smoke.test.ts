import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { extractPageObservation } from "../../../packages/perception/src/dom-extractor.js";
import type { TabId } from "../../../packages/shared/src/index.js";

/**
 * Fixture-driven smoke test for the perception → fill → submit pipeline.
 *
 * This exercises the REAL perception extractor (`extractPageObservation`,
 * `collectForms`, `collectPrimaryActions`, `classifyPageKind`) against the REAL
 * `test-pages/contact-form.html` fixture in jsdom, then fills and submits the
 * form and asserts the captured data — the "navigate → perceive → fill → submit
 * → assert" flow, minus the Electron transport.
 *
 * The full Electron e2e (the agent server's HTTP API + CDP `Runtime.evaluate` +
 * a live `WebContentsView`) is a follow-up: it needs `electron` installed and a
 * display/CI, neither of which is available in the unit-test sandbox. This test
 * covers the headlessly-verifiable core of §94 so form perception can't regress.
 */
function loadFixture(name: string): void {
  const file = resolve(process.cwd(), "apps/desktop/test-pages", name);
  const html = readFileSync(file, "utf8");
  const inner = html
    .replace(/^[\s\S]*?<html[^>]*>/i, "")
    .replace(/<\/html>[\s\S]*$/i, "");
  document.documentElement.innerHTML = inner;
}

describe("e2e smoke — contact-form fixture (perception pipeline)", () => {
  beforeEach(() => loadFixture("contact-form.html"));

  it("navigate → perceive: extracts the contact form, its fields, and a submit action", () => {
    const obs = extractPageObservation("tab-1" as TabId);

    expect(obs.title).toContain("Contact Form");
    expect(obs.forms.length).toBeGreaterThan(0);

    const form = obs.forms[0];
    const fieldNames = form.fields.map((f) => f.name);
    expect(fieldNames).toEqual(expect.arrayContaining(["name", "email", "message", "topic", "consent"]));

    // required-ness is perceived from the markup
    const nameField = form.fields.find((f) => f.name === "name");
    expect(nameField?.required).toBe(true);

    // a submit action is perceived
    expect(form.submitActions.length).toBeGreaterThan(0);
  });

  it("perceives field types and labels (not just names)", () => {
    const obs = extractPageObservation("tab-1" as TabId);
    const form = obs.forms[0];
    const email = form.fields.find((f) => f.name === "email");
    expect(email?.fieldType).toBe("email");
    const message = form.fields.find((f) => f.name === "message");
    expect(message?.fieldType).toBe("textarea");
    // labels are resolved from the associated <label> elements
    expect(email?.label.toLowerCase()).toContain("email");
  });

  it("fill → submit → assert: filled values are captured on submit", () => {
    const set = (selector: string, value: string) => {
      const el = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };

    set("#name", "Ada Lovelace");
    set("#email", "ada@example.com");
    set("#message", "Hello from the smoke test.");
    const consent = document.querySelector("#consent") as HTMLInputElement;
    consent.checked = true;
    consent.dispatchEvent(new Event("change", { bubbles: true }));

    // perception reflects the page after fill (fields still present, still a form)
    const afterFill = extractPageObservation("tab-1" as TabId);
    expect(afterFill.forms[0].fields.some((f) => f.name === "name")).toBe(true);

    const form = document.querySelector("#contact-form") as HTMLFormElement;
    let captured: Record<string, string> | null = null;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      captured = Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
    });

    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(captured).not.toBeNull();
    expect(captured!).toMatchObject({
      name: "Ada Lovelace",
      email: "ada@example.com",
      message: "Hello from the smoke test.",
      consent: "on"
    });
  });
});
