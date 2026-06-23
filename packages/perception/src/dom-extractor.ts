import type {
  FormPurpose,
  MediaReadyState,
  ObservedAction,
  ObservedField,
  ObservedForm,
  ObservedMedia,
  ObservedSocialAction,
  ObservedSocialComposer,
  ObservedSocialNavigationItem,
  ObservedSocialPost,
  PageKind,
  PageObservation,
  SocialActionKind,
  SocialPlatformKind,
  SocialSurface,
  SocialSurfaceKind,
  TabId
} from "../../shared/src/index.js";
import { collectQueryRoots } from "./page-dom-roots.js";

const OAUTH_PROVIDERS = ["google", "github", "apple", "microsoft", "facebook", "x", "twitter"];

export function extractPageObservation(tabId: TabId): PageObservation {
  const headings = collectHeadings();
  const forms = collectForms();
  const primaryActions = collectPrimaryActions();
  const alerts = collectAlerts();
  const media = collectMedia();
  const social = collectSocialSurface(primaryActions, headings);

  const observation: PageObservation = {
    tabId,
    url: window.location.href,
    title: document.title,
    timestamp: Date.now(),
    pageKind: classifyPageKind(forms, primaryActions, headings, social),
    headings,
    forms,
    primaryActions,
    alerts,
    media
  };

  if (social) {
    observation.social = social;
  }

  return observation;
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

function collectMedia(root?: ParentNode, idPrefix = "media"): ObservedMedia[] {
  const elements = root
    ? [...root.querySelectorAll("video, audio")]
    : collectElementsAcrossRoots("video, audio");

  return elements
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
        id: `${idPrefix}-${index + 1}`,
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

function collectSocialSurface(primaryActions: ObservedAction[], headings: string[]): SocialSurface | undefined {
  const platform = detectSocialPlatform(window.location.hostname);
  const posts = collectSocialPosts();
  const composers = collectSocialComposers();
  const navigation = collectSocialNavigation();
  const pageActions = primaryActions
    .map((action, index) => mapObservedActionToSocialAction(action, `social-action-${index + 1}`))
    .filter((action): action is ObservedSocialAction => Boolean(action));
  const actions = dedupeSocialActions([
    ...pageActions,
    ...posts.flatMap((post) => post.actions),
    ...composers.flatMap((composer) => composer.submitActions)
  ]).slice(0, 32);

  const hasExtractedSocialSignals = posts.length > 0 || composers.length > 0 || actions.length > 0 || navigation.length >= 2;
  const hasSocialSignals = platform !== "generic" || hasExtractedSocialSignals;

  if (!hasSocialSignals) {
    return undefined;
  }

  return {
    platform,
    kind: classifySocialSurfaceKind(platform, posts, composers, navigation, headings),
    posts,
    composers,
    navigation,
    actions,
    signals: {
      postCount: posts.length,
      composerCount: composers.length,
      navigationItemCount: navigation.length,
      actionCount: actions.length
    }
  };
}

function collectSocialPosts(): ObservedSocialPost[] {
  const candidates = dedupeElements(
    collectElementsAcrossRoots(
      [
        "article",
        "[role='article']",
        "[data-testid='tweet']",
        "[data-testid*='post' i]",
        "[data-pagelet*='FeedUnit']",
        "[data-urn*='activity']",
        "[class*='feed-shared-update']",
        "shreddit-post"
      ].join(", ")
    ).filter((element): element is HTMLElement => element instanceof HTMLElement && isVisible(element))
  )
    .filter(isSocialPostCandidate)
    .filter((element, _index, all) => !all.some((other) => other !== element && other.contains(element)))
    .slice(0, 10);

  return candidates.map((element, index) => extractSocialPost(element, index));
}

function isSocialPostCandidate(element: HTMLElement): boolean {
  const text = normalizeText(element.textContent);
  if (text.length < 8) {
    return false;
  }

  const hasExplicitPostMarker = element.matches(
    "article, [role='article'], [data-testid='tweet'], [data-testid*='post' i], [data-pagelet*='FeedUnit'], [data-urn*='activity'], [class*='feed-shared-update'], shreddit-post"
  );
  const hasTimestamp = Boolean(element.querySelector("time, a[href*='/status/'], a[href*='/posts/'], a[href*='/comments/']"));
  const hasSocialAction = [...element.querySelectorAll("button, a[href], [role='button']")]
    .filter((entry): entry is HTMLElement => entry instanceof HTMLElement)
    .some((entry) => inferSocialActionKind(getActionLabel(entry), entry instanceof HTMLAnchorElement ? entry.href : undefined));

  return hasExplicitPostMarker && (hasTimestamp || hasSocialAction);
}

function extractSocialPost(element: HTMLElement, index: number): ObservedSocialPost {
  const postId = `post-${index + 1}`;
  const author = firstMatchingText(element, [
    "[data-testid='User-Name']",
    "[data-testid='UserName']",
    "[rel='author']",
    "[itemprop='author']",
    "[class*='author']",
    "[class*='actor']",
    "a[href^='/'] span",
    "h2",
    "h3"
  ]);
  const handle = extractHandle(element);
  const text = extractPostText(element);
  const timestamp = firstMatchingText(element, ["time"]) || undefined;
  const permalink = firstMatchingHref(element, [
    "a[href*='/status/']",
    "a[href*='/posts/']",
    "a[href*='/comments/']",
    "a[href*='/watch']",
    "a[href*='/videos/']",
    "a[href*='/reel/']"
  ]);
  const actions = dedupeSocialActions(
    mapActionElements([...element.querySelectorAll("button, input[type='submit'], input[type='button'], a[href], [role='button']")])
      .map((action, actionIndex) => mapObservedActionToSocialAction(action, `${postId}-action-${actionIndex + 1}`, postId))
      .filter((action): action is ObservedSocialAction => Boolean(action))
  ).slice(0, 10);

  return {
    id: postId,
    ...(author ? { author: clipText(author, 120) } : {}),
    ...(handle ? { handle } : {}),
    text,
    ...(timestamp ? { timestamp: clipText(timestamp, 120) } : {}),
    ...(permalink ? { href: permalink } : {}),
    selectorHint: buildSelectorHint(element),
    media: collectMedia(element, `${postId}-media`),
    actions
  };
}

function extractPostText(element: HTMLElement): string {
  const explicit = firstMatchingText(element, [
    "[data-testid='tweetText']",
    "[data-ad-preview='message']",
    "[data-testid*='postText' i]",
    "[class*='feed-shared-update-v2__description']",
    "[slot='text-body']",
    "p"
  ]);

  if (explicit) {
    return clipText(explicit, 500);
  }

  return clipText(normalizeText(element.textContent), 500);
}

function collectSocialComposers(): ObservedSocialComposer[] {
  const textEntries = dedupeElements(
    collectElementsAcrossRoots("textarea, [contenteditable='true'], [role='textbox']")
      .filter((element): element is HTMLElement => element instanceof HTMLElement && isVisible(element))
      .filter((element) => !isSearchTextEntry(element))
      .filter(isSocialComposerTextEntry)
  ).slice(0, 6);

  return textEntries.map((entry, index) => extractSocialComposer(entry, index));
}

function isSocialComposerTextEntry(element: HTMLElement): boolean {
  const label = getTextEntryLabel(element);
  const context = normalizeText(`${label} ${element.closest("form, [role='dialog'], section, article")?.textContent || ""}`).toLowerCase();
  return /(what'?s happening|what is happening|what'?s on your mind|start a post|write a post|create a post|add a comment|write a comment|write a reply|reply|comment|message|post)/i.test(context);
}

function extractSocialComposer(entry: HTMLElement, index: number): ObservedSocialComposer {
  const root = entry.closest("form, [role='dialog'], [data-testid*='composer' i], [data-testid*='tweetTextarea' i], [class*='composer'], [class*='comment'], [class*='reply']") || entry.parentElement || entry;
  const purpose = inferComposerPurpose(entry, root);
  const label = getTextEntryLabel(entry);
  const placeholder = getTextEntryPlaceholder(entry);
  const submitActions = dedupeSocialActions(
    mapActionElements([...root.querySelectorAll("button, input[type='submit'], input[type='button'], [role='button']")])
      .map((action, actionIndex) => mapComposerSubmitAction(action, purpose, `composer-${index + 1}-action-${actionIndex + 1}`))
      .filter((action): action is ObservedSocialAction => Boolean(action))
  ).slice(0, 5);

  return {
    id: `composer-${index + 1}`,
    purpose,
    ...(label ? { label: clipText(label, 120) } : {}),
    ...(placeholder ? { placeholder: clipText(placeholder, 160) } : {}),
    selectorHint: buildSelectorHint(root),
    textEntrySelectorHint: buildSelectorHint(entry),
    submitActions,
    hasAttachedMedia: Boolean(root.querySelector("img, video, [data-testid*='media' i], [aria-label*='media' i]"))
  };
}

function collectSocialNavigation(): ObservedSocialNavigationItem[] {
  const items = collectElementsAcrossRoots("nav a[href], nav button, [role='navigation'] a[href], [role='navigation'] button")
    .filter((element): element is HTMLElement => element instanceof HTMLElement && isVisible(element))
    .map((element, index): ObservedSocialNavigationItem | null => {
      const label = getActionLabel(element);
      const href = element instanceof HTMLAnchorElement ? element.href : undefined;
      const destination = inferNavigationDestination(label, href);
      if (destination === "unknown") {
        return null;
      }

      return {
        id: `social-nav-${index + 1}`,
        label: clipText(label, 80),
        destination,
        selectorHint: buildSelectorHint(element),
        ...(href ? { href } : {})
      };
    })
    .filter((item): item is ObservedSocialNavigationItem => Boolean(item));

  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.destination}:${item.label}:${item.href || ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }).slice(0, 12);
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

function classifyPageKind(forms: ObservedForm[], actions: ObservedAction[], headings: string[], social?: SocialSurface): PageKind {
  if (social) {
    const socialKind = socialSurfaceKindToPageKind(social.kind);
    if (socialKind) {
      return socialKind;
    }
  }

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

function socialSurfaceKindToPageKind(kind: SocialSurfaceKind): PageKind | null {
  switch (kind) {
    case "feed":
      return "social-feed";
    case "profile":
      return "social-profile";
    case "thread":
      return "social-thread";
    case "composer":
      return "social-compose";
    case "search":
      return "social-search";
    case "messages":
      return "social-messages";
    case "notifications":
      return "social-notifications";
    case "unknown":
      return null;
  }
}

function classifySocialSurfaceKind(
  platform: SocialPlatformKind,
  posts: ObservedSocialPost[],
  composers: ObservedSocialComposer[],
  navigation: ObservedSocialNavigationItem[],
  headings: string[]
): SocialSurfaceKind {
  const url = new URL(window.location.href);
  const path = url.pathname.toLowerCase();
  const haystack = `${path} ${url.search.toLowerCase()} ${headings.join(" ")} ${navigation.map((item) => item.label).join(" ")}`.toLowerCase();

  if (/(\/messages?|\/inbox|\/direct|\/chat|messenger)/.test(haystack)) {
    return "messages";
  }

  if (/(\/notifications?|\/alerts?)/.test(haystack)) {
    return "notifications";
  }

  if (/(\/search|\/explore|[?&]q=|query=)/.test(haystack)) {
    return "search";
  }

  if (/(\/status\/|\/posts?\/|\/comments?\/|\/thread\/|\/watch\/|\/videos?\/|\/reel\/)/.test(haystack)) {
    return "thread";
  }

  if (isLikelyProfilePath(platform, path, headings)) {
    return "profile";
  }

  if (posts.length > 0) {
    return "feed";
  }

  if (composers.length > 0) {
    return "composer";
  }

  return "unknown";
}

function detectSocialPlatform(hostname: string): SocialPlatformKind {
  const host = hostname.toLowerCase().replace(/^www\./, "");

  if (host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com")) {
    return "x";
  }
  if (host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.com" || host.endsWith(".fb.com")) {
    return "facebook";
  }
  if (host === "instagram.com" || host.endsWith(".instagram.com")) {
    return "instagram";
  }
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
    return "linkedin";
  }
  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
    return "tiktok";
  }
  if (host === "reddit.com" || host.endsWith(".reddit.com")) {
    return "reddit";
  }
  if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") {
    return "youtube";
  }
  if (host === "threads.net" || host.endsWith(".threads.net")) {
    return "threads";
  }
  if (host === "bsky.app" || host.endsWith(".bsky.app")) {
    return "bluesky";
  }
  if (host.includes("mastodon")) {
    return "mastodon";
  }

  return "generic";
}

