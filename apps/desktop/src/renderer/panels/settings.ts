/**
 * Settings sheet (gear in the titlebar): approval policies, saved accounts and
 * the vault. These are agent-substrate surfaces, so the gear only shows for the
 * `agent-substrate` / `full` profiles; in `fe-dev` everything here is hidden.
 */

import type {
  AccountSummary,
  AgentProfile,
  ApprovalPolicyRecord,
  BrowserShellBridge,
  VaultSecretSummary,
} from "../../../../../packages/shared/src/index.js";
import { openDialog, type DialogHandle } from "../ui/dialog.js";
import { buildEmptyState, buildSkeletonRows } from "../ui/states.js";
import { icon } from "../ui/icons.js";
import { toast } from "../ui/toast.js";
import { validateAccountForm, type AccountFormValues, type FieldError } from "../ui/validate.js";

export type SettingsBridge = Pick<
  BrowserShellBridge,
  | "listApprovalPolicies"
  | "updateApprovalPolicy"
  | "listAccounts"
  | "saveAccount"
  | "deleteAccount"
  | "listVaultSecrets"
>;

/** Profiles that expose the settings surfaces. */
export function settingsEnabled(profile: AgentProfile | null | undefined): boolean {
  return profile === "agent-substrate" || profile === "full";
}

const DECISION_LABEL: Record<ApprovalPolicyRecord["decision"], string> = {
  ask: "Ask me",
  auto: "Allow automatically",
  block: "Always block",
};

export interface SettingsOptions {
  root?: ParentNode;
  bridge: SettingsBridge;
  onOpen?: () => void;
  onClose?: () => void;
}

export interface SettingsController {
  setProfile(profile: AgentProfile): void;
  open(): Promise<void>;
  close(): void;
  isOpen(): boolean;
}

type AccountFieldKey = keyof AccountFormValues;

