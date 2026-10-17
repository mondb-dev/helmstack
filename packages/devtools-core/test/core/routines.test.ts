import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RoutineSummary } from "../../../shared/src/index.js";
import { RoutineSpecInvalidError } from "../../src/core/routines/errors.js";
import { HelmstackCore } from "../../src/core/helmstack-core.js";
import { RoutineError, RoutineStateError } from "../../src/core/stores/routine-store.js";
import { canonical, minimal } from "../routines/fixtures.js";
import { FakeBackend } from "./fakes.js";

let dataDir: string;
let core: HelmstackCore;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "helmstack-core-routines-"));
  core = new HelmstackCore(new FakeBackend(), { dataDir, routineStore: { log: () => {} } });
});
afterEach(() => {
  core.dispose();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("HelmstackCore routines", () => {
  it("validates, stores as proposed and returns the summary with warnings", () => {
    const spec = canonical() as any;  
    delete spec.stop;
    const { routine, warnings, stepCount } = core.proposeRoutine(spec, { agentId: "agent-a" });
    expect(routine).toMatchObject({ state: "proposed", proposedBy: "agent-a", trigger: "every 6 hours", hosts: ["news.example.com"], title: spec.title });
    expect(routine.intent).toBe(spec.intent);
    expect(routine.preview.risks.map((r) => r.code)).toContain("no_stop_condition");
    expect(warnings).toEqual(expect.arrayContaining([expect.stringContaining("no stop condition")]));
    expect(warnings.some((w) => w.includes("related pages"))).toBe(false); // info flags are not warnings
    expect(stepCount).toBe(13);
    expect(core.listRoutines().map((r) => r.id)).toEqual([routine.id]);
    expect(core.getRoutine(routine.id)?.specJson).toContain('"do": "branch"');
    expect(core.getRoutine("nope")).toBeNull();
  });

  it("throws the full error list for an invalid spec and stores nothing", () => {
    const bad = canonical() as any;  
    bad.related.needs = "auto";
    bad.safety.disable_approvals = true;
    try {
      core.proposeRoutine(bad);
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RoutineSpecInvalidError);
      const paths = (err as RoutineSpecInvalidError).errors.map((e) => e.path);
      expect(paths).toEqual(["related.needs", "safety.disable_approvals"]);
    }
    expect(core.listRoutines()).toEqual([]);
  });

  it("runs the human flow and keeps every state change a core method, with events", () => {
    const changed: Array<[number, string | undefined]> = [];
    core.onRoutinesChanged((list, proposed) => changed.push([list.length, proposed?.id]));
    const agentEvents: string[] = [];
    core.onRoutineEvent((e) => agentEvents.push(`${e.type}:${e.routine.state}`));

    const { routine } = core.proposeRoutine(minimal(), { agentId: "a" });
    expect(changed).toEqual([[1, routine.id]]);
    expect(core.approveRoutine(routine.id).state).toBe("approved");
    expect(core.pauseRoutine(routine.id).state).toBe("paused");
    expect(core.resumeRoutine(routine.id).state).toBe("approved");
    expect(core.stopRoutine(routine.id).state).toBe("stopped");
    expect(core.deleteRoutine(routine.id)).toBe(true);
    expect(core.deleteRoutine(routine.id)).toBe(false);
    expect(agentEvents).toEqual(["proposed:proposed", "changed:approved", "changed:paused", "changed:approved", "changed:stopped"]);
    // `proposed` is only set on a new proposal; deletes notify the shell but not agents.
    expect(changed.map(([, p]) => p)).toEqual([routine.id, undefined, undefined, undefined, undefined, undefined]);
    expect(changed.at(-1)![0]).toBe(0);
  });

  it("illegal transitions throw clear errors", () => {
    const { routine } = core.proposeRoutine(minimal());
    expect(() => core.pauseRoutine(routine.id)).toThrow(RoutineStateError);
    expect(() => core.resumeRoutine(routine.id)).toThrow(/Can't resume a routine that is proposed/);
    core.rejectRoutine(routine.id);
    expect(() => core.approveRoutine(routine.id)).toThrow(/Can't approve a routine that is rejected/);
  });

  it("lets an agent withdraw only its own routine, only while proposed", () => {
    const mine = core.proposeRoutine(minimal(), { agentId: "a" }).routine;
    const anon = core.proposeRoutine(minimal()).routine;
    expect(() => core.withdrawRoutine(mine.id, "b")).toThrow(/different agent/);
    expect(() => core.withdrawRoutine(mine.id)).toThrow(RoutineError);
    expect(() => core.withdrawRoutine(anon.id, "a")).toThrow(/different agent/);
    expect(core.withdrawRoutine(mine.id, "a").state).toBe("rejected");
    expect(core.withdrawRoutine(anon.id).state).toBe("rejected");
    const approved = core.proposeRoutine(minimal(), { agentId: "a" }).routine;
    core.approveRoutine(approved.id);
    expect(() => core.withdrawRoutine(approved.id, "a")).toThrow(RoutineStateError);
    expect(() => core.withdrawRoutine("rt-20990101-000000-00000000", "a")).toThrow(/no longer exists/);
  });

  it("a proposal that replaces another carries a what-changed line and stops the old one on approval", () => {
    const first = core.proposeRoutine(canonical(), { agentId: "a" }).routine;
    core.approveRoutine(first.id);
    const edited = canonical() as any;  
    edited.trigger = { kind: "interval", every: "1d" };
    edited.steps[3].steps[1].accept_at = 0.9;
    const next = core.proposeRoutine(edited, { agentId: "a", replaces: first.id }).routine;
    expect(next.replaces).toBe(first.id);
    expect(next.preview.lines[0]).toMatch(/^Changed: When changed to: Every day/);
    expect(next.preview.lines.length).toBeLessThanOrEqual(10);
    expect(core.getRoutine(first.id)!.state).toBe("approved");
    core.approveRoutine(next.id);
    expect(core.getRoutine(first.id)!.state).toBe("stopped");
    expect(() => core.proposeRoutine(minimal(), { replaces: "rt-20990101-000000-00000000" })).toThrow(/no routine/);
  });

  it("refuses a 51st routine instead of deleting one", () => {
    const small = new HelmstackCore(new FakeBackend(), { dataDir: path.join(dataDir, "small"), routineStore: { maxRoutines: 2, log: () => {} } });
    try {
      small.proposeRoutine(minimal());
      small.proposeRoutine(minimal());
      expect(() => small.proposeRoutine(minimal())).toThrow(/already 2 routines/);
      expect(small.listRoutines()).toHaveLength(2);
    } finally {
      small.dispose();
    }
  });

  it("reports that nothing runs yet", () => {
    expect(core.getRoutineEngineStatus()).toEqual({ enabled: false, reason: "Routines can be reviewed and approved, but running them isn't available yet." });
  });

  it("keeps routines across a restart", () => {
    const { routine } = core.proposeRoutine(minimal(), { agentId: "a" });
    core.approveRoutine(routine.id);
    const again = new HelmstackCore(new FakeBackend(), { dataDir, routineStore: { log: () => {} } });
    try {
      expect(again.listRoutines().map((r: RoutineSummary) => [r.id, r.state])).toEqual([[routine.id, "approved"]]);
    } finally {
      again.dispose();
    }
  });

  it("contains no code that runs a routine", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = path.resolve(__dirname, "../../src/core/routines");
    const files = [...readdirSync(dir).map((f) => path.join(dir, f)), path.resolve(__dirname, "../../src/core/stores/routine-store.ts")];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      // Strip comments, then look for anything that could execute or dial out.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/child_process|\beval\(|new Function|fetch\(|http\.request|navigate\(|setInterval|setTimeout|require\(/);
    }
  });
});