function isLikelyProfilePath(platform: SocialPlatformKind, path: string, headings: string[]): boolean {
  if (/(\/profile\/|\/user\/|\/users\/|\/in\/|\/company\/|\/@)/.test(path)) {
    return true;
  }

  if (platform === "x" || platform === "instagram" || platform === "threads" || platform === "bluesky" || platform === "tiktok") {
    const segments = path.split("/").filter(Boolean);
    const first = segments[0];
    return segments.length === 1 && Boolean(first) && !["home", "explore", "search", "notifications", "messages", "settings", "compose"].includes(first);
  }

  const headingText = headings.join(" ").toLowerCase();
  return /(followers|following|posts|profile)/.test(headingText) && !/(home|feed|timeline)/.test(path);
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

function getTextEntryLabel(element: HTMLElement): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return getFieldLabel(element);
  }

  const labelledBy = element.getAttribute("aria-labelledby");
  const labelledByText = labelledBy ? resolveLabelledByText(element, labelledBy) : "";

  return (
    normalizeText(element.getAttribute("aria-label")) ||
    normalizeText(labelledByText) ||
    normalizeText(element.getAttribute("data-placeholder")) ||
    normalizeText(element.getAttribute("placeholder")) ||
    normalizeText(element.textContent)
  );
}

function getTextEntryPlaceholder(element: HTMLElement): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return normalizeText(element.getAttribute("placeholder"));
  }

  return normalizeText(element.getAttribute("data-placeholder")) || normalizeText(element.getAttribute("aria-placeholder"));
}

