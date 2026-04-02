import type { WebContents } from "electron";

import type {
  BrowserAction,
  LiteralValue,
  ObservedAction,
  ObservedField,
  ObservedForm,
  SecretRef,
  ProposedEffect
} from "../../../../packages/shared/src/index.js";

type DomActuationEffects = {
  effects?: ProposedEffect[];
};

type DomToolInvocation = Extract<import("../../../../packages/shared/src/index.js").BrowserOutputCommand, { type: "invoke_site_tool" }>;
type ValueResolver = (value: unknown) => unknown;

export async function executeDomTool(
  webContents: WebContents,
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

    await activateObservedAction(webContents, action);
    return {} satisfies DomActuationEffects;
  }

  if (command.toolName.startsWith("dom.fill.")) {
    const formId = command.toolName.slice("dom.fill.".length);
    const form = forms.find((entry) => entry.id === formId);
    if (!form) {
      throw new Error(`Unknown observed form: ${formId}`);
    }

    await fillObservedForm(webContents, form, command.args, resolveValue);
    return {
      effects: collectFormFillEffects(form)
    } satisfies DomActuationEffects;
  }

  if (command.toolName.startsWith("dom.submit.")) {
    const formId = command.toolName.slice("dom.submit.".length);
    const form = forms.find((entry) => entry.id === formId);
    if (!form) {
      throw new Error(`Unknown observed form: ${formId}`);
    }

    await submitObservedForm(webContents, form);
    return {
      effects: collectSubmitEffects(form)
    } satisfies DomActuationEffects;
  }

  throw new Error(`Unsupported DOM tool: ${command.toolName}`);
}

export async function executeBrowserAction(webContents: WebContents, action: BrowserAction, resolveValue: ValueResolver) {
  switch (action.type) {
    case "click":
      await humanJitter();
      await callBackendNode(webContents, action.node.backendNodeId, clickFunctionSource());
      return {} satisfies DomActuationEffects;
    case "type":
      await humanJitter();
      await callBackendNode(webContents, action.node.backendNodeId, typeFunctionSource(), [serializeTextValue(resolveValue(action.value), action.value)]);
      return {} satisfies DomActuationEffects;
    case "select":
      await humanJitter();
      await callBackendNode(webContents, action.node.backendNodeId, selectFunctionSource(), [action.optionText]);
      return {} satisfies DomActuationEffects;
    case "submit":
      await humanJitter(200, 500);
      await callBackendNode(webContents, action.node.backendNodeId, submitFunctionSource());
      return {} satisfies DomActuationEffects;
    case "await_human":
      throw new Error(`Manual handoff requested for ${action.reason}. Human handoff plumbing is not implemented yet.`);
    case "navigate":
      return {} satisfies DomActuationEffects;
  }
}

export async function waitForPageSettled(webContents: WebContents, timeoutMs = 1000) {
  if (webContents.isLoading()) {
    await Promise.race([
      new Promise<void>((resolve) => {
        const onStop = () => {
          webContents.removeListener("did-stop-loading", onStop);
          resolve();
        };
        webContents.on("did-stop-loading", onStop);
      }),
      delay(timeoutMs)
    ]);
  }

  await delay(150);
}

async function activateObservedAction(webContents: WebContents, action: ObservedAction) {
  await executeInPage(
    webContents,
    {
      kind: "activate-action",
      selectorHint: action.selectorHint,
      label: action.label,
      href: action.href
    },
    buildDomTraversalScript()
  );
}

async function fillObservedForm(webContents: WebContents, form: ObservedForm, args: Record<string, unknown>, resolveValue: ValueResolver) {
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
    webContents,
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

async function submitObservedForm(webContents: WebContents, form: ObservedForm) {
  await executeInPage(
    webContents,
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

async function executeInPage(webContents: WebContents, payload: unknown, script: string) {
  await webContents.executeJavaScript(`(${script})(${JSON.stringify(payload)})`, true);
}

async function callBackendNode(webContents: WebContents, backendNodeId: number, functionDeclaration: string, args: unknown[] = []) {
  if (!webContents.debugger.isAttached()) {
    webContents.debugger.attach("1.3");
  }

  const resolved = await webContents.debugger.sendCommand("DOM.resolveNode", { backendNodeId });
  const objectId = resolved.object?.objectId;
  if (!objectId) {
    throw new Error(`Unable to resolve backend node ${backendNodeId}.`);
  }

  try {
    await webContents.debugger.sendCommand("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      awaitPromise: true
    });
  } finally {
    await webContents.debugger.sendCommand("Runtime.releaseObject", { objectId }).catch(() => {});
  }
}

function serializeTextValue(value: unknown, source: LiteralValue | SecretRef) {
  if (typeof value !== "string") {
    const label = source.kind === "vault" ? source.id : source.kind === "account" ? `account:${source.accountId}.${source.field}` : "literal";
    throw new Error(`Resolved value for ${label} must be a string.`);
  }

  return value;
}

function collectFormFillEffects(form: ObservedForm): ProposedEffect[] | undefined {
  const fields = form.fields
    .filter((field) => ["email", "tel", "address-line1", "password"].includes(field.fieldType))
    .map((field) => field.label);

  return fields.length > 0 ? [{ type: "share_personal_data", fields } satisfies ProposedEffect] : undefined;
}

function collectSubmitEffects(form: ObservedForm): ProposedEffect[] | undefined {
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

function buildDomTraversalScript() {
  return `function (payload) {
    const normalizeText = (value) => (value || "").replace(/\\s+/g, " ").trim();

    const getIframeDocument = (frame) => {
      try {
        return frame.contentDocument;
      } catch {
        return null;
      }
    };

    const collectRoots = () => {
      const roots = [document];
      const queue = [document];
      const seen = new Set([document]);

      while (queue.length > 0) {
        const current = queue.shift();
        for (const element of current.querySelectorAll("*")) {
          if (element.shadowRoot && !seen.has(element.shadowRoot)) {
            seen.add(element.shadowRoot);
            roots.push(element.shadowRoot);
            queue.push(element.shadowRoot);
          }

          if (element instanceof HTMLIFrameElement) {
            const frameDocument = getIframeDocument(element);
            if (frameDocument && !seen.has(frameDocument)) {
              seen.add(frameDocument);
              roots.push(frameDocument);
              queue.push(frameDocument);
            }
          }
        }
      }

      return roots;
    };

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

/** Randomised pause that mimics human reaction time between actions. */
function humanJitter(minMs = 60, maxMs = 220) {
  return delay(Math.floor(Math.random() * (maxMs - minMs) + minMs));
}
