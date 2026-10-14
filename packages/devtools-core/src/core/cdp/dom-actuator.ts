import type { CdpTarget } from "../../../../shared/src/index.js";

import type {
  BrowserAction,
  LiteralValue,
  ObservedAction,
  ObservedField,
  ObservedForm,
  SecretRef,
  ProposedEffect
} from "../../../../shared/src/index.js";
import { isStealthEnabled } from "../runtime-config.js";
import { COLLECT_QUERY_ROOTS_SOURCE } from "../../../../perception/src/page-dom-roots.js";

type DomActuationEffects = {
  effects?: ProposedEffect[];
};

type DomToolInvocation = Extract<import("../../../../shared/src/index.js").BrowserOutputCommand, { type: "invoke_site_tool" }>;
type ValueResolver = (value: unknown) => unknown;

export async function executeDomTool(
  target: CdpTarget,
  command: DomToolInvocation,
  forms: ObservedForm[],
  actions: ObservedAction[],
  resolveValue: ValueResolver
) {
  if (command.toolName === "dom.read_page_state") {
    return {} satisfies DomActuationEffects;
  }

  if (command.toolName.startsWith("dom.activate.")) {
    const actionId = command.toolName.slice("dom.activate.".length);
    const action = actions.find((entry) => entry.id === actionId);
    if (!action) {
      throw new Error(`Unknown observed action: ${actionId}`);
    }

    await activateObservedAction(target, action);
    return {} satisfies DomActuationEffects;
  }

  if (command.toolName.startsWith("dom.fill.")) {
    const formId = command.toolName.slice("dom.fill.".length);
    const form = forms.find((entry) => entry.id === formId);
    if (!form) {
      throw new Error(`Unknown observed form: ${formId}`);
    }

    await fillObservedForm(target, form, command.args, resolveValue);
    return {
      effects: collectFormFillEffects(form, command.args)
    } satisfies DomActuationEffects;
  }

  if (command.toolName.startsWith("dom.submit.")) {
    const formId = command.toolName.slice("dom.submit.".length);
    const form = forms.find((entry) => entry.id === formId);
    if (!form) {
      throw new Error(`Unknown observed form: ${formId}`);
    }

    await submitObservedForm(target, form);
    return {
      effects: collectSubmitEffects(form)
    } satisfies DomActuationEffects;
  }

  throw new Error(`Unsupported DOM tool: ${command.toolName}`);
}

export async function executeBrowserAction(target: CdpTarget, action: BrowserAction, resolveValue: ValueResolver) {
  switch (action.type) {
    case "click":
      await humanJitter();
      await callBackendNode(target, action.node.backendNodeId, clickFunctionSource());
      return {} satisfies DomActuationEffects;
    case "type":
      await humanJitter();
      await callBackendNode(target, action.node.backendNodeId, typeFunctionSource(), [serializeTextValue(resolveValue(action.value), action.value)]);
      return {} satisfies DomActuationEffects;
    case "select":
      await humanJitter();
      await callBackendNode(target, action.node.backendNodeId, selectFunctionSource(), [action.optionText]);
      return {} satisfies DomActuationEffects;
    case "submit":
      await humanJitter(200, 500);
      await callBackendNode(target, action.node.backendNodeId, submitFunctionSource());
      return {} satisfies DomActuationEffects;
    case "await_human":
      // Handled at the registry level via createHandoff() before reaching the DOM actuator.
      return {} satisfies DomActuationEffects;
    case "navigate":
      return {} satisfies DomActuationEffects;
  }
}

export async function waitForPageSettled(target: CdpTarget, timeoutMs = 1000) {
  await target.waitForLoadStop(timeoutMs);
  await delay(150);
}

async function activateObservedAction(target: CdpTarget, action: ObservedAction) {
  await executeInPage(
    target,
    {
      kind: "activate-action",
      selectorHint: action.selectorHint,
      label: action.label,
      href: action.href
    },
    buildDomTraversalScript()
  );
}

async function fillObservedForm(target: CdpTarget, form: ObservedForm, args: Record<string, unknown>, resolveValue: ValueResolver) {
  const assignments = form.fields
    .filter((field) => Object.hasOwn(args, field.id))
    .map((field) => ({
      field,
      value: args[field.id]
    }));

  if (assignments.length === 0) {
    throw new Error(`No field assignments provided for form ${form.id}. Expected keys: ${form.fields.map((field) => field.id).join(", ")}`);
  }

  await executeInPage(
    target,
    {
      kind: "fill-form",
      fields: assignments.map(({ field, value }) => ({
        selectorHint: field.selectorHint,
        label: field.label,
        fieldType: field.fieldType,
        value: resolveValue(value)
      }))
    },
    buildDomTraversalScript()
  );
}

async function submitObservedForm(target: CdpTarget, form: ObservedForm) {
  await executeInPage(
    target,
    {
      kind: "submit-form",
      selectorHint: form.selectorHint,
      submitActions: form.submitActions.map((action) => ({
        selectorHint: action.selectorHint,
        label: action.label
      }))
    },
    buildDomTraversalScript()
  );
}