function isSearchTextEntry(element: HTMLElement): boolean {
  if (element instanceof HTMLInputElement && element.type.toLowerCase() === "search") {
    return true;
  }

  const label = getTextEntryLabel(element).toLowerCase();
  return element.getAttribute("role") === "searchbox" || /\bsearch\b/.test(label);
}

function inferComposerPurpose(entry: HTMLElement, root: Element): ObservedSocialComposer["purpose"] {
  const text = `${getTextEntryLabel(entry)} ${normalizeText(root.textContent)}`.toLowerCase();

  if (/\bmessage\b|\bdm\b|direct message/.test(text)) {
    return "message";
  }
  if (/\breply\b/.test(text)) {
    return "reply";
  }
  if (/\bcomment\b/.test(text)) {
    return "comment";
  }

  return "post";
}

function mapObservedActionToSocialAction(
  action: ObservedAction,
  id: string,
  targetPostId?: string
): ObservedSocialAction | null {
  const kind = inferSocialActionKind(action.label, action.href);
  if (!kind) {
    return null;
  }

  const count = extractCount(action.label);

  return {
    id,
    label: action.label,
    kind,
    selectorHint: action.selectorHint,
    ...(action.href ? { href: action.href } : {}),
    disabled: action.disabled,
    ...(typeof count === "number" ? { count } : {}),
    ...(targetPostId ? { targetPostId } : {})
  };
}

