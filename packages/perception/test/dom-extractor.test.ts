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

  it("extracts social feed posts, composers, navigation, and post actions", () => {
    loadPage(
      `
        <nav aria-label="Primary">
          <a href="/home">Home</a>
          <a href="/explore">Explore</a>
          <a href="/notifications">Notifications</a>
          <a href="/messages">Messages</a>
          <a href="/ada">Profile</a>
        </nav>
        <main>
          <section aria-label="Composer">
            <div role="textbox" contenteditable="true" aria-label="What is happening?"></div>
            <button type="button">Post</button>
          </section>
          <article data-testid="tweet">
            <a href="/ada">
              <span>Ada Lovelace</span>
              <span>@ada</span>
            </a>
            <time datetime="2026-05-11T08:00:00Z">1h</time>
            <div data-testid="tweetText">Building programmable perception for messy social feeds.</div>
            <button aria-label="Reply 3">Reply</button>
            <button aria-label="Repost 4">Repost</button>
            <button aria-label="Like 12">Like</button>
            <button aria-label="Bookmark">Bookmark</button>
            <button aria-label="Share">Share</button>
          </article>
        </main>
      `,
      { url: "https://example.com/home", title: "Home / X" }
    );

    // Social-surface perception is opt-in (HELMSTACK_SOCIAL) — it must be
    // requested explicitly, otherwise a feed is NOT classified as social.
    const off = extractPageObservation("tab-social");
    expect(off.pageKind).not.toBe("social-feed");
    expect(off.social).toBeUndefined();

    const observation = extractPageObservation("tab-social", { includeSocial: true });

    expect(observation.pageKind).toBe("social-feed");
    expect(observation.social?.platform).toBe("generic");
    expect(observation.social?.kind).toBe("feed");
    expect(observation.social?.posts).toHaveLength(1);
    expect(observation.social?.posts[0].author).toContain("Ada Lovelace");
    expect(observation.social?.posts[0].text).toBe("Building programmable perception for messy social feeds.");
    expect(observation.social?.posts[0].actions.map((action) => action.kind)).toEqual([
      "reply",
      "repost",
      "like",
      "bookmark",
      "share"
    ]);
    expect(observation.social?.composers[0].purpose).toBe("post");
    expect(observation.social?.composers[0].submitActions[0].kind).toBe("submit_post");
    expect(observation.social?.navigation.map((item) => item.destination)).toContain("messages");
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

  it("disambiguates non-unique selector hints with :nth-of-type", () => {
    loadPage(
      `
        <main>
          <a href="/auth/google">Continue with Google</a>
          <a href="/auth/github">Continue with GitHub</a>
        </main>
      `,
      { url: "https://example.com/login", title: "Login" }
    );

    const observation = extractPageObservation("tab-disambig");
    const hints = observation.primaryActions.map((action) => action.selectorHint);

    // Each attribute-less link gets a unique nth-of-type qualifier...
    expect(hints).toContain("a:nth-of-type(1)");
    expect(hints).toContain("a:nth-of-type(2)");
    expect(new Set(hints).size).toBe(hints.length); // all distinct

    // ...and each hint resolves to exactly one element on the page.
    for (const hint of hints) {
      expect(document.querySelectorAll(hint)).toHaveLength(1);
    }
  });

  it("leaves unique selector hints unqualified", () => {
    loadPage(`<main><button id="go">Go</button><a href="/x" data-testid="x-link">X</a></main>`, {
      url: "https://example.com/",
      title: "Home"
    });

    const observation = extractPageObservation("tab-unique");
    const hints = observation.primaryActions.map((action) => action.selectorHint);
    expect(hints).toContain("button#go");
    expect(hints).toContain('a[data-testid="x-link"]');
    expect(hints.some((h) => h.includes(":nth-of-type"))).toBe(false);
  });
});
