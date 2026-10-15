/**
 * Detection of local model servers (Ollama, LM Studio, llama.cpp). Loopback only:
 * ~800 ms probes of `/api/version` + `/api/tags` (Ollama) and `/v1/models`
 * (OpenAI-compatible). Distinguishes not installed / installed but not running /
 * running without models / running, and gates models on tool-calling support.
 */
import { existsSync } from "node:fs";

import type { AgentCliInfo, AgentModelOption, LocalRuntimeState } from "../../../../shared/src/index.js";
import { findExecutable, type DetectOptions } from "../detect.js";
import { isValidModelId } from "../types.js";
import { loopbackFetch, loopbackOrigin, readJsonCapped } from "./net.js";

export type LocalEndpointKind = "ollama" | "openai-compat";
export type LocalEndpoint = { kind: LocalEndpointKind; origin: string; label: string };

export const OLLAMA_ORIGIN = "http://127.0.0.1:11434";

export function defaultEndpoints(): LocalEndpoint[] {
  return [
    { kind: "ollama", origin: OLLAMA_ORIGIN, label: "Ollama" },
    { kind: "openai-compat", origin: "http://127.0.0.1:1234", label: "LM Studio" },
    { kind: "openai-compat", origin: "http://127.0.0.1:8080", label: "llama.cpp" }
  ];
}

/**
 * `HELMSTACK_LOCAL_ENDPOINTS`: comma list of loopback URLs. Port 11434 means Ollama;
 * `ollama=URL` / `openai=URL` force a kind. Non-loopback entries are dropped.
 */
export function parseEndpoints(raw: string | undefined): { endpoints: LocalEndpoint[]; rejected: string[] } {
  if (!raw || !raw.trim()) return { endpoints: defaultEndpoints(), rejected: [] };
  const endpoints: LocalEndpoint[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(ollama|openai)=(.+)$/i.exec(part);
    const forced = m ? (m[1].toLowerCase() === "ollama" ? "ollama" : "openai-compat") : null;
    const origin = loopbackOrigin(m ? m[2] : part);
    if (!origin) {
      rejected.push(part);
      continue;
    }
    if (seen.has(origin)) continue;
    seen.add(origin);
    const port = new URL(origin).port;
    const kind: LocalEndpointKind = forced ?? (port === "11434" ? "ollama" : "openai-compat");
    endpoints.push({ kind, origin, label: kind === "ollama" ? "Ollama" : `Local server (${new URL(origin).host})` });
  }
  return { endpoints, rejected };
}

export type LocalDetectOptions = DetectOptions & {
  endpoints?: LocalEndpoint[];
  probeTimeoutMs?: number;
  showConcurrency?: number;
  fetchImpl?: typeof fetch;
  /** App bundles that mean "installed" (tests inject fixtures). */
  appPaths?: { ollama?: string[]; openai?: string[] };
};

/** A model as the server resolved it; `id` is what is sent in chat requests. */
export type LocalModel = AgentModelOption & { endpoint: string };

export type LocalDetection = {
  infos: AgentCliInfo[];
  /** model id → endpoint origin, per provider. */
  routes: Map<string, { endpoint: string; kind: LocalEndpointKind }>;
};

type ShowCacheEntry = { key: string; tools: "yes" | "no" | "unknown" };

