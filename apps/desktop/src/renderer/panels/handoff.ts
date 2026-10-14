/**
 * Human-handoff dialog (unchanged behaviour): the agent paused for a CAPTCHA,
 * 2FA, payment or legal step. A required decision — no Escape/backdrop dismiss.
 */

import type { BrowserShellBridge, HumanHandoffRecord } from "../../../../../packages/shared/src/index.js";
import { openDialog, type DialogHandle } from "../ui/dialog.js";
import { toast } from "../ui/toast.js";

export type HandoffBridge = Pick<BrowserShellBridge, "resolveHandoff" | "cancelHandoff">;

export const HANDOFF_REASON_LABELS: Record<HumanHandoffRecord["reason"], string> = {
  captcha: "CAPTCHA — solve the challenge on the page, then click Done.",
  "2fa": "Two-factor authentication — complete the 2FA step, then click Done.",
  payment: "Payment — review and complete the payment form, then click Done.",
  legal: "Legal — review and accept the terms, then click Done.",
};

export interface HandoffOptions {
  root?: ParentNode;
  bridge: HandoffBridge;
  onOpen?: () => void;
  onClose?: () => void;
}

export interface HandoffController {
  show(handoff: HumanHandoffRecord): void;
}

export function mountHandoff(options: HandoffOptions): HandoffController {
  const root = options.root ?? document;
  const modal = root.querySelector<HTMLElement>("#handoff-modal");
  const reason = root.querySelector<HTMLElement>("#handoff-reason");
  const done = root.querySelector<HTMLButtonElement>("#handoff-done-button");
  const cancel = root.querySelector<HTMLButtonElement>("#handoff-cancel-button");
  if (!modal || !reason || !done || !cancel) {
    throw new Error("Handoff markup missing.");
  }

  let requestId: string | null = null;
  let dialog: DialogHandle | null = null;

  const hide = (): void => {
    requestId = null;
    modal.hidden = true;
    const handle = dialog;
    dialog = null;
    handle?.close();
    options.onClose?.();
  };

  done.addEventListener("click", async () => {
    if (!requestId) return;
    try {
      const result = await options.bridge.resolveHandoff(requestId);
      hide();
      if (result.status === "blocked" || result.status === "failed") toast(result.reason, "error");
      else toast("Handoff resolved. Agent resuming.", "success");
    } catch (error) {
      toast(`Couldn't resolve the handoff — ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });

  cancel.addEventListener("click", async () => {
    if (!requestId) return;
    try {
      await options.bridge.cancelHandoff(requestId);
      hide();
      toast("Handoff cancelled.");
    } catch (error) {
      toast(`Couldn't cancel the handoff — ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });

  return {
    show(handoff) {
      requestId = handoff.requestId;
      reason.textContent = HANDOFF_REASON_LABELS[handoff.reason] ?? handoff.reason;
      if (dialog) return;
      modal.hidden = false;
      options.onOpen?.();
      dialog = openDialog(modal, { dismissable: false });
    },
  };
}
