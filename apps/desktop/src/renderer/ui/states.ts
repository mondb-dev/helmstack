/**
 * Pure DOM builders for empty / loading states (styleguide §3.13).
 * Deterministic — they only touch `document`, no app state — so they unit-test
 * cleanly under jsdom and are reused by the render functions in shell.ts.
 */

export interface EmptyStateOptions {
  title: string;
  hint?: string;
}

/** `<div class="empty-state">` with a title and optional hint line. */
export function buildEmptyState(options: EmptyStateOptions): HTMLDivElement {
  const root = document.createElement("div");
  root.className = "empty-state";

  const title = document.createElement("p");
  title.className = "empty-state__title";
  title.textContent = options.title;
  root.append(title);

  if (options.hint) {
    const hint = document.createElement("p");
    hint.className = "empty-state__hint";
    hint.textContent = options.hint;
    root.append(hint);
  }

  return root;
}

/** A fragment of `count` shimmering skeleton rows for in-flight lists. */
export function buildSkeletonRows(count: number): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < Math.max(0, count); i += 1) {
    const row = document.createElement("div");
    row.className = "skeleton skeleton--row";
    fragment.append(row);
  }
  return fragment;
}
