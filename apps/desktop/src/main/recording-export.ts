import type { BrowserAction, LiteralValue, RecordingSession, SecretRef } from "../../../../packages/shared/src/index.js";

export type RecordingExportFormat = "playwright" | "cypress" | "testing-library";

/** A framework-agnostic step parsed from a recorded command. */
type Step =
  | { kind: "goto"; url: string }
  | { kind: "click"; role: string; name?: string }
  | { kind: "fill"; role: string; name?: string; value: string }
  | { kind: "select"; role: string; name?: string; option: string }
  | { kind: "submit"; role: string; name?: string }
  | { kind: "comment"; text: string };

/** Render a typed value as a JS expression, never leaking a stored secret. */
function valueExpr(value: SecretRef | LiteralValue): string {
  if (value.kind === "literal") return JSON.stringify(value.value);
  if (value.kind === "vault") return `process.env[${JSON.stringify(value.id)}] ?? "" /* vault secret */`;
  return `process.env[${JSON.stringify(`ACCOUNT_${value.field.toUpperCase()}`)}] ?? "" /* account ${value.field} */`;
}

/** Parse the recorded commands into normalized steps. */
function toSteps(recording: RecordingSession): Step[] {
  const steps: Step[] = [];
  for (const entry of recording.commands) {
    const command = entry.command as { type?: string };
    if (entry.source === "navigate" || command?.type === "navigate") {
      steps.push({ kind: "goto", url: (command as { url?: string }).url ?? "" });
      continue;
    }
    const action = command as BrowserAction;
    switch (action.type) {
      case "click":
        steps.push({ kind: "click", role: action.node.role, name: action.node.name });
        break;
      case "type":
        steps.push({ kind: "fill", role: action.node.role, name: action.node.name, value: valueExpr(action.value) });
        break;
      case "select":
        steps.push({ kind: "select", role: action.node.role, name: action.node.name, option: action.optionText });
        break;
      case "submit":
        steps.push({ kind: "submit", role: action.node.role, name: action.node.name });
        break;
      case "await_human":
        steps.push({ kind: "comment", text: `manual step: human handoff (${action.reason})` });
        break;
      default:
        steps.push({ kind: "comment", text: `unsupported step: ${JSON.stringify(command)}` });
    }
  }
  return steps;
}

function roleArgs(role: string, name?: string): string {
  const r = JSON.stringify(role.toLowerCase());
  return name ? `${r}, { name: ${JSON.stringify(name)} }` : r;
}

function renderPlaywright(steps: Step[]): string {
  const body = steps.map((s) => {
    switch (s.kind) {
      case "goto": return `  await page.goto(${JSON.stringify(s.url)});`;
      case "click": return `  await page.getByRole(${roleArgs(s.role, s.name)}).click();`;
      case "fill": return `  await page.getByRole(${roleArgs(s.role, s.name)}).fill(${s.value});`;
      case "select": return `  await page.getByRole(${roleArgs(s.role, s.name)}).selectOption(${JSON.stringify(s.option)});`;
      case "submit": return `  await page.getByRole(${roleArgs(s.role, s.name)}).click();`;
      case "comment": return `  // ${s.text}`;
    }
  });
  return [
    `import { test, expect } from "@playwright/test";`,
    ``,
    `test("recorded flow", async ({ page }) => {`,
    ...body,
    `});`,
    ``
  ].join("\n");
}

function renderCypress(steps: Step[]): string {
  const body = steps.map((s) => {
    switch (s.kind) {
      case "goto": return `    cy.visit(${JSON.stringify(s.url)});`;
      case "click": return `    cy.findByRole(${roleArgs(s.role, s.name)}).click();`;
      case "fill": return `    cy.findByRole(${roleArgs(s.role, s.name)}).type(${s.value});`;
      case "select": return `    cy.findByRole(${roleArgs(s.role, s.name)}).select(${JSON.stringify(s.option)});`;
      case "submit": return `    cy.findByRole(${roleArgs(s.role, s.name)}).click();`;
      case "comment": return `    // ${s.text}`;
    }
  });
  return [
    `// requires @testing-library/cypress`,
    `describe("recorded flow", () => {`,
    `  it("replays the recording", () => {`,
    ...body,
    `  });`,
    `});`,
    ``
  ].join("\n");
}

function renderTestingLibrary(steps: Step[]): string {
  const body = steps.map((s) => {
    switch (s.kind) {
      case "goto": return `  // navigate: render your app at ${JSON.stringify(s.url)}`;
      case "click": return `  await user.click(screen.getByRole(${roleArgs(s.role, s.name)}));`;
      case "fill": return `  await user.type(screen.getByRole(${roleArgs(s.role, s.name)}), ${s.value});`;
      case "select": return `  await user.selectOptions(screen.getByRole(${roleArgs(s.role, s.name)}), ${JSON.stringify(s.option)});`;
      case "submit": return `  await user.click(screen.getByRole(${roleArgs(s.role, s.name)}));`;
      case "comment": return `  // ${s.text}`;
    }
  });
  return [
    `import { screen } from "@testing-library/dom";`,
    `import userEvent from "@testing-library/user-event";`,
    ``,
    `export async function recordedFlow() {`,
    `  const user = userEvent.setup();`,
    ...body,
    `}`,
    ``
  ].join("\n");
}

/** Export a recording as runnable test code for the given framework. */
export function exportRecording(recording: RecordingSession, format: RecordingExportFormat): string {
  const steps = toSteps(recording);
  switch (format) {
    case "playwright": return renderPlaywright(steps);
    case "cypress": return renderCypress(steps);
    case "testing-library": return renderTestingLibrary(steps);
  }
}

/** Export a recording to every supported framework. */
export function exportRecordingAll(recording: RecordingSession): { playwright: string; cypress: string; testingLibrary: string } {
  return {
    playwright: exportRecording(recording, "playwright"),
    cypress: exportRecording(recording, "cypress"),
    testingLibrary: exportRecording(recording, "testing-library")
  };
}
