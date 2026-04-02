import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { safeStorage } from "electron";

import type { VaultSecretInput, VaultSecretSummary, VaultStatus } from "../../../../packages/shared/src/index.js";

type VaultRef = { kind: "vault"; id: string };

type VaultEntry = {
  id: string;
  label: string;
  category: "identity" | "fixture";
  valueType: "string" | "boolean";
  value: string | boolean;
};

type PersistedVaultPayload = {
  version: 1;
  updatedAt: number;
  entries: VaultEntry[];
};

type PersistedVaultEnvelope = {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
};

type PersistedKeyEnvelope = {
  version: 1;
  keyProtection: VaultStatus["keyProtection"];
  protectedKey: string;
};

const DEFAULT_ENTRIES = [
  {
    id: "vault.identity.full_name",
    label: "Primary full name",
    category: "identity",
    valueType: "string",
    value: "Avery Mercer"
  },
  {
    id: "vault.identity.work_email",
    label: "Primary work email",
    category: "identity",
    valueType: "string",
    value: "avery.mercer@example.com"
  }
] satisfies VaultEntry[];

export class VaultStore {
  private readonly vaultFilePath: string;
  private readonly keyFilePath: string;
  private readonly entries = new Map<string, VaultEntry>();
  private status: VaultStatus;

  constructor(userDataPath: string) {
    this.vaultFilePath = path.join(userDataPath, "helmstack-vault.enc");
    this.keyFilePath = path.join(userDataPath, "helmstack-vault.key");
    this.status = {
      filePath: this.vaultFilePath,
      keyProtection: safeStorage.isEncryptionAvailable() ? "safe_storage" : "plaintext_fallback",
      entryCount: 0,
      updatedAt: 0
    };
    this.initialize();
  }

  listSecrets(): VaultSecretSummary[] {
    return [...this.entries.values()].map((entry) => ({
      id: entry.id,
      label: entry.label,
      category: entry.category,
      valueType: entry.valueType,
      maskedValue: maskValue(entry.value)
    }));
  }

  getStatus(): VaultStatus {
    return { ...this.status };
  }

  saveSecrets(updates: VaultSecretInput[]): VaultSecretSummary[] {
    for (const update of updates) {
      const previous = this.entries.get(update.id);
      const next: VaultEntry = {
        id: update.id,
        label: update.label || previous?.label || update.id,
        category: update.category || previous?.category || "fixture",
        valueType: update.valueType || previous?.valueType || (typeof update.value === "boolean" ? "boolean" : "string"),
        value: update.value
      };
      this.entries.set(update.id, next);
    }

    this.persist();
    return this.listSecrets();
  }

  resolveSecret(ref: VaultRef): string | boolean {
    const entry = this.entries.get(ref.id);
    if (!entry) {
      throw new Error(`Unknown vault ref: ${ref.id}`);
    }
    return entry.value;
  }

  resolveValue(value: unknown): unknown {
    if (isSecretRef(value)) {
      return this.resolveSecret(value);
    }

    if (isLiteralWrapper(value)) {
      return value.value;
    }

    return value;
  }

  private initialize() {
    mkdirSync(path.dirname(this.vaultFilePath), { recursive: true });
    const key = this.readOrCreateMasterKey();

    if (!existsSync(this.vaultFilePath)) {
      for (const entry of DEFAULT_ENTRIES) {
        this.entries.set(entry.id, entry);
      }
      this.persistWithKey(key);
      return;
    }

    const envelope = JSON.parse(readFileSync(this.vaultFilePath, "utf8")) as PersistedVaultEnvelope;
    const payload = decryptPayload(envelope, key);
    const parsed = JSON.parse(payload) as PersistedVaultPayload;

    this.entries.clear();
    for (const entry of parsed.entries) {
      this.entries.set(entry.id, entry);
    }

    this.status = {
      ...this.status,
      entryCount: this.entries.size,
      updatedAt: parsed.updatedAt
    };
  }

  private persist() {
    const key = this.readOrCreateMasterKey();
    this.persistWithKey(key);
  }

  private persistWithKey(key: Buffer) {
    const payload: PersistedVaultPayload = {
      version: 1,
      updatedAt: Date.now(),
      entries: [...this.entries.values()]
    };

    const envelope = encryptPayload(JSON.stringify(payload), key);
    writeFileSync(this.vaultFilePath, JSON.stringify(envelope, null, 2), { encoding: "utf8", mode: 0o600 });
    this.status = {
      ...this.status,
      entryCount: this.entries.size,
      updatedAt: payload.updatedAt
    };
  }

  private readOrCreateMasterKey() {
    if (!existsSync(this.keyFilePath)) {
      const key = randomBytes(32);
      const keyProtection = safeStorage.isEncryptionAvailable() ? "safe_storage" : "plaintext_fallback";
      const protectedKey =
        keyProtection === "safe_storage"
          ? safeStorage.encryptString(key.toString("base64")).toString("base64")
          : key.toString("base64");

      const envelope: PersistedKeyEnvelope = {
        version: 1,
        keyProtection,
        protectedKey
      };

      writeFileSync(this.keyFilePath, JSON.stringify(envelope, null, 2), { encoding: "utf8", mode: 0o600 });
      this.status = {
        ...this.status,
        keyProtection
      };
      return key;
    }

    const envelope = JSON.parse(readFileSync(this.keyFilePath, "utf8")) as PersistedKeyEnvelope;
    this.status = {
      ...this.status,
      keyProtection: envelope.keyProtection
    };

    if (envelope.keyProtection === "safe_storage") {
      return Buffer.from(safeStorage.decryptString(Buffer.from(envelope.protectedKey, "base64")), "base64");
    }

    return Buffer.from(envelope.protectedKey, "base64");
  }
}

function encryptPayload(payload: string, key: Buffer): PersistedVaultEnvelope {
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

function decryptPayload(envelope: PersistedVaultEnvelope, key: Buffer) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

function isSecretRef(value: unknown): value is VaultRef {
  return Boolean(value && typeof value === "object" && "kind" in value && "id" in value && value.kind === "vault");
}

function isLiteralWrapper(value: unknown): value is { kind: "literal"; value: unknown } {
  return Boolean(value && typeof value === "object" && "kind" in value && "value" in value && value.kind === "literal");
}

function maskValue(value: string | boolean) {
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (value.includes("@")) {
    const [local, host] = value.split("@");
    return `${local.slice(0, 2)}***@${host}`;
  }

  if (value.length <= 4) {
    return "*".repeat(value.length);
  }

  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}
