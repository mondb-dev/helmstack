import type {
  FormPurpose,
  MediaReadyState,
  ObservedAction,
  ObservedField,
  ObservedForm,
  ObservedMedia,
  PageKind,
  PageObservation,
  TabId
} from "../../shared/src/index.js";

const OAUTH_PROVIDERS = ["google", "github", "apple", "microsoft", "facebook", "x", "twitter"];

export function extractPageObservation(tabId: TabId): PageObservation {
  const headings = collectHeadings();
  const forms = collectForms();
  const primaryActions = collectPrimaryActions();
  const alerts = collectAlerts();
  const media = collectMedia();

  return {
    tabId,
    url: window.location.href,
    title: document.title,
    timestamp: Date.now(),
    pageKind: classifyPageKind(forms, primaryActions, headings),
    headings,
    forms,
    primaryActions,
    alerts,
    media
  };
}

export function installPageObservationStream(notify: () => void) {
  let scheduled = false;

  const schedule = () => {
    if (scheduled) {
      return;
    }

    scheduled = true;
    window.setTimeout(() => {
      scheduled = false;
      notify();
    }, 150);
  };

  const start = () => {
    const root = document.documentElement;
    if (!root) {
      schedule();
      return;
    }

    const observed = new WeakSet<Node>();
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          observeNestedRoots(node);
        }
      }
      schedule();
    });

    const observeNode = (node: Node) => {
      if (observed.has(node)) {
        return;
      }

      observed.add(node);
      observer.observe(node, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true
      });
    };

    const observeNestedRoots = (node: Node) => {
      for (const element of collectNestedElements(node)) {
        if (element.shadowRoot) {
          observeNode(element.shadowRoot);
          observeNestedRoots(element.shadowRoot);
        }

        if (element instanceof HTMLIFrameElement) {
          element.addEventListener("load", schedule);
          const frameDocument = getIframeDocument(element);
          if (frameDocument?.documentElement) {
            observeNode(frameDocument.documentElement);
            observeNestedRoots(frameDocument);
          }
        }
      }
    };

    observeNode(root);
    observeNestedRoots(document);

    const wrapHistory = (method: "pushState" | "replaceState") => {
      const original = history[method];
      history[method] = function wrappedHistoryState(...args) {
        const result = original.apply(this, args);
        schedule();
        return result;
      };
    };

    wrapHistory("pushState");
    wrapHistory("replaceState");

    window.addEventListener("load", schedule);
    window.addEventListener("hashchange", schedule);
    window.addEventListener("popstate", schedule);
    schedule();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}

function collectForms(): ObservedForm[] {
  return collectElementsAcrossRoots("form")
    .filter((form): form is HTMLFormElement => form instanceof HTMLFormElement)
    .filter((form) => isVisible(form))
    .map((form, index) => {
      const fields = [...form.elements]
        .filter((element): element is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement => {
          return element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement;
        })
        .filter((field) => isVisible(field))
        .map((field, fieldIndex) => extractField(field, fieldIndex));

      const submitActions = collectActions(form).filter((action) => action.kind === "submit" || action.kind === "oauth");
      const nearbyHeadings = collectScopedHeadings(form);

      return {
        id: `form-${index + 1}`,
        name: form.getAttribute("name") || undefined,
        purpose: inferFormPurpose(fields, submitActions, nearbyHeadings),
        selectorHint: buildSelectorHint(form),
        fields,
        submitActions
      };
    });
}

function collectPrimaryActions(): ObservedAction[] {
  return dedupeActions(mapActionElements(collectElementsAcrossRoots("button, input[type='submit'], input[type='button'], a[href], [role='button']"))).slice(
    0,
    12
  );
}

function collectActions(root: ParentNode): ObservedAction[] {
  return mapActionElements([...root.querySelectorAll("button, input[type='submit'], input[type='button'], a[href], [role='button']")]);
}

function mapActionElements(elements: Element[]): ObservedAction[] {
  const actionElements = elements.filter((element): element is HTMLElement => element instanceof HTMLElement && isVisible(element));

  return actionElements.map((element, index) => {
    const label = getActionLabel(element) || `${element.tagName.toLowerCase()}-${index + 1}`;
    const provider = detectOAuthProvider(label);
    const kind: ObservedAction["kind"] =
      element instanceof HTMLAnchorElement ? (provider ? "oauth" : "link") : provider ? "oauth" : isSubmitElement(element) ? "submit" : "button";

    return {
      id: `action-${index + 1}`,
      label,
      kind,
      selectorHint: buildSelectorHint(element),
      href: element instanceof HTMLAnchorElement ? element.href : undefined,
      provider,
      disabled: isDisabled(element)
    };
  });
}

function collectHeadings(): string[] {
  return dedupeStrings(
    collectElementsAcrossRoots("h1, h2, h3")
      .filter((node) => isVisible(node))
      .map((node) => normalizeText(node.textContent))
      .filter(Boolean)
  ).slice(0, 6);
}

