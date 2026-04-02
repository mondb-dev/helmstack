/**
 * HelmStack — intent-driven example agent
 *
 * Connects to the browser substrate, waits for an intent from the task panel,
 * then navigates to the target and reports back what it sees.
 *
 * All output appears in the terminal panel inside the HelmStack UI.
 *
 * Prerequisites:
 *   1.  `npm run dev` in the repo root (launches the Electron browser)
 *   2.  `npm run start -w @helmstack/agent-example`
 */

import { createBrowserClient } from "@helmstack/agent-sdk";

const browser = createBrowserClient();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Log to both local console AND the HelmStack terminal panel. */
async function log(msg: string, level: "system" | "agent" | "ai" | "error" | "nav" = "agent") {
  console.log(`[agent] ${msg}`);
  await browser.log(msg, level).catch(() => {});
}

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ── Intent handler ────────────────────────────────────────────────────────────

async function handleIntent(intent: string) {
  await log(`Received intent: "${intent}"`, "system");

  const tabs = await browser.listTabs();
  const activeTab = tabs.find((t) => t.isActive);
  if (!activeTab) {
    await log("No active tab — opening one.", "error");
    const newTabs = await browser.openTab();
    const tab = newTabs.find((t) => t.isActive);
    if (!tab) {
      await log("Failed to open a tab.", "error");
      return;
    }
    await executeIntent(intent, tab.id);
  } else {
    await executeIntent(intent, activeTab.id);
  }
}

async function executeIntent(intent: string, tabId: string) {
  // Try to extract a URL from the intent
  const urlMatch = intent.match(/https?:\/\/[^\s]+/);
  const words = intent.toLowerCase();

  if (urlMatch) {
    const target = urlMatch[0];
    await log(`Navigating to ${target}`, "nav");
    await browser.navigate(tabId, target);
    await delay(2000);
  } else if (words.includes("go to") || words.includes("navigate to") || words.includes("open")) {
    // Extract the site name after "go to" / "navigate to" / "open"
    const siteMatch = intent.match(/(?:go to|navigate to|open)\s+(.+?)(?:\s+and\s+|\s*$)/i);
    if (siteMatch) {
      const target = siteMatch[1].trim();
      const url = target.includes(".") ? `https://${target}` : `https://www.google.com/search?q=${encodeURIComponent(target)}`;
      await log(`Navigating to ${url}`, "nav");
      await browser.navigate(tabId, url);
      await delay(2000);
    }
  } else {
    await log(`Searching Google for: ${intent}`, "nav");
    await browser.navigate(tabId, `https://www.google.com/search?q=${encodeURIComponent(intent)}`);
    await delay(2000);
  }

  // Capture perception
  await log("Capturing page perception...", "agent");
  const perception = await browser.getPerception(tabId);
  const g = perception.result.graph;

  await log(`Page: ${perception.result.snapshot.title}`, "agent");
  await log(`Kind: ${g.pageKind} — ${g.forms.length} forms, ${g.actions.length} actions`, "agent");

  if (g.headings.length) {
    const h1 = g.headings.find((h) => h.level === 1);
    if (h1) await log(`H1: ${h1.text}`, "agent");
  }

  if (g.alerts.length) {
    for (const alert of g.alerts) {
      await log(`Alert: ${alert}`, "agent");
    }
  }

  // Report forms if found
  if (g.forms.length > 0) {
    for (const form of g.forms) {
      await log(`Form: "${form.purpose}" — ${form.fields.length} fields`, "agent");
      for (const field of form.fields.slice(0, 5)) {
        await log(`  Field: ${field.label} (${field.fieldType}${field.required ? ", required" : ""})`, "agent");
      }
      if (form.fields.length > 5) await log(`  ... and ${form.fields.length - 5} more fields`, "agent");
    }
  }

  // Report links/actions summary
  if (g.actions.length > 0) {
    const topActions = g.actions.slice(0, 5);
    await log(`Top actions:`, "agent");
    for (const action of topActions) {
      await log(`  ${action.label || action.ariaLabel || "(unlabeled)"}`, "agent");
    }
    if (g.actions.length > 5) await log(`  ... and ${g.actions.length - 5} more`, "agent");
  }

  await log("Done processing intent.", "system");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Health check
  const health = await browser.health().catch(() => null);
  if (!health) {
    console.error("[agent] Cannot reach HelmStack on 127.0.0.1:7070. Start the browser first: npm run dev");
    process.exit(1);
  }

  await log("Agent connected. Type an intent in the task panel and press Run.", "system");
  await log(`${health.tabs} tab(s) open.`, "system");

  // Check if there's already an intent waiting
  const { intent: existing } = await browser.getIntent();
  if (existing.trim()) {
    await handleIntent(existing.trim());
  }

  // Subscribe to intent changes via SSE
  browser.stream({
    onIntentChanged: (data) => {
      if (data.intent.trim()) {
        void handleIntent(data.intent.trim());
      }
    },
    onError: (err) => {
      console.error("[agent] SSE error:", err.message);
    }
  });

  // Keep alive
  await log("Listening for intents... (Ctrl+C to stop)", "system");
}

main().catch((err: unknown) => {
  console.error("[agent] Fatal error:", err);
  process.exit(1);
});
