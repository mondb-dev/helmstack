/**
 * @helmstack/agent-sdk/lite
 *
 * The "lite" toolset: a thin, deterministic layer that makes HelmStack usable
 * by small models. Pure renderers (page view, audit digests, tabs, results)
 * plus a stateful session that owns element numbering and the plain-text
 * protocol. No model, no network, no dependencies.
 */

export { renderPageView, describePage, collectLiteElements, type RenderPageViewOptions } from "./view.js";
export { digestAudit, type DigestOptions } from "./digest.js";
export {
  liteError,
  liteNeedsApproval,
  plainErrorMessage,
  renderCommandResult,
  renderTabs,
  STALE_ELEMENT_MESSAGE,
  type LiteResultKind
} from "./text.js";
export {
  LITE_TOOL_NAMES,
  LITE_TOOL_SCHEMAS,
  liteToolCallGbnf,
  liteToolCallJsonSchema,
  type LiteParamSchema,
  type LiteParamType,
  type LiteToolName,
  type LiteToolSchema
} from "./schemas.js";
export { createLiteSession, resolveLiteMaxChars, type LiteEnv, type LiteSession, type LiteSessionOptions } from "./session.js";
export {
  DEFAULT_DIGEST_ITEMS,
  DEFAULT_VIEW_CHARS,
  LITE_AUDIT_KINDS,
  type LiteAuditKind,
  type LiteAuditReports,
  type LiteBrowser,
  type LiteDigest,
  type LiteDigestItem,
  type LiteElement,
  type LitePageSource,
  type LitePageView,
  type LiteSeverity
} from "./types.js";
