import { ipcRenderer } from "electron";

import { extractPageObservation, installPageObservationStream } from "../../../../packages/perception/src/dom-extractor.js";
import { BrowserShellChannel, type TabId } from "../../../../packages/shared/src/index.js";

// Belt-and-suspenders: remove the webdriver flag from every page context.
// The primary protection is --disable-blink-features=AutomationControlled in
// the main process, but this guards against any residual exposure.
try {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined, configurable: true });
} catch {
  // Ignore — already non-configurable or descriptor locked by the engine.
}

declare global {
  interface Window {
    __openVisualPageState?: {
      observationCounter: number;
      lastObservationAt: number;
      lastUrl: string;
    };
  }
}

function resolveTabId(): TabId {
  const arg = process.argv.find((entry) => entry.startsWith("--ov-tab-id="));
  return (arg?.slice("--ov-tab-id=".length) || "unknown") as TabId;
}

const tabId = resolveTabId();

window.__openVisualPageState = {
  observationCounter: 0,
  lastObservationAt: Date.now(),
  lastUrl: window.location.href
};

installPageObservationStream(() => {
  if (window.__openVisualPageState) {
    window.__openVisualPageState.observationCounter += 1;
    window.__openVisualPageState.lastObservationAt = Date.now();
    window.__openVisualPageState.lastUrl = window.location.href;
  }
  const observation = extractPageObservation(tabId);
  ipcRenderer.send(BrowserShellChannel.PageObserved, observation);
});
