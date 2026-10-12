/**
 * Page-side perception entry for backends without an Electron preload (the
 * headless daemon). Bundled by `scripts/build-page-inject.mjs` into an IIFE
 * string ({@link ../generated/page-inject-source.ts}) that a CDP client injects
 * into an isolated world via `Page.addScriptToEvaluateOnNewDocument`.
 *
 * It runs the very same `installPageObservationStream` + `extractPageObservation`
 * as `apps/desktop/src/preload/page-preload.ts`; only the transport differs:
 * observations are reported as JSON through a `Runtime.addBinding` function
 * instead of `ipcRenderer.send`. The tab id is not known page-side, so it is
 * left empty and stamped by the injector.
 *
 * The bundle exposes `install(config)` on the IIFE's global name; the injector
 * wraps source + call in a closure so nothing leaks into the world's globals
 * except {@link PageInjectHandle} at `globalThis[config.handleName]`.
 */
import type { PageObservation, TabId } from "../../shared/src/index.js";
import { extractPageObservation, installPageObservationStream } from "./dom-extractor.js";

export type PageInjectConfig = {
  /** Name of the CDP binding (`Runtime.addBinding`) observations are reported through. */
  bindingName: string;
  /** Global the {@link PageInjectHandle} is published under (in the isolated world). */
  handleName: string;
  /** Run social-surface perception. Mirrors `ExtractObservationOptions.includeSocial`. */
  includeSocial?: boolean;
};

/** Published at `globalThis[config.handleName]` once installed in a document. */
export type PageInjectHandle = {
  readonly version: 1;
  /** Extracts a fresh observation synchronously (tab id left empty). */
  extract(): PageObservation;
  /** Extracts a fresh observation as a JSON string (for `Runtime.evaluate` round-trips). */
  extractJson(): string;
  /** Stops reporting pushed observations. The DOM observers stay attached but go quiet. */
  dispose(): void;
};

const UNSTAMPED_TAB_ID = "" as TabId;

/**
 * Installs the observation stream in the current document. Idempotent per
 * document: a second call returns the existing handle. Child frames are
 * skipped: the top-frame extractor already walks same-origin iframes (and
 * shadow roots), and a child-frame observation would overwrite the tab's.
 */
export function install(config: PageInjectConfig): PageInjectHandle | null {
  const scope = globalThis as unknown as Record<string, unknown>;
  const existing = scope[config.handleName] as PageInjectHandle | undefined;
  if (existing) {
    return existing;
  }

  if (!isTopFrame()) {
    return null;
  }

  const options = { includeSocial: config.includeSocial ?? false };
  let disposed = false;

  const handle: PageInjectHandle = {
    version: 1,
    extract: () => extractPageObservation(UNSTAMPED_TAB_ID, options),
    extractJson: () => JSON.stringify(extractPageObservation(UNSTAMPED_TAB_ID, options)),
    dispose: () => {
      disposed = true;
    }
  };

  Object.defineProperty(scope, config.handleName, { value: handle, configurable: true, enumerable: false, writable: false });

  installPageObservationStream(() => {
    if (disposed) {
      return;
    }
    const report = scope[config.bindingName];
    if (typeof report !== "function") {
      return; // binding removed (injector disposed) or not yet exposed
    }
    try {
      (report as (payload: string) => void)(handle.extractJson());
    } catch {
      // Extraction must never surface as a page error.
    }
  });

  return handle;
}

/**
 * One-off extraction as JSON without installing the stream, for pull requests
 * that land in a world where {@link install} has not run (e.g. a fresh world).
 */
export function extractOnceJson(config: Pick<PageInjectConfig, "includeSocial">): string {
  return JSON.stringify(extractPageObservation(UNSTAMPED_TAB_ID, { includeSocial: config.includeSocial ?? false }));
}

function isTopFrame(): boolean {
  try {
    return window.top === window;
  } catch {
    return false;
  }
}
