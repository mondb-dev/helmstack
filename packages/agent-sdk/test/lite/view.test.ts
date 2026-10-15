import { describe, expect, it } from "vitest";

import { describePage, renderPageView } from "../../src/lite/index.js";
import { contactSource, manyLinks, SECRET } from "./fixtures.js";

describe("renderPageView", () => {
  it("renders the numbered view in priority order", () => {
    const view = renderPageView(contactSource(), { view: 3 });
    expect(view.text.split("\n")).toEqual([
      "Page: Contact HelmStack (http://127.0.0.1:4177/contact-form.html) · view 3",
      "Headings: Contact HelmStack > Send us a message",
      'Messages: error "Please enter a valid email address."',
      '[1] textbox "Full name" (required, empty)',
      '[2] textbox "Work email" (required, invalid, filled)',
      '[3] combobox "Topic" (filled)',
      '[4] checkbox "I agree to be contacted" (required, unchecked)',
      '[5] button "Send message"',
      '[6] button "Help"',
      '[7] link "Docs"'
    ]);
    expect(view.omitted).toBe(0);
    expect(view.elements.map((e) => [e.n, e.id])).toEqual([
      [1, "field-name"],
      [2, "field-email"],
      [3, "field-topic"],
      [4, "field-consent"],
      [5, "act-send"],
      [6, "act-help"],
      [7, "act-docs"]
    ]);
    expect(view.elements[4]!.submitsFormId).toBe("form-1");
  });

  it("never includes field values, ids or selectors", () => {
    const source = contactSource();
    // A hostile extractor that leaks values into unexpected properties still cannot reach the output.
    (source.forms[0]!.fields[1] as unknown as Record<string, unknown>).value = SECRET;
    const text = renderPageView(source).text;
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("#email");
    expect(text).not.toContain("field-email");
    expect(text).toContain("filled");
  });

  it("caps output, keeps priority order, and says what was omitted", () => {
    const view = renderPageView(manyLinks(60), { maxChars: 900 });
    expect(view.text.length).toBeLessThanOrEqual(900);
    expect(view.text).toMatch(/… \d+ more links? \(look all\)$/);
    // messages and fields survive; links are what get dropped
    expect(view.text).toContain("Messages:");
    expect(view.text).toContain('[1] textbox "Full name"');
    expect(view.omitted).toBeGreaterThan(40);
    const listed = view.elements.length;
    expect(view.text.match(/^\[\d+\]/gm)).toHaveLength(listed);
  });

  it("look all raises the cap and drops the hint", () => {
    const capped = renderPageView(manyLinks(60), { maxChars: 900 });
    const all = renderPageView(manyLinks(60), { maxChars: 900, all: true });
    expect(all.elements.length).toBeGreaterThan(capped.elements.length);
    expect(all.text.length).toBeLessThanOrEqual(900 * 6);
    expect(all.text).not.toContain("(look all)");
  });

  it("is deterministic", () => {
    expect(renderPageView(contactSource(), { view: 1 })).toEqual(renderPageView(contactSource(), { view: 1 }));
  });

  it("orders messages error-first and falls back to plain alerts", () => {
    const view = renderPageView(
      contactSource({
        alertDetails: [
          { text: "Saved!", tone: "success", signals: [] },
          { text: "Bad email", tone: "error", signals: [] }
        ]
      })
    );
    expect(view.text).toContain('Messages: error "Bad email"; success "Saved!"');
    const plain = renderPageView(contactSource({ alertDetails: undefined, alerts: ["Heads up"] }));
    expect(plain.text).toContain('Messages: notice "Heads up"');
  });

  it("shows body prose that is not already a heading, label or button, within a small budget", () => {
    const source = contactSource({
      headings: ["About Bench Co"],
      alerts: [],
      alertDetails: undefined,
      forms: [],
      actions: [{ id: "a", label: "Back to home", kind: "link", href: "/home.html", selectorHint: "a", disabled: false }],
      text: 'About Bench Co\nFounded in 2024. Our motto is "measure twice".\nBack to home'
    });
    const view = renderPageView(source);
    expect(view.text).toContain("Text: \"Founded in 2024. Our motto is 'measure twice'.\"");
    expect(view.text).not.toContain('Text: "About Bench Co');
    const long = renderPageView({ ...source, text: "word ".repeat(400) });
    const line = long.text.split("\n").find((l) => l.startsWith("Text:"))!;
    expect(line.length).toBeLessThanOrEqual(300);
    expect(line.endsWith('…"')).toBe(true);
    expect(renderPageView({ ...source, text: "word ".repeat(400) }, { all: true }).text.split("\n").find((l) => l.startsWith("Text:"))!.length).toBeGreaterThan(300);
  });

  it("handles a page with nothing interactive", () => {
    const view = renderPageView({ url: "http://x/", title: "", headings: [], forms: [], alerts: [] });
    expect(view.text).toContain("(untitled)");
    expect(view.text).toContain("No interactive elements");
    expect(view.elements).toEqual([]);
  });

  it("describePage gives a one-line description", () => {
    const line = describePage(contactSource());
    expect(line).toContain("Contact HelmStack");
    expect(line).toContain("1 form with 4 fields (2 filled)");
    expect(line).toContain("error");
    expect(line.split("\n")).toHaveLength(1);
  });
});
