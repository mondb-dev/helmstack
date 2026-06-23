import type { ConsoleLogLevel, NetworkInterceptRule } from "../../../../packages/shared/src/index.js";
import type { TabRecord } from "./tab-manager.js"; // type-only — erased at runtime, no cycle

/**
 * CDP event router + network-mock matching. Buffers console/network/WebSocket/
 * EventSource/JS-error events onto the TabRecord and fulfills intercepted
 * requests. Extracted from `TabManager`. The `tab` param carries its WebContents.
 */
export function matchesMockRule(url: string, method: string, rule: NetworkInterceptRule): boolean {
  if (rule.method && rule.method.toUpperCase() !== method.toUpperCase()) return false;

  const pattern = rule.urlPattern;

  // Regex syntax: /pattern/flags
  const regexMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
  if (regexMatch) {
    try {
      return new RegExp(regexMatch[1], regexMatch[2] ?? "").test(url);
    } catch {
      return false;
    }
  }

  // Glob: escape regex special chars then replace * with .*
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, String.raw`\$&`).replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(url);
}

export function handleCdpMessage(tab: TabRecord, method: string, params: Record<string, unknown>): void {
  switch (method) {
    case "Log.entryAdded": {
      const entry = params.entry as Record<string, unknown> | undefined;
      if (!entry) break;
      const rawLevel = (entry.level as string) ?? "log";
      const level: ConsoleLogLevel = ["log", "info", "warn", "error", "debug"].includes(rawLevel)
        ? rawLevel as ConsoleLogLevel
        : "log";
      tab.consoleLogs.push({
        level,
        text: (entry.text as string) ?? "",
        url: entry.url as string | undefined,
        lineNumber: entry.lineNumber as number | undefined,
        timestamp: (entry.timestamp as number) ?? Date.now()
      });
      break;
    }

    case "Runtime.exceptionThrown": {
      const details = params.exceptionDetails as Record<string, unknown> | undefined;
      if (!details) break;
      const exception = details.exception as Record<string, unknown> | undefined;
      const text = (exception?.description as string)
        ?? (details.text as string)
        ?? "Uncaught exception";
      tab.jsErrors.push(text);
      break;
    }

    case "Network.requestWillBeSent": {
      const requestId = params.requestId as string | undefined;
      const request = params.request as Record<string, unknown> | undefined;
      if (!requestId || !request) break;
      const rawReqHeaders = request.headers as Record<string, unknown> | undefined;
      const requestHeaders: Record<string, string> | undefined = rawReqHeaders
        ? Object.fromEntries(
            Object.entries(rawReqHeaders).map(([k, v]) => [k, String(v)])
          )
        : undefined;
      tab.networkRequests.set(requestId, {
        requestId,
        url: (request.url as string) ?? "",
        method: (request.method as string) ?? "GET",
        failed: false,
        timestamp: (params.timestamp as number) ?? Date.now(),
        requestHeaders
      });
      break;
    }

    case "Network.responseReceived": {
      const requestId = params.requestId as string | undefined;
      const response = params.response as Record<string, unknown> | undefined;
      if (!requestId || !response) break;
      const existing = tab.networkRequests.get(requestId);
      if (existing) {
        existing.statusCode = response.status as number | undefined;
        existing.statusText = response.statusText as string | undefined;
        existing.mimeType   = response.mimeType   as string | undefined;
        existing.fromDiskCache    = (response.fromDiskCache    as boolean | undefined) ?? false;
        existing.fromServiceWorker = (response.fromServiceWorker as boolean | undefined) ?? false;

        const rawHeaders = response.headers as Record<string, unknown> | undefined;
        if (rawHeaders) {
          existing.responseHeaders = Object.fromEntries(
            Object.entries(rawHeaders).map(([k, v]) => [k, String(v)])
          );
        }

        const sd = response.securityDetails as Record<string, unknown> | undefined;
        if (sd) {
          existing.securityDetails = {
            protocol:    (sd.protocol    as string) ?? "",
            keyExchange: (sd.keyExchange as string) ?? "",
            cipher:      (sd.cipher      as string) ?? "",
            subjectName: (sd.subjectName as string) ?? "",
            issuer:      (sd.issuer      as string) ?? "",
            validFrom:   (sd.validFrom   as number) ?? 0,
            validTo:     (sd.validTo     as number) ?? 0,
            sanList:     Array.isArray(sd.sanList) ? (sd.sanList as string[]) : []
          };
        }
      }
      break;
    }

    case "Network.loadingFailed": {
      const requestId = params.requestId as string | undefined;
      if (!requestId) break;
      const existing = tab.networkRequests.get(requestId);
      if (existing) {
        existing.failed    = true;
        existing.errorText = params.errorText as string | undefined;
      }
      break;
    }

    case "Network.webSocketCreated": {
      const requestId = params.requestId as string | undefined;
      const url = params.url as string | undefined;
      if (!requestId) break;
      if (url) {
        tab.webSocketUrls.set(requestId, url);
      }
      tab.webSocketFrames.push({
        requestId,
        url,
        direction: "opened",
        payload: "",
        timestamp: Date.now()
      });
      break;
    }

    case "Network.webSocketFrameSent":
    case "Network.webSocketFrameReceived": {
      const requestId = params.requestId as string | undefined;
      const response = params.response as Record<string, unknown> | undefined;
      if (!requestId || !response) break;
      tab.webSocketFrames.push({
        requestId,
        url: tab.webSocketUrls.get(requestId),
        direction: method.endsWith("Sent") ? "sent" : "received",
        opcode: response.opcode as number | undefined,
        payload: String(response.payloadData ?? ""),
        timestamp: Date.now()
      });
      break;
    }

    case "Network.webSocketClosed": {
      const requestId = params.requestId as string | undefined;
      if (!requestId) break;
      tab.webSocketFrames.push({
        requestId,
        url: tab.webSocketUrls.get(requestId),
        direction: "closed",
        payload: "",
        timestamp: Date.now()
      });
      break;
    }

    case "Network.eventSourceMessageReceived": {
      const requestId = params.requestId as string | undefined;
      if (!requestId) break;
      tab.eventSourceEvents.push({
        requestId,
        url: String(params.url ?? ""),
        eventName: String(params.eventName ?? "message"),
        eventId: String(params.eventId ?? ""),
        data: String(params.data ?? ""),
        timestamp: Date.now()
      });
      break;
    }

    case "Fetch.requestPaused": {
      const requestId = params.requestId as string | undefined;
      const request   = params.request   as Record<string, unknown> | undefined;
      if (!requestId) break;

      if (!tab.networkMockRules || !request) {
        // Fetch domain enabled but no rules active — pass through.
        void tab.view.webContents.debugger
          .sendCommand("Fetch.continueRequest", { requestId })
          .catch(() => {});
        break;
      }

      const url           = (request.url    as string) ?? "";
      const requestMethod = (request.method as string) ?? "GET";
      const matched = tab.networkMockRules.find(rule => matchesMockRule(url, requestMethod, rule));

      if (matched) {
        const body = matched.responseBody !== undefined
          ? (typeof matched.responseBody === "string"
            ? matched.responseBody
            : JSON.stringify(matched.responseBody))
          : "";
        const headers = Object.entries({
          "Content-Type": (typeof matched.responseBody === "object" && matched.responseBody !== null)
            ? "application/json"
            : "text/plain",
          ...matched.responseHeaders
        }).map(([name, value]) => ({ name, value }));

        void tab.view.webContents.debugger
          .sendCommand("Fetch.fulfillRequest", {
            requestId,
            responseCode: matched.responseStatus ?? 200,
            responseHeaders: headers,
            body: Buffer.from(body).toString("base64")
          })
          .catch(() => {});
      } else {
        void tab.view.webContents.debugger
          .sendCommand("Fetch.continueRequest", { requestId })
          .catch(() => {});
      }
      break;
    }
  }
}