const OLLAMA_REASON_NOT_RUNNING = "Ollama is installed but not running. Start it, then refresh.";

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  const gb = n / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(n / 1e6))} MB`;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export class LocalDetector {
  private readonly showCache = new Map<string, ShowCacheEntry>();
  readonly endpoints: LocalEndpoint[];

  constructor(private readonly opts: LocalDetectOptions = {}) {
    this.endpoints = opts.endpoints ?? parseEndpoints((opts.env ?? process.env).HELMSTACK_LOCAL_ENDPOINTS).endpoints;
  }

  private timeout(): number {
    return this.opts.probeTimeoutMs ?? 800;
  }

  private installed(kind: LocalEndpointKind): boolean {
    if (kind === "ollama") {
      const apps = this.opts.appPaths?.ollama ?? ["/Applications/Ollama.app"];
      return findExecutable(["ollama"], this.opts) !== null || apps.some((p) => existsSync(p));
    }
    const apps = this.opts.appPaths?.openai ?? ["/Applications/LM Studio.app"];
    return findExecutable(["llama-server", "lms"], this.opts) !== null || apps.some((p) => existsSync(p));
  }

  private async getJson(origin: string, path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<unknown> {
    try {
      const res = await loopbackFetch(origin, path, {
        method,
        body,
        timeoutMs: this.timeout(),
        fetchImpl: this.opts.fetchImpl
      });
      if (!res.ok) {
        void res.body?.cancel().catch(() => undefined);
        return null;
      }
      return await readJsonCapped(res);
    } catch {
      return null;
    }
  }

  async detect(): Promise<LocalDetection> {
    const routes: LocalDetection["routes"] = new Map();
    const oll = this.endpoints.filter((e) => e.kind === "ollama");
    const oai = this.endpoints.filter((e) => e.kind === "openai-compat");
    const infos: AgentCliInfo[] = [];

    // Ollama
    const ollamaModels: AgentModelOption[] = [];
    let ollamaVersion: string | null = null;
    let ollamaUp = false;
    for (const ep of oll) {
      const v = (await this.getJson(ep.origin, "/api/version")) as { version?: unknown } | null;
      if (!v || typeof v !== "object" || typeof v.version !== "string") continue;
      ollamaUp = true;
      ollamaVersion ??= v.version.slice(0, 40);
      const tags = (await this.getJson(ep.origin, "/api/tags")) as { models?: unknown } | null;
      const list = Array.isArray(tags?.models) ? (tags!.models as Record<string, unknown>[]) : [];
      const models = await mapLimit(list.slice(0, 100), this.opts.showConcurrency ?? 4, (m) => this.ollamaModel(ep.origin, m));
      for (const model of models) {
        if (!model || routes.has(`ollama:${model.id}`)) continue;
        routes.set(`ollama:${model.id}`, { endpoint: ep.origin, kind: "ollama" });
        ollamaModels.push(model);
      }
    }
    infos.push(this.info("ollama", "Ollama", oll.length > 0 && this.installed("ollama"), ollamaUp, ollamaVersion, ollamaModels, {
      notInstalled: "Ollama is not installed.",
      notRunning: OLLAMA_REASON_NOT_RUNNING,
      noModels: "Ollama is running but has no models. Pull one (for example `ollama pull llama3.2`), then refresh."
    }));

    // OpenAI-compatible servers (LM Studio, llama.cpp)
    const oaiModels: AgentModelOption[] = [];
    let oaiUp = false;
    const names: string[] = [];
    for (const ep of oai) {
      const data = (await this.getJson(ep.origin, "/v1/models")) as { data?: unknown } | null;
      if (!data || !Array.isArray(data.data)) continue;
      oaiUp = true;
      names.push(ep.label);
      for (const m of (data.data as Record<string, unknown>[]).slice(0, 100)) {
        const id = str(m?.id);
        if (!id || !isValidModelId(id) || routes.has(`openai-compat:${id}`)) continue;
        routes.set(`openai-compat:${id}`, { endpoint: ep.origin, kind: "openai-compat" });
        oaiModels.push({ id, label: id, source: "local", toolSupport: "unknown" });
      }
    }
    infos.push(
      this.info("openai-compat", names.length ? names.join(" / ") : "LM Studio / llama.cpp", oai.length > 0 && this.installed("openai-compat"), oaiUp, null, oaiModels, {
        notInstalled: "LM Studio or llama.cpp was not detected.",
        notRunning: "LM Studio or llama.cpp is installed but its server is not running. Start the local server, then refresh.",
        noModels: "The local server is running but no model is loaded. Load one, then refresh."
      })
    );
    return { infos, routes };
  }

  private info(
    id: "ollama" | "openai-compat",
    label: string,
    installed: boolean,
    up: boolean,
    version: string | null,
    models: AgentModelOption[],
    reasons: { notInstalled: string; notRunning: string; noModels: string }
  ): AgentCliInfo {
    const localState: LocalRuntimeState = up ? (models.length ? "running" : "no_models") : installed ? "not_running" : "not_installed";
    const reason =
      localState === "running" ? undefined : localState === "no_models" ? reasons.noModels : localState === "not_running" ? reasons.notRunning : reasons.notInstalled;
    const usable = models.some((m) => !m.disabledReason);
    return {
      id,
      kind: "local",
      localState,
      label,
      path: null,
      version,
      available: localState === "running" && usable,
      ...(localState === "running" && !usable ? { reason: "No installed model supports tool calling." } : reason ? { reason } : {}),
      models,
      confined: true,
      experimental: false,
      supportsResume: false
    };
  }

  private async ollamaModel(origin: string, m: Record<string, unknown>): Promise<AgentModelOption | null> {
    const name = str(m?.name) ?? str(m?.model);
    if (!name || !isValidModelId(name)) return null;
    const details = (m.details && typeof m.details === "object" ? m.details : {}) as Record<string, unknown>;
    const parts = [str(details.parameter_size), typeof m.size === "number" ? formatBytes(m.size) : ""].filter(Boolean) as string[];
    const base: AgentModelOption = { id: name, label: name, source: "local", ...(parts.length ? { sizeLabel: parts.join(" · ") } : {}) };
    const key = `${origin}|${name}|${str(m.digest) ?? str(m.modified_at) ?? ""}`;
    let cached = this.showCache.get(name);
    if (!cached || cached.key !== key) {
      cached = { key, tools: await this.toolSupport(origin, name) };
      this.showCache.set(name, cached);
    }
    if (cached.tools === "no") return { ...base, toolSupport: "no", disabledReason: "No tool-calling support" };
    return { ...base, toolSupport: cached.tools };
  }

  private async toolSupport(origin: string, name: string): Promise<"yes" | "no" | "unknown"> {
    const show = (await this.getJson(origin, "/api/show", "POST", { model: name })) as { capabilities?: unknown } | null;
    if (!show || !Array.isArray(show.capabilities)) return "unknown";
    return show.capabilities.includes("tools") ? "yes" : "no";
  }
}
