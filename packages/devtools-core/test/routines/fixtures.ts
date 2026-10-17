import type { RoutineSpec } from "../../../shared/src/index.js";
import { CANONICAL_ROUTINE_TEMPLATE, fillRoutineTemplate, routineActionExample, routineLibraryExample } from "../../src/core/routines/example.js";

export const TOPIC = "accessibility law changes";
export const PAGE_URL = "https://news.example.com/updates";

/** The canonical routine with the placeholders filled in. A fresh deep copy every call. */
export function canonical(): RoutineSpec {
  return fillRoutineTemplate(CANONICAL_ROUTINE_TEMPLATE, { topic: TOPIC, pageUrl: PAGE_URL });
}

export const MINIMAL: RoutineSpec = {
  version: 1,
  title: "Check a page",
  intent: "Look at this page when I ask.",
  scope: { start: ["https://example.com/"], follow: { max_depth: 0 }, max_pages_per_run: 5 },
  trigger: { kind: "manual" },
  steps: [{ do: "open", url: "$scope.start[0]" }]
};

export function minimal(): RoutineSpec {
  return structuredClone(MINIMAL);
}

/** The roster-upkeep routine: act steps (select in a branch arm, click in a loop) and an `actions` block. */
export function actionRoutine(): RoutineSpec {
  return routineActionExample();
}

/** The library example: an infer with `recall` and a `remember` in a branch arm. */
export function libraryRoutine(): RoutineSpec {
  return routineLibraryExample();
}
