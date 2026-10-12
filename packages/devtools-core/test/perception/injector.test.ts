import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CdpTarget, PageObservation, TabId } from "../../../shared/src/index.js";
import {
  PERCEPTION_BINDING_NAME,
  PERCEPTION_HANDLE_NAME,
  PERCEPTION_WORLD_NAME,
  installPerception,
  parseObservationPayload,
  requestObservation
} from "../../src/perception/injector.js";

const TAB = "tab-7" as TabId;
const CONTEXT_ID = 41;

type Call = { method: string; params?: Record<string, unknown> };
type Handler = (params: Record<string, unknown> | undefined) => unknown;

/**
 * Fake `CdpTarget`. With `execute: true` it behaves like the page's isolated
 * world inside jsdom: `Runtime.evaluate` really runs the expression against
 * the jsdom document and `Runtime.addBinding` installs a global that emits
 * `Runtime.bindingCalled`.
 */
class FakeCdpTarget implements CdpTarget {
  readonly calls: Call[] = [];
  readonly overrides = new Map<string, Handler>();
  readonly #listeners = new Set<(method: string, params: Record<string, unknown>) => void>();

  constructor(private readonly execute = false) {}

  async send<T = any>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    const override = this.overrides.get(method);
    if (override) return override(params) as T;
    const scope = globalThis as unknown as Record<string, unknown>;
    switch (method) {
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: "main-frame" } } } as T;
      case "Page.createIsolatedWorld":
        return { executionContextId: CONTEXT_ID } as T;
      case "Page.addScriptToEvaluateOnNewDocument":
        return { identifier: "script-1" } as T;
      case "Runtime.addBinding": {
        if (this.execute) {
          const name = String(params?.name);
          scope[name] = (payload: string) =>
            this.emit("Runtime.bindingCalled", { name, payload, executionContextId: CONTEXT_ID });
        }
        return {} as T;
      }
      case "Runtime.removeBinding":
        delete scope[String(params?.name)];
        return {} as T;
      case "Runtime.evaluate": {
        if (!this.execute) return { result: { type: "undefined" } } as T;
        try {
          const value = (0, eval)(String(params?.expression));
          return { result: { type: typeof value, value } } as T;
        } catch (error) {
          return { result: { type: "object" }, exceptionDetails: { text: "Uncaught", exception: { description: String(error) } } } as T;
        }
      }
      default:
        return {} as T;
    }
  }

  onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(method: string, params: Record<string, unknown>): void {
    for (const listener of [...this.#listeners]) listener(method, params);
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  async evaluate<T = unknown>(): Promise<T> {
    throw new Error("not used by the injector");
  }
  url(): string {
    return "https://example.com/";
  }
  isLoading(): boolean {
    return false;
  }
  async waitForLoadStop(): Promise<void> {}

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }
}

function observationJson(overrides: Partial<PageObservation> = {}): string {
  const observation: PageObservation = {
    tabId: "" as TabId,
    url: "https://example.com/contact",
    title: "Contact",
    timestamp: 1,
    pageKind: "form",
    headings: ["Contact"],
    forms: [],
    primaryActions: [],
    alerts: [],
    media: [],
    ...overrides
  };
  return JSON.stringify(observation);
}

function loadContactForm() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(path.join(here, "../../../../apps/desktop/test-pages/contact-form.html"), "utf8");
  const parsed = new DOMParser().parseFromString(html, "text/html");
  document.title = parsed.title;
  // innerHTML does not execute the fixture's <script>, which only wires submit handling.
  document.body.innerHTML = parsed.body.innerHTML;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[PERCEPTION_HANDLE_NAME];
  delete (globalThis as Record<string, unknown>)[PERCEPTION_BINDING_NAME];
});