function collectScopedHeadings(element: Element): string[] {
  const local = element.querySelector("h1, h2, h3");
  const labels = [local?.textContent, element.getAttribute("aria-label"), element.getAttribute("name")];
  return dedupeStrings(labels.map(normalizeText).filter(Boolean)).slice(0, 3);
}

function collectAlerts(): string[] {
  const candidates = collectElementsAcrossRoots("[role='alert'], [aria-live], .error, .errors, [data-error], [data-testid*='error']");

  return dedupeStrings(
    candidates
      .filter((element) => isVisible(element))
      .map((element) => normalizeText(element.textContent))
      .filter(Boolean)
  ).slice(0, 8);
}

const READY_STATE_LABELS: MediaReadyState[] = [
  "have_nothing",
  "have_metadata",
  "have_current_data",
  "have_future_data",
  "have_enough_data"
];

function collectMedia(): ObservedMedia[] {
  return collectElementsAcrossRoots("video, audio")
    .filter((el): el is HTMLVideoElement | HTMLAudioElement =>
      el instanceof HTMLVideoElement || el instanceof HTMLAudioElement
    )
    .filter((el) => {
      // Video must be visible. Audio is often invisible — include if it has a source.
      if (el instanceof HTMLAudioElement) {
        return el.currentSrc || el.src || el.readyState > 0;
      }
      return isVisible(el);
    })
    .slice(0, 8)
    .map((el, index): ObservedMedia => {
      const src = el.currentSrc || el.getAttribute("src") || undefined;
      const title =
        normalizeText(el.getAttribute("title")) ||
        normalizeText(el.getAttribute("aria-label")) ||
        undefined;

      return {
        id: `media-${index + 1}`,
        kind: el instanceof HTMLVideoElement ? "video" : "audio",
        ...(src ? { src } : {}),
        ...(title ? { title } : {}),
        paused: el.paused,
        muted: el.muted,
        volume: el.volume,
        currentTime: el.currentTime,
        duration: el.duration,
        loop: el.loop,
        readyState: READY_STATE_LABELS[el.readyState] ?? "have_nothing",
        selectorHint: buildSelectorHint(el)
      };
    });
}

function extractField(field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, index: number): ObservedField {
  return {
    id: `field-${index + 1}`,
    label: getFieldLabel(field),
    name: field.getAttribute("name") || undefined,
    fieldType: getFieldType(field),
    autocomplete: field.getAttribute("autocomplete") || undefined,
    placeholder: field.getAttribute("placeholder") || undefined,
    required: field.matches(":required") || field.getAttribute("aria-required") === "true",
    selectorHint: buildSelectorHint(field)
  };
}

function inferFormPurpose(fields: ObservedField[], actions: ObservedAction[], headings: string[]): FormPurpose {
  const fieldKinds = new Set(fields.map((field) => field.fieldType));
  const text = `${headings.join(" ")} ${actions.map((action) => action.label).join(" ")}`.toLowerCase();

  if (/(sign up|create account|register|join)/.test(text)) {
    return "signup";
  }

  if (/(sign in|log in|login)/.test(text)) {
    return "login";
  }

  if (fieldKinds.has("password") && (fieldKinds.has("email") || fieldKinds.has("text"))) {
    return /continue|next|verify/.test(text) ? "verification" : "auth";
  }

  if (fieldKinds.has("tel") || fieldKinds.has("address-line1")) {
    return "profile";
  }

  return "generic";
}

function classifyPageKind(forms: ObservedForm[], actions: ObservedAction[], headings: string[]): PageKind {
  const composite = `${headings.join(" ")} ${actions.map((action) => action.label).join(" ")}`.toLowerCase();

  if (/(checkout|payment|billing|shipping)/.test(composite)) {
    return "checkout";
  }

  if (forms.some((form) => form.purpose === "signup") || /(sign up|create account|register)/.test(composite)) {
    return "signup";
  }

  if (forms.some((form) => form.purpose === "login" || form.purpose === "auth") || /(sign in|log in|login)/.test(composite)) {
    return "login";
  }

  if (forms.length > 0) {
    return "form";
  }

  if (actions.length > 8) {
    return "dashboard";
  }

  return "landing";
}

function getFieldLabel(field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): string {
  if ("labels" in field && field.labels?.length) {
    const label = normalizeText([...field.labels].map((entry) => entry.textContent).join(" "));
    if (label) {
      return label;
    }
  }

  const ariaLabel = normalizeText(field.getAttribute("aria-label"));
  if (ariaLabel) {
    return ariaLabel;
  }

  const labelledBy = field.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = normalizeText(resolveLabelledByText(field, labelledBy));
    if (text) {
      return text;
    }
  }

  const nearestLabel = normalizeText(field.closest("label")?.textContent);
  if (nearestLabel) {
    return nearestLabel;
  }

  return (
    normalizeText(field.getAttribute("placeholder")) ||
    normalizeText(field.getAttribute("name")) ||
    normalizeText(field.getAttribute("id")) ||
    field.tagName.toLowerCase()
  );
}

