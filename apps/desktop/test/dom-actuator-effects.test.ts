import { describe, expect, it } from "vitest";

import { collectFormFillEffects, collectSubmitEffects } from "../src/main/dom-actuator.js";
import type { ObservedField, ObservedForm } from "../../../packages/shared/src/index.js";

function field(fieldType: ObservedField["fieldType"], label: string): ObservedField {
  return { id: label, label, fieldType, required: false, selectorHint: "input" };
}

function form(overrides: Partial<ObservedForm> = {}): ObservedForm {
  return { id: "form-1", purpose: "generic", selectorHint: "form", submitActions: [], fields: [], ...overrides };
}

describe("collectFormFillEffects", () => {
  it("flags share_personal_data for email/tel/address/password fields", () => {
    const effects = collectFormFillEffects(form({ fields: [field("email", "Email"), field("password", "Password"), field("text", "Nickname")] }));
    expect(effects).toEqual([{ type: "share_personal_data", fields: ["Email", "Password"] }]);
  });

  it("returns undefined when no sensitive fields are present", () => {
    expect(collectFormFillEffects(form({ fields: [field("text", "Search")] }))).toBeUndefined();
  });
});

describe("collectSubmitEffects", () => {
  it("flags create_account for signup forms", () => {
    expect(collectSubmitEffects(form({ purpose: "signup", name: "register" }))).toEqual([{ type: "create_account", label: "register" }]);
  });

  it("returns undefined for non-signup forms", () => {
    expect(collectSubmitEffects(form({ purpose: "login" }))).toBeUndefined();
  });
});
