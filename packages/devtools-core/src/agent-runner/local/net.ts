/**
 * Loopback-only HTTP for local model servers. Every request goes through
 * `loopbackFetch`: the origin must be a loopback address, redirects are never
 * followed, and bodies are size-capped. Nothing here ever reaches a non-local host.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** Returns the normalized origin (`http://127.0.0.1:11434`) or null when not an acceptable loopback URL. */
export function loopbackOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return null;
  return url.origin;
}

export class LoopbackError extends Error {}

export type LoopbackFetchOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

/** A response that was received from a validated loopback origin and did not redirect. */
export async function loopbackFetch(origin: string, pathname: string, opts: LoopbackFetchOptions = {}): Promise<Response> {
  const safe = loopbackOrigin(origin);
  if (!safe) throw new LoopbackError("Only loopback model servers are allowed.");
  const controller = new AbortController();
  const timer = opts.timeoutMs ? setTimeout(() => controller.abort(), opts.timeoutMs) : null;
  const onAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${safe}${pathname}`, {
      method: opts.method ?? "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });
    // `redirect: "manual"` yields an opaque-redirect (status 0) in browsers and the 3xx in Node.
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      void res.body?.cancel().catch(() => undefined);
      throw new LoopbackError("The local model server tried to redirect; refusing.");
    }
    return res;
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** Read at most `maxBytes` of a JSON body; null when invalid or too large. */
export async function readJsonCapped(res: Response, maxBytes = 4 * 1024 * 1024): Promise<unknown> {
  try {
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}
