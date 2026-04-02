import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ApprovalDecision, ApprovalPolicyKey, ApprovalPolicyRecord } from "../../../../packages/shared/src/index.js";

type PersistedApprovalPolicyState = {
  version: 1;
  updatedAt: number;
  policies: ApprovalPolicyRecord[];
};

const DEFAULT_POLICIES = [
  {
    key: "share_personal_data",
    label: "Share personal data",
    description: "Used for submits and actions that send contact or identity data to a site.",
    decision: "ask"
  },
  {
    key: "create_account",
    label: "Create account",
    description: "Used when a form submission is likely to register a new account.",
    decision: "ask"
  },
  {
    key: "accept_legal_terms",
    label: "Accept legal terms",
    description: "Used for terms of service, privacy acknowledgements, and consent gates.",
    decision: "ask"
  },
  {
    key: "submit_payment",
    label: "Submit payment",
    description: "Used for payment authorization, checkout, and purchase actions.",
    decision: "block"
  }
] satisfies ApprovalPolicyRecord[];

export class ApprovalPolicyStore {
  private readonly filePath: string;
  private readonly policies = new Map<ApprovalPolicyKey, ApprovalPolicyRecord>();

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "helmstack-approval-policies.json");
    this.initialize();
  }

  listPolicies(): ApprovalPolicyRecord[] {
    return [...this.policies.values()];
  }

  updatePolicy(key: ApprovalPolicyKey, decision: ApprovalDecision): ApprovalPolicyRecord[] {
    const existing = this.policies.get(key);
    if (!existing) {
      throw new Error(`Unknown approval policy key: ${key}`);
    }

    this.policies.set(key, {
      ...existing,
      decision
    });
    this.persist();
    return this.listPolicies();
  }

  getDecision(key: ApprovalPolicyKey): ApprovalDecision {
    return this.policies.get(key)?.decision ?? "ask";
  }

  private initialize() {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!existsSync(this.filePath)) {
      for (const policy of DEFAULT_POLICIES) {
        this.policies.set(policy.key, policy);
      }
      this.persist();
      return;
    }

    const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as PersistedApprovalPolicyState;
    this.policies.clear();
    for (const policy of parsed.policies) {
      this.policies.set(policy.key, policy);
    }
  }

  private persist() {
    const state: PersistedApprovalPolicyState = {
      version: 1,
      updatedAt: Date.now(),
      policies: [...this.policies.values()]
    };

    writeFileSync(this.filePath, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
  }
}
