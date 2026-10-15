import type { CdpTarget } from "@helmstack/shared";
import type { CDPSession } from "puppeteer-core";

/**
 * The slice of a puppeteer `CDPSession` this adapter uses. Kept structural so
 * unit tests can pass a fake.
 *
 * Event capture: puppeteer's `EventEmitter` is backed by `mitt`, which calls
 * handlers registered under the `"*"` key for every emitted event as
 * `(type, payload)`. `CdpCDPSession` re-emits every protocol event it receives
 * as `emit(method, params)`, so a single `"*"` subscription sees every CDP event
 * on the session without monkey-patching `emit` or reaching into the
 * connection. Puppeteer's typings model `"*"` handlers as single-argument, hence
 * this structural type. Non-protocol emits (symbols such as
 * `CDPSessionEvent.Disconnected`, or `sessionattached`) are filtered out by
 * requiring a string containing a `.` (`Domain.event`).
 */
export interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(type: "*", handler: (type: string | symbol, payload: unknown) => void): unknown;
  off(type: "*", handler: (type: string | symbol, payload: unknown) => void): unknown;
  /** Present on puppeteer sessions; detaches from the target. */
  detach?(): Promise<void>;
}

type FrameNavigated = { frame: { id: string; parentId?: string; url: string; urlFragment?: string } };
type FrameLoadEvent = { frameId: string };
type EvaluateResult = {
  result: { type: string; value?: unknown; description?: string; unserializableValue?: string };
  exceptionDetails?: {
    text: string;
    lineNumber: number;
    columnNumber: number;
    url?: string;
    exception?: { description?: string; value?: unknown };
  };
};

/** Thrown by `evaluate` when the page-side expression throws or rejects. */
export class EvaluationError extends Error {
  readonly details: NonNullable<EvaluateResult["exceptionDetails"]>;

  constructor(details: NonNullable<EvaluateResult["exceptionDetails"]>) {
    const description = details.exception?.description ?? stringifyValue(details.exception?.value) ?? details.text;
    super(`Evaluation failed: ${description} (at ${details.lineNumber + 1}:${details.columnNumber + 1})`);
    this.name = "EvaluationError";
    this.details = details;
  }
}

function stringifyValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function decodeUnserializable(value: string): unknown {
  switch (value) {
    case "NaN":
      return NaN;
    case "Infinity":
      return Infinity;
    case "-Infinity":
      return -Infinity;
    case "-0":
      return -0;
    default:
      return value.endsWith("n") ? BigInt(value.slice(0, -1)) : value;
  }
}

/**
 * `CdpTarget` over a dedicated puppeteer `CDPSession` attached to one page.
 * Using our own session (from `page.createCDPSession()`), not puppeteer's
 * internal one, keeps domain enables and emulation overrides isolated from
 * puppeteer's bookkeeping. Construct via `ChromeCdpTarget.attach`.
 */
export class ChromeCdpTarget implements CdpTarget {
  readonly #session: CdpSessionLike;
  readonly #listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  readonly #loadWaiters = new Set<() => void>();
  /** Waiters that also settle on a same-document change or a no-load commit (history moves). */
  readonly #settleWaiters = new Set<() => void>();
  #mainFrameId: string;
  #url: string;
  #loading: boolean;
  #disposed = false;
  readonly #onAny = (type: string | symbol, payload: unknown): void => {
    if (typeof type !== "string" || !type.includes(".")) return;
    const params = (payload ?? {}) as Record<string, unknown>;
    this.#track(type, params);
    for (const listener of [...this.#listeners]) {
      try {
        listener(type, params);
      } catch {
        // A faulty subscriber must not break event delivery to others.
      }
    }
  };

