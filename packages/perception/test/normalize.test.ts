import { describe, expect, it } from "vitest";

import { normalizePerception } from "../src/normalize.js";
import type { PageObservation, PageSnapshot } from "../../shared/src/index.js";

describe("normalizePerception", () => {
  it("merges live observation with raw snapshot into a planner-friendly page graph", () => {
    const observation: PageObservation = {
      tabId: "tab-1",
      url: "https://example.com/signup",
      title: "Sign up",
      timestamp: 1710000000000,
      pageKind: "signup",
      headings: ["Create account"],
      forms: [
        {
          id: "form-1",
          purpose: "signup",
          selectorHint: "form[name=\"signup\"]",
          fields: [
            {
              id: "field-1",
              label: "Email",
              name: "email",
              fieldType: "email",
              autocomplete: "email",
              required: true,
              selectorHint: "input[name=\"email\"]"
            },
            {
              id: "field-2",
              label: "Password",
              name: "password",
              fieldType: "password",
              required: true,
              selectorHint: "input[name=\"password\"]"
            }
          ],
          submitActions: [
            {
              id: "action-1",
              label: "Create Account",
              kind: "submit",
              selectorHint: "button",
              disabled: false
            }
          ]
        }
      ],
      primaryActions: [
        {
          id: "action-1",
          label: "Create Account",
          kind: "submit",
          selectorHint: "button",
          disabled: false
        },
        {
          id: "action-2",
          label: "Continue with Google",
          kind: "oauth",
          provider: "google",
          selectorHint: "button",
          disabled: false
        }
      ],
      alerts: [],
      media: []
    };

    const snapshot: PageSnapshot = {
      tabId: "tab-1",
      title: "Sign up",
      url: "https://example.com/signup",
      capturedAt: 1710000000100,
      dom: {
        documents: [{ nodes: [] }]
      },
      accessibilityTree: {
        nodes: [
          { role: { value: "heading" }, name: { value: "Create account" } },
          { role: { value: "textbox" }, name: { value: "Email" } },
          { role: { value: "textbox" }, name: { value: "Password" } },
          { role: { value: "button" }, name: { value: "Create Account" } }
        ]
      }
    };

    const result = normalizePerception(snapshot, observation);

    expect(result.graph.kind).toBe("signup");
    expect(result.graph.topHeading).toBe("Create account");
    expect(result.graph.oauthProviders).toEqual(["google"]);
    expect(result.graph.forms).toHaveLength(1);
    expect(result.graph.signals.documentCount).toBe(1);
    expect(result.graph.signals.accessibilityNodeCount).toBe(4);
    expect(result.graph.accessibility.headingTrail).toContain("Create account");
  });

  it("passes social surface semantics into the page graph", () => {
    const observation: PageObservation = {
      tabId: "tab-social",
      url: "https://example.com/home",
      title: "Social Home",
      timestamp: 1710000000000,
      pageKind: "social-feed",
      headings: [],
      forms: [],
      primaryActions: [],
      alerts: [],
      media: [],
      social: {
        platform: "generic",
        kind: "feed",
        posts: [],
        composers: [],
        navigation: [],
        actions: [],
        signals: {
          postCount: 0,
          composerCount: 0,
          navigationItemCount: 0,
          actionCount: 0
        }
      }
    };

    const snapshot: PageSnapshot = {
      tabId: "tab-social",
      title: "Social Home",
      url: "https://example.com/home",
      capturedAt: 1710000000100,
      dom: {
        documents: []
      },
      accessibilityTree: {
        nodes: []
      }
    };

    const result = normalizePerception(snapshot, observation);

    expect(result.graph.kind).toBe("social-feed");
    expect(result.graph.social?.kind).toBe("feed");
    expect(result.graph.social?.platform).toBe("generic");
  });
});