describe("installPerception (protocol)", () => {
  it("adds the binding, the new-document script and injects into the current document, all in the helmstack world", async () => {
    const target = new FakeCdpTarget();
    await installPerception(target, { tabId: TAB, onObservation: () => {} });

    expect(target.methods()).toEqual([
      "Page.enable",
      "Runtime.enable",
      "Runtime.addBinding",
      "Page.addScriptToEvaluateOnNewDocument",
      "Page.getFrameTree",
      "Page.createIsolatedWorld",
      "Runtime.evaluate"
    ]);
    const [, , binding, addScript, , world, evaluate] = target.calls;
    expect(binding!.params).toEqual({ name: PERCEPTION_BINDING_NAME, executionContextName: PERCEPTION_WORLD_NAME });
    expect(addScript!.params).toMatchObject({ worldName: PERCEPTION_WORLD_NAME });
    const source = String(addScript!.params!.source);
    expect(source).toContain(`.install({"bindingName":"${PERCEPTION_BINDING_NAME}","handleName":"${PERCEPTION_HANDLE_NAME}","includeSocial":false})`);
    expect(world!.params).toMatchObject({ frameId: "main-frame", worldName: PERCEPTION_WORLD_NAME });
    expect(evaluate!.params).toMatchObject({ contextId: CONTEXT_ID, expression: source, returnByValue: true });
  });

  it("passes includeSocial and custom names through", async () => {
    const target = new FakeCdpTarget();
    await installPerception(target, { tabId: TAB, onObservation: () => {}, includeSocial: true, worldName: "w", bindingName: "b" });
    const addScript = target.calls.find((c) => c.method === "Page.addScriptToEvaluateOnNewDocument")!;
    expect(addScript.params!.worldName).toBe("w");
    expect(String(addScript.params!.source)).toContain(`"bindingName":"b"`);
    expect(String(addScript.params!.source)).toContain(`"includeSocial":true`);
    expect(target.calls.find((c) => c.method === "Runtime.addBinding")!.params).toEqual({ name: "b", executionContextName: "w" });
  });

  it("turns bindingCalled into a PageObservation with the tab id stamped", async () => {
    const target = new FakeCdpTarget();
    const seen: PageObservation[] = [];
    const errors: Error[] = [];
    await installPerception(target, { tabId: TAB, onObservation: (o) => seen.push(o), onError: (e) => errors.push(e) });

    target.emit("Runtime.bindingCalled", { name: PERCEPTION_BINDING_NAME, payload: observationJson({ tabId: "spoofed" as TabId }), executionContextId: CONTEXT_ID });
    target.emit("Runtime.bindingCalled", { name: "someoneElsesBinding", payload: observationJson(), executionContextId: 1 });
    target.emit("Runtime.consoleAPICalled", { type: "log" });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.tabId).toBe(TAB);
    expect(seen[0]!.title).toBe("Contact");
    expect(errors).toEqual([]);
  });

  it("reports malformed payloads via onError without emitting", async () => {
    const target = new FakeCdpTarget();
    const seen: PageObservation[] = [];
    const errors: Error[] = [];
    await installPerception(target, { tabId: TAB, onObservation: (o) => seen.push(o), onError: (e) => errors.push(e) });

    target.emit("Runtime.bindingCalled", { name: PERCEPTION_BINDING_NAME, payload: "{not json" });
    target.emit("Runtime.bindingCalled", { name: PERCEPTION_BINDING_NAME, payload: JSON.stringify({ url: "x" }) });

    expect(seen).toEqual([]);
    expect(errors).toHaveLength(2);
  });

  it("still installs when injecting into the current document fails", async () => {
    const target = new FakeCdpTarget();
    target.overrides.set("Page.createIsolatedWorld", () => Promise.reject(new Error("No frame for given id found")));
    const errors: Error[] = [];
    const seen: PageObservation[] = [];
    await installPerception(target, { tabId: TAB, onObservation: (o) => seen.push(o), onError: (e) => errors.push(e) });

    expect(errors.map((e) => e.message)).toEqual(["No frame for given id found"]);
    target.emit("Runtime.bindingCalled", { name: PERCEPTION_BINDING_NAME, payload: observationJson() });
    expect(seen).toHaveLength(1);
  });

  it("rejects and cleans up when setup fails", async () => {
    const target = new FakeCdpTarget();
    target.overrides.set("Page.addScriptToEvaluateOnNewDocument", () => Promise.reject(new Error("Target closed")));
    await expect(installPerception(target, { tabId: TAB, onObservation: () => {} })).rejects.toThrow("Target closed");

    expect(target.listenerCount).toBe(0);
    expect(target.methods()).toContain("Runtime.removeBinding");
    expect(target.methods()).not.toContain("Page.removeScriptToEvaluateOnNewDocument");
  });

  it("dispose removes script and binding, silences the current document and is idempotent", async () => {
    const target = new FakeCdpTarget();
    const seen: PageObservation[] = [];
    const dispose = await installPerception(target, { tabId: TAB, onObservation: (o) => seen.push(o) });
    const before = target.calls.length;

    await dispose();
    const disposeCalls = target.calls.slice(before);
    expect(disposeCalls).toContainEqual({ method: "Page.removeScriptToEvaluateOnNewDocument", params: { identifier: "script-1" } });
    expect(disposeCalls).toContainEqual({ method: "Runtime.removeBinding", params: { name: PERCEPTION_BINDING_NAME } });
    const silence = disposeCalls.find((c) => c.method === "Runtime.evaluate")!;
    expect(silence.params).toMatchObject({ contextId: CONTEXT_ID });
    expect(String(silence.params!.expression)).toContain(".dispose()");

    target.emit("Runtime.bindingCalled", { name: PERCEPTION_BINDING_NAME, payload: observationJson() });
    expect(seen).toEqual([]);

    const afterFirst = target.calls.length;
    await dispose();
    expect(target.calls.length).toBe(afterFirst);
  });

  it("dispose tolerates a closed target", async () => {
    const target = new FakeCdpTarget();
    const dispose = await installPerception(target, { tabId: TAB, onObservation: () => {} });
    target.overrides.set("Page.removeScriptToEvaluateOnNewDocument", () => Promise.reject(new Error("Target closed")));
    target.overrides.set("Runtime.removeBinding", () => Promise.reject(new Error("Target closed")));
    target.overrides.set("Page.getFrameTree", () => Promise.reject(new Error("Target closed")));
    await expect(dispose()).resolves.toBeUndefined();
  });
});

