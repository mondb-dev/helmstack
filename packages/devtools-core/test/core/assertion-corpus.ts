/**
 * Corpus of natural-language assertions an IDE agent writes while verifying UI,
 * each paired with a fixture `PageGraph` and the expected verdict. Drives the
 * table test in `assertion-corpus.test.ts` and measures evaluator accuracy.
 */
import type { ObservedAction, PageGraph } from "../../../shared/src/index.js";

function graph(overrides: Partial<PageGraph> = {}): PageGraph {
  return {
    tabId: "t",
    url: "https://example.com/",
    title: "Home",
    kind: "landing",
    headings: [],
    forms: [],
    actions: [],
    alerts: [],
    media: [],
    oauthProviders: [],
    accessibility: { nodeCount: 0, roleCounts: {}, headingTrail: [], interactiveNodes: [] },
    signals: { documentCount: 1, accessibilityNodeCount: 0, formCount: 0, actionCount: 0, capturedAt: 0 },
    ...overrides
  };
}

function action(label: string, kind: ObservedAction["kind"], extra: Partial<ObservedAction> = {}): ObservedAction {
  return { id: `a-${label}`, label, kind, selectorHint: "x", disabled: false, ...extra };
}

const signIn = action("Sign in", "submit");

const login = graph({
  url: "https://app.acme.test/login",
  title: "Sign in · Acme",
  kind: "login",
  headings: ["Welcome back"],
  forms: [{
    id: "f1", name: "login", purpose: "login", selectorHint: "form",
    fields: [
      { id: "email", label: "Email", fieldType: "email", required: true, selectorHint: "#email" },
      { id: "password", label: "Password", fieldType: "password", required: true, selectorHint: "#password" }
    ],
    submitActions: [signIn]
  }],
  actions: [
    signIn,
    action("Forgot password?", "link", { href: "https://app.acme.test/forgot" }),
    action("Create account", "link", { href: "https://app.acme.test/signup" }),
    action("Continue with Google", "oauth", { provider: "google" })
  ],
  oauthProviders: ["google"],
  accessibility: {
    nodeCount: 40,
    roleCounts: { heading: 1, button: 2, link: 2, textbox: 2, img: 1 },
    headingTrail: ["Welcome back"],
    interactiveNodes: [
      { role: "textbox", name: "Email" }, { role: "textbox", name: "Password" },
      { role: "button", name: "Sign in" }, { role: "button", name: "Continue with Google" },
      { role: "link", name: "Forgot password?" }, { role: "link", name: "Create account" }
    ]
  }
});

const loginError = { ...login, alerts: ["Invalid email or password"] };

const dashboard = graph({
  url: "https://app.acme.test/dashboard",
  title: "Dashboard | Acme",
  kind: "dashboard",
  headings: ["Dashboard", "Recent orders", "Team"],
  actions: [
    action("New order", "button"),
    action("Export", "button", { disabled: true }),
    action("Home", "link", { href: "https://app.acme.test/" }),
    action("Orders", "link", { href: "https://app.acme.test/orders" }),
    action("Settings", "link", { href: "https://app.acme.test/settings" }),
    action("Help", "link", { href: "https://app.acme.test/help" })
  ],
  accessibility: {
    nodeCount: 80,
    roleCounts: { heading: 3, navigation: 1, img: 2, button: 2, link: 4 },
    headingTrail: ["Dashboard", "Recent orders", "Team"],
    interactiveNodes: []
  }
});

const settings = graph({
  url: "https://app.acme.test/settings",
  title: "Settings | Acme",
  kind: "form",
  headings: ["Profile", "Newsletter"],
  forms: [
    {
      id: "p", name: "profile", purpose: "profile", selectorHint: "#profile",
      fields: [
        { id: "name", label: "Name", fieldType: "text", required: true, selectorHint: "#name" },
        { id: "bio", label: "Bio", fieldType: "textarea", required: false, selectorHint: "#bio" }
      ],
      submitActions: [action("Save", "submit")]
    },
    {
      id: "n", name: "newsletter", purpose: "generic", selectorHint: "#news",
      fields: [{ id: "news-email", label: "Email", fieldType: "email", required: false, selectorHint: "#ne" }],
      submitActions: [action("Subscribe", "submit")]
    }
  ],
  actions: [action("Save", "submit"), action("Subscribe", "submit")],
  alerts: ["Profile saved"]
});

const modal = graph({
  title: "Orders | Acme",
  headings: ["Confirm delete"],
  actions: [action("Cancel", "button"), action("Delete", "button"), action("Close", "button")],
  accessibility: {
    nodeCount: 20,
    roleCounts: { dialog: 1, heading: 1, button: 3 },
    headingTrail: ["Confirm delete"],
    interactiveNodes: [{ role: "button", name: "Cancel" }, { role: "button", name: "Delete" }, { role: "button", name: "Close" }]
  }
});

const unlabeled = graph({
  actions: [action("Save", "button"), action("button-2", "button")],
  accessibility: {
    nodeCount: 5, roleCounts: { button: 2 }, headingTrail: [],
    interactiveNodes: [{ role: "button", name: "Save" }, { role: "button" }]
  }
});

