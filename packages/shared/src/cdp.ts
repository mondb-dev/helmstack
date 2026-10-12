/**
 * Minimal Chrome DevTools Protocol handle for one page. Inspection and
 * actuation modules depend on this instead of Electron's `WebContents`, so the
 * same code runs inside the desktop shell (`webContents.debugger`) and against
 * a plain Chrome over CDP (headless daemon, CI).
 *
 * Adapters own debugger attachment: `send` attaches on first use, so callers
 * never call `attach`/`isAttached` themselves.
 */
export interface CdpTarget {
  /** Sends a CDP command, attaching the debugger first if needed. */
  send<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Subscribes to CDP events. Returns an unsubscribe function. */
  onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void;
  /** Evaluates an expression in the page's main world, awaiting promises and returning by value. */
  evaluate<T = unknown>(expression: string, options?: { userGesture?: boolean }): Promise<T>;
  /** Current top-level URL. */
  url(): string;
  /** True while the top-level frame is loading. */
  isLoading(): boolean;
  /** Resolves once the page stops loading, immediately if idle, or after `timeoutMs` at the latest. */
  waitForLoadStop(timeoutMs: number): Promise<void>;
}
