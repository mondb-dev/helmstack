/**
 * Regular expressions (as source strings) shared by the routine validator and the
 * JSON Schema, so the two cannot drift apart on what a valid id, reference or
 * duration looks like.
 */

/** Step ids, state keys, field names and tags. */
export const NAME_PATTERN = "^[a-z][a-z0-9_]{0,31}$";

/**
 * A reference. Only these four shapes exist: `$scope.start[i]`, `$item`, `$<step id>`
 * and `state.<key>`. There are no property paths, expressions or interpolation.
 */
export const REF_PATTERN =
  "^(\\$scope\\.start\\[\\d{1,2}\\]|\\$item|\\$[a-z][a-z0-9_]{0,31}|state\\.[a-z][a-z0-9_]{0,31})$";

/** `30m`, `6h`, `1d`. Zero and sub-minute units do not parse. */
export const EVERY_PATTERN = "^[1-9]\\d{0,5}(m|h|d)$";
export const ACTIVE_HOURS_PATTERN = "^([01]\\d|2[0-3]):[0-5]\\d-([01]\\d|2[0-3]):[0-5]\\d$";
/** Five whitespace-separated cron fields built from digits, `*`, `/`, `,` and `-`. */
export const CRON_PATTERN = "^[0-9*/,\\-]+( [0-9*/,\\-]+){4}$";
export const TIMEZONE_PATTERN = "^[A-Za-z][A-Za-z0-9_+\\-]*(/[A-Za-z0-9_+\\-]+){0,2}$";
export const HOST_PATTERN =
  "^(\\*\\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$";
export const FIELD_TYPE_PATTERN = "^(text(<=([1-9]\\d{0,2}|1\\d{3}|2000))?|date|url|number|bool)\\?{0,1}$";
export const INFER_OUTPUT_PATTERN = "^(score|label|bool|text<=([1-9]\\d{0,2}|1\\d{3}|2000))$";
export const LABEL_PATTERN = "^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$";
export const WAIT_PATTERN = "^[1-9]\\d{0,3}(s|m|h)$";
export const WHEN_PATTERN = "^(always|new_notes>[0-9]{1,4})$";
export const RATE_PATTERN = "^[1-9]\\d{0,2} requests? / [1-9]\\d{0,3}s$";
export const HTTP_URL_PATTERN = "^https?://";

export const re = (source: string): RegExp => new RegExp(source);
