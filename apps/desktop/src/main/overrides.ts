import type { WebContents } from "electron";

import type { TabRecord } from "./tab-manager.js"; // type-only — erased at runtime, no cycle

/**
 * Per-tab device/network emulation appliers — media features, CPU/network
 * resource budgets, and geolocation/timezone/locale overrides — pushed to the
 * page over CDP. Extracted from `TabManager`. Each reads the override state off
 * the `TabRecord` and is a no-op when that state is unset.
 */
function ensureAttached(webContents: WebContents): void {
  if (!webContents.debugger.isAttached()) webContents.debugger.attach("1.3");
}

export async function applyMediaEmulation(tab: TabRecord): Promise<void> {
  const emulation = tab.mediaEmulation;
  if (!emulation) return;

  const { webContents } = tab.view;
  ensureAttached(webContents);

  const features: Array<{ name: string; value: string }> = [];
  if (emulation.colorScheme) features.push({ name: "prefers-color-scheme", value: emulation.colorScheme });
  if (emulation.reducedMotion) features.push({ name: "prefers-reduced-motion", value: emulation.reducedMotion });
  if (emulation.forcedColors) features.push({ name: "forced-colors", value: emulation.forcedColors });

  await webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
    media: emulation.media ?? "",
    features
  }).catch(() => {});
}

export async function applyResourceBudget(tab: TabRecord): Promise<void> {
  const budget = tab.resourceBudget;
  if (!budget) return;

  const { webContents } = tab.view;
  ensureAttached(webContents);

  await webContents.debugger.sendCommand("Emulation.setCPUThrottlingRate", {
    rate: Math.max(1, budget.cpuThrottlingRate ?? 1)
  }).catch(() => {});

  await webContents.debugger.sendCommand("Network.emulateNetworkConditions", {
    offline: budget.offline ?? false,
    latency: budget.latencyMs ?? 0,
    downloadThroughput: budget.downloadThroughputKbps ? budget.downloadThroughputKbps * 1024 / 8 : -1,
    uploadThroughput: budget.uploadThroughputKbps ? budget.uploadThroughputKbps * 1024 / 8 : -1
  }).catch(() => {});
}

export async function applyLocationOverride(tab: TabRecord): Promise<void> {
  const location = tab.locationOverride;
  if (!location) return;

  const { webContents } = tab.view;
  ensureAttached(webContents);

  await webContents.debugger.sendCommand("Emulation.setGeolocationOverride", {
    latitude: location.latitude,
    longitude: location.longitude,
    accuracy: location.accuracy ?? 1
  }).catch(() => {});

  if (location.timezoneId) {
    await webContents.debugger.sendCommand("Emulation.setTimezoneOverride", { timezoneId: location.timezoneId }).catch(() => {});
  }

  if (location.locale) {
    await webContents.debugger.sendCommand("Emulation.setLocaleOverride", { locale: location.locale }).catch(() => {});
  }
}
