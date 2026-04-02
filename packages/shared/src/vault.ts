export type VaultSecretValueType = "string" | "boolean";

export type VaultSecretSummary = {
  id: string;
  label: string;
  category: "identity" | "fixture";
  valueType: VaultSecretValueType;
  maskedValue: string;
};

export type FixturePageName = "contact-form";

export type VaultSecretInput = {
  id: string;
  label: string;
  category: "identity" | "fixture";
  valueType: VaultSecretValueType;
  value: string | boolean;
};

export type VaultStatus = {
  filePath: string;
  keyProtection: "safe_storage" | "plaintext_fallback";
  entryCount: number;
  updatedAt: number;
};
