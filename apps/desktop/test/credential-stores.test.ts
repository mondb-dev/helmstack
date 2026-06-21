import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Both stores import `safeStorage` from electron; mock it so the plaintext-key
// fallback path runs (no OS keychain in the test environment).
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8")
  }
}));

import { AccountStore } from "../src/main/account-store.js";
import { VaultStore } from "../src/main/vault-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "helmstack-cred-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("AccountStore — TOTP (RFC 6238, SHA1/6-digit/30s)", () => {
  // RFC 6238 Appendix B secret "12345678901234567890" in base32.
  const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  // 6-digit truncations of the published 8-digit RFC test values.
  const VECTORS: Array<[number, string]> = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"]
  ];

  it("matches the RFC 6238 test vectors", () => {
    const store = new AccountStore(dir);
    const account = store.saveAccount({
      label: "rfc",
      origins: ["example.com"],
      username: "u",
      password: "p",
      totpSeed: SEED
    });

    for (const [unixSeconds, expected] of VECTORS) {
      vi.spyOn(Date, "now").mockReturnValue(unixSeconds * 1000);
      expect(store.generateTotp(account.id).code).toBe(expected);
    }
  });

  it("throws when the account has no TOTP seed", () => {
    const store = new AccountStore(dir);
    const account = store.saveAccount({ label: "x", origins: ["example.com"], username: "u", password: "p" });
    expect(() => store.generateTotp(account.id)).toThrow(/no TOTP seed/i);
  });
});

describe("AccountStore — origin matching", () => {
  it("matches exact, parent, and subdomain origins; rejects unrelated", () => {
    const store = new AccountStore(dir);
    store.saveAccount({ label: "gh", origins: ["github.com"], username: "u", password: "p" });

    expect(store.lookupByOrigin("https://github.com/login").map((a) => a.label)).toEqual(["gh"]);
    expect(store.lookupByOrigin("https://login.github.com/foo").map((a) => a.label)).toEqual(["gh"]);
    expect(store.lookupByOrigin("github.com").map((a) => a.label)).toEqual(["gh"]);
    expect(store.lookupByOrigin("https://gitlab.com")).toEqual([]);
    expect(store.lookupByOrigin("https://notgithub.com")).toEqual([]);
  });

  it("masks the password and omits the TOTP seed in summaries", () => {
    const store = new AccountStore(dir);
    const summary = store.saveAccount({
      label: "x",
      origins: ["example.com"],
      username: "user@example.com",
      password: "supersecret",
      totpSeed: "ABCDEFGH"
    });
    expect(summary.maskedPassword).not.toContain("supersecret");
    expect(summary.hasTotpSeed).toBe(true);
    expect(summary).not.toHaveProperty("password");
    expect(summary).not.toHaveProperty("totpSeed");
  });
});

describe("VaultStore — encryption round-trip", () => {
  it("persists secrets and reads them back from a fresh instance", () => {
    const vault = new VaultStore(dir);
    vault.saveSecrets([{ id: "vault.test.api_key", label: "API key", category: "fixture", valueType: "string", value: "sk-123" }]);

    // A fresh instance simulates an app restart reading the same userData dir.
    const reloaded = new VaultStore(dir);
    expect(reloaded.resolveValue({ kind: "vault", id: "vault.test.api_key" })).toBe("sk-123");
  });

  it("masks secret values in listings", () => {
    const vault = new VaultStore(dir);
    vault.saveSecrets([{ id: "vault.test.token", label: "Token", category: "fixture", valueType: "string", value: "abcdef123456" }]);
    const entry = vault.listSecrets().find((s) => s.id === "vault.test.token")!;
    expect(entry.maskedValue).not.toBe("abcdef123456");
    expect(entry.maskedValue).toContain("***");
  });

  it("throws on an unknown vault ref", () => {
    const vault = new VaultStore(dir);
    expect(() => vault.resolveValue({ kind: "vault", id: "vault.missing" })).toThrow(/unknown vault ref/i);
  });
});