export function mountSettings(options: SettingsOptions): SettingsController {
  const root = options.root ?? document;
  const q = <T extends HTMLElement>(id: string): T => {
    const el = root.querySelector<T>(`#${id}`);
    if (!el) throw new Error(`Settings markup missing: #${id}`);
    return el;
  };
  const gear = q<HTMLButtonElement>("settings-button");
  const sheet = q<HTMLElement>("settings-sheet");
  const closeButton = q<HTMLButtonElement>("settings-close");
  const backdrop = q<HTMLElement>("settings-backdrop");
  const policyList = q<HTMLElement>("policy-list");
  const accountsList = q<HTMLElement>("accounts-list");
  const vaultList = q<HTMLElement>("vault-list");
  const accountForm = q<HTMLFormElement>("account-form");
  const inputs: Record<AccountFieldKey, HTMLInputElement> = {
    label: q("account-label"),
    origin: q("account-origin"),
    username: q("account-username"),
    password: q("account-password"),
    totpSeed: q("account-totp"),
  };
  const errorNodes: Partial<Record<AccountFieldKey, HTMLElement>> = {
    label: q("account-label-error"),
    origin: q("account-origin-error"),
    username: q("account-username-error"),
    password: q("account-password-error"),
  };

  gear.replaceChildren(icon("settings"));
  closeButton.replaceChildren(icon("x"));

  let dialog: DialogHandle | null = null;
  let enabled = false;

  // ── policies ──────────────────────────────────────────────────────────────
  const renderPolicies = (policies: ApprovalPolicyRecord[]): void => {
    if (policies.length === 0) {
      policyList.replaceChildren(buildEmptyState({ title: "No approval policies" }));
      return;
    }
    policyList.replaceChildren(
      ...policies.map((policy) => {
        const row = document.createElement("div");
        row.className = "policy-row";
        const selectId = `policy-${policy.key}`;
        const text = document.createElement("div");
        text.className = "policy-row__text";
        const label = document.createElement("label");
        label.className = "policy-row__label";
        label.htmlFor = selectId;
        label.textContent = policy.label;
        const description = document.createElement("p");
        description.className = "policy-row__description";
        description.id = `${selectId}-desc`;
        description.textContent = policy.description;
        text.append(label, description);

        const select = document.createElement("select");
        select.className = "select policy-row__select";
        select.id = selectId;
        select.setAttribute("aria-describedby", description.id);
        for (const decision of ["ask", "auto", "block"] as const) {
          const option = document.createElement("option");
          option.value = decision;
          option.textContent = DECISION_LABEL[decision];
          select.append(option);
        }
        select.value = policy.decision;
        select.addEventListener("change", async () => {
          const decision = select.value as ApprovalPolicyRecord["decision"];
          try {
            renderPolicies(await options.bridge.updateApprovalPolicy(policy.key, decision));
            root.querySelector<HTMLSelectElement>(`#${selectId}`)?.focus();
            toast(`${policy.label}: ${DECISION_LABEL[decision].toLowerCase()}.`, "success");
          } catch (error) {
            select.value = policy.decision;
            toast(`Couldn't update the policy — ${error instanceof Error ? error.message : String(error)}`, "error");
          }
        });
        row.append(text, select);
        return row;
      })
    );
  };

  // ── accounts ──────────────────────────────────────────────────────────────
  const renderAccounts = (accounts: AccountSummary[]): void => {
    if (accounts.length === 0) {
      accountsList.replaceChildren(
        buildEmptyState({ title: "No accounts yet", hint: "Add credentials below so the agent can sign in for you." })
      );
      return;
    }
    accountsList.replaceChildren(
      ...accounts.map((account) => {
        const chip = document.createElement("div");
        chip.className = "account-chip";
        const body = document.createElement("div");
        body.className = "account-chip-body";
        const labelEl = document.createElement("div");
        labelEl.className = "account-chip-label";
        labelEl.textContent = account.label;
        const meta = document.createElement("div");
        meta.className = "account-chip-meta";
        meta.textContent = `${account.username} · ${account.origins.join(", ")}`;
        body.append(labelEl, meta);

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "account-chip-delete";
        deleteBtn.type = "button";
        deleteBtn.replaceChildren(icon("x", { size: 14 }));
        deleteBtn.title = "Delete account";
        deleteBtn.setAttribute("aria-label", `Delete account ${account.label}`);
        deleteBtn.addEventListener("click", async () => {
          try {
            await options.bridge.deleteAccount(account.id);
            renderAccounts(await options.bridge.listAccounts());
            toast(`Deleted account ${account.label}.`, "success");
          } catch (error) {
            toast(`Couldn't delete the account — ${error instanceof Error ? error.message : String(error)}`, "error");
          }
        });
        chip.append(body, deleteBtn);
        return chip;
      })
    );
  };

  const clearFieldError = (field: AccountFieldKey): void => {
    inputs[field].removeAttribute("aria-invalid");
    const node = errorNodes[field];
    if (node) {
      node.textContent = "";
      node.hidden = true;
    }
  };

  const showFieldErrors = (errors: FieldError[]): void => {
    (Object.keys(errorNodes) as AccountFieldKey[]).forEach(clearFieldError);
    for (const { field, message } of errors) {
      inputs[field].setAttribute("aria-invalid", "true");
      const node = errorNodes[field];
      if (node) {
        node.textContent = message;
        node.hidden = false;
      }
    }
    if (errors.length > 0) inputs[errors[0].field].focus();
  };

  (Object.keys(errorNodes) as AccountFieldKey[]).forEach((field) =>
    inputs[field].addEventListener("input", () => clearFieldError(field))
  );

  accountForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values: AccountFormValues = {
      label: inputs.label.value.trim(),
      origin: inputs.origin.value.trim(),
      username: inputs.username.value.trim(),
      password: inputs.password.value,
      totpSeed: inputs.totpSeed.value.trim() || undefined,
    };
    const errors = validateAccountForm(values);
    showFieldErrors(errors);
    if (errors.length > 0) return;
    try {
      await options.bridge.saveAccount({
        label: values.label,
        origins: [values.origin],
        username: values.username,
        password: values.password,
        totpSeed: values.totpSeed,
      });
      accountForm.reset();
      renderAccounts(await options.bridge.listAccounts());
      toast(`Saved account ${values.label}.`, "success");
    } catch (error) {
      toast(`Couldn't save the account — ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });

  // ── vault ─────────────────────────────────────────────────────────────────
  const renderVault = (secrets: VaultSecretSummary[]): void => {
    if (secrets.length === 0) {
      vaultList.replaceChildren(buildEmptyState({ title: "Vault is empty", hint: "Saved-account secrets appear here." }));
      return;
    }
    vaultList.replaceChildren(
      ...secrets.map((secret) => {
        const item = document.createElement("div");
        item.className = "vault-chip";
        const label = document.createElement("strong");
        label.textContent = secret.label;
        const value = document.createElement("span");
        value.textContent = `${secret.id} · ${secret.maskedValue}`;
        item.append(label, value);
        return item;
      })
    );
  };

  const load = async (): Promise<void> => {
    policyList.replaceChildren(buildSkeletonRows(3));
    accountsList.replaceChildren(buildSkeletonRows(2));
    vaultList.replaceChildren(buildSkeletonRows(2));
    const [policies, accounts, secrets] = await Promise.allSettled([
      options.bridge.listApprovalPolicies(),
      options.bridge.listAccounts(),
      options.bridge.listVaultSecrets(),
    ]);
    const failed = (list: HTMLElement, what: string): void =>
      list.replaceChildren(buildEmptyState({ title: `Couldn't load ${what}`, hint: "Close and reopen settings to retry." }));
    if (policies.status === "fulfilled") renderPolicies(policies.value);
    else failed(policyList, "approval policies");
    if (accounts.status === "fulfilled") renderAccounts(accounts.value);
    else failed(accountsList, "accounts");
    if (secrets.status === "fulfilled") renderVault(secrets.value);
    else failed(vaultList, "the vault");
  };

  // ── open / close ──────────────────────────────────────────────────────────
  const close = (): void => {
    if (!dialog) return;
    const handle = dialog;
    dialog = null;
    sheet.hidden = true;
    gear.setAttribute("aria-expanded", "false");
    handle.close();
    options.onClose?.();
  };

  const open = async (): Promise<void> => {
    if (!enabled || dialog) return;
    sheet.hidden = false;
    gear.setAttribute("aria-expanded", "true");
    options.onOpen?.();
    dialog = openDialog(sheet, {
      dismissable: true,
      initialFocus: closeButton,
      onClose: () => {
        if (dialog) {
          dialog = null;
          sheet.hidden = true;
          gear.setAttribute("aria-expanded", "false");
          options.onClose?.();
        }
      },
    });
    await load();
  };

  gear.setAttribute("aria-expanded", "false");
  gear.addEventListener("click", () => void open());
  closeButton.addEventListener("click", close);
  backdrop.addEventListener("click", close);

  return {
    setProfile(profile) {
      enabled = settingsEnabled(profile);
      gear.hidden = !enabled;
      if (!enabled) close();
    },
    open,
    close,
    isOpen: () => dialog !== null,
  };
}
