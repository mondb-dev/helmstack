// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RoutineSpec } from "@helmstack/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HelmstackCore } from "../../../packages/devtools-core/src/core/helmstack-core.js";
import { ChromeBackend } from "../src/chrome-backend.js";
import { tryFindChrome } from "../src/chrome.js";

// Real headless Chrome against a LOCAL page served by this test (never a remote site).
const chrome = process.platform === "win32" && process.env.HELMSTACK_TEST_WINDOWS_CHROME !== "1" ? null : tryFindChrome();

const NAMES = ["Jalen Smith", "Star Player", "Mo Lee"];
const page = (works: boolean): string => `<!doctype html><meta charset=utf-8><title>Roster</title>
<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "ItemList",
  itemListElement: NAMES.map((name, i) => ({ "@type": "ListItem", position: i + 1, name, url: `/p/${i + 1}` }))
})}</script>
<main><h1>Free agents and roster</h1><p id="msg"></p><ul id="roster">
${NAMES.map(
  (n) => `<li>${n} <button onclick="${works ? `msg('${n} added to your team')` : "0"}">Add</button> <button onclick="${works ? "drop(this)" : "0"}">Drop</button>
<select aria-label="Slot" onchange="${works ? "msg('Lineup saved')" : "0"}"><option>Starter</option><option>Bench</option></select></li>`
).join("\n")}
</ul></main>
<script>function msg(t){document.getElementById('msg').textContent=t}
function drop(b){var li=b.closest('li');li.remove();msg('dropped')}</script>`;

const wait = async (check: () => boolean, ms = 20_000): Promise<void> => {
  const t = Date.now();
  while (!check()) {
    if (Date.now() - t > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 40));
  }
};

