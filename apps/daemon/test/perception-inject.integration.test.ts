// @vitest-environment node
import type { PageObservation, TabId } from "@helmstack/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PERCEPTION_HANDLE_NAME,
  installPerception,
  requestObservation
} from "../../../packages/devtools-core/src/perception/injector.js";
import { launchChrome, tryFindChrome, type ChromeHandle } from "../src/chrome.js";
import { ChromeTabs } from "../src/tabs.js";

// Real-Chrome tests flake on the Windows runner ("The browser is already running for …") and the
// daemon is not verified on Windows; set HELMSTACK_TEST_WINDOWS_CHROME=1 to run them there.
const chrome = process.platform === "win32" && process.env.HELMSTACK_TEST_WINDOWS_CHROME !== "1" ? null : tryFindChrome();

function dataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

const FORM_PAGE = dataUrl(`<!doctype html><title>Contact</title>
<main>
  <h1>Contact us</h1>
  <form name="contact">
    <label for="email">Email</label><input id="email" name="email" type="email" required>
    <label for="msg">Message</label><textarea id="msg" name="msg"></textarea>
    <button type="submit">Send message</button>
  </form>
  <div role="alert">Please fill in all fields</div>
</main>`);

const SECOND_PAGE = dataUrl(`<!doctype html><title>Login</title>
<main>
  <h1>Sign in</h1>
  <form id="login">
    <input name="username" autocomplete="username" aria-label="Username">
    <input name="password" type="password" aria-label="Password">
    <button type="submit">Sign in</button>
  </form>
  <button type="button" id="help">Get help</button>
</main>`);

/** Waits for the first observation (after `since`) matching `predicate`. */
function waitFor(
  seen: PageObservation[],
  predicate: (o: PageObservation) => boolean,
  timeoutMs = 10_000
): Promise<PageObservation> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const match = seen.find(predicate);
      if (match) return resolve(match);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`No matching observation in ${timeoutMs} ms; saw ${seen.map((o) => o.title).join(", ")}`));
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe.skipIf(!chrome)("perception injection against real headless Chrome", () => {
  let handle: ChromeHandle;
  let tabs: ChromeTabs;

  beforeAll(async () => {
    handle = await launchChrome({ executablePath: chrome!.path });
    tabs = await ChromeTabs.create(handle.browser);
  }, 60_000);

  afterAll(async () => {
    tabs?.dispose();
    await handle?.close();
  });

  it("pushes forms/actions for the loaded document and after navigation; pull returns fresh data", async () => {
    const summary = await tabs.open(FORM_PAGE);
    const tabId = summary.id as TabId;
    const target = tabs.get(tabId);
    const seen: PageObservation[] = [];
    const errors: Error[] = [];

    const dispose = await installPerception(target, {
      tabId,
      onObservation: (o) => seen.push(o),
      onError: (e) => errors.push(e)
    });

    // Already-loaded document: injected via createIsolatedWorld + evaluate.
    const first = await waitFor(seen, (o) => o.title === "Contact");
    expect(first.tabId).toBe(tabId);
    expect(first.forms).toHaveLength(1);
    expect(first.forms[0]!.fields.map((f) => f.name)).toEqual(["email", "msg"]);
    expect(first.forms[0]!.submitActions.map((a) => a.label)).toContain("Send message");
    expect(first.primaryActions.length).toBeGreaterThan(0);
    expect(first.alerts).toContain("Please fill in all fields");

    // Isolated world: neither the binding nor the handle is visible to page scripts.
    await expect(
      target.evaluate(`typeof globalThis.__helmstackObserved + "/" + typeof globalThis[${JSON.stringify(PERCEPTION_HANDLE_NAME)}]`)
    ).resolves.toBe("undefined/undefined");

    // New document: re-injected by addScriptToEvaluateOnNewDocument.
    await tabs.navigate(tabId, SECOND_PAGE);
    const second = await waitFor(seen, (o) => o.title === "Login");
    expect(second.tabId).toBe(tabId);
    expect(second.pageKind).toBe("login");
    expect(second.forms).toHaveLength(1);
    expect(second.forms[0]!.purpose).toBe("login");
    expect(second.primaryActions.map((a) => a.label)).toEqual(expect.arrayContaining(["Sign in", "Get help"]));

    // Pull: sees a DOM change immediately, without waiting for the debounce.
    await target.evaluate(`document.querySelector("main").insertAdjacentHTML("beforeend", "<div role='alert'>Wrong password</div>")`);
    const pulled = await requestObservation(target, { tabId });
    expect(pulled?.tabId).toBe(tabId);
    expect(pulled?.alerts).toContain("Wrong password");
    expect(pulled?.forms).toHaveLength(1);

    // Mutation-driven push also arrives.
    await waitFor(seen, (o) => o.alerts.includes("Wrong password"));
    expect(errors).toEqual([]);

    // After dispose: no more pushes, even across navigation.
    await dispose();
    const countAfterDispose = seen.length;
    // Current document: dispose reached the running stream (createIsolatedWorld reuses the world).
    await target.evaluate(`document.querySelector("main").insertAdjacentHTML("beforeend", "<div role='alert'>After dispose</div>")`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(seen.length).toBe(countAfterDispose);
    await tabs.navigate(tabId, FORM_PAGE);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(seen.length).toBe(countAfterDispose);

    // Pull still works without an installed stream (one-off extraction).
    const oneOff = await requestObservation(target, { tabId });
    expect(oneOff?.title).toBe("Contact");
    expect(oneOff?.forms).toHaveLength(1);

    await tabs.close(tabId);
  }, 60_000);

  it("observes open shadow roots from the top frame only (child frames do not report)", async () => {
    const summary = await tabs.open("about:blank");
    const tabId = summary.id as TabId;
    const target = tabs.get(tabId);
    const seen: PageObservation[] = [];
    const dispose = await installPerception(target, { tabId, onObservation: (o) => seen.push(o) });

    // srcdoc iframes are same-origin with their parent.
    const page = dataUrl(`<!doctype html><title>Nested</title>
<iframe srcdoc="<form name='framed'><input name='q' aria-label='Search'><button type='submit'>Search</button></form>"></iframe>
<div id="host"></div>
<script>
  const root = document.getElementById("host").attachShadow({ mode: "open" });
  root.innerHTML = "<form name='shadowed'><input name='code' aria-label='Code'><button type='submit'>Verify</button></form>";
</script>`);
    await tabs.navigate(tabId, page);
    const nested = await waitFor(seen, (o) => o.title === "Nested" && o.forms.some((f) => f.name === "shadowed"));
    expect(nested.forms.map((f) => f.name)).toContain("shadowed");
    // KNOWN GAP (pre-existing, shared with the Electron preload): forms inside real same-origin
    // iframes are dropped because dom-extractor filters with "instanceof HTMLFormElement", which is
    // false for elements from the iframe's realm. Flip this when the extractor is realm-safe.
    expect(nested.forms.map((f) => f.name)).not.toContain("framed");
    // Only the top frame reports: no observation comes from the srcdoc child frame.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(seen.some((o) => o.url === "about:srcdoc")).toBe(false);
    expect(seen.every((o) => o.url.startsWith("about:blank") || o.title === "Nested")).toBe(true);

    await dispose();
    await tabs.close(tabId);
  }, 60_000);
});
