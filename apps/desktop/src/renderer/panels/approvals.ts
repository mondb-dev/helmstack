/**
 * Pending-approval surfaces: a persistent banner (oldest summary + "+N more")
 * shown while anything is waiting, a polite live-region announcement for each
 * newly queued approval, and the Review dialog (approve / reject / decide
 * later). Driven entirely by `listPendingApprovals` + `onApprovalsChanged`, so
 * approvals queued by agents over HTTP show up the same as shell-initiated ones.
 */

import type {
  BrowserCommandResult,
  BrowserShellBridge,
  PendingApproval,
  ProposedEffect,
  TabId,
} from "../../../../../packages/shared/src/index.js";
import { openDialog, type DialogHandle } from "../ui/dialog.js";
import { icon } from "../ui/icons.js";
import { toast } from "../ui/toast.js";
import { truncateMiddle } from "../ui/format.js";

export type ApprovalsBridge = Pick<BrowserShellBridge, "listPendingApprovals" | "approveCommand" | "rejectCommand">;

export function describeEffect(effect: ProposedEffect): string {
  switch (effect.type) {
    case "create_account":
      return `Create account: ${effect.label}`;
    case "share_personal_data":
      return `Share personal data: ${effect.fields.join(", ")}`;
    case "accept_legal_terms":
      return `Accept legal terms: ${effect.provider}`;
    case "submit_payment":
      return effect.amount ? `Submit payment: ${effect.amount}${effect.currency ? ` ${effect.currency}` : ""}` : "Submit payment";
  }
}

/**
 * Effect lines worth listing under the summary: none when there are no
 * effects, or when the only thing they'd say is the summary again.
 */
export function effectLines(approval: Pick<PendingApproval, "summary" | "effects">): string[] {
  const norm = (value: string): string => value.trim().replace(/\s+/g, " ").toLowerCase();
  const summary = norm(approval.summary);
  const lines = [...new Set(approval.effects.map(describeEffect))];
  if (lines.every((line) => norm(line) === summary)) return [];
  return lines;
}

/** Longest path shown before it's truncated in the middle (full path in the tooltip). */
export const APPROVAL_PATH_MAX = 40;

/** Where an approval was requested, and whether its tab has since left that origin. */
export interface RequestSite {
  /** Origin the request was made on, e.g. "https://shop.test". */
  origin: string;
  /** Path (no query or fragment — they can carry tokens), truncated; "" for "/". */
  path: string;
  /** Untruncated path, for the tooltip. */
  fullPath: string;
  /** The tab's current origin when it differs from the request's, else null. */
  movedTo: string | null;
}

function parseUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Label for where a tab is now: its origin, or the bare URL for opaque origins (about:blank, data:). */
function locationLabel(url: URL): string {
  if (url.origin !== "null") return url.origin;
  return truncateMiddle(`${url.protocol}${url.pathname}`, APPROVAL_PATH_MAX);
}

/**
 * Pure: the request's own origin + path (from `PendingApproval.origin`/`url`,
 * never the tab's current URL), and the tab's current origin if it no longer
 * matches. Null when the approval carries neither field (older servers).
 */
export function requestSite(
  approval: Pick<PendingApproval, "url" | "origin">,
  currentUrl?: string
): RequestSite | null {
  const url = parseUrl(approval.url);
  const origin = approval.origin ?? (url && url.origin !== "null" ? url.origin : undefined);
  if (!origin) return null;
  const fullPath = url && url.origin === origin && url.pathname !== "/" ? url.pathname : "";
  const current = parseUrl(currentUrl);
  return {
    origin,
    path: truncateMiddle(fullPath, APPROVAL_PATH_MAX),
    fullPath,
    movedTo: current && current.origin !== origin ? locationLabel(current) : null,
  };
}

export interface ApprovalsOptions {
  root?: ParentNode;
  bridge: ApprovalsBridge;
  /** Human label for a tab id (e.g. its host), for the dialog's meta line. */
  tabLabel?: (tabId: TabId) => string | undefined;
  /** The tab's current URL, to catch an approval whose tab has left the requesting origin. */
  tabUrl?: (tabId: TabId) => string | undefined;
  onLayoutChange?: () => void;
  onDialogOpen?: () => void;
  onDialogClose?: () => void;
  /** A decision produced a follow-up (e.g. a human handoff). */
  onResult?: (result: BrowserCommandResult) => void;
  /** Focus target when the dialog closes and its opener (the Review button) is gone or hidden. */
  fallbackFocus?: () => HTMLElement | null;
}