  private constructor(session: CdpSessionLike, init: { mainFrameId: string; url: string; loading: boolean }) {
    this.#session = session;
    this.#mainFrameId = init.mainFrameId;
    this.#url = init.url;
    this.#loading = init.loading;
    session.on("*", this.#onAny);
  }

  /** Accepts a puppeteer `CDPSession` or any `CdpSessionLike`. */
  static async attach(session: CDPSession | CdpSessionLike): Promise<ChromeCdpTarget> {
    const s = session as unknown as CdpSessionLike;
    await s.send("Page.enable");
    const { frameTree } = (await s.send("Page.getFrameTree")) as {
      frameTree: { frame: { id: string; url: string; urlFragment?: string } };
    };
    const ready = (await s
      .send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true })
      .catch(() => null)) as EvaluateResult | null;
    return new ChromeCdpTarget(s, {
      mainFrameId: frameTree.frame.id,
      url: frameTree.frame.url + (frameTree.frame.urlFragment ?? ""),
      loading: ready ? ready.result.value !== "complete" : false
    });
  }

  send<T = any>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.#session.send(method, params) as Promise<T>;
  }

  onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async evaluate<T = unknown>(expression: string, options?: { userGesture?: boolean }): Promise<T> {
    const response = await this.send<EvaluateResult>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: options?.userGesture ?? false
    });
    if (response.exceptionDetails) throw new EvaluationError(response.exceptionDetails);
    const { result } = response;
    if (result.unserializableValue !== undefined) return decodeUnserializable(result.unserializableValue) as T;
    return result.value as T;
  }

  url(): string {
    return this.#url;
  }

  /** Id of the top-level frame (equals the page's target id in Chrome). */
  mainFrameId(): string {
    return this.#mainFrameId;
  }

  isLoading(): boolean {
    return this.#loading;
  }

  waitForLoadStop(timeoutMs: number): Promise<void> {
    if (!this.#loading || this.#disposed) return Promise.resolve();
    return this.#nextLoadStop(timeoutMs);
  }

  /**
   * Navigates the main frame and resolves once it stops loading (or after
   * `timeoutMs`). Same-document navigations resolve immediately. Throws if
   * Chrome reports a navigation error (e.g. DNS failure).
   */
  async navigate(url: string, timeoutMs: number): Promise<void> {
    // Subscribe before sending so a fast frameStoppedLoading is not missed.
    let cancel: () => void = () => {};
    const stopped = this.#nextLoadStop(timeoutMs, (c) => (cancel = c));
    try {
      const result = await this.send<{ loaderId?: string; errorText?: string }>("Page.navigate", { url });
      if (result.errorText) throw new Error(`Navigation to ${url} failed: ${result.errorText}`);
      if (!result.loaderId) return; // same-document navigation: no load cycle
      await stopped;
    } finally {
      cancel();
    }
  }

  /** `Page.reload`; resolves once the main frame stops loading (or after `timeoutMs`). */
  async reload(ignoreCache: boolean, timeoutMs: number): Promise<void> {
    let cancel: () => void = () => {};
    const stopped = this.#nextLoadStop(timeoutMs, (c) => (cancel = c));
    try {
      await this.send("Page.reload", { ignoreCache });
      await stopped;
    } finally {
      cancel();
    }
  }

  /**
   * Moves `delta` entries through the navigation history. Resolves `false`
   * (and does nothing) when there is no such entry; otherwise waits until the
   * navigation settles: load stop, a same-document change, or a commit that
   * never starts loading (back/forward cache restore).
   */
  async navigateHistory(delta: number, timeoutMs: number): Promise<boolean> {
    const history = await this.send<{ currentIndex: number; entries: { id: number; url: string }[] }>("Page.getNavigationHistory");
    const entry = history.entries[history.currentIndex + delta];
    if (!entry) return false;
    let cancel: () => void = () => {};
    const settled = this.#nextSettled(timeoutMs, (c) => (cancel = c));
    try {
      await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
      await settled;
    } finally {
      cancel();
    }
    return true;
  }

  /** Stops tracking and detaches listeners. Does not close the page. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#session.off("*", this.#onAny);
    this.#listeners.clear();
    this.#loading = false;
    for (const resolve of [...this.#loadWaiters]) resolve();
  }

  #nextSettled(timeoutMs: number, exposeCancel?: (cancel: () => void) => void): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.#loadWaiters.delete(done);
        this.#settleWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, timeoutMs));
      this.#loadWaiters.add(done);
      this.#settleWaiters.add(done);
      exposeCancel?.(done);
    });
  }

  #nextLoadStop(timeoutMs: number, exposeCancel?: (cancel: () => void) => void): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.#loadWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, timeoutMs));
      this.#loadWaiters.add(done);
      exposeCancel?.(done);
    });
  }

  #track(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "Page.frameNavigated": {
        const { frame } = params as unknown as FrameNavigated;
        if (!frame.parentId) {
          this.#mainFrameId = frame.id;
          this.#url = frame.url + (frame.urlFragment ?? "");
          // A commit that never started loading (bfcache restore) is already settled.
          if (!this.#loading) for (const resolve of [...this.#settleWaiters]) resolve();
        }
        break;
      }
      case "Page.navigatedWithinDocument": {
        const { frameId, url } = params as { frameId: string; url: string };
        if (frameId === this.#mainFrameId) {
          this.#url = url;
          for (const resolve of [...this.#settleWaiters]) resolve();
        }
        break;
      }
      case "Page.frameStartedLoading":
        if ((params as FrameLoadEvent).frameId === this.#mainFrameId) this.#loading = true;
        break;
      case "Page.frameStoppedLoading":
        if ((params as FrameLoadEvent).frameId === this.#mainFrameId) {
          this.#loading = false;
          for (const resolve of [...this.#loadWaiters]) resolve();
        }
        break;
    }
  }
}
