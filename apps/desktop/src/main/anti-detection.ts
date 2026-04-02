import type { WebContents } from "electron";

/**
 * Deep anti-detection layer.
 *
 * Call `installAntiDetection(webContents)` once per tab WebContents immediately
 * after creation.  It uses CDP `Page.addScriptToEvaluateOnNewDocument` to inject
 * a hardening script into the page's *main* JavaScript world before any site
 * code runs — including across navigations.
 *
 * Patches applied:
 *  1. navigator.webdriver          — undefined (belt-and-suspenders over Chrome flag)
 *  2. window.chrome                — full realistic chrome object
 *  3. navigator.plugins            — PDF Viewer + Chrome PDF Plugin
 *  4. navigator.mimeTypes          — matching set
 *  5. WebGLRenderingContext        — realistic UNMASKED_VENDOR / UNMASKED_RENDERER
 *  6. WebGL2RenderingContext       — same
 *  7. HTMLCanvasElement.toDataURL  — imperceptible per-session pixel noise
 *  8. Permissions.prototype.query  — "default" for notifications
 *  9. navigator.platform           — consistent with user-agent OS
 */

export async function installAntiDetection(webContents: WebContents): Promise<void> {
  if (!webContents.debugger.isAttached()) {
    webContents.debugger.attach("1.3");
  }

  await webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
    source: ANTI_DETECTION_SCRIPT,
    runImmediately: true
  });
}

// ── Injected script ───────────────────────────────────────────────────────────
// Written as a plain string so it executes in the page's main JS world.
// Keep it self-contained (no imports, no closure over Node.js globals).

