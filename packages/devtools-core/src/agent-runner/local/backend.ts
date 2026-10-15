/**
 * Local model backend for the agent runner: detection + per-conversation lite
 * sessions + the turn loop. The loop reaches the page only through
 * `BrowserClient` over loopback HTTP to this instance's own agent API, with the
 * instance token and an attributable agent id (`chat:ollama:<model>`), so
 * approvals (human-only on desktop), activity recording and redaction stay in
 * one pipeline. It is pinned to the conversation's tab and gets no other capability.
 */
import { readFileSync } from "node:fs";

import type { AgentCliInfo } from "../../../../shared/src/index.js";
import { createLiteSession, type LiteBrowser } from "../../../../agent-sdk/src/lite/index.js";
import { BrowserClient } from "../../../../agent-sdk/src/index.js";
import type { AdapterEvent } from "../types.js";
import { LocalDetector, type LocalDetectOptions } from "./detect.js";
import { DEFAULT_NUM_CTX, runLocalTurn, type HistoryMessage, type LocalTurnResult } from "./loop.js";
import { loopbackOrigin } from "./net.js";

export type LocalBackendOptions = {
  /** Agent API of this HelmStack instance. */
  port: number;
  host?: string;
  tokenFile?: string | null;
  authToken?: string | null;
  env?: NodeJS.ProcessEnv;
  detect?: LocalDetectOptions;
  /** Ollama context window sent as `options.num_ctx`. Default 8192 or HELMSTACK_LOCAL_NUM_CTX. */
  numCtx?: number;
  maxSteps?: number;
  idleTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Tests / alternative transports. Default: BrowserClient over loopback HTTP. */
  createBrowser?: (ctx: { agentId: string; tabId: string }) => LiteBrowser;
  settleMs?: number;
};

export function resolveNumCtx(env: NodeJS.ProcessEnv | undefined, explicit?: number): number {
  const raw = explicit ?? Number((env?.HELMSTACK_LOCAL_NUM_CTX ?? "").trim());
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_NUM_CTX;
  return Math.min(131_072, Math.max(2048, Math.floor(raw)));
}

export type LocalSession = {
  runTurn(input: {
    history: readonly HistoryMessage[];
    text: string;
    signal: AbortSignal;
    emit: (events: AdapterEvent[]) => void;
  }): Promise<LocalTurnResult>;
  close(): void;
};

export class LocalModelBackend {
  private readonly detector: LocalDetector;
  private routes = new Map<string, { endpoint: string; kind: "ollama" | "openai-compat" }>();
  readonly numCtx: number;

  constructor(private readonly opts: LocalBackendOptions) {
    this.detector = new LocalDetector({ env: opts.env, ...opts.detect, fetchImpl: opts.fetchImpl ?? opts.detect?.fetchImpl });
    this.numCtx = resolveNumCtx(opts.env, opts.numCtx);
  }

  async refresh(): Promise<AgentCliInfo[]> {
    const { infos, routes } = await this.detector.detect();
    this.routes = routes;
    return infos;
  }

  /** Is `model` currently served by `provider`? Used to validate conversation starts. */
  route(provider: string, model: string): { endpoint: string; kind: "ollama" | "openai-compat" } | null {
    return this.routes.get(`${provider}:${model}`) ?? null;
  }

  createSession(ctx: { provider: "ollama" | "openai-compat"; model: string; tabId: string }): LocalSession {
    const route = this.route(ctx.provider, ctx.model);
    if (!route || !loopbackOrigin(route.endpoint)) throw new Error("That local model is not available. Refresh the model list.");
    const agentId = `chat:${ctx.provider}:${ctx.model}`;
    const inner = this.opts.createBrowser ? this.opts.createBrowser({ agentId, tabId: ctx.tabId }) : this.defaultBrowser(agentId);
    // Pin the lite session to the conversation's tab: it can neither see nor switch to others.
    const browser = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "listTabs") return async () => (await target.listTabs()).filter((t) => t.id === ctx.tabId);
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as LiteBrowser;
    const lite = createLiteSession(browser, {
      env: { HELMSTACK_LITE_MAX_CHARS: this.opts.env?.HELMSTACK_LITE_MAX_CHARS },
      ...(this.opts.settleMs !== undefined ? { settleMs: this.opts.settleMs } : {})
    });
    return {
      runTurn: (input) =>
        runLocalTurn({
          provider: ctx.provider,
          origin: route.endpoint,
          model: ctx.model,
          history: input.history,
          userText: input.text,
          call: (name, args) => lite.call(name, args),
          signal: input.signal,
          emit: input.emit,
          numCtx: this.numCtx,
          maxSteps: this.opts.maxSteps,
          idleTimeoutMs: this.opts.idleTimeoutMs,
          fetchImpl: this.opts.fetchImpl
        }),
      close: () => lite.close()
    };
  }

  private defaultBrowser(agentId: string): LiteBrowser {
    const host = this.opts.host ?? "127.0.0.1";
    if (!loopbackOrigin(`http://${host.includes(":") ? `[${host}]` : host}`)) throw new Error("The agent API must be on loopback.");
    let token: string | undefined;
    if (this.opts.tokenFile) {
      try {
        token = readFileSync(this.opts.tokenFile, "utf8").trim() || undefined;
      } catch {
        token = undefined;
      }
    }
    token ??= this.opts.authToken ?? undefined;
    return new BrowserClient({ port: this.opts.port, host, authToken: token, agentId }) as unknown as LiteBrowser;
  }
}
