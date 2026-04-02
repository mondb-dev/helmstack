import { describe, expect, it, vi } from "vitest";

import { extractPageObservation } from "../src/dom-extractor.js";
import { normalizePerception } from "../src/normalize.js";
import type { PageGraph, PageObservation, PageSnapshot } from "../../shared/src/index.js";
import { loadFixture, readFixtureJson } from "./test-helpers.js";

const CASES = [
  {
    name: "signup-basic",
    url: "https://example.com/signup",
    title: "Sign up"
  },
  {
    name: "login-alert",
    url: "https://example.com/login",
    title: "Login"
  },
  {
    name: "oauth-choice",
    url: "https://example.com/register",
    title: "Register"
  },
  {
    name: "spa-profile-step",
    url: "https://example.com/onboarding/profile",
    title: "Finish setup"
  },
  {
    name: "shadow-signup",
    url: "https://example.com/shadow-signup",
    title: "Shadow Signup"
  },
  {
    name: "iframe-login",
    url: "https://example.com/embedded-auth",
    title: "Embedded Auth"
  }
] as const;

describe("fixture goldens", () => {
  for (const fixture of CASES) {
    it(`matches observation and graph goldens for ${fixture.name}`, () => {
      const dateNow = vi.spyOn(Date, "now").mockReturnValue(1710000000000);

      try {
        loadFixture(fixture.name, { url: fixture.url, title: fixture.title });

        const observation = extractPageObservation(`tab-${fixture.name}`);
        const expectedObservation = readFixtureJson<PageObservation>(`goldens/${fixture.name}.observation.json`);
        expect(toComparable(observation)).toEqual(expectedObservation);

        const snapshot = readFixtureJson<PageSnapshot>(`fixtures/${fixture.name}.snapshot.json`);
        const graph = normalizePerception(snapshot, observation).graph;
        const expectedGraph = readFixtureJson<PageGraph>(`goldens/${fixture.name}.graph.json`);
        expect(toComparable(graph)).toEqual(expectedGraph);
      } finally {
        dateNow.mockRestore();
      }
    });
  }
});

function toComparable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
