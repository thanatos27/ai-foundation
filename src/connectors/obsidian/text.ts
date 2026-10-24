/**
 * Plain Markdown text handling shared by knowledge and life log files: no frontmatter, no file system.
 */

/** A new file's body: LF line endings and one final newline. Nothing else is changed. */
export function normalizeBody(content: string): string {
  const body = content.replace(/\r\n?/g, '\n');
  return body.endsWith('\n') ? body : `${body}\n`;
}

/**
 * What to append to a file whose text is `existing` so that `content` starts a new paragraph:
 * line breaks are added only where needed, in the file's line ending (CRLF if it has any).
 */
export function appendText(existing: string, content: string): string {
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  let text = content.replace(/\r\n?/g, '\n').replaceAll('\n', eol);
  if (!text.endsWith(eol)) text += eol;
  if (existing === '') return text;

  const trailingBreaks = (/(?:\r?\n)*$/.exec(existing)?.[0].match(/\n/g) ?? []).length;
  return eol.repeat(Math.max(0, 2 - trailingBreaks)) + text;
}