const cart = graph({
  title: "Cart | Shop",
  headings: ["Your cart", "3 items in your cart"],
  actions: [action("Checkout", "button"), action("Remove", "button"), action("Remove", "button"), action("Remove", "button")]
});

const blank = graph({ title: "" });

export type CorpusCase = { assertion: string; page: PageGraph; pageName: string; expected: boolean };

const fixtures = { login, loginError, dashboard, settings, modal, unlabeled, cart, blank };
type FixtureName = keyof typeof fixtures;

const rows: Array<[string, FixtureName, boolean]> = [
  // Headings
  ["the page has a heading", "login", true],
  ["there is a heading", "blank", false],
  ["the page has an h1", "login", true],
  ["has a heading 'Welcome back'", "login", true],
  ["the heading says \"welcome back\"", "login", true],
  ["the main heading is 'Dashboard'", "dashboard", true],
  ["the main heading is 'Settings'", "dashboard", false],
  ["there are 3 headings", "dashboard", true],
  ["at least 2 headings", "login", false],
  ["a heading containing 'Recent'", "dashboard", true],
  // Buttons
  ["there is a sign in button", "login", true],
  ["the 'Sign in' button is visible", "login", true],
  ["the page has a submit button", "login", true],
  ["the page has a submit button", "dashboard", false],
  ["there is a button labeled \"Delete account\"", "dashboard", false],
  ["the export button is disabled", "dashboard", true],
  ["the New order button is enabled", "dashboard", true],
  ["the 'New order' button is disabled", "dashboard", false],
  ["exactly 2 buttons", "dashboard", true],
  ["at most 1 button", "dashboard", false],
  ["the logout button is not visible", "login", true],
  ["the 'Sign in' button is not shown", "login", false],
  // Links
  ["there is a 'Create account' link", "login", true],
  ["at least 3 links", "dashboard", true],
  ["at least 3 links", "login", false],
  ["the page has a link named Settings", "dashboard", true],
  ["has no links", "modal", true],
  ["the forgot password link is displayed", "login", true],
  ["there are two links", "dashboard", false],
  // Forms and fields
  ["there is a login form", "login", true],
  ["exactly 2 forms", "settings", true],
  ["exactly 2 forms", "login", false],
  ["the page has a form", "dashboard", false],
  ["the login form has 2 fields", "login", true],
  ["there is an email field", "login", true],
  ["the email field is required", "login", true],
  ["the bio field is required", "settings", false],
  ["the bio field is optional", "settings", true],
  ["the page has a password input", "login", true],
  ["there is a textbox", "dashboard", false],
  ["the form has a required password field", "login", true],
  ["the profile form has 3 fields", "settings", false],
  ["there are 3 fields", "settings", true],
  // Alerts and errors
  ["there are no error messages", "login", true],
  ["there are no error messages", "loginError", false],
  ["the page does not show an error", "login", true],
  ["an error message is displayed", "loginError", true],
  ["an error is shown", "login", false],
  ["the error says 'Invalid email or password'", "loginError", true],
  ["shows an alert", "settings", true],
  ["has no errors", "settings", true],
  ["no alerts", "settings", false],
  // Text present / absent
  ["the page shows \"Welcome back\"", "login", true],
  ["the page contains the text 'welcome   BACK'", "login", true],
  ["the page does not contain \"Welcome back\"", "login", false],
  ["'Profile saved' is displayed", "settings", true],
  ["\"Payment failed\" is not visible", "settings", true],
  ["displays 'Order #1234'", "dashboard", false],
  // Title / URL
  ["the page title is 'Dashboard | Acme'", "dashboard", true],
  ["the title contains 'acme'", "login", true],
  ["the title doesn't contain 'Error'", "login", true],
  ["the url contains /dashboard", "dashboard", true],
  ["the URL contains '/settings'", "dashboard", false],
  ["the URL ends with /login", "login", true],
  // Dialogs, media, accessibility
  ["a modal is open", "modal", true],
  ["there is no dialog", "dashboard", true],
  ["exactly one dialog", "modal", true],
  ["all buttons have accessible names", "login", true],
  ["all buttons have accessible names", "unlabeled", false],
  ["there is a button with accessible name 'Close'", "modal", true],
  ["the page has at least 2 images", "dashboard", true],
  ["there is a video", "dashboard", false],
  // Counts expressed in words / page text
  ["the dashboard shows three headings", "dashboard", true],
  ["the cart shows 3 items", "cart", true],
  // Not evaluable from a page graph: must not pass
  ["the layout feels balanced", "dashboard", false],
  ["the total is correct", "cart", false]
];

export const ASSERTION_CORPUS: CorpusCase[] = rows.map(([assertion, pageName, expected]) => ({
  assertion, pageName, page: fixtures[pageName], expected
}));

/** Corpus rows the evaluator cannot decide and must flag as unsupported. */
export const UNSUPPORTED_ASSERTIONS = ["the layout feels balanced", "the total is correct"];
