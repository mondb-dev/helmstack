/**
 * Perception over plain CDP — the substitute for the Electron page preload
 * (`apps/desktop/src/preload/page-preload.ts`) on backends without preloads.
 *
 * The page-side bundle (`packages/perception/src/page-inject.ts`, shipped as a
 * string in `generated/page-inject-source.ts`) runs the same
 * `installPageObservationStream` + `extractPageObservation` as the preload, in
 * an isolated world (parity with `contextIsolation: true`: page scripts can't
 * see or tamper with it), and reports JSON through a `Runtime.addBinding`
 * function. This module wires that up on a `CdpTarget` and turns
 * `Runtime.bindingCalled` into `PageObservation`s with the tab id stamped — the
 * same shape the desktop's `TabManager.recordObservation` receives over IPC.
 *
 * Depends only on `CdpTarget` (no Electron, no puppeteer).
 */
import type { CdpTarget, PageObservation, TabId } from "../../../shared/src/index.js";
import { PAGE_INJECT_GLOBAL, PAGE_INJECT_SOURCE } from "../../../perception/src/generated/page-inject-source.js";

/** Isolated world (and execution-context) name the extractor runs in. */
export const PERCEPTION_WORLD_NAME = "helmstack";
/** Binding the page side reports observations through. */
export const PERCEPTION_BINDING_NAME = "__helmstackObserved";
/** Global (inside the isolated world) holding the page-side handle with `extract()`. */
export const PERCEPTION_HANDLE_NAME = "__helmstack";

export type PerceptionInjectorOptions = {
  /** Stamped onto every observation (the page side does not know it). */
  tabId: TabId;
  /** Receives every pushed observation (debounced 150 ms page-side, like the preload). */
  onObservation: (observation: PageObservation) => void;
  /** Social-surface perception; mirrors the desktop's `HELMSTACK_SOCIAL` flag. Default false. */
  includeSocial?: boolean;
  /** Reports malformed payloads and failures to inject into the current document. */
  onError?: (error: Error) => void;
  /** Overrides for tests / multiple installers on one target. */
  worldName?: string;
  bindingName?: string;
};

export type RequestObservationOptions = {
  /** Stamped onto the result. Defaults to an empty id. */
  tabId?: TabId;
  includeSocial?: boolean;
  worldName?: string;
};

type FrameTree = { frameTree: { frame: { id: string } } };
type IsolatedWorld = { executionContextId: number };
type EvaluateResponse = {
  result: { type: string; value?: unknown };
  exceptionDetails?: { text: string; exception?: { description?: string } };
};

/**
 * Source evaluated in the isolated world of every new document (and once in the
 * current one). Wraps the bundle in a closure so only the handle and nothing
 * else lands on the world's global object.
 */
export function buildPerceptionScript(config: { bindingName: string; includeSocial: boolean }): string {
  const installConfig = {
    bindingName: config.bindingName,
    handleName: PERCEPTION_HANDLE_NAME,
    includeSocial: config.includeSocial
  };
  return `(() => {\n${PAGE_INJECT_SOURCE}\n${PAGE_INJECT_GLOBAL}.install(${JSON.stringify(installConfig)});\n})();`;
}

function buildPullExpression(includeSocial: boolean): string {
  const handle = `globalThis[${JSON.stringify(PERCEPTION_HANDLE_NAME)}]`;
  return (
    `(${handle} ? ${handle}.extractJson() : (() => {\n${PAGE_INJECT_SOURCE}\n` +
    `return ${PAGE_INJECT_GLOBAL}.extractOnceJson(${JSON.stringify({ includeSocial })});\n})())`
  );
}

/** Parses and sanity-checks a page payload, stamping `tabId`. Throws on malformed input. */
export function parseObservationPayload(payload: string, tabId: TabId): PageObservation {
  const parsed: unknown = JSON.parse(payload);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Perception payload is not an object");
  }
  const candidate = parsed as Partial<PageObservation>;
  if (
    typeof candidate.url !== "string" ||
    typeof candidate.pageKind !== "string" ||
    !Array.isArray(candidate.forms) ||
    !Array.isArray(candidate.primaryActions) ||
    !Array.isArray(candidate.headings) ||
    !Array.isArray(candidate.alerts) ||
    !Array.isArray(candidate.media)
  ) {
    throw new Error("Perception payload is missing PageObservation fields");
  }
  return { ...(candidate as PageObservation), tabId };
}

