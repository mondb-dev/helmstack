/**
 * Human names for the agent's tool calls. MCP names look like
 * `mcp__helmstack__browser_a11y_audit` (or bare `browser_a11y_audit`); anything
 * not in the table (a CLI's own tools, new HelmStack tools) shows its raw name.
 */

const TOOL_LABELS: Record<string, string> = {
  browser_a11y_audit: "Accessibility audit",
  browser_add_site_patterns: "Add site patterns",
  browser_assert: "Assertion",
  browser_assert_element_styles: "Assert element styles",
  browser_capture_named_screenshot: "Capture screenshot",
  browser_capture_storage: "Capture storage",
  browser_changed_elements: "Changed elements",
  browser_clear_cookies: "Clear cookies",
  browser_clear_downloads: "Clear downloads",
  browser_clear_location_override: "Clear location override",
  browser_clear_media_emulation: "Clear media emulation",
  browser_clear_resource_budget: "Clear resource budget",
  browser_clear_site_patterns: "Clear site patterns",
  browser_clear_storage: "Clear storage",
  browser_clear_tab_logs: "Clear tab logs",
  browser_component_sources: "Component sources",
  browser_component_tree: "Component tree",
  browser_css_coverage: "CSS coverage",
  browser_delete_cookie: "Delete cookie",
  browser_delete_perception_snapshot: "Delete page snapshot",
  browser_delete_screenshot: "Delete screenshot",
  browser_design_tokens: "Design tokens",
  browser_detect_framework: "Detect framework",
  browser_diff_perception: "Compare page snapshots",
  browser_diff_screenshots: "Compare screenshots",
  browser_disable_network_mock: "Disable network mock",
  browser_enable_network_mock: "Enable network mock",
  browser_evaluate: "Evaluate script",
  browser_execute: "Run browser command",
  browser_export_har: "Export HAR",
  browser_focus_order: "Focus order",
  browser_get_cookies: "Read cookies",
  browser_get_location_override: "Read location override",
  browser_get_media_emulation: "Read media emulation",
  browser_get_network_mock: "Read network mock",
  browser_get_perception: "Read page",
  browser_get_recording: "Read recording",
  browser_get_resource_budget: "Read resource budget",
  browser_get_site_patterns: "Read site patterns",
  browser_get_storage: "Read storage",
  browser_get_tab_logs: "Read tab logs",
  browser_health: "Page health",
  browser_health_report: "Health report",
  browser_inspect_element_styles: "Inspect element styles",
  browser_js_coverage: "JavaScript coverage",
  browser_layout_issues: "Layout issues",
  browser_list_downloads: "List downloads",
  browser_list_manifests: "List manifests",
  browser_list_perception_snapshots: "List page snapshots",
  browser_list_screenshots: "List screenshots",
  browser_list_tabs: "List tabs",
  browser_log: "Log message",
  browser_media_state: "Media state",
  browser_mutation_timeline: "Mutation timeline",
  browser_navigate: "Navigate",
  browser_reload: "Reload page",
  browser_go_back: "Go back",
  browser_go_forward: "Go forward",
  browser_network_audit: "Network audit",
  browser_open_tab: "Open tab",
  browser_performance: "Performance",
  browser_pick_element: "Pick element",
  browser_save_perception_snapshot: "Save page snapshot",
  browser_screenshot: "Screenshot",
  browser_seo_audit: "SEO audit",
  browser_set_cookie: "Set cookie",
  browser_set_file_input_files: "Set file input",
  browser_set_location_override: "Set location override",
  browser_set_media_emulation: "Set media emulation",
  browser_set_resource_budget: "Set resource budget",
  browser_set_site_patterns: "Set site patterns",
  browser_set_storage: "Set storage",
  browser_set_viewport: "Set viewport",
  browser_start_recording: "Start recording",
  browser_stop_recording: "Stop recording",
  browser_threejs_scene: "Three.js scene",
  browser_trace: "Trace",
  browser_viewport_suite: "Viewport suite",
};

/** `mcp__helmstack__browser_a11y_audit` → `browser_a11y_audit`. */
export function baseToolName(name: string): string {
  const match = /^mcp__[^_][^]*?__(.+)$/.exec(name);
  return match ? match[1] : name;
}

export function humanizeToolName(name: string): string {
  const base = baseToolName(name);
  return Object.hasOwn(TOOL_LABELS, base) ? TOOL_LABELS[base] : name;
}
