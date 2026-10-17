import type { RoutineSpecError } from "../../../../shared/src/index.js";

/** Thrown when a proposed spec fails validation; the HTTP layer maps it to 400 with the error list. */
export class RoutineSpecInvalidError extends Error {
  readonly code = "invalid_routine_spec";
  constructor(readonly errors: RoutineSpecError[]) {
    super(
      `The routine spec is not valid (${errors.length} problem${errors.length === 1 ? "" : "s"}): ` +
        errors.slice(0, 5).map((e) => `${e.path}: ${e.message}`).join("; ") +
        (errors.length > 5 ? "; ..." : "")
    );
    this.name = "RoutineSpecInvalidError";
  }
}
