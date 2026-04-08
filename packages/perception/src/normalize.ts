import type {
  AccessibilitySummary,
  ObservedAction,
  PageGraph,
  PageObservation,
  PageSnapshot,
  PerceptionResult
} from "../../shared/src/index.js";

type AccessibilityNode = {
  role?: { value?: string };
  name?: { value?: string };
};

export function normalizePerception(snapshot: PageSnapshot, observation: PageObservation | null): PerceptionResult {
  const accessibility = summarizeAccessibility(snapshot.accessibilityTree.nodes as AccessibilityNode[]);
  const graph: PageGraph = {
    tabId: snapshot.tabId,
    url: snapshot.url,
    title: snapshot.title,
    kind: observation?.pageKind || inferKindFromAccessibility(accessibility),
    topHeading: observation?.headings[0] || accessibility.headingTrail[0],
    headings: observation?.headings || accessibility.headingTrail,
    forms: observation?.forms || [],
    actions: observation?.primaryActions || projectActions(accessibility),
    alerts: observation?.alerts || [],
    media: observation?.media || [],
    oauthProviders: collectOAuthProviders(observation?.primaryActions || []),
    accessibility,
    signals: {
      documentCount: snapshot.dom.documents.length,
      accessibilityNodeCount: accessibility.nodeCount,
      formCount: observation?.forms.length || 0,
      actionCount: observation?.primaryActions.length || 0,
      capturedAt: snapshot.capturedAt
    }
  };

  return {
    snapshot,
    observation,
    graph
  };
}

function summarizeAccessibility(nodes: AccessibilityNode[]): AccessibilitySummary {
  const roleCounts: Record<string, number> = {};
  const interactiveNodes: AccessibilitySummary["interactiveNodes"] = [];
  const headingTrail: string[] = [];

  for (const node of nodes) {
    const role = node.role?.value || "unknown";
    const name = node.name?.value;

    roleCounts[role] = (roleCounts[role] || 0) + 1;

    if (["button", "link", "textbox", "checkbox", "radioButton", "comboBox"].includes(role)) {
      interactiveNodes.push({ role, name });
    }

    if (role === "heading" && name) {
      headingTrail.push(name);
    }
  }

  return {
    nodeCount: nodes.length,
    roleCounts,
    headingTrail: headingTrail.slice(0, 10),
    interactiveNodes: interactiveNodes.slice(0, 20)
  };
}

function inferKindFromAccessibility(accessibility: AccessibilitySummary): PageGraph["kind"] {
  const headings = accessibility.headingTrail.join(" ").toLowerCase();
  if (/(sign up|register|create account)/.test(headings)) {
    return "signup";
  }
  if (/(log in|sign in|login)/.test(headings)) {
    return "login";
  }
  if (/(checkout|payment|billing)/.test(headings)) {
    return "checkout";
  }
  return "landing";
}

function projectActions(accessibility: AccessibilitySummary): ObservedAction[] {
  return accessibility.interactiveNodes.slice(0, 8).map((node, index) => ({
    id: `ax-action-${index + 1}`,
    label: node.name || `${node.role}-${index + 1}`,
    kind: node.role === "link" ? "link" : "button",
    selectorHint: "ax",
    disabled: false
  }));
}

function collectOAuthProviders(actions: ObservedAction[]): string[] {
  return [...new Set(actions.map((action) => action.provider).filter(Boolean))] as string[];
}

