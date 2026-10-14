/**
 * Small, DOM-free formatting helpers shared by the shell panels.
 */

/** Host of a URL for compact labels; falls back to the raw value. */
export function safeHostLabel(value: string): string {
  try {
    return new URL(value).host || value;
  } catch {
    return value;
  }
}

/** Address-bar input → navigable URL (scheme kept, bare words → search). */
export function normalizeNavigationTarget(rawValue: string): string | null {
  const value = rawValue.trim();
  if (!value) {
    return null;
  }
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value)) {
    return value;
  }
  if (/\s/.test(value)) {
    return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
  }
  return `https://${value}`;
}

/** "just now", "12s ago", "3m ago", "2h ago", "4d ago". */
export function relativeTime(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** "1 client" / "3 clients". */
export function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}
