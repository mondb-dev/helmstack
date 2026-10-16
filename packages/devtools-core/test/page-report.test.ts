import { describe, expect, it } from "vitest";

import type { A11yAuditReport, CreateReportInput, SeoAuditReport, TabLogSnapshot } from "../../shared/src/index.js";
import { REPORT_LIMITS } from "../../shared/src/index.js";
import {
  REPORT_FIELD_LIMITS,
  buildReport,
  escapeMarkdown,
  safeHttpUrl,
  type BuildReportOptions,
  type ReportEvidence
} from "../src/core/reports/page-report.js";

const AT = Date.UTC(2026, 9, 16, 10, 30, 0);

function build(input: CreateReportInput, evidence: ReportEvidence = {}, over: Partial<BuildReportOptions> = {}) {
  return buildReport({
    id: "20261016-103000-abcdef01",
    page: {
      tabId: "tab-1",
      url: "https://example.com/pricing?token=SECRET#frag",
      title: "Pricing",
      capturedAt: AT,
      viewport: { width: 1280, height: 800 },
      helmstackVersion: "1.2.3"
    },
    input,
    evidence,
    ...over
  });
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function a11y(): A11yAuditReport {
  return {
    tabId: "tab-1", url: "u", capturedAt: AT, score: 71,
    violations: [
      { rule: "1.1.1-image-alt", impact: "serious", wcagCriteria: "1.1.1", wcagLevel: "A", principle: "perceivable",
        selector: "img[alt=\"</code><script>alert(1)</script>\"]", description: "Image needs a name", remediation: "Add alt", role: "img", name: "SECRET-NAME" },
      { rule: "2.4.2-title", impact: "critical", wcagCriteria: "2.4.2", wcagLevel: "A", principle: "operable",
        selector: "input[value=\"hunter2\"]", description: "No title", remediation: "Add title", role: "document" }
    ],
    violationCounts: { critical: 1, serious: 1, moderate: 0, minor: 0 },
    byPrinciple: { perceivable: 1, operable: 1, understandable: 0, robust: 0 },
    violatedRules: [], recommendations: [], passes: 40, nodeCount: 120
  };
}

function seo(): SeoAuditReport {
  return {
    tabId: "tab-1", url: "u", capturedAt: AT, score: 80, pass: true,
    issues: [{ id: "title-short", section: "metadata", severity: "warning", message: "Title is short", fix: "Lengthen it", selectors: ["title"] }],
    counts: { error: 0, warning: 1, info: 0 },
    sections: {} as SeoAuditReport["sections"], skipped: [], unsupported: [], truncated: false, options: { checkLinks: false, maxLinks: 25 }
  };
}

function logs(): TabLogSnapshot {
  return {
    tabId: "tab-1", capturedAt: AT, webSocketFrames: [], eventSourceEvents: [], jsErrors: ["boom"],
    consoleLogs: [{ level: "error", text: "Failed https://api.example.com/v1?apikey=SECRET&x=1 done", timestamp: 1 }],
    networkRequests: [{
      requestId: "r1", url: "https://cdn.example.com/a.js?sig=TOP", method: "GET", statusCode: 500, failed: false, timestamp: 1,
      requestHeaders: { Authorization: "Bearer SECRET" }, responseHeaders: { "Set-Cookie": "sid=SECRET" }
    }]
  };
}

const NASTY = [
  "<script>alert(1)</script>",
  "\"><img src=x onerror=alert(1)>",
  "<svg/onload=alert(1)>",
  "javascript:alert(1)"
];

describe("buildReport safety", () => {
  it("HTML-escapes every agent string (title, summary, findings, recommendations, author)", () => {
    const { html } = build({
      title: NASTY[0],
      summary: NASTY[1],
      author: NASTY[2],
      findings: [{ title: NASTY[0]!, severity: "high", area: NASTY[1], evidence: NASTY[2], recommendation: NASTY[1]! }],
      recommendations: [NASTY[0]!, NASTY[1]!]
    });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<svg/i);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes page-derived strings (title, selectors, console messages, URLs)", () => {
    const { html } = build(
      {},
      { accessibility: a11y(), logs: { console: logs() } },
      { page: { tabId: "t", url: "https://example.com/", title: "<script>alert(1)</script>", capturedAt: AT, helmstackVersion: "1" } }
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("links only http(s) URLs and keeps javascript: and data: as text", () => {
    const ok = build({}).html;
    expect(ok).toMatch(/<a href="https:\/\/example\.com\/pricing" rel="noopener noreferrer">/);
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd"]) {
      const { html } = build({}, {}, { page: { tabId: "t", url: bad, title: "x", capturedAt: AT, helmstackVersion: "1" } });
      expect(html).not.toMatch(/<a href/);
      expect(html).not.toMatch(/href="(javascript|data|file):/i);
    }
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("https://u:p@example.com/a?b=1#c")).toBe("https://example.com/a");
  });

  it("strips control and bidi characters", () => {
    const { html, markdown } = build({ summary: "a\u0000b\u202ec\u0007d\u200be", title: "t\u0001x" });
    expect(html + markdown).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u202e\u200b]/);
    expect(html).toContain("abcde");
  });

  it("escapes markdown control characters so agent text cannot add structure", () => {
    const evil = "# Heading\n- [click](javascript:alert(1))\n<script>x</script> **bold** `code` ![i](http://x/y.png)\n1. item\n---";
    const { markdown } = build({ summary: evil, recommendations: [evil], findings: [{ title: evil, severity: "low", recommendation: evil }] });
    expect(markdown).not.toMatch(/^# Heading/m);
    expect(markdown).not.toMatch(/\[click\]\(/);
    expect(markdown).not.toMatch(/<script>/);
    expect(markdown).not.toMatch(/\*\*bold\*\*/);
    expect(markdown).not.toMatch(/!\[i\]/);
    expect(escapeMarkdown("a_b *c* [d](e)")).toBe("a\\_b \\*c\\* \\[d\\](e)");
    expect(escapeMarkdown("1. x\n- y")).toBe("1\\. x  \n\\- y");
  });

  it("emits one file with no scripts or external resources and a restrictive CSP", () => {
    const { html } = build(
      { summary: "ok", findings: [{ title: "f", severity: "low", recommendation: "r" }] },
      { accessibility: a11y(), seo: seo(), logs: { console: logs(), network: logs() }, screenshotPng: PNG }
    );
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<iframe|<object|<embed|<form|<base\b/i);
    expect(html).not.toMatch(/@import|url\(/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    const srcs = [...html.matchAll(/\ssrc="([^"]*)"/g)].map((m) => m[1]!);
    expect(srcs.length).toBe(1);
    expect(srcs[0]).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
    // The only http(s) URLs in attributes are the page link.
    const attrUrls = [...html.matchAll(/(?:href|src|action)="(https?:[^"]*)"/g)].map((m) => m[1]);
    expect(attrUrls).toEqual(["https://example.com/pricing"]);
  });

  it("omits a screenshot whose bytes are not a PNG", () => {
    const { html, summary } = build({}, { screenshotPng: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]) });
    expect(summary.screenshot).toBe(false);
    expect(html).not.toContain("data:image");
  });

  it("never includes field values, cookies, tokens, headers or query strings", () => {
    const { html, markdown, preview } = build({}, { accessibility: a11y(), logs: { console: logs(), network: logs() } });
    const all = html + markdown + preview;
    for (const secret of ["SECRET", "hunter2", "apikey", "sig=", "Bearer", "Set-Cookie", "sid="]) {
      expect(all, secret).not.toContain(secret);
    }
    expect(all).toContain("https://api.example.com/v1");
    expect(all).toContain("https://cdn.example.com/a.js");
  });
});

describe("buildReport limits", () => {
  it("truncates over-long fields with an ellipsis and says so in the report", () => {
    const huge = "x".repeat(50_000);
    const { html, markdown, summary } = build({
      title: huge,
      summary: huge,
      author: huge,
      findings: Array.from({ length: 80 }, (_, i) => ({ title: `${i}${huge}`, severity: "low" as const, evidence: huge, recommendation: huge })),
      recommendations: Array.from({ length: 60 }, () => huge)
    });
    expect(html.length).toBeLessThan(600_000);
    expect(html).toContain("Content was shortened to fit limits");
    expect(html).toContain(`Summary was cut to ${REPORT_LIMITS.summaryChars} characters`);
    expect(html).toContain(`Only the first ${REPORT_LIMITS.findings} of 80 findings are shown`);
    expect(html).toContain(`Only the first ${REPORT_LIMITS.recommendations} of 60 recommendations are shown`);
    expect(markdown).toContain("shortened to fit limits");
    expect(summary.findingCount).toBe(REPORT_LIMITS.findings);
    expect(summary.title.length).toBeLessThanOrEqual(REPORT_LIMITS.titleChars);
    expect(summary.title.endsWith("…")).toBe(true);
    expect(html).not.toContain("x".repeat(REPORT_LIMITS.summaryChars + 1));
    expect(html).toContain(`Finding 1 evidence was cut to ${REPORT_FIELD_LIMITS.findingEvidenceChars} characters`);
  });

  it("coerces an unknown severity to info and keeps severity order critical to info", () => {
    const { html, summary } = build({
      findings: [
        { title: "low one", severity: "low", recommendation: "r" },
        { title: "crit one", severity: "critical", recommendation: "r" },
        { title: "weird", severity: "catastrophic" as never, recommendation: "r" }
      ]
    });
    expect(summary.severityCounts).toEqual({ critical: 1, high: 0, medium: 0, low: 1, info: 1 });
    expect(html.indexOf("crit one")).toBeLessThan(html.indexOf("low one"));
    expect(html.indexOf("low one")).toBeLessThan(html.indexOf("weird"));
  });
});

describe("buildReport provenance and determinism", () => {
  const input: CreateReportInput = {
    summary: "S",
    author: "Claude Code",
    findings: [{ title: "T", severity: "medium", recommendation: "R" }],
    recommendations: ["Do A", "Do B"]
  };

  it("labels the agent's content and HelmStack's measurements separately", () => {
    const { html, markdown } = build(input, { accessibility: a11y(), seo: seo() });
    expect(html).toContain("Written by Claude Code; not verified by HelmStack");
    expect(html).toContain("Measured by HelmStack");
    expect(markdown).toContain("Written by Claude Code; not verified by HelmStack");
    expect(markdown).toContain("Measured by HelmStack");
    // Each agent section carries the label; the agent's text never sits inside a measured section.
    const measured = html.slice(html.indexOf('<section class="measured">'));
    expect(measured).not.toContain("Do A");
    expect(measured.split("</section>")[0]).not.toContain("Written by");
    const labelCount = (html.match(/Written by Claude Code; not verified by HelmStack/g) ?? []).length;
    expect(labelCount).toBeGreaterThanOrEqual(3);
  });

  it("falls back to the agent id for the author, then to a generic name", () => {
    expect(build({}, {}, { fallbackAuthor: "agent-7" }).summary.author).toBe("agent-7");
    expect(build({}).summary.author).toBe("an AI agent");
  });

  it("produces byte-identical output for the same input", () => {
    const evidence = { accessibility: a11y(), seo: seo(), logs: { console: logs(), network: logs() }, screenshotPng: PNG };
    const a = build(input, evidence);
    const b = build(input, evidence);
    expect(b.html).toBe(a.html);
    expect(b.markdown).toBe(a.markdown);
    expect(b.summary).toEqual(a.summary);
    expect(a.html).toContain("2026-10-16T10:30:00.000Z");
  });

  it("orders measured issues by severity then id regardless of input order", () => {
    const forward = a11y();
    const reversed = { ...forward, violations: [...forward.violations].reverse() };
    expect(build({}, { accessibility: reversed }).html).toBe(build({}, { accessibility: forward }).html);
  });

  it("records skipped measurements in the summary and the report", () => {
    const { summary, html } = build({}, {}, { skipped: [{ kind: "seo", reason: "timed out after 20 s" }] });
    expect(summary.skipped).toEqual([{ kind: "seo", reason: "timed out after 20 s" }]);
    expect(html).toContain("timed out after 20 s");
    expect(summary.evidence).toEqual([]);
  });
});
