import { describe, expect, it } from "vitest";

import type { RoutineSpec } from "../../../shared/src/index.js";
import { assessRisks, buildPreview, countSteps, diffPreviews, triggerText } from "../../src/core/routines/preview.js";
import { scopeHosts } from "../../src/core/routines/scope.js";
import { canonical, minimal } from "./fixtures.js";

const codes = (spec: RoutineSpec): string[] => assessRisks(spec).map((r) => r.code);
const edit = (base: RoutineSpec, fn: (s: any) => void): RoutineSpec => {  
  const s = structuredClone(base);
  fn(s);
  return s;
};

describe("buildPreview", () => {
  it("describes the canonical routine in 5 to 10 plain bullets with the real numbers", () => {
    const p = buildPreview(canonical());
    expect(p.headline).toBe("Check news.example.com every 6 hours and note anything new.");
    expect(p.lines.length).toBeGreaterThanOrEqual(5);
    expect(p.lines.length).toBeLessThanOrEqual(10);
    const text = p.lines.join("\n");
    expect(text).toContain("When: Every 6 hours, each run shifted by up to 10%, only between 07:00 and 23:00.");
    expect(text).toContain("news.example.com");
    expect(text).toContain("up to 30 pages per run");
    expect(text).toContain("accepts when the score is 0.7 or higher and rejects below 0.3");
    expect(text).toContain("in between it is uncertain and is noted as a maybe");
    expect(text).toContain("Asked 3 times; must quote the page as evidence");
    expect(text).toContain("needs your approval before it is added");
    expect(text).toContain("after 30 days, after 120 runs, or when it judges");
    expect(text).toContain("200,000 tokens, 30 pages, 20 minutes per run; $5 in total");
    expect(text).toContain("never types passwords or uses saved logins");
    expect(text).toContain("tags: update, maybe");
    expect(text).not.toMatch(/undefined|NaN|\[object/);
  });

  it("is deterministic and does not depend on key order", () => {
    const a = canonical();
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as RoutineSpec;
    expect(buildPreview(a)).toEqual(buildPreview(canonical()));
    expect(buildPreview(reordered)).toEqual(buildPreview(a));
  });

  it("stays within 10 lines for a spec with many judgments, and keeps every threshold visible", () => {
    const spec = edit(canonical(), (s) => {
      for (let i = 0; i < 4; i += 1) {
        s.steps[3].steps.push({ do: "infer", id: `extra${i}`, question: `Extra question ${i}?`, output: "bool", accept_at: 0.8, reject_below: 0.1 + i / 100, on_uncertain: "skip" });
      }
    });
    const p = buildPreview(spec);
    expect(p.lines.length).toBeLessThanOrEqual(10);
    for (let i = 0; i < 4; i += 1) expect(p.lines.join("\n")).toContain(`Extra question ${i}?`);
    const withChanges = buildPreview(spec, { changes: ["Something changed."] });
    expect(withChanges.lines.length).toBeLessThanOrEqual(10);
    expect(withChanges.lines[0]).toBe("Changed: Something changed.");
  });

  it("says plainly when there is no stop condition, no judgment, or no note", () => {
    const p = buildPreview(minimal());
    expect(p.lines.join("\n")).toContain("No stop condition: it keeps running until you stop it.");
    expect(p.lines.join("\n")).toContain("It makes no judgments");
    expect(p.lines.join("\n")).toContain("None of its steps records a note.");
    expect(p.headline).toBe("Check example.com when you start it and report what it finds.");
    expect(p.lines.length).toBeGreaterThanOrEqual(5);
  });

  it("derives the trigger text and hosts for the summary", () => {
    expect(triggerText({ kind: "manual" })).toBe("manual");
    expect(triggerText({ kind: "interval", every: "30m" })).toBe("every 30 minutes");
    expect(triggerText({ kind: "interval", every: "1h" })).toBe("every hour");
    expect(triggerText({ kind: "interval", every: "1d" })).toBe("every day");
    expect(triggerText({ kind: "interval", every: "6h" })).toBe("every 6 hours");
    expect(triggerText({ kind: "schedule", cron: "0 9 * * 1-5" })).toBe("weekdays at 09:00");
    expect(triggerText({ kind: "schedule", cron: "30 8 * * *", timezone: "UTC" })).toBe("every day at 08:30 (UTC)");
    expect(triggerText({ kind: "schedule", cron: "0 9 * * 1" })).toBe("every Monday at 09:00");
    expect(triggerText({ kind: "schedule", cron: "0 9 * * 6,0" })).toBe("weekends at 09:00");
    expect(triggerText({ kind: "schedule", cron: "*/15 * * * *" })).toBe("every 15 minutes");
    expect(triggerText({ kind: "schedule", cron: "15 * * * *" })).toBe("every hour at :15");
    expect(triggerText({ kind: "schedule", cron: "0 9 15 * *" })).toBe("on day 15 of every month at 09:00");
    expect(triggerText({ kind: "schedule", cron: "0 9 1 6 *" })).toBe('on the schedule "0 9 1 6 *"');
    expect(triggerText({ kind: "event", watch: "price < 10" })).toBe("when a watch fires: price < 10");
    expect(scopeHosts(canonical().scope)).toEqual(["news.example.com"]);
    expect(scopeHosts(edit(canonical(), (s) => { s.scope.follow = { allow_hosts: ["*.example.org"], max_depth: 1 }; }).scope)).toEqual(["news.example.com", "*.example.org"]);
    expect(scopeHosts(edit(canonical(), (s) => { s.scope.follow = {}; }).scope)).toEqual([]);
  });
});

describe("risk flags", () => {
  it("flags nothing serious on the canonical routine, only the informational ones", () => {
    const risks = assessRisks(canonical());
    expect(risks.map((r) => r.code)).toEqual(["judged_by_model", "related_widens_scope"]);
    expect(risks.every((r) => r.level === "info")).toBe(true);
  });

  it("any_site (high): link-following with no allow-list and same_site off", () => {
    const open = edit(canonical(), (s) => { s.scope.follow = { same_site: false, max_depth: 2 }; });
    expect(assessRisks(open)[0]).toMatchObject({ level: "high", code: "any_site" });
    expect(codes(edit(canonical(), (s) => { s.scope.follow = {}; }))).toContain("any_site");
    expect(codes(edit(canonical(), (s) => { delete s.scope.follow; }))).toContain("any_site");
    // Not open: depth 0, an allow-list, or same_site.
    expect(codes(edit(canonical(), (s) => { s.scope.follow = { max_depth: 0 }; }))).not.toContain("any_site");
    expect(codes(edit(canonical(), (s) => { s.scope.follow = { allow_hosts: ["a.example.org"] }; }))).not.toContain("any_site");
    expect(codes(canonical())).not.toContain("any_site");
  });

  it("no_stop_condition and no_budgets (warnings)", () => {
    const bare = edit(canonical(), (s) => { delete s.stop; });
    expect(assessRisks(bare).find((r) => r.code === "no_stop_condition")).toMatchObject({ level: "warning", message: "This routine has no stop condition and will keep running until you stop it." });
    expect(assessRisks(bare).find((r) => r.code === "no_budgets")?.level).toBe("warning");
    expect(codes(edit(canonical(), (s) => { s.stop.any = []; }))).toContain("no_stop_condition");
    expect(codes(edit(canonical(), (s) => { s.stop.budgets = {}; }))).toContain("no_budgets");
    expect(codes(canonical())).not.toContain("no_budgets");
  });

  it("fast_interval (warning) for intervals and cron under 5 minutes", () => {
    expect(codes(edit(canonical(), (s) => { s.trigger = { kind: "interval", every: "4m" }; }))).toContain("fast_interval");
    expect(codes(edit(canonical(), (s) => { s.trigger = { kind: "interval", every: "5m" }; }))).not.toContain("fast_interval");
    expect(codes(edit(canonical(), (s) => { s.trigger = { kind: "schedule", cron: "* * * * *" }; }))).toContain("fast_interval");
    expect(codes(edit(canonical(), (s) => { s.trigger = { kind: "schedule", cron: "*/2 * * * *" }; }))).toContain("fast_interval");
    expect(codes(edit(canonical(), (s) => { s.trigger = { kind: "schedule", cron: "*/10 * * * *" }; }))).not.toContain("fast_interval");
    expect(codes(edit(canonical(), (s) => { s.trigger = { kind: "schedule", cron: "0 9 * * *" }; }))).not.toContain("fast_interval");
  });

  it("many_pages (info) above 50 per run", () => {
    expect(assessRisks(edit(canonical(), (s) => { s.scope.max_pages_per_run = 51; })).find((r) => r.code === "many_pages")?.level).toBe("info");
    expect(codes(edit(canonical(), (s) => { s.scope.max_pages_per_run = 50; }))).not.toContain("many_pages");
  });

  it("low_accept_threshold (warning) below 0.5, on a judgment or on related", () => {
    expect(assessRisks(edit(canonical(), (s) => { s.steps[3].steps[1].accept_at = 0.4; })).find((r) => r.code === "low_accept_threshold")?.level).toBe("warning");
    expect(codes(edit(canonical(), (s) => { s.related.accept_at = 0.2; }))).toContain("low_accept_threshold");
    expect(codes(edit(canonical(), (s) => { s.steps[3].steps[1].accept_at = 0.5; }))).not.toContain("low_accept_threshold");
  });

  it("no_evidence_check (info) only when evidence is explicitly none", () => {
    expect(codes(edit(canonical(), (s) => { s.steps[3].steps[1].evidence = "none"; }))).toContain("no_evidence_check");
    expect(codes(edit(canonical(), (s) => { delete s.steps[3].steps[1].evidence; }))).not.toContain("no_evidence_check");
  });

  it("event_trigger_unverified", () => {
    expect(codes(edit(canonical(), (s) => { s.trigger = { kind: "event", watch: "x" }; }))).toContain("event_trigger_unverified");
  });

  it("no_human_fallback (info) when every uncertain outcome is skip", () => {
    const skipAll = edit(canonical(), (s) => {
      s.steps[3].steps[1].on_uncertain = "skip";
      s.steps[3].steps[2].accept[0].on_uncertain = "skip";
    });
    expect(assessRisks(skipAll).find((r) => r.code === "no_human_fallback")?.level).toBe("info");
    const oneAsks = edit(skipAll, (s) => { s.steps[3].steps[1].on_uncertain = "ask_human"; });
    expect(codes(oneAsks)).not.toContain("no_human_fallback");
    expect(codes(minimal())).not.toContain("no_human_fallback");
  });

  it("judged_by_model (info) whenever a judgment or an inferred stop condition exists", () => {
    expect(assessRisks(canonical()).find((r) => r.code === "judged_by_model")?.level).toBe("info");
    expect(codes(minimal())).not.toContain("judged_by_model");
    const stopOnly = edit(minimal(), (s) => {
      s.stop = { any: [{ when_inferred: "The topic is resolved", confidence: 0.9 }] };
    });
    expect(codes(stopOnly)).toContain("judged_by_model");
    expect(assessRisks(canonical()).find((r) => r.code === "judged_by_model")?.message).toMatch(/no tools/);
  });

  it("related_widens_scope (info)", () => {
    expect(codes(canonical())).toContain("related_widens_scope");
    expect(codes(edit(canonical(), (s) => { delete s.related; }))).not.toContain("related_widens_scope");
  });

  it("has_login_hint (warning) for login, account or checkout pages", () => {
    for (const url of ["https://shop.example.com/checkout", "https://example.com/account/orders", "https://login.example.com/", "https://example.com/users/sign-in"]) {
      const risks = assessRisks(edit(canonical(), (s) => { s.scope.start = [url]; }));
      const hint = risks.find((r) => r.code === "has_login_hint");
      expect(hint, url).toBeDefined();
      expect(hint?.level).toBe("warning");
      expect(hint?.message).toContain("never type credentials");
    }
    expect(codes(edit(canonical(), (s) => { s.scope.start = ["https://example.com/blog/accountability"]; }))).not.toContain("has_login_hint");
    expect(codes(canonical())).not.toContain("has_login_hint");
  });

  it("orders risks high, then warnings, then info, with a stable order inside a level", () => {
    const worst = edit(canonical(), (s) => {
      s.scope.follow = {};
      s.scope.max_pages_per_run = 120;
      delete s.stop;
      s.trigger = { kind: "interval", every: "1m" };
      s.scope.start = ["https://example.com/login"];
    });
    expect(assessRisks(worst).map((r) => r.code)).toEqual(["any_site", "has_login_hint", "no_stop_condition", "fast_interval", "no_budgets", "many_pages", "judged_by_model", "related_widens_scope"]);
  });
});

describe("diffPreviews", () => {
  it("lists what changed between two versions of a routine", () => {
    const before = buildPreview(canonical());
    const after = buildPreview(edit(canonical(), (s) => { s.trigger = { kind: "interval", every: "1d" }; s.steps[3].steps[1].accept_at = 0.9; delete s.stop; }));
    const changes = diffPreviews(before, after);
    expect(changes.some((c) => c.startsWith("When changed to: Every day"))).toBe(true);
    expect(changes.some((c) => c.startsWith("Decides (2) changed"))).toBe(true);
    expect(changes.some((c) => c.includes("New flag (warning)") && c.includes("no stop condition"))).toBe(true);
    expect(changes.length).toBeLessThanOrEqual(8);
    expect(diffPreviews(before, before)).toEqual(["Nothing visible in the preview changed."]);
  });
});

describe("countSteps", () => {
  it("counts nested steps", () => {
    expect(countSteps(canonical())).toBe(13);
    expect(countSteps(minimal())).toBe(1);
  });
});