async function executeInPage(target: CdpTarget, payload: unknown, script: string) {
  await target.evaluate(`(${script})(${JSON.stringify(payload)})`, { userGesture: true });
}

async function callBackendNode(target: CdpTarget, backendNodeId: number, functionDeclaration: string, args: unknown[] = []) {
  const resolved = await target.send("DOM.resolveNode", { backendNodeId });
  const objectId = resolved.object?.objectId;
  if (!objectId) {
    throw new Error(`Unable to resolve backend node ${backendNodeId}.`);
  }

  try {
    await target.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      awaitPromise: true
    });
  } finally {
    await target.send("Runtime.releaseObject", { objectId }).catch(() => {});
  }
}

function serializeTextValue(value: unknown, source: LiteralValue | SecretRef) {
  if (typeof value !== "string") {
    const label = source.kind === "vault" ? source.id : source.kind === "account" ? `account:${source.accountId}.${source.field}` : "literal";
    throw new Error(`Resolved value for ${label} must be a string.`);
  }

  return value;
}

const PERSONAL_FIELD_TYPES = new Set(["email", "tel", "address-line1", "password"]);
/** `autocomplete` tokens that identify contact / identity / credential data. */
const PERSONAL_AUTOCOMPLETE = new Set([
  "name", "given-name", "additional-name", "family-name", "nickname", "email", "username",
  "current-password", "new-password", "one-time-code", "tel", "tel-national", "street-address",
  "address-line1", "address-line2", "address-line3", "postal-code", "bday", "sex", "organization"
]);

function hasPersonalAutocomplete(autocomplete: string | undefined): boolean {
  if (!autocomplete) return false;
  return autocomplete.toLowerCase().split(/\s+/).some((token) => PERSONAL_AUTOCOMPLETE.has(token) || token.startsWith("cc-"));
}

/** True when a field carries contact, identity, credential or card data. */
export function isPersonalField(field: Pick<ObservedField, "fieldType" | "autocomplete">): boolean {
  return PERSONAL_FIELD_TYPES.has(field.fieldType) || hasPersonalAutocomplete(field.autocomplete);
}

/**
 * Same classification for a live element, from its DOM attributes
 * (`type`, `autocomplete`) — used for low-level `type` actions.
 */
export function isPersonalInputAttributes(attributes: Record<string, string>): boolean {
  const type = (attributes.type ?? "").toLowerCase();
  return PERSONAL_FIELD_TYPES.has(type) || hasPersonalAutocomplete(attributes.autocomplete);
}

/** Vault / account refs are the user's stored identity or credential data by definition. */
export function isSecretRefValue(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "kind" in value && (value.kind === "vault" || value.kind === "account"));
}

/**
 * Effects of filling `form`. With `args`, only the fields actually being
 * assigned count (filling just a search box on a form that also has an email
 * field shares nothing personal), plus any field fed from a vault/account ref.
 */
export function collectFormFillEffects(form: ObservedForm, args?: Record<string, unknown>): ProposedEffect[] | undefined {
  const fields = form.fields
    .filter((field) => {
      if (!args) return isPersonalField(field);
      return Object.hasOwn(args, field.id) && (isPersonalField(field) || isSecretRefValue(args[field.id]));
    })
    .map((field) => field.label);

  return fields.length > 0 ? [{ type: "share_personal_data", fields } satisfies ProposedEffect] : undefined;
}

export function collectSubmitEffects(form: ObservedForm): ProposedEffect[] | undefined {
  if (form.purpose === "signup") {
    return [{ type: "create_account", label: form.name || form.purpose } satisfies ProposedEffect];
  }
  return undefined;
}

function clickFunctionSource() {
  return `function () {
    if (!(this instanceof Element)) {
      throw new Error("Resolved backend node is not an element.");
    }
    if (this instanceof HTMLElement) {
      this.focus();
      this.click();
      return true;
    }
    throw new Error("Resolved backend node is not clickable.");
  }`;
}

function typeFunctionSource() {
  return `function (value) {
    if (!(this instanceof Element)) {
      throw new Error("Resolved backend node is not an element.");
    }
    const element = this;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.focus();
      element.value = String(value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    throw new Error("Resolved backend node is not a text input.");
  }`;
}

function selectFunctionSource() {
  return `function (optionText) {
    if (!(this instanceof HTMLSelectElement)) {
      throw new Error("Resolved backend node is not a select element.");
    }
    const option = [...this.options].find((entry) => entry.label === optionText || entry.text === optionText || entry.value === optionText);
    if (!option) {
      throw new Error("Requested option was not found.");
    }
    this.value = option.value;
    this.dispatchEvent(new Event("input", { bubbles: true }));
    this.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }`;
}

