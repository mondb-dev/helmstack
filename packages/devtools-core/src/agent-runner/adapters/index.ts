import type { AgentCliAdapter } from "../types.js";
import { claudeAdapter } from "./claude.js";
import { geminiAdapter } from "./gemini.js";

/** Allowlist of runnable CLIs. Anything not listed here is never executed. */
export const BUILTIN_ADAPTERS: readonly AgentCliAdapter[] = [claudeAdapter, geminiAdapter];

export { claudeAdapter, geminiAdapter };
