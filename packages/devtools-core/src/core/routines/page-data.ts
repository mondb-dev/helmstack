/**
 * Read-only page data for routine steps.
 *
 * One fixed script (written here, never from a spec or a model) runs in the page and returns
 * plain JSON: the page's own title/date/summary, items found in structured data (JSON-LD
 * `ItemList`, `Article`, `Event`, ...) and groups of repeating blocks (siblings with the same
 * shape that each carry a link). Both are site-agnostic. The result is untrusted text and is
 * sanitized and size-capped on this side before the executor sees it.
 */

/** One item found on a page. Every value is page-supplied text. */
export type PageItem = Record<string, string>;

export type PageBlockGroup = { confidence: number; items: PageItem[] };

export type PageData = {
  /** The URL the page reports (after redirects). */
  url: string;
  title: string;
  /** The page itself as a record: title, url, date, summary. */
  page: PageItem;
  structured: PageItem[];
  blocks: PageBlockGroup[];
};

export const PAGE_ITEM_CAP = 200;
export const PAGE_FIELD_CHARS = 2000;
export const PAGE_GROUP_CAP = 3;

/** Confidence given to items read from structured data. */
export const STRUCTURED_CONFIDENCE = 0.9;

export const PAGE_COLLECTOR_SCRIPT = String.raw`(() => {
  const CAP = ${PAGE_ITEM_CAP};
  const clip = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
  const abs = (u) => {
    if (!u) return "";
    try {
      const x = new URL(String(u), document.baseURI);
      return /^https?:$/.test(x.protocol) ? x.href : "";
    } catch (e) { return ""; }
  };
  const str = (v) => (typeof v === "string" ? v : v && typeof v === "object" && typeof v["@id"] === "string" ? v["@id"] : "");
  const meta = (name) => {
    const el = document.querySelector('meta[property="' + name + '"],meta[name="' + name + '"]');
    return el ? clip(el.getAttribute("content"), 500) : "";
  };

  // ── structured data (JSON-LD) ──
  const structured = [];
  const seen = new Set();
  const SKIP = /^(WebSite|Organization|BreadcrumbList|SearchAction|ImageObject|Person|ListItem|SiteNavigationElement|WPHeader|WPFooter)$/;
  const typeOf = (n) => [].concat(n["@type"] || []).map(String);
  const addNode = (n, force) => {
    if (!n || typeof n !== "object") return;
    const types = typeOf(n);
    if (!force && types.length && types.every((t) => SKIP.test(t))) return;
    const title = clip(n.headline || n.name || "", 300);
    const url = abs(str(n.url) || str(n["@id"]) || str(n.mainEntityOfPage));
    if (!title && !url) return;
    const key = url + "|" + title;
    if (seen.has(key)) return;
    seen.add(key);
    structured.push({
      title: title,
      url: url,
      date: clip(n.datePublished || n.startDate || n.dateCreated || n.dateModified || "", 60),
      summary: clip(n.description || n.abstract || "", 1000),
      type: clip(types[0] || "", 60)
    });
  };
  const walk = (n, depth) => {
    if (!n || typeof n !== "object" || depth > 6 || structured.length >= CAP) return;
    if (Array.isArray(n)) { n.forEach((x) => walk(x, depth + 1)); return; }
    if (Array.isArray(n["@graph"])) n["@graph"].forEach((x) => walk(x, depth + 1));
    if (Array.isArray(n.itemListElement)) {
      n.itemListElement.forEach((el) => {
        if (!el || typeof el !== "object") return;
        const inner = el.item && typeof el.item === "object" ? el.item : typeof el.item === "string" ? { url: el.item, name: el.name } : el;
        addNode(inner.name || inner.headline || inner.url ? inner : el, true);
      });
      return;
    }
    addNode(n);
    ["hasPart", "mainEntity", "blogPost", "event", "subEvent"].forEach((k) => { if (n[k]) walk(n[k], depth + 1); });
  };
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try { walk(JSON.parse(s.textContent || ""), 0); } catch (e) { /* not JSON */ }
  });

  // ── repeating blocks ──
  const DATE_RE = /\b(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?|\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]* \d{4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]* \d{1,2},? \d{4}|\d{1,2}\/\d{1,2}\/\d{4})\b/i;
  const visible = (el) => {
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return !r || r.width > 0 || r.height > 0;
  };
  const describe = (el) => {
    if (!visible(el) || el.closest("nav,header,footer,aside,[role=navigation],[role=banner],[role=contentinfo]")) return null;
    const text = clip(el.innerText || el.textContent || "", 1500);
    if (text.length < 15) return null;
    const heading = el.querySelector("h1,h2,h3,h4,h5,h6,[role=heading]");
    const headLink = heading ? heading.querySelector("a[href]") || heading.closest("a[href]") : null;
    const links = Array.from(el.querySelectorAll("a[href]")).filter((a) => abs(a.getAttribute("href")) && clip(a.textContent, 5).length > 0);
    const link = headLink || links.sort((a, b) => clip(b.textContent, 400).length - clip(a.textContent, 400).length)[0] || (el.tagName === "A" ? el : null);
    const url = link ? abs(link.getAttribute("href")) : "";
    const title = clip(heading ? heading.textContent : link ? link.textContent : text, 300);
    if (!title) return null;
    const time = el.querySelector("time[datetime]");
    const m = DATE_RE.exec(text);
    const date = time ? clip(time.getAttribute("datetime"), 60) : m ? clip(m[1], 60) : "";
    let summary = text.indexOf(title) === 0 ? text.slice(title.length) : text;
    summary = clip(summary.replace(date, ""), 500);
    return { title: title, url: url, date: date, summary: summary, hasHeading: !!heading };
  };
  const groups = [];
  const parents = Array.from(document.querySelectorAll("body,ul,ol,div,section,main,article,tbody,dl")).slice(0, 800);
  for (const parent of parents) {
    const kids = Array.from(parent.children);
    if (kids.length < 3) continue;
    const bySig = new Map();
    for (const k of kids) {
      const sig = k.tagName + "." + Array.from(k.classList).sort().join(".");
      if (!bySig.has(sig)) bySig.set(sig, []);
      bySig.get(sig).push(k);
    }
    for (const members of bySig.values()) {
      if (members.length < 3) continue;
      const described = members.map(describe).filter(Boolean);
      if (described.length < 3) continue;
      const n = described.length;
      const frac = (f) => described.filter(f).length / n;
      const linked = frac((d) => d.url);
      if (linked < 0.5) continue;
      const confidence = Math.min(0.85, 0.4 + 0.2 * Math.min(1, n / 8) + 0.15 * linked + 0.05 * frac((d) => d.hasHeading) + 0.05 * frac((d) => d.date));
      groups.push({ rank: n * linked, confidence: Math.round(confidence * 100) / 100, items: described.slice(0, CAP).map((d) => ({ title: d.title, url: d.url, date: d.date, summary: d.summary })) });
    }
  }
  groups.sort((a, b) => b.rank - a.rank);

  // ── the page itself ──
  const time0 = document.querySelector("time[datetime]");
  const main = structured.find((s) => s.url === abs(location.href)) || null;
  const page = {
    title: clip(meta("og:title") || document.title, 300),
    url: location.href,
    date: clip((main && main.date) || meta("article:published_time") || (time0 && time0.getAttribute("datetime")) || "", 60),
    summary: clip((main && main.summary) || meta("og:description") || meta("description"), 1000)
  };
  return { url: location.href, title: clip(document.title, 300), page: page, structured: structured.slice(0, CAP), blocks: groups.slice(0, ${PAGE_GROUP_CAP}).map((g) => ({ confidence: g.confidence, items: g.items })) };
})()`;

