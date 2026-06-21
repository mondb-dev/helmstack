import type { AccountInput, NetworkInterceptRule, ResourceBudget } from "../../../../packages/shared/src/index.js";

/**
 * Lightweight, zero-dependency validators for REST request bodies. Each returns
 * a typed value or a human-readable error, so the agent server can answer real
 * `400`s instead of casting unknown input and crashing later. Pure — testable.
 */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = (error: string): ParseResult<never> => ({ ok: false, error });

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optionalNumber(v: unknown, name: string): string | null {
  return v === undefined || typeof v === "number" ? null : `${name} must be a number`;
}

function optionalString(v: unknown, name: string): string | null {
  return v === undefined || typeof v === "string" ? null : `${name} must be a string`;
}

export function parseNetworkMockRules(body: Record<string, unknown>): ParseResult<NetworkInterceptRule[]> {
  if (!Array.isArray(body.rules)) return fail("rules must be an array");
  const rules: NetworkInterceptRule[] = [];
  for (let i = 0; i < body.rules.length; i++) {
    const r = body.rules[i];
    if (!isObject(r)) return fail(`rules[${i}] must be an object`);
    if (typeof r.urlPattern !== "string" || r.urlPattern.length === 0) {
      return fail(`rules[${i}].urlPattern must be a non-empty string`);
    }
    const errs = [
      optionalString(r.method, `rules[${i}].method`),
      optionalNumber(r.responseStatus, `rules[${i}].responseStatus`)
    ].filter(Boolean);
    if (errs.length) return fail(errs[0]!);
    if (r.responseHeaders !== undefined && !isObject(r.responseHeaders)) {
      return fail(`rules[${i}].responseHeaders must be an object`);
    }
    rules.push(r as unknown as NetworkInterceptRule);
  }
  return ok(rules);
}

export function parseResourceBudget(body: Record<string, unknown>): ParseResult<ResourceBudget> {
  const errs = [
    optionalNumber(body.cpuThrottlingRate, "cpuThrottlingRate"),
    optionalNumber(body.downloadThroughputKbps, "downloadThroughputKbps"),
    optionalNumber(body.uploadThroughputKbps, "uploadThroughputKbps"),
    optionalNumber(body.latencyMs, "latencyMs"),
    optionalNumber(body.maxJsHeapMb, "maxJsHeapMb"),
    body.offline === undefined || typeof body.offline === "boolean" ? null : "offline must be a boolean"
  ].filter(Boolean);
  if (errs.length) return fail(errs[0]!);
  return ok(body as ResourceBudget);
}

export function parseAccountInput(body: Record<string, unknown>): ParseResult<AccountInput> {
  if (typeof body.label !== "string" || body.label.length === 0) return fail("label is required");
  if (!Array.isArray(body.origins) || !body.origins.every((o) => typeof o === "string")) {
    return fail("origins must be an array of strings");
  }
  if (typeof body.username !== "string") return fail("username must be a string");
  if (typeof body.password !== "string") return fail("password must be a string");
  const errs = [optionalString(body.totpSeed, "totpSeed"), optionalString(body.notes, "notes")].filter(Boolean);
  if (errs.length) return fail(errs[0]!);
  return ok(body as unknown as AccountInput);
}

export function parseViewportBody(body: Record<string, unknown>): ParseResult<{ width: number; height: number; mobile: boolean }> {
  if (typeof body.width !== "number" || typeof body.height !== "number") {
    return fail("width and height are required numbers");
  }
  if (body.mobile !== undefined && typeof body.mobile !== "boolean") {
    return fail("mobile must be a boolean");
  }
  return ok({ width: body.width, height: body.height, mobile: body.mobile === true });
}
