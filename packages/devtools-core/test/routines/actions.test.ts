import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RoutineActionEvent, RoutineGrants, RoutineSpec, RoutineStep } from "../../../shared/src/index.js";
import { localDay, type ActPerformRequest, type ActPerformResult, type PageState, type RoutineControl } from "../../src/core/routines/act.js";
import { RoutineEngine } from "../../src/core/routines/engine.js";
import type { RoutineBrowser } from "../../src/core/routines/executor.js";
import { ModelCallError, type InferenceModel, type ModelRequest } from "../../src/core/routines/inference.js";
import { buildPreview, triggerText } from "../../src/core/routines/preview.js";
import { parseGrants } from "../../src/core/routines/grants.js";
import { validateRoutineSpec } from "../../src/core/routines/validate.js";
import { RoutineDataStore } from "../../src/core/stores/routine-data-store.js";
import { RoutineStore } from "../../src/core/stores/routine-store.js";

const HOST = "league.example.com";
const START = `https://${HOST}/free-agents`;
const SENTINEL = "ZEBRA-PAGE-TEXT-9921";
const SECRET_VALUE = "TYPED-SECRET-5530";
const T0 = new Date(2026, 9, 17, 9, 0, 0).getTime();

class Clock {
  t = T0;
  sleeps: number[] = [];
  now = () => this.t;
  sleep = async (ms: number) => {
    this.sleeps.push(ms);
    this.t += ms;
  };
}

/** A local page model: rows with Add / Drop / Slot / Propose trade / Buy now controls. */
class Site implements RoutineBrowser {
  rows: string[] = ["Jalen Smith", "Star Player", "Mo Lee"];
  messages: string[] = [];
  performed: string[] = [];
  swallow = false;
  needsApproval: string | null = null;
  redirectAfter: string | null = null;
  beforePerform: (req: ActPerformRequest) => void = () => {};
  url = START;
  opened = 0;
  closed: string[] = [];
  async openTab() {
    this.opened += 1;
    return `tab-${this.opened}`;
  }
  async navigate(_t: string, url: string) {
    this.url = url;
    return { url };
  }
  async collect() {
    return {
      url: this.url,
      title: "Free agents",
      page: { title: "Free agents", url: this.url },
      structured: this.rows.map((n, i) => ({ title: n, url: `https://${HOST}/p/${i}` })),
      blocks: []
    };
  }
  async closeTab(t: string) {
    this.closed.push(t);
  }
  async controls(): Promise<RoutineControl[]> {
    const out: RoutineControl[] = [];
    for (const n of this.rows) {
      const context = `${n} Guard ${SENTINEL}`;
      out.push({ id: `add:${n}`, role: "button", name: "Add", context, disabled: false });
      out.push({ id: `drop:${n}`, role: "button", name: "Drop", context, disabled: false });
      out.push({ id: `trade:${n}`, role: "button", name: "Propose trade", context, disabled: false });
      out.push({ id: `buy:${n}`, role: "button", name: "Buy now", context, disabled: false });
      out.push({ id: `slot:${n}`, role: "combobox", name: "Slot", context, disabled: false });
      out.push({ id: `note:${n}`, role: "textbox", name: "Note", context, disabled: false });
    }
    return out;
  }
  async perform(_t: string, req: ActPerformRequest): Promise<ActPerformResult> {
    this.beforePerform(req);
    const [kind, ...rest] = req.controlId.split(":");
    const name = rest.join(":");
    if (!this.rows.includes(name)) return { status: "failed", reason: "The control is no longer on the page." };
    if (this.needsApproval === req.controlId) return { status: "needs_approval", kinds: ["sharing personal data"] };
    this.performed.push(`${req.action}:${req.controlId}${req.value !== undefined ? `=${req.value}` : ""}`);
    if (this.redirectAfter) this.url = this.redirectAfter;
    if (this.swallow) return { status: "done" };
    if (kind === "add") this.messages.push(`${name} added to your team`);
    if (kind === "drop") {
      this.rows = this.rows.filter((r) => r !== name);
      this.messages.push(`${name} dropped`);
    }
    if (kind === "slot") this.messages.push(`${name} moved to ${req.value}`);
    if (kind === "trade") this.messages.push(`offer sent for ${name}`);
    if (kind === "buy") this.messages.push(`bought ${name}`);
    if (kind === "note") this.messages.push(`note saved for ${name}`);
    return { status: "done" };
  }
  async pageState(): Promise<PageState> {
    return { url: this.url, text: [...this.rows, ...this.messages].join("\n") };
  }
}

