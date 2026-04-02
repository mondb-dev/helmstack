import type { AccountRef } from "./account.js";
import type { TabId } from "./browser.js";

export type VaultRef = {
  kind: "vault";
  id: string;
};

/** A secret reference can point to the identity vault or an account field. */
export type SecretRef = VaultRef | AccountRef;

export type LiteralValue = {
  kind: "literal";
  value: string;
};

export type NodeRef = {
  tabId: TabId;
  frameId: string;
  backendNodeId: number;
  role: string;
  name?: string;
};

export type BrowserAction =
  | { type: "navigate"; url: string }
  | { type: "click"; node: NodeRef }
  | { type: "type"; node: NodeRef; value: SecretRef | LiteralValue }
  | { type: "select"; node: NodeRef; optionText: string }
  | { type: "submit"; node: NodeRef }
  | { type: "await_human"; reason: "captcha" | "2fa" | "payment" | "legal" };

export type ApprovalDecision = "auto" | "ask" | "block";

export type ProposedEffect =
  | { type: "create_account"; label: string }
  | { type: "share_personal_data"; fields: string[] }
  | { type: "accept_legal_terms"; provider: string }
  | { type: "submit_payment"; amount?: string; currency?: string };

