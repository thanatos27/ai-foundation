/**
 * HTML comments and tags as Google Calendar stores them in a description (`<b>`, `<br>`, `<a href>`…).
 * A quoted attribute value may contain `>`; an unquoted `<` ends the attempt, keeping the scan linear.
 */
const HTML_MARKUP = /<!--[\s\S]*?-->|<\/?[A-Za-z](?:[^<>"']|"[^"]*"|'[^']*')*>/g;
/** `#attended` as a standalone, case-sensitive token (docs/specs/schedule-attendance.md). */
const ATTENDED_FLAG = /(?<![\p{L}\p{N}\p{M}_\-#&/\\])#attended(?![\p{L}\p{N}\p{M}_\-#/\\])/u;

/**
 * Whether the user marked the event as attended: a standalone `#attended` in its description.
 * Markup is replaced by a space first, so attribute values and comments never count and
 * a tag boundary separates tokens. A lightweight approximation, not an HTML parser or a
 * visible-text extraction: entities stay as written.
 */
export function hasAttendedFlag(description: string | null | undefined): boolean {
  if (!description) return false;
  return ATTENDED_FLAG.test(description.replace(HTML_MARKUP, ' '));
}
