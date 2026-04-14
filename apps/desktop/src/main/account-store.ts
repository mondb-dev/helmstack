import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { safeStorage } from "electron";

import type {
  AccountInput,
  AccountRecord,
  AccountRef,
  AccountSummary,
  AccountUpdate,
  TotpResult
} from "../../../../packages/shared/src/index.js";

// ── Persisted types ──────────────────────────────────────────────────────────

type PersistedPayload = {
  version: 1;
  updatedAt: number;
  accounts: AccountRecord[];
};

type PersistedEnvelope = {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
};

type PersistedKeyEnvelope = {
  version: 1;
  keyProtection: "safe_storage" | "plaintext_fallback";
  protectedKey: string;
};

// ── Store ────────────────────────────────────────────────────────────────────

/**
 * Encrypted credential store for site accounts.
 *
 * - Shares the same master-key file as VaultStore (`helmstack-vault.key`).
 * - Persists to its own encrypted file (`helmstack-accounts.enc`).
 * - TOTP generation using Node.js crypto (no external deps).
 * - Origin matching with subdomain awareness.
 */
export class AccountStore {
  private readonly dataFilePath: string;
  private readonly keyFilePath: string;
  private readonly accounts = new Map<string, AccountRecord>();

  constructor(userDataPath: string) {
    mkdirSync(userDataPath, { recursive: true });
    this.dataFilePath = path.join(userDataPath, "helmstack-accounts.enc");
    this.keyFilePath = path.join(userDataPath, "helmstack-vault.key");
    this.load();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  listAccounts(): AccountSummary[] {
    return [...this.accounts.values()].map(summarize);
  }

  getAccount(id: string): AccountRecord | null {
    return this.accounts.get(id) ?? null;
  }

  saveAccount(input: AccountInput): AccountSummary {
    const now = Date.now();
    const record: AccountRecord = {
      id: randomUUID(),
      label: input.label,
      origins: normalizeOrigins(input.origins),
      username: input.username,
      password: input.password,
      totpSeed: input.totpSeed || undefined,
      notes: input.notes || undefined,
      createdAt: now,
      updatedAt: now
    };

    this.accounts.set(record.id, record);
    this.persist();
    return summarize(record);
  }

  updateAccount(id: string, update: AccountUpdate): AccountSummary {
    const existing = this.accounts.get(id);
    if (!existing) {
      throw new Error(`Account not found: ${id}`);
    }

    const merged: AccountRecord = {
      ...existing,
      label: update.label ?? existing.label,
      origins: update.origins ? normalizeOrigins(update.origins) : existing.origins,
      username: update.username ?? existing.username,
      password: update.password ?? existing.password,
      totpSeed: update.totpSeed !== undefined ? update.totpSeed || undefined : existing.totpSeed,
      notes: update.notes !== undefined ? update.notes || undefined : existing.notes,
      updatedAt: Date.now()
    };

    this.accounts.set(id, merged);
    this.persist();
    return summarize(merged);
  }

  deleteAccount(id: string): void {
    if (!this.accounts.delete(id)) {
      throw new Error(`Account not found: ${id}`);
    }
    this.persist();
  }

  /** Find accounts whose origins match the given URL or domain. */
  lookupByOrigin(origin: string): AccountSummary[] {
    const domain = toDomain(origin);
    if (!domain) return [];

    return [...this.accounts.values()]
      .filter((account) => account.origins.some((o) => domainsMatch(o, domain)))
      .map(summarize);
  }

  /** Return the first full AccountRecord (with plaintext password) matching the given origin. */
  findRecordByOrigin(origin: string): AccountRecord | null {
    const domain = toDomain(origin);
    if (!domain) return null;

    return (
      [...this.accounts.values()].find((account) => account.origins.some((o) => domainsMatch(o, domain))) ?? null
    );
  }

  /** Generate a TOTP code for the given account. */
  generateTotp(accountId: string): TotpResult {
    const account = this.accounts.get(accountId);
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }
    if (!account.totpSeed) {
      throw new Error(`Account ${accountId} has no TOTP seed configured`);
    }

    const now = Math.floor(Date.now() / 1000);
    const period = 30;
    const counter = Math.floor(now / period);
    const code = computeTotp(account.totpSeed, counter);
    const expiresIn = period - (now % period);

    return { code, expiresIn };
  }