function mapComposerSubmitAction(
  action: ObservedAction,
  purpose: ObservedSocialComposer["purpose"],
  id: string
): ObservedSocialAction | null {
  const label = action.label.toLowerCase();
  const isSubmit = /\b(post|tweet|publish|reply|comment|send|share)\b/.test(label) || action.kind === "submit";

  if (!isSubmit) {
    return null;
  }

  return {
    id,
    label: action.label,
    kind: purpose === "message" ? "message" : "submit_post",
    selectorHint: action.selectorHint,
    ...(action.href ? { href: action.href } : {}),
    disabled: action.disabled
  };
}

function inferSocialActionKind(label: string, href?: string): SocialActionKind | null {
  const value = `${label} ${href || ""}`.toLowerCase();

  if (/\b(like|liked|favorite|favourite)\b/.test(value)) {
    return "like";
  }
  if (/\b(react|reaction)\b/.test(value)) {
    return "react";
  }
  if (/\b(comment|comments)\b/.test(value)) {
    return "comment";
  }
  if (/\b(reply|replies)\b/.test(value)) {
    return "reply";
  }
  if (/\b(share|send to|copy link)\b/.test(value)) {
    return "share";
  }
  if (/\b(repost|retweet|reblog|boost)\b/.test(value)) {
    return "repost";
  }
  if (/\b(bookmark|save)\b/.test(value)) {
    return "bookmark";
  }
  if (/\b(follow|connect|subscribe|join)\b/.test(value)) {
    return "follow";
  }
  if (/\b(message|direct message|dm|inbox)\b/.test(value)) {
    return "message";
  }
  if (/\b(profile|view profile|author)\b/.test(value)) {
    return "open_profile";
  }
  if (/\b(search|explore)\b/.test(value)) {
    return "search";
  }
  if (/\b(post|tweet|publish)\b/.test(value)) {
    return "submit_post";
  }
  if (/\b(home|feed|notifications|settings)\b/.test(value)) {
    return "navigate";
  }

  return null;
}

