/**
 * Override chips strip: one chip per agent-applied override on the active tab
 * (viewport, media, throttling, location, mocks, recording, watches). Each chip
 * opens a popover with details and a per-kind "Clear"; "Clear all" resets the
 * tab. Chips are reconciled by kind so an open popover / focused chip survives
 * live updates.
 */

import type { BrowserShellBridge, TabId, TabOverrideKind, TabOverrides, ViewportOverride } from "../../../../../packages/shared/src/index.js";
import { icon } from "../ui/icons.js";
import { createPopover, type PopoverController } from "../ui/popover.js";
import { plural } from "../ui/format.js";
import { toast } from "../ui/toast.js";

export type OverridesBridge = Pick<BrowserShellBridge, "getTabOverrides" | "clearTabOverrides">;

export interface OverrideChip {
  kind: TabOverrideKind;
  /** Short chip text, e.g. "390×844 · mobile". */
  label: string;
  /** Popover heading, e.g. "Viewport". */
  title: string;
  tone: "warning" | "danger";
  details: Array<[key: string, value: string]>;
}

/** Canonical chip order. */
export const OVERRIDE_KINDS: TabOverrideKind[] = [
  "viewport",
  "media",
  "resourceBudget",
  "location",
  "networkMock",
  "recording",
  "watches",
];

const MEDIA_TYPE_LABEL: Record<string, string> = { print: "Print", screen: "Screen" };

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Pure: TabOverrides → chips to render, in canonical order. */
export function describeOverrides(overrides: TabOverrides): OverrideChip[] {
  const chips: OverrideChip[] = [];
  const { viewport, media, resourceBudget, location, networkMockRuleCount, recording, watches } = overrides;

  if (viewport) {
    chips.push({
      kind: "viewport",
      title: "Viewport",
      label: `${viewport.width}×${viewport.height}${viewport.mobile ? " · mobile" : ""}`,
      tone: "warning",
      details: [
        ["Size", `${viewport.width} × ${viewport.height} px`],
        ["Mobile emulation", viewport.mobile ? "On" : "Off"],
      ],
    });
  }

  if (media) {
    const parts: string[] = [];
    const details: Array<[string, string]> = [];
    if (media.colorScheme && media.colorScheme !== "no-preference") {
      parts.push(capitalize(media.colorScheme));
    }
    if (media.colorScheme) details.push(["Color scheme", media.colorScheme]);
    if (media.reducedMotion === "reduce") parts.push("Reduced motion");
    if (media.reducedMotion) details.push(["Reduced motion", media.reducedMotion]);
    if (media.forcedColors === "active") parts.push("Forced colors");
    if (media.forcedColors) details.push(["Forced colors", media.forcedColors]);
    if (media.media && media.media !== "screen") parts.push(MEDIA_TYPE_LABEL[media.media] ?? capitalize(media.media));
    if (media.media) details.push(["Media type", media.media]);
    chips.push({
      kind: "media",
      title: "Media emulation",
      label: parts.length > 0 ? parts.join(" · ") : "Media",
      tone: "warning",
      details,
    });
  }

  if (resourceBudget) {
    const parts: string[] = [];
    const details: Array<[string, string]> = [];
    const { cpuThrottlingRate, offline, downloadThroughputKbps, uploadThroughputKbps, latencyMs, maxJsHeapMb } = resourceBudget;
    if (cpuThrottlingRate && cpuThrottlingRate > 1) {
      parts.push(`${cpuThrottlingRate}× CPU`);
      details.push(["CPU slowdown", `${cpuThrottlingRate}×`]);
    }
    if (offline) {
      parts.push("Offline");
      details.push(["Network", "Offline"]);
    } else if (downloadThroughputKbps !== undefined || uploadThroughputKbps !== undefined || latencyMs !== undefined) {
      parts.push("Slow network");
    }
    if (downloadThroughputKbps !== undefined) details.push(["Download", `${downloadThroughputKbps} kbps`]);
    if (uploadThroughputKbps !== undefined) details.push(["Upload", `${uploadThroughputKbps} kbps`]);
    if (latencyMs !== undefined) details.push(["Latency", `${latencyMs} ms`]);
    if (maxJsHeapMb !== undefined) {
      parts.push(`${maxJsHeapMb} MB heap`);
      details.push(["JS heap budget", `${maxJsHeapMb} MB`]);
    }
    chips.push({
      kind: "resourceBudget",
      title: "Throttling",
      label: parts.length > 0 ? parts.join(" · ") : "Throttling",
      tone: "warning",
      details,
    });
  }

  if (location) {
    const details: Array<[string, string]> = [
      ["Latitude", String(location.latitude)],
      ["Longitude", String(location.longitude)],
    ];
    if (location.accuracy !== undefined) details.push(["Accuracy", `${location.accuracy} m`]);
    if (location.timezoneId) details.push(["Time zone", location.timezoneId]);
    if (location.locale) details.push(["Locale", location.locale]);
    chips.push({
      kind: "location",
      title: "Location",
      label: location.timezoneId ? `Location · ${location.timezoneId}` : "Location",
      tone: "warning",
      details,
    });
  }

  if (networkMockRuleCount > 0) {
    chips.push({
      kind: "networkMock",
      title: "Network mocks",
      label: plural(networkMockRuleCount, "mock"),
      tone: "warning",
      details: [["Active rules", String(networkMockRuleCount)]],
    });
  }

  if (recording) {
    chips.push({
      kind: "recording",
      title: "Recording",
      label: "Recording",
      tone: "warning",
      details: [["Status", "An agent is recording this tab"]],
    });
  }

  if (watches.total > 0) {
    chips.push({
      kind: "watches",
      title: "Watches",
      label: `Watches ${watches.passing}/${watches.total}`,
      tone: watches.failing > 0 ? "danger" : "warning",
      details: [
        ["Passing", String(watches.passing)],
        ["Failing", String(watches.failing)],
        ["Total", String(watches.total)],
      ],
    });
  }

  return chips;
}

