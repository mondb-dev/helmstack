/**
 * Deterministic frontend-verification tasks on the fixture site. Every task has
 * a programmatic success check over real page state and/or the final answer.
 */

import type { BenchTask, CheckContext } from "./harness.js";

const text = (ctx: CheckContext) => ctx.finalText.toLowerCase();
const usedTool = (ctx: CheckContext, pattern: RegExp) => ctx.toolCalls.some((c) => pattern.test(c.name));
const pageText = (ctx: CheckContext, id: string) =>
  ctx.evaluate<string>(`(document.getElementById(${JSON.stringify(id)})||{}).textContent||""`);

const FILL_CONTACT = (extra: string) => `On the contact form, ${extra}`;

export const TASKS: readonly BenchTask[] = [
  {
    id: "contact-fill-submit",
    start: "/contact-form.html",
    prompt: FILL_CONTACT("enter name 'Ada Lovelace', email 'ada@example.com' and message 'Hello from the benchmark', tick the consent box and send the message."),
    async check(ctx) {
      const ok = (await pageText(ctx, "form-success")).includes("Message sent for Ada Lovelace");
      return { pass: ok, why: ok ? "confirmation block shows the sent message" : "no confirmation on the page" };
    }
  },
  {
    id: "contact-invalid-email",
    start: "/contact-form.html",
    prompt: FILL_CONTACT("enter name 'Ada', email 'not-an-email' and message 'hi', tick the consent box and submit. Then tell me exactly which error message the page shows."),
    async check(ctx) {
      const shown = (await pageText(ctx, "form-error")).includes("valid email address");
      const said = text(ctx).includes("valid email address");
      return { pass: shown && said, why: `page error shown=${shown}, answer mentions it=${said}` };
    }
  },
  {
    id: "contact-missing-consent",
    start: "/contact-form.html",
    prompt: FILL_CONTACT("enter name 'Ada', email 'ada@example.com' and message 'hi' but do NOT tick the consent box, then submit. Tell me the error message the page shows."),
    async check(ctx) {
      const shown = (await pageText(ctx, "form-error")).includes("Consent is required");
      const said = text(ctx).includes("consent");
      return { pass: shown && said, why: `page error shown=${shown}, answer mentions consent=${said}` };
    }
  },
  {
    id: "contact-select-topic",
    start: "/contact-form.html",
    prompt: FILL_CONTACT("choose the topic 'Partnership', enter name 'Ada', email 'ada@example.com' and message 'Hi', tick consent and send. Tell me which topic the confirmation mentions."),
    async check(ctx) {
      const confirmation = await pageText(ctx, "form-success");
      const ok = confirmation.includes("Topic: partnership") && text(ctx).includes("partnership");
      return { pass: ok, why: ok ? "sent with topic partnership" : `confirmation was: ${confirmation.slice(0, 80) || "(none)"}` };
    }
  },
  {
    id: "signup-pro-five-seats",
    start: "/signup.html",
    prompt: "Choose the Pro plan with 5 seats and submit the form. Tell me the confirmation text.",
    async check(ctx) {
      const status = await pageText(ctx, "status");
      const ok = status === "Plan selected: Pro with 5 seats";
      return { pass: ok, why: ok ? "status shows Pro with 5 seats" : `status was: ${status || "(empty)"}` };
    }
  },
  {
    id: "a11y-top-issue",
    start: "/a11y-issues.html",
    prompt: "Run an accessibility check on this page and tell me the single most important problem it found.",
    async check(ctx) {
      const ran = usedTool(ctx, /a11y|audit/i);
      const named = /label|accessible name|no name|unnamed|button/.test(text(ctx));
      return { pass: ran && named, why: `ran audit=${ran}, names a real issue=${named}` };
    }
  },
  {
    id: "seo-missing-tags",
    start: "/seo-poor.html",
    prompt: "Run an SEO audit on this page and list which important tags or elements are missing.",
    async check(ctx) {
      const t = text(ctx);
      const ran = usedTool(ctx, /seo|audit/i);
      const names = /\bh1\b/.test(t) && /description/.test(t) && /canonical|lang/.test(t);
      return { pass: ran && names, why: `ran audit=${ran}, names h1+description+(canonical|lang)=${names}` };
    }
  },
  {
    id: "mobile-overflow-yes",
    start: "/wide.html",
    prompt: "Check how this page behaves on a phone-sized screen. Does it scroll sideways? Answer YES or NO and name the element causing it.",
    async check(ctx) {
      const t = text(ctx);
      const ok = /\byes\b/.test(t) && /banner/.test(t);
      return { pass: ok, why: ok ? "answered yes and named the banner" : `answer was: ${ctx.finalText.slice(0, 100)}` };
    }
  },
  {
    id: "mobile-overflow-no",
    start: "/about.html",
    prompt: "Check how this page behaves on a phone-sized screen. Does it scroll sideways? Answer YES or NO.",
    async check(ctx) {
      const t = text(ctx);
      const ok = /\bno\b/.test(t) && !/\byes\b/.test(t);
      return { pass: ok, why: ok ? "answered no" : `answer was: ${ctx.finalText.slice(0, 100)}` };
    }
  },
  {
    id: "navigate-to-about",
    start: "/home.html",
    prompt: "Open the About page of this site and tell me the company motto written there.",
    async check(ctx) {
      const urls = await ctx.tabUrls();
      const ok = urls.some((u) => u.endsWith("/about.html")) && text(ctx).includes("measure twice");
      return { pass: ok, why: ok ? "on about page and quoted the motto" : `urls=${urls.join(",")}` };
    }
  },
  {
    id: "navigate-and-back",
    start: "/home.html",
    prompt: "Go to the About page, then go back to where you started. Tell me the main heading of the page you end on.",
    async check(ctx) {
      const urls = await ctx.tabUrls();
      const ok = urls.some((u) => u.endsWith("/home.html")) && text(ctx).includes("bench home");
      return { pass: ok, why: ok ? "ended on home and named its heading" : `urls=${urls.join(",")}` };
    }
  },
  {
    id: "health-failing-categories",
    start: "/a11y-issues.html",
    prompt: "Run an overall page health check and tell me which categories are failing.",
    async check(ctx) {
      const ran = usedTool(ctx, /health|audit/i);
      const named = /console|network|accessib|seo/.test(text(ctx));
      return { pass: ran && named, why: `ran health=${ran}, names a category=${named}` };
    }
  }
];