function inferNavigationDestination(
  label: string,
  href?: string
): ObservedSocialNavigationItem["destination"] {
  const value = `${label} ${href || ""}`.toLowerCase();

  if (/\b(home|feed|timeline)\b/.test(value)) {
    return "home";
  }
  if (/\b(search|explore)\b/.test(value)) {
    return "search";
  }
  if (/\b(notifications?|alerts?)\b/.test(value)) {
    return "notifications";
  }
  if (/\b(messages?|inbox|direct)\b/.test(value)) {
    return "messages";
  }
  if (/\b(profile|me|account)\b/.test(value)) {
    return "profile";
  }
  if (/\b(bookmark|saved)\b/.test(value)) {
    return "bookmarks";
  }
  if (/\b(settings|preferences)\b/.test(value)) {
    return "settings";
  }
  if (/\b(create|compose|post)\b/.test(value)) {
    return "create";
  }

  return "unknown";
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

/**
 * Actuation-grade selector hint: semantic attribute priority (id / name /
 * autocomplete / data-testid / type / role / aria-label) plus `:nth-of-type`
 * uniqueness qualification, tuned to re-resolve an element across a perceive→act
 * cycle. Intentionally distinct from `page-selector.selectorForElement` (the
 * short descriptive hint used by the inspector report scripts) — see that
 * module's header for why the two are not merged.
 */
function buildSelectorHint(element: Element): string {
  return qualifyIfAmbiguous(element, buildBaseSelectorHint(element));
}

/** The most specific single-attribute selector available, falling back to the tag. */
function buildBaseSelectorHint(element: Element): string {
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

  const testId = element.getAttribute("data-testid");
  if (testId) {
    return `${tag}[data-testid="${cssEscape(testId)}"]`;
  }

  const type = element.getAttribute("type");
  if (type) {
    return `${tag}[type="${cssEscape(type)}"]`;
  }

  const role = element.getAttribute("role");
  if (role) {
    return `${tag}[role="${cssEscape(role)}"]`;
  }

  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) {
    return `${tag}[aria-label="${cssEscape(ariaLabel)}"]`;
  }

  return tag;
}

/**
 * If `base` matches more than one element in the element's root, append an
 * `:nth-of-type()` qualifier so the hint resolves to a single element. The
 * element always matches its own base, so this never produces a false negative.
 */
function qualifyIfAmbiguous(element: Element, base: string): string {
  const root = element.getRootNode();
  if (!(root instanceof Document || root instanceof ShadowRoot)) {
    return base;
  }

  let matchCount: number;
  try {
    matchCount = root.querySelectorAll(base).length;
  } catch {
    return base;
  }
  if (matchCount <= 1) {
    return base;
  }

  const parent = element.parentElement;
  if (!parent) {
    return base;
  }
  const sameTagIndex = [...parent.children].filter((child) => child.tagName === element.tagName).indexOf(element);
  if (sameTagIndex < 0) {
    return base;
  }
  return `${base}:nth-of-type(${sameTagIndex + 1})`;
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

function dedupeSocialActions(actions: ObservedSocialAction[]): ObservedSocialAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = `${action.kind}:${action.label}:${action.selectorHint}:${action.targetPostId || ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupeElements<T extends Element>(elements: T[]): T[] {
  const seen = new Set<T>();
  return elements.filter((element) => {
    if (seen.has(element)) {
      return false;
    }
    seen.add(element);
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

function clipText(value: string, maxLength: number): string {
  const normalized = normalizeText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return normalized.slice(0, maxLength).trimEnd();
}

function firstMatchingText(root: ParentNode, selectors: string[]): string {
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    const text = normalizeText(element?.textContent);
    if (text) {
      return text;
    }
  }

  return "";
}

function firstMatchingHref(root: ParentNode, selectors: string[]): string | undefined {
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    if (element instanceof HTMLAnchorElement && element.href) {
      return element.href;
    }
  }

  return undefined;
}

function extractHandle(root: ParentNode): string | undefined {
  const text = normalizeText(root.textContent);
  const match = text.match(/@[\w.-]{2,30}/);
  return match?.[0];
}

function extractCount(label: string): number | undefined {
  const match = label.match(/\b(\d+(?:[.,]\d+)?)([kKmMbB])?\b/);
  if (!match) {
    return undefined;
  }

  const base = Number(match[1].replace(",", "."));
  if (!Number.isFinite(base)) {
    return undefined;
  }

  const suffix = match[2]?.toLowerCase();
  if (suffix === "k") {
    return Math.round(base * 1_000);
  }
  if (suffix === "m") {
    return Math.round(base * 1_000_000);
  }
  if (suffix === "b") {
    return Math.round(base * 1_000_000_000);
  }

  return Math.round(base);
}

function cssEscape(value: string): string {
  return CSS.escape(value);
}

function collectElementsAcrossRoots(selector: string): Element[] {
  const seen = new Set<Element>();
  const elements: Element[] = [];

  for (const root of collectQueryRoots(document)) {
    for (const element of root.querySelectorAll(selector)) {
      if (!seen.has(element)) {
        seen.add(element);
        elements.push(element);
      }
    }
  }

  return elements;
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
