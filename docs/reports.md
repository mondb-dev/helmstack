# Page analysis reports

A report is one file that captures what an agent concluded about a page together with what HelmStack measured on it. This page explains what is in a report, how an agent creates one, and where the files live.

**Prerequisites:** a running HelmStack (desktop or daemon) and an agent connected to it. See [Connect an agent](connect-an-agent.md).

## What an agent does

1. The user asks, for example, "analyze this page and give me the recommendations for improvement, prepare a report for this".
2. The agent runs audits and looks at the page, then calls `browser_create_report` (or `createReport` in the [SDK](agent-sdk.md), or `POST /api/tabs/:id/report`) with **its own findings and recommendations**.
3. HelmStack collects its own measurements of the page, writes the report and returns where it saved it.

The audit tools (`browser_a11y_audit`, `browser_seo_audit`, `browser_health_report`, `browser_layout_issues`, `browser_performance`, `browser_focus_order`, `browser_network_audit`) tell the model to offer a report after it presents results, so the user does not have to know the tool exists. Agents should create a report only after the user asked for one or agreed to the offer.

## What is in a report

| Section | Source | Label in the report |
| --- | --- | --- |
| Title block: page, URL, capture time, author, viewport, active overrides, HelmStack version | HelmStack, plus the author name the agent gave | none |
| Summary | The agent | Written by *author*; not verified by HelmStack |
| Findings, grouped by severity (critical, high, medium, low, info) | The agent | Written by *author*; not verified by HelmStack |
| Recommendations, in the agent's priority order | The agent | Written by *author*; not verified by HelmStack |
| Measured by HelmStack: health scorecard, accessibility, SEO, layout, performance, console, network | HelmStack | Measured by HelmStack |
| Screenshot of the page | HelmStack | Measured by HelmStack |
| Appendix: what was included, what could not be collected, generation time | HelmStack | none |

The two kinds of content are never merged: the agent's sections and the measured sections are styled differently and each carries its label. A finding can say anything; the label tells the reader it has not been checked.

Measured sections show scores, counts and the top issues of each audit with their selectors. Console and network sections show counts plus the first errors and failed requests, with query strings and fragments removed from URLs.

The same input always produces the same file: the capture time is the only clock used and lists are ordered by severity, then identifier.

## Calling it

```ts
const { report, path, preview } = await client.createReport(tabId, {
  summary: "The pricing page is readable but fails keyboard and contrast checks.",
  findings: [
    {
      title: "Plan buttons are not reachable by keyboard",
      severity: "high",
      area: "accessibility",
      evidence: "div.plan-cta has onclick but no tabindex or role (3 occurrences).",
      recommendation: "Use <button> elements or add role=button and tabindex=0 with key handlers."
    }
  ],
  recommendations: ["Fix keyboard access on plan buttons", "Raise body text contrast to 4.5:1"],
  include: ["accessibility", "seo", "layout", "performance", "health", "console"],
  author: "Claude Code"
});
```

| Field | Default | Notes |
| --- | --- | --- |
| `title` | `Page analysis: <page title>` | |
| `summary`, `findings`, `recommendations` | empty | A report with no findings is allowed |
| `include` | accessibility, seo, layout, performance, health | Also `console` and `network` |
| `screenshot` | `true` | Viewport screenshot embedded as a PNG data URI |
| `author` | the `X-Agent-ID` header, else "an AI agent" | Shown on the report |

The result holds the report `summary` (id, title, counts by severity, measurements included, anything skipped), the `path` of the HTML file on this machine, and a short text `preview` the agent can show in chat.

`GET /api/reports` lists reports and `GET /api/reports/:id?format=html|md` downloads one as an attachment. The SDK has `listReports()` and `getReport(id, format)`; MCP has `browser_list_reports`. Agents cannot delete a report; only the person can, from the HelmStack window.

## Limits

Input over a limit is rejected with a `400` that names the field. It is never shortened silently.

| Field | Limit |
| --- | --- |
| `title` | 120 characters |
| `summary` | 4,000 characters |
| `findings` | 50 items; title 160, area 40, evidence 1,200, recommendation 1,200 characters |
| `recommendations` | 30 items of 600 characters |
| `author` | 80 characters |
| Request body | 256 KB (`413` above that) |
| Unknown fields | rejected |

As a backstop the builder also cuts anything over these limits with an ellipsis and says so in the report.

A measurement that throws or takes longer than 20 seconds is left out and listed under "Not measured" in the report and in `skipped` in the result. The report is still written.

## Where the files are

Reports live in `<data-dir>/reports/`: `<id>.html`, `<id>.md` and a small `index.json`. The data directory is the app's user-data folder on the desktop and `--data-dir` on the daemon. Ids look like `20261016-103000-1a2b3c4d`.

HelmStack keeps the newest 100 reports and at most 200 MB; older ones are deleted when a new report would exceed that, and the deletion is logged. In the desktop window the person can save a copy, open it in the browser, show it in the file manager or delete it.

The HTML file is self-contained: inline styles, the screenshot embedded, no scripts and no external requests. To get a PDF, open the file in any browser and use Print, then Save as PDF. HelmStack does not produce PDFs itself.

## Privacy

- Everything stays on this machine; HelmStack sends nothing anywhere.
- Reports never include form field values, cookies, tokens, request or response headers, or request bodies.
- URLs are shown without credentials, query strings or fragments.
- All text from the agent and from the page is treated as plain text: it is escaped in the HTML and in the Markdown, never rendered as markup, and control characters are removed.
- Files are served by id from the index only. An id that is not in the index, or is not the expected shape, never reaches the file system.

## Lite toolset

The [lite toolset](lite-toolset.md) has no report verb. It stays at 14 verbs, and a report needs a structured list of findings that small models handle poorly. Use the full toolset to create reports.
