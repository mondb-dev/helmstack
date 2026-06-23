import type { WebContents } from "electron";

import type { ElementPickResult, TabId } from "../../../../packages/shared/src/index.js";

/**
 * In-page element-picker overlay. Returns a function-expression string that,
 * when invoked, installs a devtools-style "inspect" overlay and returns a
 * Promise resolving to the element the human clicks (or `null` on Escape).
 * Injected via `webContents.executeJavaScript((${script})(), true)`, which
 * awaits the promise.
 *
 * Exported as a string so the overlay + selector logic can be unit-tested in
 * jsdom. Uses `event.target` (not `elementFromPoint`, which jsdom stubs) so the
 * hover/click path is testable.
 *
 * NOTE: the selector generator here duplicates the per-module `selectorFor`
 * helpers; unifying those into one source of truth is tracked separately.
 */
export function elementPickerScript(): string {
  return `function() {
    return new Promise(function(resolve) {
      var OVERLAY_ID = '__helmstack_pick_overlay__';
      function esc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : s; }
      function selectorFor(el) {
        if (!el || el.nodeType !== 1) return '';
        if (el.id) return '#' + esc(el.id);
        var testid = el.getAttribute && el.getAttribute('data-testid');
        if (testid) return '[data-testid="' + testid + '"]';
        var parts = [];
        var node = el;
        while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html' && node.tagName.toLowerCase() !== 'body') {
          if (node.id) { parts.unshift('#' + esc(node.id)); break; }
          var tag = node.tagName.toLowerCase();
          var nth = 1, sib = node;
          while (sib.previousElementSibling) { sib = sib.previousElementSibling; if (sib.tagName === node.tagName) nth++; }
          parts.unshift(tag + ':nth-of-type(' + nth + ')');
          node = node.parentElement;
        }
        return parts.join(' > ');
      }

      var overlay = document.createElement('div');
      overlay.id = OVERLAY_ID;
      overlay.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:rgba(29,127,90,0.22);border:1px solid #1d7f5a;border-radius:2px;box-shadow:0 0 0 1px rgba(255,255,255,0.4);transition:all 40ms ease;';
      (document.body || document.documentElement).appendChild(overlay);
      var current = null;

      function place(el) {
        var r = el.getBoundingClientRect();
        overlay.style.left = r.left + 'px';
        overlay.style.top = r.top + 'px';
        overlay.style.width = r.width + 'px';
        overlay.style.height = r.height + 'px';
      }
      function onMove(e) {
        var el = e.target;
        if (!el || el.id === OVERLAY_ID || el.nodeType !== 1) return;
        current = el;
        place(el);
      }
      function cleanup() {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKey, true);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }
      function onClick(e) {
        e.preventDefault(); e.stopPropagation();
        var el = (e.target && e.target.id !== OVERLAY_ID) ? e.target : current;
        cleanup();
        if (!el || el.nodeType !== 1) { resolve(null); return; }
        resolve({
          selector: selectorFor(el),
          tagName: el.tagName.toLowerCase(),
          text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
          id: el.id || null
        });
      }
      function onKey(e) { if (e.key === 'Escape') { cleanup(); resolve(null); } }

      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);
    });
  }`;
}

/**
 * Activate the inspect overlay in the page and resolve when the human picks an
 * element (or cancels). The picked selector is handed back so an agent can act
 * on it (then enrich with component source / styles via the existing endpoints).
 * Assumes the CDP debugger is not required — uses Electron's `executeJavaScript`.
 */
export async function pickElement(webContents: WebContents, tabId: TabId): Promise<ElementPickResult> {
  const raw = await webContents.executeJavaScript(`(${elementPickerScript()})()`, true) as
    | { selector: string; tagName: string; text: string; id: string | null }
    | null;

  const base = { tabId, url: webContents.getURL(), capturedAt: Date.now() };
  if (!raw) {
    return { ...base, picked: false, selector: "", tagName: "", text: "", id: null };
  }
  return { ...base, picked: true, selector: raw.selector, tagName: raw.tagName, text: raw.text, id: raw.id };
}
