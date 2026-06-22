import type { WebContents } from "electron";

import type { A11yAuditReport, TabId } from "../../../../packages/shared/src/index.js";

/**
 * WCAG 2.2-aligned accessibility audit over the live AX tree + select DOM
 * checks. Extracted from `TabManager`. Assumes the CDP debugger is attached.
 */
export async function runA11yAudit(webContents: WebContents, tabId: TabId): Promise<A11yAuditReport> {
    type A11yViolation = import("../../../../packages/shared/src/index.js").A11yViolation;
    type A11yRuleSummary = import("../../../../packages/shared/src/index.js").A11yRuleSummary;
    type A11yWcagPrinciple = import("../../../../packages/shared/src/index.js").A11yWcagPrinciple;



    // ── Rule metadata ───────────────────────────────────────────────────────

    type RuleMeta = {
      wcag: string;
      level: "A" | "AA" | "AAA";
      principle: A11yWcagPrinciple;
      impact: import("../../../../packages/shared/src/index.js").A11yImpact;
      title: string;
    };

    const RULES: Record<string, RuleMeta> = {
      "1.1.1-image-alt":          { wcag: "1.1.1", level: "A",  principle: "perceivable",     impact: "critical", title: "Images must have a non-empty accessible name" },
      "1.3.1-input-label":        { wcag: "1.3.1", level: "A",  principle: "perceivable",     impact: "serious",  title: "Form inputs must have an accessible label" },
      "1.3.1-table-header":       { wcag: "1.3.1", level: "A",  principle: "perceivable",     impact: "moderate", title: "Table header cells must have a discernible name" },
      "2.1.1-interactive-label":  { wcag: "2.1.1", level: "A",  principle: "operable",        impact: "critical", title: "Interactive elements must be keyboard-operable" },
      "2.4.2-page-title":         { wcag: "2.4.2", level: "A",  principle: "operable",        impact: "serious",  title: "Page must have a descriptive <title>" },
      "2.4.3-heading-order":      { wcag: "2.4.3", level: "A",  principle: "operable",        impact: "moderate", title: "Heading levels must not skip ranks" },
      "2.4.4-link-purpose":       { wcag: "2.4.4", level: "A",  principle: "operable",        impact: "moderate", title: "Link text must be meaningful out of context" },
      "2.4.6-button-label":       { wcag: "2.4.6", level: "AA", principle: "operable",        impact: "serious",  title: "Buttons must have an accessible name" },
      "2.4.6-link-label":         { wcag: "2.4.6", level: "AA", principle: "operable",        impact: "serious",  title: "Links must have an accessible name" },
      "3.1.1-page-lang":          { wcag: "3.1.1", level: "A",  principle: "understandable",  impact: "serious",  title: "HTML element must have a lang attribute" },
      "4.1.2-aria-required-attr": { wcag: "4.1.2", level: "A",  principle: "robust",          impact: "critical", title: "ARIA widget roles must have required state attributes" },
      "4.1.3-disabled-label":     { wcag: "4.1.3", level: "AA", principle: "robust",          impact: "minor",    title: "Disabled controls must still have an accessible name" },
    };

    // ── Fetch AX tree and DOM-level checks in parallel ──────────────────────

    await webContents.debugger.sendCommand("Accessibility.enable");

    const [axResult, domChecks] = await Promise.all([
      webContents.debugger.sendCommand("Accessibility.getFullAXTree", {}) as Promise<{
        nodes: Array<{
          nodeId: string;
          role?: { value: string };
          name?: { value: string };
          ignored?: boolean;
          properties?: Array<{ name: string; value: { value: unknown } }>;
          childIds?: string[];
          backendDOMNodeId?: number;
        }>;
      }>,
      webContents.debugger.sendCommand("Runtime.evaluate", {
        expression: `(function() {
          var html = document.documentElement;
          var lang = html ? html.getAttribute('lang') : null;
          var title = document.title;
          return { lang: lang, title: title };
        })()`,
        returnByValue: true,
      }) as Promise<{ result: { value: { lang: string | null; title: string } } }>,
    ]);

    const { nodes } = axResult;
    const { lang: pageLang, title: pageTitle } = domChecks.result.value;

    const violations: A11yViolation[] = [];
    let passes = 0;

    // Helper to build a stable selector hint from an AX node.
    const selectorFor = (node: (typeof nodes)[number], role: string): string =>
      node.backendDOMNodeId ? `[data-ax-node="${node.nodeId}"]` : `[role="${role}"]`;

    // Helper to push a violation using the rule metadata.
    const push = (ruleId: string, node: (typeof nodes)[number], role: string, name: string | undefined, description: string, remediation: string) => {
      const meta = RULES[ruleId];
      violations.push({
        rule: ruleId,
        impact: meta.impact,
        wcagCriteria: meta.wcag,
        wcagLevel: meta.level,
        principle: meta.principle,
        selector: selectorFor(node, role),
        description,
        remediation,
        role,
        name,
      });
    };

    // ── DOM-level checks (page-wide) ────────────────────────────────────────

    // 3.1.1 — HTML lang attribute
    if (!pageLang || pageLang.trim() === "") {
      violations.push({
        rule: "3.1.1-page-lang",
        impact: RULES["3.1.1-page-lang"].impact,
        wcagCriteria: "3.1.1",
        wcagLevel: "A",
        principle: "understandable",
        selector: "html",
        description: "The <html> element has no lang attribute.",
        remediation: 'Add a lang attribute to the root element: <html lang="en">. Use a valid BCP 47 language tag matching the page\'s primary language.',
        role: "document",
      });
    }

    // 2.4.2 — Page title
    if (!pageTitle || pageTitle.trim() === "") {
      violations.push({
        rule: "2.4.2-page-title",
        impact: RULES["2.4.2-page-title"].impact,
        wcagCriteria: "2.4.2",
        wcagLevel: "A",
        principle: "operable",
        selector: "head > title",
        description: "The page has no <title> or its title is empty.",
        remediation: "Add a <title> element inside <head> that briefly describes the page's purpose or current view. Avoid generic titles like 'Page' or 'Untitled'.",
        role: "document",
      });
    }

    // ── Ambiguous-link-text word list (2.4.4) ───────────────────────────────
    const GENERIC_LINK_TEXTS = new Set([
      "click here", "here", "read more", "more", "details", "learn more",
      "this", "link", "click", "go", "view", "see more", "continue", "next",
    ]);

    // ── ARIA roles that require specific state properties ───────────────────
    // Maps AX property name (as returned by CDP) to the role(s) that require it.
    const ARIA_REQUIRED: Record<string, string[]> = {
      checked:    ["checkbox", "radio", "menuitemcheckbox", "menuitemradio", "treeitem", "switch"],
      expanded:   ["combobox", "listbox", "tree", "treegrid", "rowgroup"],
      valuenow:   ["slider", "scrollbar", "spinbutton"],
    };

    // ── Per-node checks ─────────────────────────────────────────────────────

    let lastHeadingLevel = 0;

    for (const node of nodes) {
      if (node.ignored) continue;

      const role = node.role?.value ?? "generic";
      const name = node.name?.value;
      const trimmedName = name?.trim() ?? "";
      const props = Object.fromEntries(
        (node.properties ?? []).map(p => [p.name, p.value?.value])
      );

      let nodeViolations = 0;

      // ── 1.1.1 — Images must have a non-empty accessible name ───────────────
      if (role === "img") {
        if (!trimmedName || trimmedName === "image") {
          push(
            "1.1.1-image-alt", node, role, name,
            "Image is missing an accessible name.",
            'Add descriptive alt text (alt="...") to the <img> element. For decorative images use alt="" and role="presentation". Avoid generic text like "image" or "photo".'
          );
          nodeViolations++;
        }
      }

      // ── 1.3.1 — Form inputs must have an accessible label ──────────────────
      if ((role === "textbox" || role === "combobox" || role === "spinbutton" || role === "searchbox") && !trimmedName) {
        push(
          "1.3.1-input-label", node, role, name,
          `${role} input has no accessible label.`,
          "Associate a <label> element using the for/id pair, or add an aria-label / aria-labelledby attribute. Placeholder text alone does not count as a label."
        );
        nodeViolations++;
      }

      // ── 1.3.1 — Table header cells must have a name ────────────────────────
      if ((role === "columnheader" || role === "rowheader") && !trimmedName) {
        push(
          "1.3.1-table-header", node, role, name,
          `${role === "columnheader" ? "Column" : "Row"} header cell has no accessible name.`,
          "Add descriptive text content to the <th> element. Avoid empty header cells — if a column needs no visual header, provide a visually-hidden text label."
        );
        nodeViolations++;
      }

      // ── 2.4.3 — Heading levels must not skip ranks ─────────────────────────
      if (role === "heading") {
        const level = Number(props["level"]) || 0;
        if (level > 0) {
          if (lastHeadingLevel > 0 && level > lastHeadingLevel + 1) {
            push(
              "2.4.3-heading-order", node, role, name,
              `Heading level skips from h${lastHeadingLevel} to h${level}.`,
              `Use consecutive heading levels. Add an h${lastHeadingLevel + 1} between h${lastHeadingLevel} and h${level}, or restructure the document outline so no levels are skipped.`
            );
            nodeViolations++;
          }
          lastHeadingLevel = level;
        }
      }

      // ── 2.4.4 — Links must have meaningful text ────────────────────────────
      if (role === "link") {
        if (!trimmedName) {
          push(
            "2.4.6-link-label", node, role, name,
            "Link has no accessible name.",
            "Add descriptive text content to the <a> element, or use aria-label / aria-labelledby to provide a name that describes the link destination."
          );
          nodeViolations++;
        } else if (GENERIC_LINK_TEXTS.has(trimmedName.toLowerCase())) {
          push(
            "2.4.4-link-purpose", node, role, name,
            `Link text "${trimmedName}" is ambiguous out of context.`,
            `Replace or augment the link text to describe the destination. Use aria-label to add context, e.g. aria-label="Read more about pricing". Avoid generic phrases like "click here" or "read more".`
          );
          nodeViolations++;
        }
      }

      // ── 2.4.6 — Buttons must have an accessible name ───────────────────────
      if (role === "button" && !trimmedName) {
        push(
          "2.4.6-button-label", node, role, name,
          "Button has no accessible name.",
          "Add visible text content inside the <button>, or use aria-label for icon-only buttons. If using an icon, add a visually-hidden <span> or aria-label describing the action."
        );
        nodeViolations++;
      }

      // ── 4.1.2 — ARIA widget roles must have required state attributes ───────
      for (const [prop, requiredByRoles] of Object.entries(ARIA_REQUIRED)) {
        if (requiredByRoles.includes(role) && props[prop] === undefined) {
          push(
            "4.1.2-aria-required-attr", node, role, name,
            `Element with role="${role}" is missing required ARIA state: ${prop}.`,
            `Add the ${prop === "checked" ? "aria-checked" : prop === "expanded" ? "aria-expanded" : "aria-valuenow"} attribute to satisfy the WAI-ARIA spec for role="${role}". Update it dynamically to reflect the current widget state.`
          );
          nodeViolations++;
        }
      }

      // ── 4.1.3 — Disabled controls must still have an accessible name ────────
      if (props["disabled"] === true && (role === "button" || role === "textbox" || role === "combobox") && !trimmedName) {
        push(
          "4.1.3-disabled-label", node, role, name,
          `Disabled ${role} has no accessible name.`,
          "Screen readers still announce disabled elements. Add an aria-label or aria-labelledby so users understand what the control is for even when disabled."
        );
        nodeViolations++;
      }

      if (nodeViolations === 0) passes++;
    }

    // ── Aggregate results ───────────────────────────────────────────────────

    const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    const byPrinciple: Record<A11yWcagPrinciple, number> = {
      perceivable: 0, operable: 0, understandable: 0, robust: 0,
    };
    const ruleViolationCounts: Record<string, number> = {};

    for (const v of violations) {
      counts[v.impact]++;
      byPrinciple[v.principle]++;
      ruleViolationCounts[v.rule] = (ruleViolationCounts[v.rule] ?? 0) + 1;
    }

    // Score: start at 100, deduct weighted penalty capped per tier
    const penalty =
      Math.min(counts.critical * 8,  48) +
      Math.min(counts.serious  * 4,  32) +
      Math.min(counts.moderate * 2,  12) +
      Math.min(counts.minor    * 1,   5);
    const score = Math.max(0, 100 - penalty);

    // Deduplicated rule summaries, sorted by severity then count
    const severityOrder: Record<string, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };
    const violatedRules: A11yRuleSummary[] = Object.entries(ruleViolationCounts)
      .map(([ruleId, count]): A11yRuleSummary => {
        const meta = RULES[ruleId];
        return {
          ruleId,
          wcagCriteria: meta.wcag,
          wcagLevel: meta.level,
          principle: meta.principle,
          impact: meta.impact,
          description: meta.title,
          count,
        };
      })
      .sort((a, b) =>
        severityOrder[a.impact] - severityOrder[b.impact] ||
        b.count - a.count
      );

    // Top-priority plain-English recommendations (deduplicated, ordered by impact)
    const recommendations: string[] = [];
    const seen = new Set<string>();
    for (const r of violatedRules) {
      if (seen.has(r.ruleId)) continue;
      seen.add(r.ruleId);
      switch (r.ruleId) {
        case "1.1.1-image-alt":
          recommendations.push(`Add descriptive alt text to ${r.count} image${r.count > 1 ? "s" : ""}. Use alt="" for purely decorative images.`);
          break;
        case "1.3.1-input-label":
          recommendations.push(`Label ${r.count} form input${r.count > 1 ? "s" : ""} using <label for="…">, aria-label, or aria-labelledby.`);
          break;
        case "1.3.1-table-header":
          recommendations.push(`Add descriptive text to ${r.count} empty table header cell${r.count > 1 ? "s" : ""}.`);
          break;
        case "2.1.1-interactive-label":
          recommendations.push(`Ensure all ${r.count} interactive element${r.count > 1 ? "s" : ""} are keyboard-operable (Tab / Enter / Space).`);
          break;
        case "2.4.2-page-title":
          recommendations.push("Add a meaningful <title> element that describes the page's content or current view.");
          break;
        case "2.4.3-heading-order":
          recommendations.push(`Fix ${r.count} heading level skip${r.count > 1 ? "s" : ""} — use consecutive h1→h2→h3 levels without gaps.`);
          break;
        case "2.4.4-link-purpose":
          recommendations.push(`Replace ${r.count} generic link text${r.count > 1 ? "s" : ""} ("click here", "read more") with descriptive labels.`);
          break;
        case "2.4.6-button-label":
          recommendations.push(`Name ${r.count} unlabelled button${r.count > 1 ? "s" : ""}. Use visible text or aria-label for icon-only buttons.`);
          break;
        case "2.4.6-link-label":
          recommendations.push(`Add accessible names to ${r.count} link${r.count > 1 ? "s" : ""} that currently have no text.`);
          break;
        case "3.1.1-page-lang":
          recommendations.push('Set the page language on the <html> element (e.g. <html lang="en">) so screen readers use the correct pronunciation engine.');
          break;
        case "4.1.2-aria-required-attr":
          recommendations.push(`Add missing ARIA state attributes to ${r.count} widget${r.count > 1 ? "s" : ""} (aria-checked, aria-expanded, aria-valuenow as appropriate).`);
          break;
        case "4.1.3-disabled-label":
          recommendations.push(`Add accessible names to ${r.count} disabled control${r.count > 1 ? "s" : ""} so screen readers can still identify them.`);
          break;
      }
    }

    if (counts.critical === 0 && counts.serious === 0 && violations.length === 0) {
      recommendations.push("No violations detected. Use the element style inspector for text contrast (WCAG 1.4.3), then manually review focus-visible styling (WCAG 2.4.7) and motion sensitivity (WCAG 2.3.3).");
    } else if (counts.critical > 0 || counts.serious > 0) {
      recommendations.push("Prioritise critical and serious violations first — they block access for screen reader and keyboard-only users.");
    }

    return {
      tabId,
      url: webContents.getURL(),
      capturedAt: Date.now(),
      score,
      violations,
      violationCounts: counts,
      byPrinciple,
      violatedRules,
      recommendations,
      passes,
      nodeCount: nodes.length,
    };
}