const NAME_FIELDS = { name: "text<=80" } as const;

type ActOver = Record<string, unknown>;

function mk(act: ActOver, extra: Partial<RoutineSpec> = {}, after: RoutineStep[] = []): RoutineSpec {
  const s = {
    version: 1,
    title: "Roster upkeep",
    intent: "Keep my roster in shape.",
    scope: { start: [START], follow: { allow_hosts: [HOST], max_depth: 1 }, max_pages_per_run: 5 },
    trigger: { kind: "manual" },
    state: { notes: "log" },
    steps: [
      { do: "open", url: "$scope.start[0]" },
      { do: "locate", id: "list", target: "players", strategies: ["structured_data"], min_confidence: 0.6, on_low: "fail" },
      {
        do: "for_each",
        items: "$list",
        limit: 3,
        steps: [
          { do: "extract", id: "p", fields: NAME_FIELDS, strategies: ["structured_data"], from: "$item" },
          {
            do: "act",
            action: "click",
            effect: "add_item",
            target: "the Add button in this player's row",
            strategies: ["repeating_blocks"],
            min_confidence: 0.8,
            on_low: "skip",
            subject: "$p",
            verify: { present: ["added to your team"] },
            ...act
          }
        ]
      },
      ...after
    ],
    ...extra
  } as unknown as RoutineSpec;
  const checked = validateRoutineSpec(s);
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  return s;
}

const auto = (effects: RoutineGrants["effects"], protect: string[] = []): RoutineGrants => ({ effects, protect });
const ADD_AUTO = auto({ add_item: { mode: "auto", perRun: 5, perDay: 10 } });

let dir: string;
let clock: Clock;
let site: Site;
let store: RoutineStore;
let data: RoutineDataStore;
let engine: RoutineEngine;
let events: RoutineActionEvent[];

function build(model?: InferenceModel): RoutineEngine {
  const e = new RoutineEngine({
    routines: store,
    data,
    browser: site,
    fetchRobots: async () => ({ status: 404, text: "" }),
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0.5,
    log: () => {},
    ...(model ? { model: { resolve: async () => ({ ok: true as const, model }) } } : {})
  });
  store.onEvent((event) => {
    if (event.type === "changed") e.handleRoutineChanged(event.routine);
    else if (event.type === "deleted") e.handleRoutineDeleted(event.routine);
  });
  e.actions.onChanged((ev) => events.push(ev));
  return e;
}

function add(spec: RoutineSpec, grants?: RoutineGrants): string {
  const r = store.propose({ spec, preview: buildPreview(spec), trigger: triggerText(spec.trigger) });
  if (grants) data.writeGrants(r.id, grants);
  store.transition(r.id, "approve");
  return r.id;
}