  /**
   * Resolve an AccountRef to a concrete value.
   * Used by the form-fill resolver so agents can write:
   *   `{ kind: "account", accountId: "...", field: "password" }`
   */
  resolveRef(ref: AccountRef): string {
    const account = this.accounts.get(ref.accountId);
    if (!account) {
      throw new Error(`Account not found: ${ref.accountId}`);
    }

    // Mark usage
    account.lastUsedAt = Date.now();
    this.persist();

    switch (ref.field) {
      case "username":
        return account.username;
      case "password":
        return account.password;
      case "totp":
        return this.generateTotp(ref.accountId).code;
    }
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  private load() {
    if (!existsSync(this.dataFilePath)) return;

    const key = this.readOrCreateMasterKey();
    const envelope = JSON.parse(readFileSync(this.dataFilePath, "utf8")) as PersistedEnvelope;
    const raw = decrypt(envelope, key);
    const payload = JSON.parse(raw) as PersistedPayload;

    this.accounts.clear();
    for (const account of payload.accounts) {
      this.accounts.set(account.id, account);
    }
  }

  private persist() {
    const key = this.readOrCreateMasterKey();
    const payload: PersistedPayload = {
      version: 1,
      updatedAt: Date.now(),
      accounts: [...this.accounts.values()]
    };

    const envelope = encrypt(JSON.stringify(payload), key);
    writeFileSync(this.dataFilePath, JSON.stringify(envelope, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  /**
   * Read (or create) the master key.
   * Shares the same key file as VaultStore so both stores unlock with one key.
   */
  private readOrCreateMasterKey(): Buffer {
    if (!existsSync(this.keyFilePath)) {
      const key = randomBytes(32);
      const keyProtection = safeStorage.isEncryptionAvailable() ? "safe_storage" : "plaintext_fallback";
      const protectedKey =
        keyProtection === "safe_storage"
          ? safeStorage.encryptString(key.toString("base64")).toString("base64")
          : key.toString("base64");

      const envelope: PersistedKeyEnvelope = { version: 1, keyProtection, protectedKey };
      writeFileSync(this.keyFilePath, JSON.stringify(envelope, null, 2), { encoding: "utf8", mode: 0o600 });
      return key;
    }

    const envelope = JSON.parse(readFileSync(this.keyFilePath, "utf8")) as PersistedKeyEnvelope;
    if (envelope.keyProtection === "safe_storage") {
      return Buffer.from(safeStorage.decryptString(Buffer.from(envelope.protectedKey, "base64")), "base64");
    }
    return Buffer.from(envelope.protectedKey, "base64");
  }
}

// ── Encryption ───────────────────────────────────────────────────────────────

function encrypt(payload: string, key: Buffer): PersistedEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

function decrypt(envelope: PersistedEnvelope, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

// ── TOTP (RFC 6238) ──────────────────────────────────────────────────────────

function computeTotp(seed: string, counter: number, digits = 6): string {
  const key = base32Decode(seed);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac("sha1", key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;

  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = binCode % 10 ** digits;
  return otp.toString().padStart(digits, "0");
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/[\s=-]/g, "").toUpperCase();
  let bits = "";
  for (const char of cleaned) {
    const val = BASE32_ALPHABET.indexOf(char);
    if (val === -1) throw new Error(`Invalid base32 character: ${char}`);
    bits += val.toString(2).padStart(5, "0");
  }

  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

// ── Origin matching ──────────────────────────────────────────────────────────

/**
 * Extract the effective domain from a URL string or bare domain.
 * `"https://login.github.com/foo"` → `"login.github.com"`
 * `"github.com"` → `"github.com"`
 */
function toDomain(input: string): string | null {
  try {
    if (input.includes("://")) {
      return new URL(input).hostname.toLowerCase();
    }
    return input.toLowerCase().replace(/\/.*$/, "");
  } catch {
    return null;
  }
}

/** Normalize a list of user-supplied origin strings to clean domains. */
function normalizeOrigins(origins: string[]): string[] {
  return origins.map((o) => toDomain(o)).filter((d): d is string => d !== null);
}

/**
 * Domain-aware matching:
 *   `github.com` matches `github.com` (exact)
 *   `github.com` matches `login.github.com` (account domain is parent)
 *   `login.github.com` matches `github.com` (page domain is parent)
 */
function domainsMatch(accountDomain: string, pageDomain: string): boolean {
  if (accountDomain === pageDomain) return true;
  if (pageDomain.endsWith("." + accountDomain)) return true;
  if (accountDomain.endsWith("." + pageDomain)) return true;
  return false;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function summarize(record: AccountRecord): AccountSummary {
  return {
    id: record.id,
    label: record.label,
    origins: record.origins,
    username: record.username,
    maskedPassword: maskPassword(record.password),
    hasTotpSeed: !!record.totpSeed,
    notes: record.notes,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastUsedAt: record.lastUsedAt
  };
}

function maskPassword(password: string): string {
  if (password.length <= 2) return "*".repeat(password.length);
  return password[0] + "*".repeat(Math.min(password.length - 2, 10)) + password[password.length - 1];
}
