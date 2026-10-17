import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRunnerStatus, RoutineModelStatus, RoutineNote, RoutineSummary } from "../../../packages/shared/src/index.js";
import { MODEL_EXPLANATION, hasJudgment, mountRoutines, type RoutinesBridge } from "../src/renderer/panels/routines.js";
import { createFakeBridge, flush, loadShellDom } from "./helpers/shell-fixtures.js";

let seq = 0;
function routine(partial: Partial<RoutineSummary> = {}): RoutineSummary {
  seq += 1;
  return {
    id: `rm${seq}`,
    title: `Routine ${seq}`,
    intent: "Watch pricing",
    state: "approved",
    createdAt: 1,
    updatedAt: 1,
    trigger: "every 6 hours",
    hosts: ["example.com"],
    specVersion: 1,
    preview: { headline: "h", lines: [], risks: [] },
    ...partial,
  };
}
const JUDGING = { headline: "h", lines: ['Decides: judge "is this a price change?".'], risks: [{ level: "info" as const, code: "judged_by_model", message: "A model judges." }] };
const EVIL = "<img src=x onerror=alert(1)>";

const RUNNER = {
  enabled: true,
  defaultWorkingDirectory: "/tmp",
  clis: [
    { id: "claude", label: "Claude", path: "/x", version: "1", available: true, confined: true, models: [{ id: "sonnet", label: "Sonnet" }] },
    { id: "ollama", kind: "local", label: "Ollama", path: null, version: null, available: true, confined: true, models: [{ id: "llama3", label: "Llama 3" }] },
    { id: "gemini", label: "Gemini", path: null, version: null, available: false, reason: "not installed", confined: true, models: [] },
  ],
} as unknown as AgentRunnerStatus;

const NONE: RoutineModelStatus = { choice: null, available: false, reason: "Choose a model." };

type Impl = Record<string, (...args: never[]) => unknown>;
function setup(list: RoutineSummary[], overrides: Impl = {}) {
  const fake = createFakeBridge({
    listRoutines: () => list,
    getRoutineEngineStatus: () => ({ enabled: true, running: [] }),
    getRoutineModel: () => NONE,
    setRoutineModel: ((c: unknown) => ({ choice: c, available: true })) as never,
    getAgentRunnerStatus: () => RUNNER,
    ...overrides,
  });
  const ctrl = mountRoutines({ bridge: fake.bridge as unknown as RoutinesBridge });
  return { fake, ctrl };
}

const body = (): HTMLElement => document.getElementById("routines-body")!;
const section = (): HTMLElement => body().querySelector<HTMLElement>(".routines__model")!;
const select = (): HTMLSelectElement => body().querySelector<HTMLSelectElement>("#routines-model-select")!;
const btn = (label: string): HTMLButtonElement =>
  Array.from(section().querySelectorAll("button")).find((b) => b.textContent === label)!;
function pick(value: string): void {
  select().value = value;
  select().dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  loadShellDom();
  document.getElementById("toast-region")?.remove();
});
afterEach(() => vi.restoreAllMocks());

