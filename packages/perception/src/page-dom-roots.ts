/**
 * Single source of truth for cross-root DOM traversal in the page world.
 *
 * Both observation (`dom-extractor`, bundled into the preload) and actuation
 * (`dom-actuator`, injected as a string via `executeJavaScript`) must agree on
 * exactly which roots are reachable, or a selector seen during observation can
 * fail to resolve during actuation. To keep them in lock-step:
 *
 *  - observation imports {@link collectQueryRoots} directly (the bundler inlines it);
 *  - actuation injects {@link COLLECT_QUERY_ROOTS_SOURCE}, which is derived from
 *    the very same function via `.toString()`, so the two can never drift.
 *
 * The function is intentionally self-contained (no external helpers, only DOM
 * globals) so its serialized form runs verbatim in the page.
 */
export function collectQueryRoots(startDoc: Document): Array<Document | ShadowRoot> {
  const roots: Array<Document | ShadowRoot> = [startDoc];
  const pending: Array<Document | ShadowRoot> = [startDoc];
  const seen = new Set<Node>([startDoc]);

  while (pending.length > 0) {
    const current = pending.shift() as Document | ShadowRoot;
    for (const element of Array.from(current.querySelectorAll("*"))) {
      const shadow = (element as HTMLElement).shadowRoot;
      if (shadow && !seen.has(shadow)) {
        seen.add(shadow);
        roots.push(shadow);
        pending.push(shadow);
      }

      if (element instanceof HTMLIFrameElement) {
        let frameDocument: Document | null;
        try {
          frameDocument = element.contentDocument;
        } catch {
          frameDocument = null; // cross-origin iframe — not reachable
        }
        if (frameDocument && !seen.has(frameDocument)) {
          seen.add(frameDocument);
          roots.push(frameDocument);
          pending.push(frameDocument);
        }
      }
    }
  }

  return roots;
}

/**
 * Page-world source for {@link collectQueryRoots}, derived from the function
 * itself so it can never drift from the typed implementation. Inject as
 * `(${COLLECT_QUERY_ROOTS_SOURCE})(document)`.
 */
export const COLLECT_QUERY_ROOTS_SOURCE = collectQueryRoots.toString();