async function mainFrameWorld(target: CdpTarget, worldName: string): Promise<number> {
  const { frameTree } = await target.send<FrameTree>("Page.getFrameTree");
  const { executionContextId } = await target.send<IsolatedWorld>("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName,
    grantUniveralAccess: false
  });
  return executionContextId;
}

async function evaluateInContext(target: CdpTarget, contextId: number, expression: string): Promise<unknown> {
  const response = await target.send<EvaluateResponse>("Runtime.evaluate", {
    expression,
    contextId,
    returnByValue: true,
    awaitPromise: false
  });
  if (response.exceptionDetails) {
    const { exceptionDetails } = response;
    throw new Error(`Perception script failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  }
  return response.result.value;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Installs push-style perception on a tab:
 *
 * 1. `Runtime.addBinding` scoped to the `helmstack` execution-context name, so
 *    the binding exists only in our isolated world (never in the page's world);
 * 2. `Page.addScriptToEvaluateOnNewDocument({ worldName })` — re-injects into
 *    every future document (navigations, reloads) before page scripts run;
 * 3. `Page.createIsolatedWorld` + `Runtime.evaluate` for the already-loaded
 *    document (failure is reported via `onError` but is not fatal: the next
 *    navigation still gets the script).
 *
 * The page side runs only in the top frame; same-origin iframes and open shadow
 * roots are covered by the extractor's own traversal, as with the preload.
 *
 * Resolves to an idempotent disposer that removes the script and binding and
 * silences the stream in the current document.
 */
export async function installPerception(target: CdpTarget, options: PerceptionInjectorOptions): Promise<() => Promise<void>> {
  const worldName = options.worldName ?? PERCEPTION_WORLD_NAME;
  const bindingName = options.bindingName ?? PERCEPTION_BINDING_NAME;
  const includeSocial = options.includeSocial ?? false;
  const reportError = (error: unknown) => options.onError?.(toError(error));

  const offEvent = target.onEvent((method, params) => {
    if (method !== "Runtime.bindingCalled" || params.name !== bindingName) {
      return;
    }
    let observation: PageObservation;
    try {
      observation = parseObservationPayload(String(params.payload), options.tabId);
    } catch (error) {
      reportError(error);
      return;
    }
    options.onObservation(observation);
  });

  let scriptId: string | null = null;
  let bindingAdded = false;
  let disposed = false;

  const dispose = async () => {
    if (disposed) {
      return;
    }
    disposed = true;
    offEvent();
    const steps: Array<Promise<unknown>> = [];
    if (scriptId) {
      steps.push(target.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId }));
    }
    if (bindingAdded) {
      steps.push(target.send("Runtime.removeBinding", { name: bindingName }));
    }
    // Silence the stream already running in the current document and drop its
    // handle, so a later install starts a fresh stream.
    steps.push(
      mainFrameWorld(target, worldName).then((contextId) =>
        evaluateInContext(
          target,
          contextId,
          `(() => { const h = globalThis[${JSON.stringify(PERCEPTION_HANDLE_NAME)}]; if (h) { h.dispose(); delete globalThis[${JSON.stringify(PERCEPTION_HANDLE_NAME)}]; } })()`
        )
      )
    );
    await Promise.allSettled(steps); // target may already be closed
  };

  try {
    await target.send("Page.enable");
    // bindingCalled is only emitted on sessions with the Runtime domain enabled.
    await target.send("Runtime.enable");
    await target.send("Runtime.addBinding", { name: bindingName, executionContextName: worldName });
    bindingAdded = true;
    const source = buildPerceptionScript({ bindingName, includeSocial });
    const added = await target.send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", { source, worldName });
    scriptId = added.identifier;

    try {
      const contextId = await mainFrameWorld(target, worldName);
      await evaluateInContext(target, contextId, source);
    } catch (error) {
      reportError(error);
    }
  } catch (error) {
    await dispose();
    throw toError(error);
  }

  return dispose;
}

/**
 * Pull-style perception: extracts a fresh observation from the current
 * document right now (no 150 ms debounce). Uses the installed stream's handle
 * in the `helmstack` world when present; otherwise ships the bundle for a
 * one-off extraction without installing a stream. Resolves to `null` when the
 * page has no document to observe yet.
 */
export async function requestObservation(target: CdpTarget, options: RequestObservationOptions = {}): Promise<PageObservation | null> {
  const contextId = await mainFrameWorld(target, options.worldName ?? PERCEPTION_WORLD_NAME);
  const value = await evaluateInContext(target, contextId, buildPullExpression(options.includeSocial ?? false));
  if (typeof value !== "string") {
    return null;
  }
  return parseObservationPayload(value, options.tabId ?? ("" as TabId));
}