const ANTI_DETECTION_SCRIPT = /* js */ `(function () {
  'use strict';

  // ── 1. navigator.webdriver ─────────────────────────────────────────────────
  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true
    });
  } catch (_) {}

  // ── 2. window.chrome ──────────────────────────────────────────────────────
  // Real Chrome always has window.chrome; Electron/Chromium headless does not.
  if (!window.chrome) {
    const loadStart = Date.now() - Math.floor(Math.random() * 200 + 50);
    const chrome = {
      app: {
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: () => null,
        getIsInstalled: () => false,
        installState: (_cb) => { _cb({ state: 'not_installed' }); },
        isInstalled: false,
        runningState: () => 'cannot_run',
      },
      csi: () => ({
        startE: loadStart,
        onloadT: loadStart + Math.floor(Math.random() * 300 + 200),
        pageT: Date.now() - loadStart,
        tran: 15,
      }),
      loadTimes: () => ({
        requestTime: loadStart / 1000,
        startLoadTime: loadStart / 1000,
        commitLoadTime: (loadStart + 50) / 1000,
        finishDocumentLoadTime: (loadStart + 200) / 1000,
        finishLoadTime: (loadStart + 300) / 1000,
        firstPaintTime: (loadStart + 120) / 1000,
        firstPaintAfterLoadTime: 0,
        navigationType: 'Other',
        wasFetchedViaSpdy: false,
        wasNpnNegotiated: true,
        npnNegotiatedProtocol: 'h2',
        wasAlternateProtocolAvailable: false,
        connectionInfo: 'h2',
      }),
      runtime: {},
    };
    try {
      Object.defineProperty(window, 'chrome', { value: chrome, writable: false, enumerable: false, configurable: false });
    } catch (_) {
      window.chrome = chrome;
    }
  }

  // ── 3+4. navigator.plugins / mimeTypes ────────────────────────────────────
  // Real Chrome has at minimum these two plugins.
  function makeFakePlugin(name, description, filename, mimeTypes) {
    const plugin = Object.create(Plugin.prototype);
    Object.defineProperties(plugin, {
      name:        { value: name,        enumerable: true },
      description: { value: description, enumerable: true },
      filename:    { value: filename,    enumerable: true },
      length:      { value: mimeTypes.length, enumerable: true },
    });
    mimeTypes.forEach((mt, i) => {
      Object.defineProperty(plugin, i, { value: mt, enumerable: true });
    });
    plugin[Symbol.iterator] = Array.prototype[Symbol.iterator].bind(mimeTypes);
    return plugin;
  }

  function makeMimeType(type, suffixes, description, plugin) {
    const mt = Object.create(MimeType.prototype);
    Object.defineProperties(mt, {
      type:        { value: type,        enumerable: true },
      suffixes:    { value: suffixes,    enumerable: true },
      description: { value: description, enumerable: true },
      enabledPlugin: { value: plugin,   enumerable: true },
    });
    return mt;
  }

  try {
    const pdfMt = makeMimeType('application/pdf', 'pdf', 'Portable Document Format', null);
    const pdfPlugin = makeFakePlugin(
      'PDF Viewer', 'Portable Document Format',
      'internal-pdf-viewer', [pdfMt]
    );
    Object.defineProperty(pdfMt, 'enabledPlugin', { value: pdfPlugin });

    const chromePdfMt = makeMimeType('application/x-google-chrome-pdf', 'pdf', 'Portable Document Format', null);
    const chromePdfPlugin = makeFakePlugin(
      'Chrome PDF Viewer', 'Portable Document Format',
      'internal-pdf-viewer', [chromePdfMt]
    );
    Object.defineProperty(chromePdfMt, 'enabledPlugin', { value: chromePdfPlugin });

    const plugins = [pdfPlugin, chromePdfPlugin];
    const mimeTypes = [pdfMt, chromePdfMt];

    const fakePluginArray = Object.create(PluginArray.prototype);
    Object.defineProperty(fakePluginArray, 'length', { value: plugins.length });
    plugins.forEach((p, i) => Object.defineProperty(fakePluginArray, i, { value: p, enumerable: true }));
    fakePluginArray.item  = (i) => plugins[i] ?? null;
    fakePluginArray.namedItem = (n) => plugins.find(p => p.name === n) ?? null;
    fakePluginArray.refresh = () => {};
    fakePluginArray[Symbol.iterator] = Array.prototype[Symbol.iterator].bind(plugins);

    const fakeMimeTypeArray = Object.create(MimeTypeArray.prototype);
    Object.defineProperty(fakeMimeTypeArray, 'length', { value: mimeTypes.length });
    mimeTypes.forEach((m, i) => Object.defineProperty(fakeMimeTypeArray, i, { value: m, enumerable: true }));
    fakeMimeTypeArray.item = (i) => mimeTypes[i] ?? null;
    fakeMimeTypeArray.namedItem = (n) => mimeTypes.find(m => m.type === n) ?? null;
    fakeMimeTypeArray[Symbol.iterator] = Array.prototype[Symbol.iterator].bind(mimeTypes);

    Object.defineProperty(navigator, 'plugins',   { get: () => fakePluginArray,   configurable: true });
    Object.defineProperty(navigator, 'mimeTypes', { get: () => fakeMimeTypeArray, configurable: true });
  } catch (_) {}

  // ── 5+6. WebGL fingerprint ─────────────────────────────────────────────────
  // UNMASKED_VENDOR_WEBGL (37445) and UNMASKED_RENDERER_WEBGL (37446) are the
  // two parameters sites query to fingerprint GPU.
  const GPU_VENDOR   = 'Google Inc. (Apple)';
  const GPU_RENDERER = 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)';

  function patchWebGL(ctx) {
    try {
      const orig = ctx.getParameter.bind(ctx.__proto__);
      ctx.__proto__.getParameter = function (param) {
        if (param === 37445) return GPU_VENDOR;
        if (param === 37446) return GPU_RENDERER;
        return orig.call(this, param);
      };
    } catch (_) {}
  }

  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...args) {
    const ctx = origGetContext.call(this, type, ...args);
    if (ctx && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
      patchWebGL(ctx);
    }
    return ctx;
  };

  // ── 7. Canvas noise ────────────────────────────────────────────────────────
  // Add a deterministic but unique-per-session sub-pixel offset so the canvas
  // hash differs from a vanilla Electron fingerprint without being detectable.
  const NOISE_SEED = Math.random();

  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (type, quality) {
    const ctx2d = this.getContext('2d');
    if (ctx2d && this.width > 0 && this.height > 0) {
      const x = Math.floor(NOISE_SEED * this.width);
      const y = Math.floor(NOISE_SEED * this.height);
      const imageData = ctx2d.getImageData(x, y, 1, 1);
      imageData.data[0] = (imageData.data[0] + 1) & 0xff; // flip one LSB
      ctx2d.putImageData(imageData, x, y);
    }
    return origToDataURL.call(this, type, quality);
  };

  // ── 8. Permissions ────────────────────────────────────────────────────────
  // Chromium in automation mode returns "denied" for notification permission
  // by default, which is a fingerprinting signal.  Return "default" instead.
  try {
    const origQuery = Permissions.prototype.query;
    Permissions.prototype.query = function (parameters) {
      return origQuery.call(this, parameters).then((result) => {
        if (parameters.name === 'notifications' && result.state === 'denied') {
          Object.defineProperty(result, 'state', { value: 'default' });
        }
        return result;
      });
    };
  } catch (_) {}

  // ── 9. navigator.platform ─────────────────────────────────────────────────
  // Electron may report 'Linux x86_64' even on macOS inside some contexts.
  // Force it to match the host UA we already set.
  try {
    const ua = navigator.userAgent;
    const platform =
      /Mac/i.test(ua)  ? 'MacIntel'  :
      /Win/i.test(ua)  ? 'Win32'     :
      /Linux/i.test(ua) ? 'Linux x86_64' : navigator.platform;
    Object.defineProperty(navigator, 'platform', { get: () => platform, configurable: true });
  } catch (_) {}

})();`;