function submitFunctionSource() {
  return `function () {
    if (!(this instanceof Element)) {
      throw new Error("Resolved backend node is not an element.");
    }
    if (this instanceof HTMLFormElement) {
      if (typeof this.requestSubmit === "function") {
        this.requestSubmit();
      } else {
        this.submit();
      }
      return true;
    }
    if (this instanceof HTMLElement) {
      const form = this.form;
      if (form) {
        if (typeof form.requestSubmit === "function") {
          form.requestSubmit(this instanceof HTMLButtonElement || this instanceof HTMLInputElement ? this : undefined);
        } else {
          form.submit();
        }
        return true;
      }
      this.click();
      return true;
    }
    throw new Error("Resolved backend node cannot be submitted.");
  }`;
}

export function buildDomTraversalScript() {
  return `function (payload) {
    const normalizeText = (value) => (value || "").replace(/\\s+/g, " ").trim();

    // Cross-root traversal — single source of truth shared with observation
    // (perception/page-dom-roots). Keeps observation and actuation in lock-step.
    const collectRoots = () => (${COLLECT_QUERY_ROOTS_SOURCE})(document);

    const isVisible = (element) => {
      const view = element.ownerDocument.defaultView || window;
      const style = view.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };

    const queryCandidates = (selectorHint) => {
      const elements = [];
      for (const root of collectRoots()) {
        try {
          for (const element of root.querySelectorAll(selectorHint)) {
            elements.push(element);
          }
        } catch {
          continue;
        }
      }
      return elements.filter((element) => element instanceof HTMLElement && isVisible(element));
    };

    const labelFor = (element) =>
      normalizeText(
        element.getAttribute("aria-label") ||
          element.getAttribute("title") ||
          ("value" in element ? String(element.value || "") : "") ||
          element.innerText ||
          element.textContent
      );

    const matchesLabel = (element, label) => !label || labelFor(element) === normalizeText(label);

    const findElement = (descriptor) => {
      const candidates = queryCandidates(descriptor.selectorHint);

      const exact = candidates.find((element) => {
        if (descriptor.href && "href" in element && element.href !== descriptor.href) {
          return false;
        }
        return matchesLabel(element, descriptor.label);
      });

      if (exact) {
        return exact;
      }

      // If selectorHint found elements but label didn't match (e.g. empty inputs),
      // trust the selectorHint — it was captured from the live DOM at observation time.
      if (candidates.length > 0) {
        const hrefMatch = candidates.find(
          (element) => !descriptor.href || !("href" in element) || element.href === descriptor.href
        );
        if (hrefMatch) return hrefMatch;
      }

      if (descriptor.label) {
        return collectRoots()
          .flatMap((root) => [...root.querySelectorAll("button, input, select, textarea, a, form")])
          .find((element) => element instanceof HTMLElement && isVisible(element) && matchesLabel(element, descriptor.label));
      }

      return null;
    };

    const setFieldValue = (element, fieldType, value) => {
      if (element instanceof HTMLSelectElement) {
        const option = [...element.options].find((entry) => entry.label === String(value) || entry.text === String(value) || entry.value === String(value));
        if (!option) {
          throw new Error("Select option not found.");
        }
        element.value = option.value;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }

      if (fieldType === "checkbox" || fieldType === "radio") {
        if (!(element instanceof HTMLInputElement)) {
          throw new Error("Boolean field target is not an input.");
        }
        element.checked = Boolean(value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }

      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        element.focus();
        element.value = String(value ?? "");
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }

      throw new Error("Unsupported field target.");
    };

    switch (payload.kind) {
      case "activate-action": {
        const action = findElement(payload);
        if (!action) {
          throw new Error("Observed action could not be resolved on the live page.");
        }
        action.focus?.();
        action.click?.();
        return true;
      }
      case "fill-form": {
        for (const assignment of payload.fields) {
          const element = findElement(assignment);
          if (!element) {
            throw new Error("Observed field could not be resolved on the live page.");
          }
          setFieldValue(element, assignment.fieldType, assignment.value);
        }
        return true;
      }
      case "submit-form": {
        const form = findElement(payload);
        if (form instanceof HTMLFormElement) {
          const preferred = payload.submitActions?.map(findElement).find(Boolean);
          if (preferred instanceof HTMLElement) {
            preferred.click();
            return true;
          }
          if (typeof form.requestSubmit === "function") {
            form.requestSubmit();
          } else {
            form.submit();
          }
          return true;
        }
        throw new Error("Observed form could not be resolved on the live page.");
      }
      default:
        throw new Error("Unsupported DOM actuation payload.");
    }
  }`;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Randomised pause that mimics human reaction time between actions.
 * No-op unless stealth mode is enabled, so default actuation is deterministic
 * and fast (zero added latency).
 */
function humanJitter(minMs = 60, maxMs = 220) {
  if (!isStealthEnabled()) {
    return Promise.resolve();
  }
  return delay(Math.floor(Math.random() * (maxMs - minMs) + minMs));
}
