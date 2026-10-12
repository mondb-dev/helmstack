import type { CdpTarget, LocationOverride, MediaEmulation, ResourceBudget } from "../../../../shared/src/index.js";

/**
 * Per-tab device/network emulation appliers — media features, CPU/network
 * resource budgets, and geolocation/timezone/locale overrides — pushed to the
 * page over CDP. Extracted from `TabManager`. Each takes the tab's current
 * override state and is a no-op when that state is unset.
 */
export async function applyMediaEmulation(target: CdpTarget, emulation: MediaEmulation | null): Promise<void> {
  if (!emulation) return;

  const features: Array<{ name: string; value: string }> = [];
  if (emulation.colorScheme) features.push({ name: "prefers-color-scheme", value: emulation.colorScheme });
  if (emulation.reducedMotion) features.push({ name: "prefers-reduced-motion", value: emulation.reducedMotion });
  if (emulation.forcedColors) features.push({ name: "forced-colors", value: emulation.forcedColors });

  await target.send("Emulation.setEmulatedMedia", {
    media: emulation.media ?? "",
    features
  }).catch(() => {});
}

export async function applyResourceBudget(target: CdpTarget, budget: ResourceBudget | null): Promise<void> {
  if (!budget) return;

  await target.send("Emulation.setCPUThrottlingRate", {
    rate: Math.max(1, budget.cpuThrottlingRate ?? 1)
  }).catch(() => {});

  await target.send("Network.emulateNetworkConditions", {
    offline: budget.offline ?? false,
    latency: budget.latencyMs ?? 0,
    downloadThroughput: budget.downloadThroughputKbps ? budget.downloadThroughputKbps * 1024 / 8 : -1,
    uploadThroughput: budget.uploadThroughputKbps ? budget.uploadThroughputKbps * 1024 / 8 : -1
  }).catch(() => {});
}

export async function applyLocationOverride(target: CdpTarget, location: LocationOverride | null): Promise<void> {
  if (!location) return;

  await target.send("Emulation.setGeolocationOverride", {
    latitude: location.latitude,
    longitude: location.longitude,
    accuracy: location.accuracy ?? 1
  }).catch(() => {});

  if (location.timezoneId) {
    await target.send("Emulation.setTimezoneOverride", { timezoneId: location.timezoneId }).catch(() => {});
  }

  if (location.locale) {
    await target.send("Emulation.setLocaleOverride", { locale: location.locale }).catch(() => {});
  }
}
