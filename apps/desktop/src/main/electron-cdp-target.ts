import type { WebContents } from "electron";

import type { CdpTarget } from "../../../../packages/shared/src/index.js";

const CDP_PROTOCOL_VERSION = "1.3";

const adapters = new WeakMap<WebContents, CdpTarget>();

/**
 * Adapts an Electron `WebContents` to the shared `CdpTarget` contract so the
 * inspection/actuation modules stay Electron-free. One adapter is cached per
 * `WebContents`; the debugger is attached lazily on the first `send`.
 */
export type CdpIntercept = {
  /** Runs before a command is sent; the command waits for it. */
  before?(method: string): void | Promise<void>;
  /** Runs after a command settled (success or failure). */
  after?(method: string): void;
};

export function electronCdpTarget(webContents: WebContents, intercept?: CdpIntercept): CdpTarget {
  const cached = adapters.get(webContents);
  if (cached) return cached;

  const target: CdpTarget = {
    async send<T = any>(method: string, params?: Record<string, unknown>): Promise<T> {
      if (!webContents.debugger.isAttached()) {
        webContents.debugger.attach(CDP_PROTOCOL_VERSION);
      }
      try {
        await intercept?.before?.(method);
        return (await webContents.debugger.sendCommand(method, params)) as T;
      } finally {
        intercept?.after?.(method);
      }
    },

    onEvent(listener) {
      const onMessage = (_event: Electron.Event, method: string, params: Record<string, unknown>) => {
        listener(method, params);
      };
      webContents.debugger.on("message", onMessage);
      return () => {
        webContents.debugger.removeListener("message", onMessage);
      };
    },

    evaluate<T = unknown>(expression: string, options?: { userGesture?: boolean }): Promise<T> {
      return webContents.executeJavaScript(expression, options?.userGesture) as Promise<T>;
    },

    url: () => webContents.getURL(),

    isLoading: () => webContents.isLoading(),

    async waitForLoadStop(timeoutMs: number): Promise<void> {
      if (!webContents.isLoading()) return;

      let onStop: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        onStop = () => resolve();
        timer = setTimeout(resolve, timeoutMs);
        webContents.on("did-stop-loading", onStop);
      });
      if (timer) clearTimeout(timer);
      if (onStop) webContents.removeListener("did-stop-loading", onStop);
    }
  };

  adapters.set(webContents, target);
  return target;
}
