import type { AccountRef } from "../../../../packages/shared/src/index.js";
import type { SecretResolver } from "../../../../packages/devtools-core/src/core/commands/types.js";
import type { AccountStore } from "./account-store.js";
import type { VaultStore } from "./vault-store.js";

/**
 * Desktop `SecretResolver` for the command registry: account refs
 * (`{ kind: "account" }`) resolve through the account store, everything else
 * (vault refs, literal wrappers, plain values) through the vault.
 */
export function createDesktopSecrets(vault: VaultStore, accounts: AccountStore): SecretResolver {
  return {
    resolveValue: (value) => (isAccountRef(value) ? accounts.resolveRef(value) : vault.resolveValue(value))
  };
}

export function isAccountRef(value: unknown): value is AccountRef {
  return Boolean(value && typeof value === "object" && "kind" in value && "accountId" in value && value.kind === "account");
}