describe.skipIf(!chrome)("routine actions against a local page in real headless Chrome", () => {
  let server: http.Server;
  let base: string;
  let dataDir: string;
  let backend: ChromeBackend;
  let core: HelmstackCore;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/robots.txt" || req.url === "/favicon.ico") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page(!req.url?.startsWith("/broken")));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dataDir = await mkdtemp(path.join(tmpdir(), "helmstack-actions-it-"));
    backend = await ChromeBackend.launch({ dataDir, chrome: { executablePath: chrome!.path } });
    core = new HelmstackCore(backend, { dataDir, routineEngine: { autoStart: false, sleep: async () => {} } });
  }, 60_000);

  afterAll(async () => {
    core?.dispose();
    await backend?.close();
    await new Promise((r) => server?.close(r));
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  function spec(startPath: string, act: Record<string, unknown>, protect: string[] = []): RoutineSpec {
    return {
      version: 1,
      title: "Local roster",
      intent: "Test routine on a local page.",
      scope: { start: [`${base}${startPath}`], follow: { max_depth: 0 }, max_pages_per_run: 3 },
      trigger: { kind: "manual" },
      steps: [
        { do: "open", url: "$scope.start[0]" },
        { do: "locate", id: "list", target: "players", strategies: ["structured_data"], min_confidence: 0.5, on_low: "fail" },
        {
          do: "for_each",
          items: "$list",
          limit: 3,
          steps: [
            { do: "extract", id: "p", fields: { name: "text<=80" }, strategies: ["structured_data"], from: "$item" },
            { do: "act", target: "the Add button in this player's row", strategies: ["repeating_blocks"], min_confidence: 0.8, on_low: "fail", subject: "$p", action: "click", effect: "add_item", verify: { present: ["added to your team"] }, ...act }
          ]
        }
      ],
      ...(protect.length ? { actions: { protect } } : {})
    } as RoutineSpec;
  }

  const create = (s: RoutineSpec, grants?: Parameters<HelmstackCore["approveRoutine"]>[1]): string => {
    const { routine } = core.proposeRoutine(s);
    core.approveRoutine(routine.id, grants);
    return routine.id;
  };
  const runAndWait = async (id: string) => {
    const before = core.listRoutineRuns(id).length;
    core.runRoutineNow(id);
    await wait(() => core.listRoutineRuns(id).length > before && core.listRoutineRuns(id)[0]!.status !== "running");
    return core.listRoutineRuns(id)[0]!;
  };
  const bodyText = async (url: string): Promise<string> => {
    const tab = await core.createTab(url);
    const id = tab.at(-1)!.id;
    const v = await core.evaluateExpression(id, "document.body.innerText");
    await core.closeTab(id);
    return String(v.value);
  };

  it("auto grant: the add happens and is verified; a protected player is blocked; the select works", async () => {
    // 1. add_item auto, one run clicks Add for every row (3) and verifies
    const addId = create(spec("/roster", {}), { effects: { add_item: { mode: "auto", perRun: 5, perDay: 10 } }, protect: [] });
    const r1 = await runAndWait(addId);
    expect(r1.status).toBe("completed");
    const done = core.listRoutineActions(addId);
    expect(done.map((a) => a.status)).toEqual(["done", "done", "done"]);
    expect(done[0]).toMatchObject({ allowedBy: "grant", effect: "add_item" });
    expect(JSON.stringify(done)).not.toContain("secret");

    // 2. remove_item with auto grant, Star Player protected: the other two are dropped, he is blocked
    const dropId = create(
      spec("/roster", { target: "the Drop button in this player's row", effect: "remove_item", verify: { present: ["dropped"] } }, ["star player"]),
      { effects: { remove_item: { mode: "auto", perRun: 5, perDay: 10 } }, protect: [] }
    );
    const r2 = await runAndWait(dropId);
    expect(r2.status).toBe("completed");
    const acts = core.listRoutineActions(dropId);
    expect(acts.filter((a) => a.status === "blocked").map((a) => a.subject)).toEqual(["Star Player"]);
    expect(acts.filter((a) => a.status === "done")).toHaveLength(2);
    expect(acts.some((a) => a.status === "pending")).toBe(false);

    // 3. rearrange via a select, auto
    const slotId = create(
      spec("/roster", { action: "select", effect: "rearrange", target: "the Slot menu in this player's row", value: "Bench", verify: { present: ["Lineup saved"] } }),
      { effects: { rearrange: { mode: "auto", perRun: 5, perDay: 10 } }, protect: [] }
    );
    const r3 = await runAndWait(slotId);
    expect(r3.status).toBe("completed");
    expect(core.listRoutineActions(slotId).map((a) => a.status)).toEqual(["done", "done", "done"]);
  }, 90_000);

  it("no grant: actions wait, then a human approval performs one through the real pipeline", async () => {
    const id = create(spec("/roster", {}));
    const r = await runAndWait(id);
    expect(r.status).toBe("needs_human");
    expect(r.summary).toContain("Waiting for you to approve 3 actions");
    const pending = core.listRoutineActions(id);
    expect(pending.every((a) => a.status === "pending")).toBe(true);
    const res = await core.approveRoutineAction(id, pending.find((a) => a.subject === "Mo Lee")!.id);
    expect(res).toMatchObject({ status: "done", allowedBy: "human" });
    expect(await bodyText(`${base}/roster`)).not.toContain("added to your team"); // a fresh page load is unaffected
    const declined = core.declineRoutineAction(id, pending.find((a) => a.subject === "Jalen Smith")!.id);
    expect(declined.status).toBe("declined");
  }, 60_000);

  it("verify failure: the action fails, the run fails and the routine is paused at once", async () => {
    const id = create(spec("/broken", {}), { effects: { add_item: { mode: "auto", perRun: 5, perDay: 10 } }, protect: [] });
    const r = await runAndWait(id);
    expect(r.status).toBe("failed");
    expect(core.listRoutines().find((x) => x.id === id)!.state).toBe("paused");
    const acts = core.listRoutineActions(id);
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ status: "failed" });
  }, 60_000);
});