export interface ApprovalsController {
  /** Replace the pending list (from `onApprovalsChanged` or a refresh). */
  update(pending: PendingApproval[]): void;
  refresh(): Promise<void>;
  /** Open the Review dialog on the oldest pending approval. */
  review(): void;
  pending(): PendingApproval[];
  /** Tabs changed (navigation, close) — re-check origins on screen. */
  tabsChanged(): void;
}

export function mountApprovals(options: ApprovalsOptions): ApprovalsController {
  const root = options.root ?? document;
  const q = <T extends HTMLElement>(id: string): T => {
    const el = root.querySelector<T>(`#${id}`);
    if (!el) throw new Error(`Approval markup missing: #${id}`);
    return el;
  };
  const banner = q<HTMLElement>("approval-banner");
  const bannerIcon = q<HTMLElement>("approval-banner-icon");
  const bannerSummary = q<HTMLElement>("approval-banner-summary");
  const bannerMore = q<HTMLElement>("approval-banner-more");
  const reviewButton = q<HTMLButtonElement>("approval-review-button");
  const announcer = q<HTMLElement>("approval-announcer");
  const modal = q<HTMLElement>("approval-modal");
  const position = q<HTMLElement>("approval-position");
  const copy = q<HTMLElement>("approval-copy");
  const meta = q<HTMLElement>("approval-meta");
  const site = q<HTMLElement>("approval-site");
  const siteOrigin = q<HTMLElement>("approval-site-origin");
  const sitePath = q<HTMLElement>("approval-site-path");
  const moved = q<HTMLElement>("approval-moved");
  const bannerSite = q<HTMLElement>("approval-banner-site");
  const effects = q<HTMLElement>("approval-effects");
  const approveButton = q<HTMLButtonElement>("approval-approve-button");
  const rejectButton = q<HTMLButtonElement>("approval-reject-button");
  const laterButton = q<HTMLButtonElement>("approval-later-button");

  bannerIcon.replaceChildren(icon("shield-alert"));

  let pending: PendingApproval[] = [];
  let seen = new Set<string>();
  let primed = false;
  let dialog: DialogHandle | null = null;
  let shownRequestId: string | null = null;
  let busy = false;
  let opener: HTMLElement | null = null;

  const siteOf = (approval: PendingApproval): RequestSite | null =>
    requestSite(approval, options.tabUrl?.(approval.tabId));

  const renderBanner = (): void => {
    const wasHidden = banner.hidden;
    if (pending.length === 0) {
      banner.hidden = true;
    } else {
      banner.hidden = false;
      bannerSummary.textContent = pending[0].summary;
      const where = siteOf(pending[0]);
      bannerSite.hidden = !where;
      bannerSite.textContent = where ? `${where.origin}${where.path}` : "";
      bannerSite.title = where ? `Requested on ${where.origin}${where.fullPath}` : "";
      bannerMore.textContent = pending.length > 1 ? `+${pending.length - 1} more` : "";
      reviewButton.textContent = pending.length > 1 ? `Review (${pending.length})` : "Review";
    }
    if (wasHidden !== banner.hidden) options.onLayoutChange?.();
  };

  const announce = (next: PendingApproval[]): void => {
    const fresh = next.filter((p) => !seen.has(p.requestId));
    seen = new Set(next.map((p) => p.requestId));
    // The first list (bootstrap) is announced once as a summary; afterwards each new one.
    if (fresh.length === 0) return;
    if (!primed) {
      announcer.textContent = `${next.length} approval${next.length === 1 ? "" : "s"} waiting for review.`;
      return;
    }
    announcer.textContent =
      fresh.length === 1
        ? `New approval request: ${fresh[0].summary}`
        : `${fresh.length} new approval requests. Oldest: ${fresh[0].summary}`;
  };

  const paintDialog = (approval: PendingApproval): void => {
    shownRequestId = approval.requestId;
    const index = pending.findIndex((p) => p.requestId === approval.requestId);
    position.textContent = pending.length > 1 ? `Approval ${index + 1} of ${pending.length}` : "Approval required";
    copy.textContent = approval.summary;
    const tab = options.tabLabel?.(approval.tabId);
    const when = new Date(approval.createdAt).toLocaleTimeString();
    meta.textContent = tab ? `Tab ${tab} · requested ${when}` : `Requested ${when}`;

    const where = siteOf(approval);
    site.hidden = !where;
    siteOrigin.textContent = where?.origin ?? "";
    sitePath.textContent = where?.path ?? "";
    site.title = where ? `${where.origin}${where.fullPath}` : "";
    const movedTo = where?.movedTo ?? null;
    moved.hidden = movedTo === null;
    moved.textContent = movedTo === null ? "" : `This tab has moved to ${movedTo}. Approving is disabled.`;
    const approveHadFocus = document.activeElement === approveButton;
    approveButton.disabled = movedTo !== null;
    if (approveButton.disabled && approveHadFocus) rejectButton.focus();
    const lines = effectLines(approval);
    effects.hidden = lines.length === 0;
    effects.replaceChildren(
      ...lines.map((line) => {
        const item = document.createElement("li");
        item.className = "approval-effect";
        item.textContent = line;
        return item;
      })
    );
  };

  const closeDialog = (): void => {
    if (!dialog) return;
    const handle = dialog;
    dialog = null;
    shownRequestId = null;
    modal.hidden = true;
    handle.close();
    restoreFocus();
    options.onDialogClose?.();
  };

  /** Back to the opener (normally the Review button) if it's still usable, else the fallback. */
  const restoreFocus = (): void => {
    const target = opener;
    opener = null;
    const usable =
      target !== null &&
      target.isConnected &&
      target.closest("[hidden]") === null &&
      !target.hasAttribute("disabled") &&
      !modal.contains(target);
    (usable ? target : options.fallbackFocus?.())?.focus();
  };

  const review = (): void => {
    if (pending.length === 0) return;
    paintDialog(pending[0]);
    if (dialog) return;
    modal.hidden = false;
    options.onDialogOpen?.();
    opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    dialog = openDialog(modal, {
      dismissable: true,
      initialFocus: approveButton.disabled ? rejectButton : approveButton,
      onClose: () => {
        // Escape path: openDialog already restores focus.
        if (dialog) {
          dialog = null;
          shownRequestId = null;
          modal.hidden = true;
          opener = null;
          options.onDialogClose?.();
        }
      },
    });
  };

  const update = (next: PendingApproval[]): void => {
    announce(next);
    primed = true;
    pending = [...next].sort((a, b) => a.createdAt - b.createdAt);
    renderBanner();
    if (dialog) {
      if (pending.length === 0) {
        closeDialog();
      } else if (!pending.some((p) => p.requestId === shownRequestId)) {
        // The one on screen was resolved elsewhere (e.g. by an agent) → show the next.
        paintDialog(pending[0]);
      } else {
        paintDialog(pending.find((p) => p.requestId === shownRequestId)!);
      }
    }
  };

  const refresh = async (): Promise<void> => {
    update(await options.bridge.listPendingApprovals());
  };

  const decide = async (decision: "approve" | "reject"): Promise<void> => {
    const requestId = shownRequestId;
    if (!requestId || busy) return;
    if (decision === "approve" && approveButton.disabled) return;
    busy = true;
    const button = decision === "approve" ? approveButton : rejectButton;
    button.setAttribute("aria-busy", "true");
    try {
      const result =
        decision === "approve"
          ? await options.bridge.approveCommand(requestId)
          : await options.bridge.rejectCommand(requestId);
      if (result.status === "blocked" || result.status === "failed") {
        toast(result.reason, "error");
      } else if (decision === "approve") {
        toast("Approved. The agent can continue.", "success");
      } else {
        toast("Rejected. The agent was told no.", "info");
      }
      options.onResult?.(result);
    } catch (error) {
      toast(`Couldn't ${decision} — ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      busy = false;
      button.removeAttribute("aria-busy");
    }
    // Drop it locally right away; the authoritative list follows via onApprovalsChanged.
    update(pending.filter((p) => p.requestId !== requestId));
    try {
      await refresh();
    } catch {
      /* the change event will catch us up */
    }
  };

  reviewButton.addEventListener("click", review);
  approveButton.addEventListener("click", () => void decide("approve"));
  rejectButton.addEventListener("click", () => void decide("reject"));
  laterButton.addEventListener("click", closeDialog);
  renderBanner();

  const tabsChanged = (): void => {
    renderBanner();
    if (dialog && shownRequestId) {
      const shown = pending.find((p) => p.requestId === shownRequestId);
      if (shown) paintDialog(shown);
    }
  };

  return { update, refresh, review, pending: () => pending, tabsChanged };
}
