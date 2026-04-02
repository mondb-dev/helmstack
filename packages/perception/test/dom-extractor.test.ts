import { describe, expect, it, vi } from "vitest";

import { extractPageObservation, installPageObservationStream } from "../src/dom-extractor.js";
import { loadPage } from "./test-helpers.js";

describe("extractPageObservation", () => {
  it("detects a signup page with required fields and oauth actions", () => {
    loadPage(
      `
        <main>
          <h1>Create account</h1>
          <form name="signup">
            <label>Email<input type="email" name="email" required autocomplete="email" /></label>
            <label>Password<input type="password" name="password" required /></label>
            <button type="submit">Create Account</button>
            <button type="button">Continue with Google</button>
          </form>
        </main>
      `,
      { url: "https://example.com/signup", title: "Sign up" }
    );

    const observation = extractPageObservation("tab-signup");

    expect(observation.pageKind).toBe("signup");
    expect(observation.headings).toContain("Create account");
    expect(observation.forms).toHaveLength(1);
    expect(observation.forms[0].purpose).toBe("signup");
    expect(observation.forms[0].fields.map((field) => field.fieldType)).toEqual(["email", "password"]);
    expect(observation.forms[0].fields.every((field) => field.required)).toBe(true);
    expect(observation.primaryActions.some((action) => action.provider === "google")).toBe(true);
  });

  it("detects a login page and extracts inline validation alerts", () => {
    loadPage(
      `
        <section>
          <h1>Log in</h1>
          <form>
            <label>Email address<input type="email" name="email" /></label>
            <label>Password<input type="password" name="password" /></label>
            <button type="submit">Sign in</button>
          </form>
          <div role="alert">Incorrect email or password</div>
        </section>
      `,
      { url: "https://example.com/login", title: "Login" }
    );

    const observation = extractPageObservation("tab-login");

    expect(observation.pageKind).toBe("login");
    expect(observation.forms[0].purpose).toBe("login");
    expect(observation.alerts).toContain("Incorrect email or password");
  });
});

describe("installPageObservationStream", () => {
  it("emits on initial load, DOM mutation, and history updates", async () => {
    vi.useFakeTimers();
    loadPage(`<main><h1>Welcome</h1></main>`, { url: "https://example.com/home" });

    let callCount = 0;
    installPageObservationStream(() => {
      callCount += 1;
    });

    vi.advanceTimersByTime(160);
    expect(callCount).toBe(1);

    const next = document.createElement("button");
    next.textContent = "Continue";
    document.body.append(next);
    await Promise.resolve();

    vi.advanceTimersByTime(149);
    expect(callCount).toBe(1);
    vi.advanceTimersByTime(1);
    expect(callCount).toBe(2);

    history.pushState({}, "", "/next");
    vi.advanceTimersByTime(160);
    expect(callCount).toBe(3);

    vi.useRealTimers();
  });

  it("emits when a same-origin iframe document mutates", async () => {
    vi.useFakeTimers();
    loadPage(`<main><div id="frame-host"></div></main>`, { url: "https://example.com/embedded" });

    const host = document.getElementById("frame-host")!;
    const frame = document.createElement("iframe");
    host.append(frame);

    const frameDocument = document.implementation.createHTMLDocument("Embedded Frame");
    frameDocument.body.innerHTML = `<button>Initial</button>`;
    Object.defineProperty(frame, "contentDocument", {
      configurable: true,
      value: frameDocument
    });

    let callCount = 0;
    installPageObservationStream(() => {
      callCount += 1;
    });

    vi.advanceTimersByTime(160);
    expect(callCount).toBe(1);

    const extra = frameDocument.createElement("button");
    extra.textContent = "Next";
    frameDocument.body.append(extra);
    await Promise.resolve();

    vi.advanceTimersByTime(160);
    expect(callCount).toBe(2);

    vi.useRealTimers();
  });
});
