import type { WebContents } from "electron";

import type { PerformanceReport, TabId } from "../../../../packages/shared/src/index.js";

/**
 * Capture performance metrics: CDP `Performance.getMetrics` counters plus
 * Navigation Timing and Core Web Vitals (LCP/FCP/CLS/INP/TTFB) and the top-20
 * slowest resources via `Runtime.evaluate`. Extracted from `TabManager`.
 * Assumes the CDP debugger is already attached.
 */
export async function capturePerformance(webContents: WebContents, tabId: TabId): Promise<PerformanceReport> {
  // Enable Performance domain (idempotent).
  await webContents.debugger.sendCommand("Performance.enable", { timeDomain: "timeTicks" });

  const [cdpResult, pageData] = await Promise.all([
    webContents.debugger.sendCommand("Performance.getMetrics") as Promise<{ metrics: Array<{ name: string; value: number }> }>,
    webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: `(function() {
        var t = performance.timing;
        var nav = t && t.navigationStart ? {
          ttfb:             t.responseStart     - t.navigationStart,
          domInteractive:   t.domInteractive    - t.navigationStart,
          domContentLoaded: t.domContentLoadedEventEnd - t.navigationStart,
          loadEvent:        t.loadEventEnd      - t.navigationStart
        } : null;

        var lcp = null, fcp = null, cls = 0, inp = null;
        try {
          var lcpEntries = performance.getEntriesByType("largest-contentful-paint");
          if (lcpEntries.length) lcp = lcpEntries[lcpEntries.length - 1].startTime;
          var paintEntries = performance.getEntriesByType("paint");
          for (var pe of paintEntries) {
            if (pe.name === "first-contentful-paint") fcp = pe.startTime;
          }
          var layoutEntries = performance.getEntriesByType("layout-shift");
          for (var le of layoutEntries) {
            if (!le.hadRecentInput) cls += le.value;
          }
          var inpEntries = performance.getEntriesByType("event");
          if (inpEntries.length) {
            var sorted = inpEntries.slice().sort(function(a,b){ return b.duration - a.duration; });
            inp = sorted[0].duration;
          }
        } catch(e) {}

        var resources = performance.getEntriesByType("resource")
          .map(function(r) {
            return { name: r.name, initiatorType: r.initiatorType,
                     transferSize: r.transferSize || 0, duration: r.duration };
          })
          .sort(function(a,b){ return b.duration - a.duration; })
          .slice(0, 20);

        return { nav: nav, lcp: lcp, fcp: fcp, cls: cls, inp: inp,
                 ttfb: nav ? nav.ttfb : null, resources: resources };
      })()`,
      returnByValue: true
    }) as Promise<{ result: { value: { nav: { ttfb: number; domInteractive: number; domContentLoaded: number; loadEvent: number } | null; lcp: number | null; fcp: number | null; cls: number; inp: number | null; ttfb: number | null; resources: Array<{ name: string; initiatorType: string; transferSize: number; duration: number }> } } }>
  ]);

  const cdpMetrics: Record<string, number> = {};
  for (const m of cdpResult.metrics) {
    cdpMetrics[m.name] = m.value;
  }

  const pd = pageData.result.value;

  return {
    tabId,
    url: webContents.getURL(),
    capturedAt: Date.now(),
    navigation: pd.nav,
    vitals: {
      lcp:  pd.lcp  !== null ? Math.round(pd.lcp)  : null,
      fcp:  pd.fcp  !== null ? Math.round(pd.fcp)  : null,
      cls:  pd.cls  !== null ? Math.round(pd.cls * 1000) / 1000 : null,
      inp:  pd.inp  !== null ? Math.round(pd.inp)  : null,
      ttfb: pd.ttfb !== null ? Math.round(pd.ttfb) : null
    },
    slowResources: pd.resources,
    cdpMetrics
  };
}