async function run(id: string) {
  engine.runNow(id);
  await engine.whenIdle();
  return engine.listRuns(id)[0]!;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "helmstack-actions-"));
  clock = new Clock();
  site = new Site();
  events = [];
  store = new RoutineStore(dir, { log: () => {}, now: clock.now });
  data = new RoutineDataStore(dir, { log: () => {}, now: clock.now });
  engine = build();
});
afterEach(() => {
  engine.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const actions = (id: string) => engine.actions.list(id);

describe("grants", () => {
  it("accepts a sane set, fills limits for auto and drops duplicate names", () => {
    const r = parseGrants({ effects: { add_item: { mode: "auto" }, offer: { mode: "ask" } }, protect: [" Star ", "star", "Other"] });
    expect(r).toEqual({ ok: true, grants: { effects: { add_item: { mode: "auto", perRun: 5, perDay: 10 }, offer: { mode: "ask" } }, protect: ["Star", "Other"] } });
  });

  it.each([
    [{ effects: { offer: { mode: "auto" } } }],
    [{ effects: { respond: { mode: "auto" } } }],
    [{ effects: { other: { mode: "auto" } } }],
    [{ effects: { add_item: { mode: "auto", perDay: 0 } } }],
    [{ effects: { add_item: { mode: "auto", perRun: 51 } } }],
    [{ effects: { add_item: { mode: "auto", perRun: 1.5 } } }],
    [{ effects: { add_item: { mode: "yes" } } }],
    [{ effects: { add_item: { mode: "auto", extra: 1 } } }],
    [{ effects: { buy: { mode: "ask" } } }],
    [{ protect: Array.from({ length: 51 }, (_, i) => `n${i}`) }],
    [{ protect: ["x".repeat(81)] }],
    [{ protect: [""] }],
    [{ protect: ["a\u0007b"] }],
    [{ other: 1 }],
    [null],
    [[]]
  ])("rejects %j", (bad) => {
    expect(parseGrants(bad).ok).toBe(false);
  });

  it("stores grants with owner-only permissions, defaults to nothing, and never applies the spec's request", async () => {
    const spec = mk({}, { actions: { request: { add_item: { mode: "auto", per_run: 3 } } } });
    const id = add(spec);
    expect(data.readGrants(id)).toEqual({ effects: {}, protect: [] });
    const run1 = await run(id);
    expect(run1.status).toBe("needs_human");
    expect(site.performed).toEqual([]);
    engine.actions.setGrants(id, ADD_AUTO);
    const file = path.join(dir, "routines", id, "grants.json");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(() => engine.actions.setGrants(id, { effects: { offer: { mode: "auto" } }, protect: [] })).toThrow();
    expect(data.readGrants(id)).toEqual({ effects: { add_item: { mode: "auto", perRun: 5, perDay: 10 } }, protect: [] });
    // a hand-edited file that tries auto offers is ignored as a whole
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.grants.effects.offer = { mode: "auto" };
    writeFileSync(file, JSON.stringify(raw));
    expect(data.readGrants(id)).toEqual({ effects: {}, protect: [] });
  });
});

describe("spec and preview", () => {
  it("flags acts_on_account, requests_auto and no_protect_list and describes the actions in plain words", () => {
    const spec = mk(
      { effect: "remove_item", target: "the Drop button in this player's row" },
      { actions: { request: { remove_item: { mode: "auto", per_run: 1 } } } }
    );
    const p = buildPreview(spec);
    const codes = p.risks.map((r) => `${r.level}:${r.code}`);
    expect(codes).toEqual(expect.arrayContaining(["high:acts_on_account", "warning:requests_auto", "warning:no_protect_list"]));
    const line = p.lines.find((l) => l.startsWith("Actions:"))!;
    expect(line).toContain(`May change things on ${HOST}`);
    expect(line).toContain("asks you first unless you allow it");
    expect(line).toContain("remove items (1 per run)");
    const protectedSpec = mk({ effect: "remove_item", target: "the Drop button" }, { actions: { protect: ["Star Player"] } });
    const q = buildPreview(protectedSpec);
    expect(q.risks.map((r) => r.code)).not.toContain("no_protect_list");
    expect(q.risks.map((r) => r.code)).not.toContain("requests_auto");
    expect(q.lines.find((l) => l.startsWith("Actions:"))).toContain("Star Player");
    expect(buildPreview(mk({}, {})).lines.length).toBeLessThanOrEqual(11);
  });
});

describe("running actions", () => {
  it("with no grant every action waits: pending, run needs_human, nothing touched, routine stays approved", async () => {
    const id = add(mk({}));
    const r = await run(id);
    expect(r.status).toBe("needs_human");
    expect(r.summary).toContain("Waiting for you to approve 3 actions");
    expect(site.performed).toEqual([]);
    const list = actions(id);
    expect(list).toHaveLength(3);
    expect(list.every((a) => a.status === "pending" && a.effect === "add_item")).toBe(true);
    expect(list.map((a) => a.description)).toContain(`Click "Add" for Jalen Smith on ${HOST}.`);
    expect(store.get(id)!.state).toBe("approved");
    expect(JSON.stringify(list)).not.toContain("secret");
  });

  it("with an auto grant the add is done and verified, by grant", async () => {
    const id = add(mk({}), ADD_AUTO);
    const r = await run(id);
    expect(r.status).toBe("completed");
    expect(site.performed).toEqual(["click:add:Jalen Smith", "click:add:Star Player", "click:add:Mo Lee"]);
    expect(actions(id).map((a) => [a.status, a.allowedBy])).toEqual([["done", "grant"], ["done", "grant"], ["done", "grant"]]);
  });

  it("spaces automatic actions at least two seconds apart", async () => {
    const id = add(mk({}), ADD_AUTO);
    await run(id);
    expect(clock.sleeps.filter((s) => s >= 1900 && s <= 2000).length).toBeGreaterThanOrEqual(2);
  });

  it("(c) the protect list blocks even with an auto grant, never asks, and the rest of the run goes on", async () => {
    const spec = mk({ effect: "remove_item", target: "the Drop button in this player's row", verify: { present: ["dropped"] } });
    const id = add(spec, auto({ remove_item: { mode: "auto", perRun: 5, perDay: 10 } }, ["star player"]));
    const r = await run(id);
    expect(r.status).toBe("completed");
    expect(site.performed).toEqual(["click:drop:Jalen Smith", "click:drop:Mo Lee"]);
    const blocked = actions(id).filter((a) => a.status === "blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.subject).toBe("Star Player");
    expect(actions(id).some((a) => a.status === "pending")).toBe(false);
  });

  it("the spec's own protect list also blocks, and a substring either way matches", async () => {
    const spec = mk({ effect: "remove_item", target: "the Drop button in this player's row", verify: { present: ["dropped"] } }, { actions: { protect: ["Mo Lee Jr."] } });
    const id = add(spec, auto({ remove_item: { mode: "auto" } }));
    await run(id);
    expect(site.performed).not.toContain("click:drop:Mo Lee");
    expect(actions(id).find((a) => a.subject === "Mo Lee")!.status).toBe("blocked");
  });

  it("rearranging into the bench is protected; adding is not", async () => {
    const slot = mk({ action: "select", effect: "rearrange", target: "the Slot menu in this player's row", value: "Bench", verify: { present: ["moved to Bench"] } });
    const id = add(slot, auto({ rearrange: { mode: "auto", perRun: 5, perDay: 10 }, add_item: { mode: "auto" } }, ["Star Player"]));
    await run(id);
    expect(site.performed).toEqual(["select:slot:Jalen Smith=Bench", "select:slot:Mo Lee=Bench"]);
    const to = mk({ action: "select", effect: "rearrange", target: "the Slot menu in this player's row", value: "Starter", verify: { present: ["moved to Starter"] } });
    site = new Site();
    engine.dispose();
    engine = build();
    const id2 = add(to, auto({ rearrange: { mode: "auto", perRun: 5, perDay: 10 } }, ["Star Player"]));
    await run(id2);
    expect(site.performed).toContain("select:slot:Star Player=Starter");
  });

  it.each(["offer", "respond", "other"] as const)("(d) %s always waits, even with every grant", async (effect) => {
    const id = add(mk({ effect, target: "the Propose trade button in this player's row", verify: { present: ["offer sent"] } }), auto({ add_item: { mode: "auto" }, rearrange: { mode: "auto" }, remove_item: { mode: "auto" } }));
    const r = await run(id);
    expect(r.status).toBe("needs_human");
    expect(site.performed).toEqual([]);
    expect(actions(id).every((a) => a.status === "pending")).toBe(true);
    expect(actions(id)[0]!.note).toContain("always wait for you");
  });

  it("(e) perRun caps the automatic attempts; the rest wait", async () => {
    const id = add(mk({}), auto({ add_item: { mode: "auto", perRun: 1, perDay: 10 } }));
    const r = await run(id);
    expect(site.performed).toEqual(["click:add:Jalen Smith"]);
    expect(r.status).toBe("needs_human");
    const byStatus = actions(id).map((a) => a.status).sort();
    expect(byStatus).toEqual(["done", "pending", "pending"]);
    expect(actions(id).filter((a) => a.status === "pending").map((a) => a.note).join(" ")).toContain("per run");
  });

  it("(e) perDay is per calendar day, persisted across an engine restart, and counts attempts", async () => {
    const id = add(mk({}), auto({ add_item: { mode: "auto", perRun: 5, perDay: 2 } }));
    await run(id);
    expect(site.performed).toHaveLength(2);
    engine.dispose();
    engine = build();
    site.messages = [];
    const r2 = await run(id);
    expect(site.performed).toHaveLength(2); // nothing more today
    expect(r2.status).toBe("needs_human");
    expect(JSON.parse(readFileSync(path.join(dir, "routines", id, "action-counters.json"), "utf8"))).toMatchObject({ day: localDay(clock.t), counts: { add_item: 2 } });
    clock.t += 24 * 3_600_000;
    engine.dispose();
    engine = build();
    await run(id);
    expect(site.performed.length).toBe(4);
  });

  it("(e) an attempt that fails still counts against the day", async () => {
    site.swallow = true;
    const id = add(mk({}), auto({ add_item: { mode: "auto", perRun: 5, perDay: 1 } }));
    const r = await run(id);
    expect(r.status).toBe("failed");
    expect(JSON.parse(readFileSync(path.join(dir, "routines", id, "action-counters.json"), "utf8")).counts.add_item).toBe(1);
  });

  it("a change to the grants applies to the very next action of the same run", async () => {
    site.beforePerform = () => {
      engine.actions.setGrants(id, { effects: { add_item: { mode: "ask" } }, protect: [] });
    };
    const id = add(mk({}), ADD_AUTO);
    const r = await run(id);
    expect(site.performed).toEqual(["click:add:Jalen Smith"]);
    expect(r.status).toBe("needs_human");
    expect(actions(id).filter((a) => a.status === "pending")).toHaveLength(2);
  });

  it("(f) HelmStack's own always-ask is never auto: a control named like a purchase waits whatever was granted", async () => {
    const id = add(mk({ target: "the Buy now button in this player's row", verify: { present: ["bought"] } }), ADD_AUTO);
    const r = await run(id);
    expect(r.status).toBe("needs_human");
    expect(site.performed).toEqual([]);
    expect(actions(id).find((a) => a.subject === "Jalen Smith")!.note).toContain("HelmStack always asks");
  });

  it("(f) when the command pipeline reports it needs its own approval, the action becomes pending and nothing is auto-resolved", async () => {
    site.needsApproval = "add:Jalen Smith";
    const id = add(mk({}), ADD_AUTO);
    const r = await run(id);
    expect(r.status).toBe("needs_human");
    expect(site.performed).not.toContain("click:add:Jalen Smith");
    const first = actions(id).find((a) => a.subject === "Jalen Smith")!;
    expect(first.status).toBe("pending");
    expect(first.note).toContain("HelmStack asks for its own approval");
    expect(first.note).toContain("sharing personal data");
  });

  it("once one action waits, later automatic ones in the same run wait behind it", async () => {
    site.needsApproval = "add:Jalen Smith";
    const id = add(mk({}), ADD_AUTO);
    await run(id);
    expect(site.performed).toEqual([]);
    expect(actions(id).every((a) => a.status === "pending")).toBe(true);
  });

  it("(g) a failed verify fails the action and the run, pauses the routine at once, and is not retried", async () => {
    site.swallow = true;
    const spec = mk({}, { on_failure: { retries: 3, backoff: "fixed", pause_after: 10, notify: true } });
    const id = add(spec, ADD_AUTO);
    const r = await run(id);
    expect(r.status).toBe("failed");
    expect(site.performed).toEqual(["click:add:Jalen Smith"]);
    expect(store.get(id)!.state).toBe("paused");
    expect(actions(id).map((a) => a.status)).toEqual(["failed"]);
    expect(engine.getRun(id, r.id)!.log.some((l) => l.message.includes("Paused at once"))).toBe(true);
  });

  it("a redirect outside the scope after the click fails the action and pauses", async () => {
    site.redirectAfter = "https://elsewhere.example.net/landing";
    const id = add(mk({}), ADD_AUTO);
    const r = await run(id);
    expect(r.status).toBe("failed");
    expect(store.get(id)!.state).toBe("paused");
    expect(actions(id)[0]!.note).toContain("outside the routine's scope");
  });

  it("a control that cannot be found follows on_low and does nothing", async () => {
    const id = add(mk({ target: "the Teleport button in this player's row", on_low: "skip" }), ADD_AUTO);
    expect((await run(id)).status).toBe("completed");
    expect(site.performed).toEqual([]);
    const id2 = add(mk({ target: "the Teleport button in this player's row", on_low: "ask_human" }), ADD_AUTO);
    expect((await run(id2)).status).toBe("needs_human");
    const id3 = add(mk({ target: "the Teleport button in this player's row", on_low: "fail" }), ADD_AUTO);
    expect((await run(id3)).status).toBe("failed");
    expect(site.performed).toEqual([]);
  });

  it("an ambiguous match is not guessed", async () => {
    const id = add(mk({ subject: undefined, strategies: ["structured_data"] }), ADD_AUTO);
    await run(id);
    expect(site.performed).toEqual([]);
  });

  it("the model can only pick from the numbered list, and its quote must come from the chosen entry", async () => {
    const answerWith = (value: string, quote: (subject: string) => string): InferenceModel => ({
      label: "fake",
      local: true,
      async complete(req: ModelRequest) {
        const subject = /for "([^"]*)"/.exec(req.user)?.[1] ?? "";
        return JSON.stringify({ value, confidence: 0.95, evidence: quote(subject) });
      }
    });
    const target = "the control that puts this player on my team";
    const spec = mk({ target, strategies: ["infer"], min_confidence: 0.8 });
    engine.dispose();
    engine = build(answerWith("1", (subject) => `button "Add" in: ${subject}`));
    await run(add(spec, ADD_AUTO));
    expect(site.performed).toEqual(["click:add:Jalen Smith", "click:add:Star Player", "click:add:Mo Lee"]);
    // a quote that is not in the chosen entry is refused
    site.performed = [];
    engine.dispose();
    engine = build(answerWith("1", () => "Mallory Guard"));
    await run(add(spec, ADD_AUTO));
    // "none", an out-of-range number and a failing model all do nothing
    const failing = { label: "x", local: true, complete: async () => { throw new ModelCallError("down", "failed"); } } as InferenceModel;
    for (const m of [answerWith("none", () => "x"), answerWith("99", () => "x"), failing]) {
      engine.dispose();
      engine = build(m);
      await run(add(spec, ADD_AUTO));
    }
    expect(site.performed).toEqual([]);
  });

  it("an act with no model and only infer needs a person", async () => {
    const id = add(mk({ target: "the control that puts this player on my team", strategies: ["infer"] }), ADD_AUTO);
    expect((await run(id)).status).toBe("needs_human");
    expect(site.performed).toEqual([]);
  });
});

describe("pending actions", () => {
  it("expire after 12 hours and an expired action never runs", async () => {
    const id = add(mk({}));
    await run(id);
    const a = actions(id)[0]!;
    expect(a.expiresAt - a.createdAt).toBe(12 * 3_600_000);
    clock.t += 12 * 3_600_000 + 1;
    expect(actions(id).every((x) => x.status === "expired")).toBe(true);
    await expect(engine.actions.approve(id, a.id)).rejects.toThrow(/expired/);
    expect(site.performed).toEqual([]);
  });

  it("approve performs it, records the human, and re-checks everything", async () => {
    const id = add(mk({}));
    await run(id);
    const a = actions(id).find((x) => x.subject === "Mo Lee")!;
    const done = await engine.actions.approve(id, a.id);
    expect(done).toMatchObject({ status: "done", allowedBy: "human" });
    expect(site.performed).toEqual(["click:add:Mo Lee"]);
    await expect(engine.actions.approve(id, a.id)).rejects.toThrow(/already done/);
    expect(() => engine.actions.decline(id, a.id)).toThrow();
    await expect(engine.actions.approve(id, "act-zzzz-abcd")).rejects.toThrow(/no longer exists/);
    await expect(engine.actions.approve(id, "nonsense")).rejects.toThrow(/invalid action id/);
  });

  it("approve fails safely when the page changed: nothing is done", async () => {
    const id = add(mk({}));
    await run(id);
    const a = actions(id).find((x) => x.subject === "Mo Lee")!;
    site.rows = site.rows.filter((r) => r !== "Mo Lee");
    const res = await engine.actions.approve(id, a.id);
    expect(res.status).toBe("failed");
    expect(res.note).toBe("The page changed, ask again next run.");
    expect(site.performed).toEqual([]);
  });

  it("approve whose result does not show fails and pauses the routine; its tab is always closed", async () => {
    const id = add(mk({}));
    await run(id);
    site.swallow = true;
    const before = site.closed.length;
    const res = await engine.actions.approve(id, actions(id)[0]!.id);
    expect(res.status).toBe("failed");
    expect(store.get(id)!.state).toBe("paused");
    expect(site.closed.length).toBeGreaterThan(before);
  });

  it("approve re-applies the protect list", async () => {
    const id = add(mk({ effect: "remove_item", target: "the Drop button in this player's row", verify: { present: ["dropped"] } }));
    await run(id);
    const a = actions(id).find((x) => x.subject === "Star Player")!;
    engine.actions.setGrants(id, { effects: {}, protect: ["Star"] });
    expect((await engine.actions.approve(id, a.id)).status).toBe("blocked");
    expect(site.performed).toEqual([]);
  });

  it("decline marks it declined and unknown, expired or already-decided actions are rejected", async () => {
    const id = add(mk({}));
    await run(id);
    const a = actions(id)[0]!;
    expect(engine.actions.decline(id, a.id).status).toBe("declined");
    expect(() => engine.actions.decline(id, a.id)).toThrow(/already declined/);
    expect(() => engine.actions.decline(id, "act-aaaa-bbbb")).toThrow(/no longer exists/);
  });

  it("the kill switch, pausing and deleting drop what waits and cancel what is running", async () => {
    const id = add(mk({}));
    await run(id);
    engine.setKillSwitch(true);
    expect(actions(id).every((a) => a.status === "expired")).toBe(true);
    await expect(engine.actions.approve(id, actions(id)[0]!.id)).rejects.toThrow();
    engine.setKillSwitch(false);

    const id2 = add(mk({}));
    await run(id2);
    store.transition(id2, "pause");
    expect(actions(id2).every((a) => a.status === "expired")).toBe(true);
    store.transition(id2, "resume");
    expect(actions(id2).every((a) => a.status === "expired")).toBe(true);

    const id3 = add(mk({}));
    await run(id3);
    const target = actions(id3)[0]!;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    site.beforePerform = () => {};
    const slowNavigate = site.navigate.bind(site);
    site.navigate = async (t, u) => {
      await gate;
      return slowNavigate(t, u);
    };
    const pending = engine.actions.approve(id3, target.id);
    await Promise.resolve();
    engine.setKillSwitch(true);
    release();
    const res = await pending;
    expect(res.status).toBe("failed");
    expect(site.performed).toEqual([]);
    engine.setKillSwitch(false);
    store.delete(id3);
    expect(readdirSync(dir).some((n) => n === "routines")).toBe(true);
  });

  it("keeps the newest 100 and survives a restart", async () => {
    const id = add(mk({}));
    for (let i = 0; i < 40; i += 1) {
      clock.t += 1000;
      await run(id);
    }
    expect(actions(id).length).toBe(100);
    engine.dispose();
    engine = build();
    expect(actions(id).length).toBe(100);
  });

  it("an action left running by a crash is marked failed at the next start", async () => {
    const id = add(mk({}));
    await run(id);
    const stored = data.readActions(id);
    stored[0]!.status = "approved";
    data.writeActions(id, stored);
    engine.dispose();
    engine = build();
    engine.start();
    expect(actions(id).find((a) => a.id === stored[0]!.id)!.status).toBe("failed");
  });
});

describe("what is logged and broadcast", () => {
  it("never contains page text beyond the fixed description, and never a typed value", async () => {
    const spec = mk({ action: "fill", effect: "other", target: "the Note field in this player's row", value: SECRET_VALUE, verify: { present: ["note saved"] } });
    const grants = auto({ add_item: { mode: "auto" } });
    const id = add(spec, grants);
    const r = await run(id);
    expect(r.status).toBe("needs_human");
    const everything = JSON.stringify([engine.getRun(id, r.id), actions(id), events, engine.listRuns(id)]);
    expect(everything).not.toContain(SECRET_VALUE);
    expect(everything).not.toContain(SENTINEL);
    expect(actions(id)[0]!.description).toContain(`${SECRET_VALUE.length} characters`);
    // after a human approves, still nothing leaks
    await engine.actions.approve(id, actions(id)[0]!.id);
    const after = JSON.stringify([engine.getRun(id, r.id), actions(id), events]);
    expect(after).not.toContain(SECRET_VALUE);
    expect(after).not.toContain(SENTINEL);
    expect(site.performed.some((p) => p.includes(SECRET_VALUE))).toBe(true);
    // events carry ids and words only
    for (const e of events) expect(Object.keys(e).sort()).toEqual(["actionId", "effect", "routineId", "status"]);
    // a finished action keeps no copy of what it needed to be redone
    const onDisk = readFileSync(path.join(dir, "routines", id, "actions.json"), "utf8");
    expect(onDisk.split(SECRET_VALUE).length - 1).toBeLessThanOrEqual(2); // only the two still-waiting actions keep it
  });
});