function cleanText(value: unknown, max = PAGE_FIELD_CHARS): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanItem(value: unknown): PageItem {
  const out: PageItem = {};
  if (typeof value !== "object" || value === null) return out;
  let n = 0;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (n >= 12 || !/^[a-z][a-z0-9_]{0,31}$/.test(k)) continue;
    const text = cleanText(v);
    if (text) {
      out[k] = text;
      n += 1;
    }
  }
  return out;
}

/** Validate and cap whatever the page script returned. Never throws. */
export function sanitizePageData(raw: unknown, fallbackUrl: string): PageData {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const items = (v: unknown): PageItem[] =>
    Array.isArray(v) ? v.slice(0, PAGE_ITEM_CAP).map(cleanItem).filter((i) => Object.keys(i).length > 0) : [];
  const blocks: PageBlockGroup[] = [];
  if (Array.isArray(o.blocks)) {
    for (const g of o.blocks.slice(0, PAGE_GROUP_CAP)) {
      const group = (typeof g === "object" && g !== null ? g : {}) as Record<string, unknown>;
      const confidence = typeof group.confidence === "number" && Number.isFinite(group.confidence) ? Math.max(0, Math.min(1, group.confidence)) : 0;
      const list = items(group.items);
      if (list.length > 0) blocks.push({ confidence, items: list });
    }
  }
  return {
    url: cleanText(o.url, 2048) || fallbackUrl,
    title: cleanText(o.title, 300),
    page: cleanItem(o.page),
    structured: items(o.structured),
    blocks
  };
}
