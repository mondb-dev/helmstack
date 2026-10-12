/**
 * Inputs the portable command registry needs instead of Electron's
 * `WebContents` and the desktop's vault/account stores (ADR 0001 §4.3).
 */
import type { CdpTarget } from "../../../../shared/src/index.js";

/** The page a command runs against. */
export interface PageHandle {
  readonly cdp: CdpTarget;
  /** Navigates the tab and resolves once the page has loaded. */
  navigate(url: string): Promise<void>;
}

/**
 * Resolves secret references in command values. Desktop backs it with the
 * vault (`{ kind: "vault" }`) and account store (`{ kind: "account" }`); a
 * backend without secrets passes values through unchanged.
 */
export interface SecretResolver {
  resolveValue(value: unknown): unknown;
}

/** Resolver for backends with no vault: values pass through unchanged. */
export const passthroughSecrets: SecretResolver = {
  resolveValue: (value) => value
};
