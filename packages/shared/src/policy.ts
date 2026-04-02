import type { ApprovalDecision, ProposedEffect } from "./ai.js";

export type ApprovalPolicyKey = ProposedEffect["type"];

export type ApprovalPolicyRecord = {
  key: ApprovalPolicyKey;
  label: string;
  description: string;
  decision: ApprovalDecision;
};
