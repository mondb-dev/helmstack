import type { HarArchive, HarEntry, HarNameValue, NetworkRequestEntry } from "../../../../packages/shared/src/index.js";

const CREATOR = { name: "HelmStack", version: "0.1.0" };

/** Convert a header record into the HAR name/value array form. */
function toHeaderList(headers: Record<string, string> | undefined): HarNameValue[] {
  if (!headers) return [];
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

/** Parse a URL's query parameters into the HAR name/value array form. */
function toQueryString(url: string): HarNameValue[] {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function toHarEntry(entry: NetworkRequestEntry): HarEntry {
  const httpVersion = entry.securityDetails?.protocol ? "HTTP/2" : "HTTP/1.1";
  return {
    startedDateTime: new Date(entry.timestamp).toISOString(),
    time: -1,
    request: {
      method: entry.method,
      url: entry.url,
      httpVersion,
      headers: toHeaderList(entry.requestHeaders),
      queryString: toQueryString(entry.url),
      cookies: [],
      headersSize: -1,
      bodySize: -1
    },
    response: {
      status: entry.statusCode ?? 0,
      statusText: entry.statusText ?? (entry.failed ? "Failed" : ""),
      httpVersion,
      headers: toHeaderList(entry.responseHeaders),
      cookies: [],
      content: { size: -1, mimeType: entry.mimeType ?? "" },
      redirectURL: "",
      headersSize: -1,
      bodySize: -1,
      ...(entry.failed && entry.errorText ? { _error: entry.errorText } : {})
    },
    cache: {},
    timings: { send: -1, wait: -1, receive: -1 },
    ...(entry.fromDiskCache ? { _fromDiskCache: true } : {}),
    ...(entry.fromServiceWorker ? { _fromServiceWorker: true } : {})
  };
}

/**
 * Build a HAR 1.2 archive from buffered network requests. Timing and body-size
 * fields are emitted as `-1` (the HAR convention for "not available") because
 * the substrate buffers request outcomes, not full waterfall timing.
 */
export function buildHar(pageUrl: string, entries: NetworkRequestEntry[]): HarArchive {
  const earliest = entries.reduce((min, e) => Math.min(min, e.timestamp), entries[0]?.timestamp ?? Date.now());
  return {
    log: {
      version: "1.2",
      creator: CREATOR,
      pages: [
        {
          startedDateTime: new Date(earliest).toISOString(),
          id: "page_1",
          title: pageUrl,
          pageTimings: { onContentLoad: -1, onLoad: -1 }
        }
      ],
      entries: entries.map(toHarEntry)
    }
  };
}
