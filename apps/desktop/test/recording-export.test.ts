import { describe, expect, it } from "vitest";

import { exportRecording, exportRecordingAll } from "../src/main/recording-export.js";
import type { RecordedCommand, RecordingSession } from "../../../packages/shared/src/index.js";

function cmd(source: RecordedCommand["source"], command: unknown): RecordedCommand {
  return { at: 0, source, command, outcome: "completed" };
}

const node = (role: string, name?: string) => ({ tabId: "t", frameId: "0", backendNodeId: 1, role, ...(name ? { name } : {}) });

const recording: RecordingSession = {
  tabId: "t",
  startedAt: 0,
  commands: [
    cmd("navigate", { type: "navigate", url: "https://example.com/login" }),
    cmd("command", { type: "type", node: node("textbox", "Email"), value: { kind: "literal", value: "a@b.com" } }),
    cmd("command", { type: "type", node: node("textbox", "Password"), value: { kind: "vault", id: "vault.identity.work_email" } }),
    cmd("command", { type: "select", node: node("combobox", "Country"), optionText: "US" }),
    cmd("command", { type: "click", node: node("button", "Sign in") })
  ]
};

describe("exportRecording — Playwright", () => {
  const out = exportRecording(recording, "playwright");

  it("emits a Playwright test with goto and getByRole locators", () => {
    expect(out).toContain('import { test, expect } from "@playwright/test";');
    expect(out).toContain('await page.goto("https://example.com/login");');
    expect(out).toContain('await page.getByRole("textbox", { name: "Email" }).fill("a@b.com");');
    expect(out).toContain('await page.getByRole("combobox", { name: "Country" }).selectOption("US");');
    expect(out).toContain('await page.getByRole("button", { name: "Sign in" }).click();');
  });

  it("never inlines a stored secret value", () => {
    expect(out).toContain('process.env["vault.identity.work_email"]');
    expect(out).not.toContain('"vault.identity.work_email": ');
  });
});

describe("exportRecording — Cypress", () => {
  it("emits cy.visit + findByRole calls", () => {
    const out = exportRecording(recording, "cypress");
    expect(out).toContain("@testing-library/cypress");
    expect(out).toContain('cy.visit("https://example.com/login");');
    expect(out).toContain('cy.findByRole("textbox", { name: "Email" }).type("a@b.com");');
    expect(out).toContain('cy.findByRole("button", { name: "Sign in" }).click();');
  });
});

describe("exportRecording — Testing Library", () => {
  it("emits userEvent + screen.getByRole calls", () => {
    const out = exportRecording(recording, "testing-library");
    expect(out).toContain("@testing-library/user-event");
    expect(out).toContain('await user.click(screen.getByRole("button", { name: "Sign in" }));');
    expect(out).toContain('await user.type(screen.getByRole("textbox", { name: "Email" }), "a@b.com");');
  });
});

describe("exportRecordingAll", () => {
  it("returns all three formats", () => {
    const all = exportRecordingAll(recording);
    expect(all.playwright).toContain("@playwright/test");
    expect(all.cypress).toContain("describe(");
    expect(all.testingLibrary).toContain("recordedFlow");
  });

  it("handles an empty recording", () => {
    const all = exportRecordingAll({ tabId: "t", startedAt: 0, commands: [] });
    expect(all.playwright).toContain('test("recorded flow"');
  });
});