describe("requestObservation (protocol)", () => {
  it("evaluates in the helmstack world of the main frame and stamps the tab id", async () => {
    const target = new FakeCdpTarget();
    target.overrides.set("Runtime.evaluate", () => ({ result: { type: "string", value: observationJson({ title: "Fresh" }) } }));
    const observation = await requestObservation(target, { tabId: TAB });

    expect(observation?.title).toBe("Fresh");
    expect(observation?.tabId).toBe(TAB);
    expect(target.calls.find((c) => c.method === "Page.createIsolatedWorld")!.params).toMatchObject({
      frameId: "main-frame",
      worldName: PERCEPTION_WORLD_NAME
    });
    expect(target.calls.find((c) => c.method === "Runtime.evaluate")!.params).toMatchObject({ contextId: CONTEXT_ID });
  });

  it("resolves null when nothing comes back and throws on page exceptions", async () => {
    const target = new FakeCdpTarget();
    await expect(requestObservation(target)).resolves.toBeNull();

    target.overrides.set("Runtime.evaluate", () => ({
      result: { type: "object" },
      exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: boom" } }
    }));
    await expect(requestObservation(target)).rejects.toThrow("TypeError: boom");
  });
});

describe("parseObservationPayload", () => {
  it("overrides any page-supplied tab id", () => {
    expect(parseObservationPayload(observationJson({ tabId: "evil" as TabId }), TAB).tabId).toBe(TAB);
  });

  it("rejects non-objects", () => {
    expect(() => parseObservationPayload("null", TAB)).toThrow();
    expect(() => parseObservationPayload("[]", TAB)).toThrow();
  });
});

describe("bundled page source against contact-form.html (jsdom)", () => {
  it("pushes an observation with the contact form, serves pulls, and goes quiet after dispose", async () => {
    loadContactForm();
    const target = new FakeCdpTarget(true);
    const seen: PageObservation[] = [];
    const errors: Error[] = [];
    const dispose = await installPerception(target, { tabId: TAB, onObservation: (o) => seen.push(o), onError: (e) => errors.push(e) });

    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 2000 });
    expect(errors).toEqual([]);
    const pushed = seen.at(-1)!;
    expect(pushed.tabId).toBe(TAB);
    expect(pushed.title).toBe("HelmStack Contact Form Fixture");
    expect(pushed.forms.length).toBeGreaterThanOrEqual(1);
    expect(pushed.forms[0]!.fields.map((f) => f.name)).toEqual(
      expect.arrayContaining(["name", "email", "topic", "message", "consent"])
    );
    expect(pushed.forms[0]!.submitActions.map((a) => a.label)).toContain("Send message");

    // Pull hits the installed handle and sees a change before the debounce fires.
    document.getElementById("form-error")!.textContent = "Email is malformed";
    const pulled = await requestObservation(target, { tabId: TAB });
    expect(pulled?.tabId).toBe(TAB);
    expect(pulled?.alerts).toContain("Email is malformed");

    await dispose();
    const count = seen.length;
    document.body.insertAdjacentHTML("beforeend", "<div role='alert'>after dispose</div>");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen.length).toBe(count);
    expect((globalThis as Record<string, unknown>)[PERCEPTION_HANDLE_NAME]).toBeUndefined();
  });

  it("pull without an installed stream does a one-off extraction", async () => {
    loadContactForm();
    const target = new FakeCdpTarget(true);
    const observation = await requestObservation(target, { tabId: TAB });

    expect(observation?.forms.length).toBeGreaterThanOrEqual(1);
    expect((globalThis as Record<string, unknown>)[PERCEPTION_HANDLE_NAME]).toBeUndefined();
  });
});
