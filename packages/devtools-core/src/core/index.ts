/**
 * Shared, backend-agnostic core (ADR 0001 §4.3): CDP inspection/actuation
 * modules, pure report builders, stores and perception helpers.
 */
export * from "./util.js";
export * from "./runtime-config.js";
export * from "./cdp/a11y-audit.js";
export * from "./cdp/cdp-events.js";
export * from "./cdp/component-tree.js";
export * from "./cdp/dom-actuator.js";
export * from "./cdp/overrides.js";
export * from "./cdp/performance-probe.js";
export * from "./cdp/seo-audit.js";
export * from "./cdp/storage-inspector.js";
export * from "./cdp/style-inspector.js";
export * from "./cdp/threejs-inspector.js";
export * from "./reports/component-source.js";
export * from "./reports/css-coverage.js";
export * from "./reports/design-tokens.js";
export * from "./reports/element-bounds.js";
export * from "./reports/focus-order.js";
export * from "./reports/framework-detect.js";
export * from "./reports/har.js";
export * from "./reports/health-report.js";
export * from "./reports/js-coverage.js";
export * from "./reports/layout-issues.js";
export * from "./reports/media-state.js";
export * from "./reports/mutation-timeline.js";
export * from "./reports/pixel-compare.js";
export * from "./reports/recording-export.js";
export * from "./reports/robots-txt.js";
export * from "./reports/trace-summary.js";
export * from "./stores/approval-policy-store.js";
export * from "./stores/approval-store.js";
export * from "./stores/assertion-watch.js";
export * from "./stores/baseline-store.js";
export * from "./stores/handoff-store.js";
export * from "./stores/site-pattern-store.js";
export * from "./stores/visual-diff-store.js";
export * from "./perception/assertions.js";
export * from "./perception/diff.js";
export * from "./commands/types.js";
export * from "./commands/site-capability-registry.js";