describe("routines model section", () => {
  it("explains itself and shows the none-chosen state", async () => {
    setup([routine()]);
    await flush();
    expect(section().textContent).toContain(MODEL_EXPLANATION);
    expect(section().querySelector('[data-role="model-status"]')!.textContent).toContain("No model chosen yet.");
    expect(btn("Save").disabled).toBe(true);
    expect(btn("Clear").disabled).toBe(true);
    expect(section().textContent).toContain("local, runs on this computer");
    expect(section().querySelector("optgroup[disabled]")).not.toBeNull();
  });

  it("shows a gentle notice only when an approved routine judges and no model is chosen", async () => {
    setup([routine({ preview: JUDGING })]);
    await flush();
    expect(section().querySelector(".routines__model-notice")).not.toBeNull();
    setup([routine({ preview: { headline: "h", lines: ["Decides: It makes no judgments; every step is fixed."], risks: [] } })]);
    await flush();
    expect(hasJudgment(routine({ preview: JUDGING }))).toBe(true);
    expect(section().querySelector(".routines__model-notice")).toBeNull();
  });

  it("shows a chosen, available model without the notice", async () => {
    setup([routine({ preview: JUDGING })], { getRoutineModel: () => ({ choice: { cli: "ollama", model: "llama3" }, available: true }) });
    await flush();
    const text = section().querySelector('[data-role="model-status"]')!.textContent!;
    expect(text).toContain("Ollama · llama3");
    expect(text).toContain("Available now");
    expect(select().value).toBe("ollama::llama3");
    expect(section().querySelector(".routines__model-notice")).toBeNull();
    expect(btn("Clear").disabled).toBe(false);
  });

  it("shows a chosen but unavailable model with the reason", async () => {
    setup([routine()], { getRoutineModel: () => ({ choice: { cli: "gemini" }, available: false, reason: "not installed" }) });
    await flush();
    const text = section().querySelector('[data-role="model-status"]')!.textContent!;
    expect(text).toContain("Not available right now — not installed");
  });

  it("saves and clears a choice", async () => {
    const { fake } = setup([routine()]);
    await flush();
    pick("claude::sonnet");
    expect(btn("Save").disabled).toBe(false);
    btn("Save").click();
    await flush();
    expect(fake.fn("setRoutineModel")).toHaveBeenCalledWith({ cli: "claude", model: "sonnet" });
    expect(section().querySelector('[data-role="model-status"]')!.textContent).toContain("Claude · sonnet");
    btn("Clear").click();
    await flush();
    expect(fake.fn("setRoutineModel")).toHaveBeenLastCalledWith(null);
    expect(section().querySelector('[data-role="model-status"]')!.textContent).toContain("No model chosen yet.");
  });

  it("shows a save failure inline as an alert", async () => {
    setup([routine()], {
      setRoutineModel: (() => {
        throw new Error("flag-like model id");
      }) as never,
    });
    await flush();
    pick("claude::sonnet");
    btn("Save").click();
    await flush();
    const alert = section().querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe("Couldn't save the model — flag-like model id");
  });

  it("escapes a model id and error text", async () => {
    setup([routine()], {
      getRoutineModel: () => ({ choice: { cli: "ollama", model: EVIL }, available: true }),
      getAgentRunnerStatus: () => {
        throw new Error(EVIL);
      },
    });
    await flush();
    expect(section().querySelector("img")).toBeNull();
    expect(section().textContent).toContain(EVIL);
  });

  it("does nothing when the bridge lacks the model methods", async () => {
    const getRoutineModel = vi.fn();
    const bridge = {
      listRoutines: async () => [routine()],
      getRoutine: async () => undefined,
      getRoutineEngineStatus: async () => ({ enabled: true }),
      approveRoutine: async () => undefined,
      rejectRoutine: async () => undefined,
      pauseRoutine: async () => undefined,
      resumeRoutine: async () => undefined,
      stopRoutine: async () => undefined,
      deleteRoutine: async () => undefined,
      onRoutinesChanged: () => () => undefined,
    } as unknown as RoutinesBridge;
    mountRoutines({ bridge });
    await flush();
    expect(body().querySelector(".routines__model")).toBeNull();
    expect(getRoutineModel).not.toHaveBeenCalled();
  });
});

describe("routine notes with a model verdict", () => {
  it("shows confidence and quote as text and keeps the uncertain marker", async () => {
    const r = routine();
    const note: RoutineNote = {
      id: "n1",
      routineId: r.id,
      runId: "x",
      at: Date.now(),
      url: "https://example.com/a",
      maybe: true,
      fields: { Confidence: "0.62", evidence: EVIL, title: "Price" },
    };
    setup([r], { listRoutineRuns: () => [], listRoutineNotes: () => [note], getRoutineMemory: () => ({ routineId: r.id, sets: {}, values: {} }) });
    await flush();
    const toggle = Array.from(body().querySelectorAll<HTMLButtonElement>("button")).find((b) => b.dataset.action === "toggle-detail");
    toggle?.click();
    await flush();
    const item = body().querySelector(".routine-note") as HTMLElement;
    expect(item).not.toBeNull();
    expect(item.textContent).toContain("Model's confidence: 0.62");
    expect(item.textContent).toContain(`Quote: ${EVIL}`);
    expect(item.textContent).toContain("uncertain");
    expect(item.textContent).toContain("title: Price");
    expect(item.querySelector("img")).toBeNull();
  });
});
