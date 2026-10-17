/**
 * Which model answers routine judgments. A human setting (shell IPC only; there is no HTTP or MCP
 * route), saved in `<dataDir>/routine-model.json` (temp file + rename, 0600). Routines, agents and
 * page text cannot read it or change it.
 *
 * `HELMSTACK_ROUTINE_MODEL=cli[:model]` (for example `claude`, `claude:haiku`,
 * `ollama:llama3.2:3b`) is a fallback for the daemon, used only while nothing is saved. Whether the
 * runtime is installed or reachable is checked with the same detection the agent chat uses.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { AGENT_CLI_IDS, type AgentCliId, type RoutineModelChoice, type RoutineModelStatus } from "../../../../shared/src/index.js";
import { BUILTIN_ADAPTERS } from "../../agent-runner/adapters/index.js";
import { detectCli, type DetectOptions } from "../../agent-runner/detect.js";
import { LocalDetector, type LocalDetectOptions } from "../../agent-runner/local/detect.js";
import { MODEL_ID_PATTERN } from "../../agent-runner/types.js";
import { createCliInferenceModel, createLocalInferenceModel, type SpawnFn } from "./inference-models.js";
import type { InferenceModel } from "./inference.js";

export const ROUTINE_MODEL_FILE = "routine-model.json";
export const ROUTINE_MODEL_ENV = "HELMSTACK_ROUTINE_MODEL";
export const CHOOSE_MODEL_MESSAGE = "Choose a model for routines in the Routines tab";

export type InferenceResolution = { ok: true; model: InferenceModel } | { ok: false; reason: string; chosen: boolean };

/** Anything that can say which model to use right now. The engine only needs this. */
export interface ModelResolver {
  resolve(): Promise<InferenceResolution>;
}

/** Validates a choice from the renderer or a file. Throws a plain-language Error. */
export function parseRoutineModelChoice(value: unknown): RoutineModelChoice {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Choose a model runtime.");
  const v = value as Record<string, unknown>;
  if (typeof v.cli !== "string" || !(AGENT_CLI_IDS as readonly string[]).includes(v.cli)) throw new Error("That model runtime is not supported.");
  const cli = v.cli as AgentCliId;
  let model: string | undefined;
  if (v.model !== undefined && v.model !== null && v.model !== "") {
    if (typeof v.model !== "string" || !MODEL_ID_PATTERN.test(v.model)) {
      throw new Error("Invalid model id. Use letters, digits and . _ : / - only (max 80 characters), starting with a letter or digit.");
    }
    model = v.model;
  }
  if ((cli === "ollama" || cli === "openai-compat") && !model) throw new Error("Choose one of the detected local models.");
  return { cli, ...(model ? { model } : {}) };
}

/** `cli[:model]`, or null when empty or invalid. */
export function parseRoutineModelEnv(raw: string | undefined): RoutineModelChoice | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const i = text.indexOf(":");
  try {
    return parseRoutineModelChoice(i < 0 ? { cli: text } : { cli: text.slice(0, i), model: text.slice(i + 1) });
  } catch {
    return null;
  }
}

export type RoutineModelManagerOptions = {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  detect?: DetectOptions;
  local?: LocalDetectOptions;
  fetchImpl?: typeof fetch;
  spawn?: SpawnFn;
  tmpRoot?: string;
  log?: (message: string) => void;
  /** Tests: use this model whenever a choice exists (detection is skipped). */
  fakeModel?: InferenceModel;
};

export class RoutineModelManager implements ModelResolver {
  private readonly file: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly log: (message: string) => void;

  constructor(private readonly opts: RoutineModelManagerOptions) {
    this.file = path.join(opts.dataDir, ROUTINE_MODEL_FILE);
    this.env = opts.env ?? process.env;
    this.platform = opts.platform ?? process.platform;
    this.log = opts.log ?? (() => {});
  }

  /** The saved choice, else the environment fallback, else null. */
  choice(): RoutineModelChoice | null {
    return this.readSaved() ?? parseRoutineModelEnv(this.env[ROUTINE_MODEL_ENV]);
  }

  async getStatus(): Promise<RoutineModelStatus> {
    const choice = this.choice();
    if (!choice) return { choice: null, available: false, reason: `${CHOOSE_MODEL_MESSAGE}.` };
    const found = await this.find(choice);
    return found.ok ? { choice, available: true } : { choice, available: false, reason: found.reason };
  }

  /** Save (or, with null, clear) the choice. Throws on an invalid one. */
  async setChoice(raw: unknown): Promise<RoutineModelStatus> {
    if (raw === null) {
      rmSync(this.file, { force: true });
      return this.getStatus();
    }
    const choice = parseRoutineModelChoice(raw);
    mkdirSync(this.opts.dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: 1, ...choice }), { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    return this.getStatus();
  }

  async resolve(): Promise<InferenceResolution> {
    const choice = this.choice();
    if (!choice) return { ok: false, reason: CHOOSE_MODEL_MESSAGE, chosen: false };
    const found = await this.find(choice);
    return found.ok ? { ok: true, model: found.model } : { ok: false, reason: found.reason, chosen: true };
  }

  // ── internals ──────────────────────────────────────────────────────────

  private readSaved(): RoutineModelChoice | null {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return null;
    }
    try {
      return parseRoutineModelChoice(JSON.parse(text));
    } catch {
      this.log("[Routines] the saved routine model choice was unreadable and is ignored");
      return null;
    }
  }

  private async find(choice: RoutineModelChoice): Promise<{ ok: true; model: InferenceModel } | { ok: false; reason: string }> {
    if (this.opts.fakeModel) return { ok: true, model: this.opts.fakeModel };
    if (choice.cli === "claude" || choice.cli === "gemini") {
      if (this.platform === "win32") return { ok: false, reason: "Running a model CLI isn't supported on Windows yet. Choose a local model." };
      const adapter = BUILTIN_ADAPTERS.find((a) => a.id === choice.cli);
      if (!adapter) return { ok: false, reason: "That model runtime is not supported." };
      const info = await detectCli(adapter, { env: this.env, ...this.opts.detect });
      if (!info.available || !info.path) return { ok: false, reason: `${adapter.label} is not available: ${info.reason ?? "unknown reason"}.` };
      return {
        ok: true,
        model: createCliInferenceModel({
          cli: choice.cli,
          binary: info.path,
          label: choice.model ? `${adapter.label} (${choice.model})` : adapter.label,
          ...(choice.model ? { model: choice.model } : {}),
          env: this.env,
          ...(this.opts.spawn ? { spawn: this.opts.spawn } : {}),
          ...(this.opts.tmpRoot ? { tmpRoot: this.opts.tmpRoot } : {})
        })
      };
    }
    const detector = new LocalDetector({ env: this.env, ...this.opts.local, ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}) });
    const { infos, routes } = await detector.detect();
    const info = infos.find((i) => i.id === choice.cli);
    const route = choice.model ? routes.get(`${choice.cli}:${choice.model}`) : undefined;
    if (!route) {
      const reason = info && !info.models.length && info.reason ? info.reason : `${choice.model ?? "That model"} was not found on ${info?.label ?? "the local server"}. Pick an installed model.`;
      return { ok: false, reason };
    }
    return {
      ok: true,
      model: createLocalInferenceModel({
        kind: route.kind,
        origin: route.endpoint,
        model: choice.model!,
        label: `${info?.label ?? choice.cli} ${choice.model}`,
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {})
      })
    };
  }
}
