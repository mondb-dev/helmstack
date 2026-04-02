/**
 * Account credential model.
 *
 * An account is a set of credentials bound to one or more site origins.
 * Accounts are stored encrypted alongside the identity vault but have a
 * dedicated schema, lifecycle, and lookup model (origin-based).
 */

/** Stored record — never leaves the main process unmasked. */
export type AccountRecord = {
  id: string;
  label: string;
  /** Domains this account applies to, e.g. `["github.com"]`. */
  origins: string[];
  username: string;
  password: string;
  /** Base32-encoded TOTP seed for 2FA (RFC 6238). */
  totpSeed?: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
};

/** Exposed to renderers and agents — password is masked, TOTP seed omitted. */
export type AccountSummary = {
  id: string;
  label: string;
  origins: string[];
  username: string;
  maskedPassword: string;
  hasTotpSeed: boolean;
  notes?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
};

/** Input for creating or fully replacing an account. */
export type AccountInput = {
  label: string;
  origins: string[];
  username: string;
  password: string;
  totpSeed?: string;
  notes?: string;
};

/** Partial update — every field is optional. */
export type AccountUpdate = Partial<AccountInput>;

/** Typed ref that form-fill values can use to pull an account field. */
export type AccountRef = {
  kind: "account";
  accountId: string;
  field: "username" | "password" | "totp";
};

/** Result of a TOTP generation request. */
export type TotpResult = {
  code: string;
  /** Seconds remaining before this code expires. */
  expiresIn: number;
};