interface ChipView {
  item: HTMLLIElement;
  button: HTMLButtonElement;
  text: HTMLSpanElement;
  glyph: HTMLSpanElement;
  panel: HTMLDivElement;
  popover: PopoverController;
  chip: OverrideChip;
}

export interface OverridesStripOptions {
  root?: ParentNode;
  bridge: OverridesBridge;
  /** Called after the strip's visibility or size may have changed. */
  onLayoutChange?: () => void;
  /** Popover open/close hooks (the shell freeze-frames the page meanwhile). */
  onPopoverOpen?: (key: string) => void;
  onPopoverClose?: (key: string) => void;
  /** Where focus goes when the last chip disappears under it. */
  fallbackFocus?: () => HTMLElement | null;
}

export interface OverridesStrip {
  /** Switch to `tabId` and fetch its overrides. */
  setActiveTab(tabId: TabId | undefined): Promise<void>;
  /** Live update from `onTabOverridesChanged`; ignored for other tabs. */
  update(overrides: TabOverrides): void;
  chips(): OverrideChip[];
  /** The active tab's agent-applied viewport size, or null. */
  viewportOverride(): ViewportOverride | null;
}

export function mountOverridesStrip(options: OverridesStripOptions): OverridesStrip {
  const root = options.root ?? document;
  const strip = root.querySelector<HTMLElement>("#override-strip");
  const list = root.querySelector<HTMLUListElement>("#override-chips");
  const clearAll = root.querySelector<HTMLButtonElement>("#override-clear-all");
  if (!strip || !list || !clearAll) {
    throw new Error("Override strip markup missing.");
  }

  let activeTabId: TabId | undefined;
  let current: OverrideChip[] = [];
  let viewport: ViewportOverride | null = null;
  const views = new Map<TabOverrideKind, ChipView>();

  const clear = async (kind: TabOverrideKind | "all"): Promise<void> => {
    if (!activeTabId) return;
    const tabId = activeTabId;
    try {
      const next = await options.bridge.clearTabOverrides(tabId, kind);
      update(next);
      toast(kind === "all" ? "Cleared all overrides on this tab." : "Override cleared.", "success");
    } catch (error) {
      toast(`Couldn't clear the override — ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  const buildPanel = (view: ChipView): void => {
    const { chip, panel } = view;
    const heading = document.createElement("p");
    heading.className = "popover__title";
    heading.textContent = chip.title;

    const kv = document.createElement("dl");
    kv.className = "kv";
    for (const [key, value] of chip.details) {
      const dt = document.createElement("dt");
      dt.className = "kv__key";
      dt.textContent = key;
      const dd = document.createElement("dd");
      dd.className = "kv__val";
      dd.textContent = value;
      kv.append(dt, dd);
    }

    const actions = document.createElement("div");
    actions.className = "popover__actions";
    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.className = "btn btn--sm btn--ghost";
    clearButton.textContent = "Clear";
    clearButton.setAttribute("aria-label", `Clear ${chip.title.toLowerCase()} override`);
    clearButton.addEventListener("click", () => void clear(chip.kind));
    actions.append(clearButton);

    panel.replaceChildren(heading, kv, actions);
  };

  const paintChip = (view: ChipView, chip: OverrideChip, fresh = false): void => {
    const detailsChanged = fresh || JSON.stringify(view.chip) !== JSON.stringify(chip);
    view.chip = chip;
    view.text.textContent = chip.label;
    view.button.className = `override-chip override-chip--${chip.tone}`;
    view.button.dataset.kind = chip.kind;
    const failing = chip.tone === "danger" ? ", failing" : "";
    view.button.setAttribute("aria-label", `${chip.title}: ${chip.label}${failing}`);
    view.glyph.replaceChildren(icon(chip.tone === "danger" ? "circle-x" : "triangle-alert", { size: 14 }));
    // Only rebuild the popover body when its content changed, so focus inside
    // an open popover survives unrelated live updates.
    if (detailsChanged) buildPanel(view);
  };

  const createChip = (chip: OverrideChip): ChipView => {
    const item = document.createElement("li");
    item.className = "override-strip__item";
    const button = document.createElement("button");
    button.type = "button";
    const glyph = document.createElement("span");
    glyph.className = "override-chip__icon";
    const text = document.createElement("span");
    text.className = "override-chip__text";
    button.append(glyph, text);
    const panel = document.createElement("div");
    panel.id = `override-popover-${chip.kind}`;
    item.append(button, panel);
    const key = `override:${chip.kind}`;
    const popover = createPopover(button, panel, {
      label: `${chip.title} override`,
      onOpen: () => options.onPopoverOpen?.(key),
      onClose: () => options.onPopoverClose?.(key),
    });
    const view: ChipView = { item, button, text, glyph, panel, popover, chip };
    paintChip(view, chip, true);
    return view;
  };

  const render = (): void => {
    const focusedKind = [...views.entries()].find(([, v]) => v.item.contains(document.activeElement))?.[0];
    const nextKinds = new Set(current.map((c) => c.kind));

    for (const [kind, view] of views) {
      if (!nextKinds.has(kind)) {
        view.popover.destroy();
        view.item.remove();
        views.delete(kind);
      }
    }

    const ordered: HTMLLIElement[] = [];
    for (const chip of current) {
      let view = views.get(chip.kind);
      if (view) {
        paintChip(view, chip);
      } else {
        view = createChip(chip);
        views.set(chip.kind, view);
      }
      ordered.push(view.item);
    }
    // Re-order without detaching nodes that are already in place (keeps focus).
    ordered.forEach((item, index) => {
      if (list.children[index] !== item) list.insertBefore(item, list.children[index] ?? null);
    });

    const wasHidden = strip.hidden;
    strip.hidden = current.length === 0;

    // Focus fell out with a removed chip → move to a sensible neighbour.
    if (focusedKind && !views.has(focusedKind) && (document.activeElement === document.body || !document.activeElement)) {
      const first = views.values().next().value as ChipView | undefined;
      (first?.button ?? options.fallbackFocus?.() ?? null)?.focus();
    }

    if (wasHidden !== strip.hidden || current.length > 0) {
      options.onLayoutChange?.();
    }
  };

  const update = (overrides: TabOverrides): void => {
    if (overrides.tabId !== activeTabId) return;
    viewport = overrides.viewport;
    current = describeOverrides(overrides);
    render();
  };

  clearAll.addEventListener("click", () => void clear("all"));

  return {
    async setActiveTab(tabId) {
      activeTabId = tabId;
      viewport = null;
      if (!tabId) {
        current = [];
        render();
        return;
      }
      try {
        update(await options.bridge.getTabOverrides(tabId));
      } catch {
        current = [];
        render();
      }
    },
    update,
    chips: () => current,
    viewportOverride: () => viewport,
  };
}