function getFieldType(field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): ObservedField["fieldType"] {
  if (field instanceof HTMLTextAreaElement) {
    return "textarea";
  }

  if (field instanceof HTMLSelectElement) {
    return "select";
  }

  const autocomplete = (field.getAttribute("autocomplete") || "").toLowerCase();
  if (autocomplete === "address-line1") {
    return "address-line1";
  }

  const type = field.type.toLowerCase();
  switch (type) {
    case "email":
    case "password":
    case "tel":
    case "url":
    case "search":
    case "checkbox":
    case "radio":
    case "date":
    case "number":
      return type;
    default:
      return "text";
  }
}

function getActionLabel(element: HTMLElement): string {
  return (
    normalizeText(element.getAttribute("aria-label")) ||
    normalizeText(element.getAttribute("title")) ||
    normalizeText("value" in element ? String((element as HTMLInputElement).value) : "") ||
    normalizeText(element.textContent) ||
    element.tagName.toLowerCase()
  );
}

function detectOAuthProvider(label: string): string | undefined {
  const lower = label.toLowerCase();
  return OAUTH_PROVIDERS.find((provider) => lower.includes(provider));
}

function isSubmitElement(element: HTMLElement): boolean {
  return (
    (element instanceof HTMLButtonElement && element.type === "submit") ||
    (element instanceof HTMLInputElement && element.type === "submit")
  );
}

function isDisabled(element: HTMLElement): boolean {
  return element.matches(":disabled") || element.getAttribute("aria-disabled") === "true";
}

function isVisible(element: Element): boolean {
  const htmlElement = element as HTMLElement;
  const view = htmlElement.ownerDocument.defaultView || window;
  const style = view.getComputedStyle(htmlElement);
  const rect = htmlElement.getBoundingClientRect();

  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

function buildSelectorHint(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const id = element.getAttribute("id");
  if (id) {
    return `${tag}#${cssEscape(id)}`;
  }

  const name = element.getAttribute("name");
  if (name) {
    return `${tag}[name="${cssEscape(name)}"]`;
  }

  const autocomplete = element.getAttribute("autocomplete");
  if (autocomplete) {
    return `${tag}[autocomplete="${cssEscape(autocomplete)}"]`;
  }

  const type = element.getAttribute("type");
  if (type) {
    return `${tag}[type="${cssEscape(type)}"]`;
  }

  return tag;
}

function dedupeActions(actions: ObservedAction[]): ObservedAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = `${action.kind}:${action.label}:${action.selectorHint}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }

  return result;
}

function normalizeText(value: string | null | undefined): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

function cssEscape(value: string): string {
  return CSS.escape(value);
}

function collectElementsAcrossRoots(selector: string): Element[] {
  const seen = new Set<Element>();
  const elements: Element[] = [];

  for (const root of collectQueryRoots()) {
    for (const element of root.querySelectorAll(selector)) {
      if (!seen.has(element)) {
        seen.add(element);
        elements.push(element);
      }
    }
  }

  return elements;
}

function collectQueryRoots(): Array<Document | ShadowRoot> {
  const roots: Array<Document | ShadowRoot> = [document];
  const pending: Array<Document | ShadowRoot> = [document];
  const seen = new Set<Node>([document]);

  while (pending.length > 0) {
    const current = pending.shift()!;
    for (const element of current.querySelectorAll("*")) {
      if (element instanceof Element && element.shadowRoot && !seen.has(element.shadowRoot)) {
        seen.add(element.shadowRoot);
        roots.push(element.shadowRoot);
        pending.push(element.shadowRoot);
      }

      if (element instanceof HTMLIFrameElement) {
        const frameDocument = getIframeDocument(element);
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

function resolveLabelledByText(field: Element, labelledBy: string): string {
  const root = field.getRootNode();

  return labelledBy
    .split(/\s+/)
    .map((id) => {
      const local = findById(root, id);
      if (local?.textContent) {
        return local.textContent;
      }

      return document.getElementById(id)?.textContent || "";
    })
    .join(" ");
}

function findById(root: Node, id: string): Element | null {
  if (root instanceof Document) {
    return root.getElementById(id);
  }

  if (root instanceof ShadowRoot) {
    return root.querySelector(`#${cssEscape(id)}`);
  }

  return null;
}

function getIframeDocument(frame: HTMLIFrameElement): Document | null {
  try {
    return frame.contentDocument;
  } catch {
    return null;
  }
}

function collectNestedElements(node: Node): Element[] {
  const elements: Element[] = [];

  if (node instanceof Element) {
    elements.push(node);
    elements.push(...node.querySelectorAll("*"));
    return elements;
  }

  if (node instanceof Document || node instanceof ShadowRoot) {
    return [...node.querySelectorAll("*")];
  }

  return elements;
}
