import { InputValidationError } from '../../errors.js';

/**
 * Characters replaced by a space: unusable in file names on Windows / macOS / Linux (`/ \ : * ? " < > |`
 * and control characters) and Obsidian link syntax (`# ^ [ ]`), which would break wikilinks to the note.
 */
const UNSAFE = /[/\\:*?"<>|#^[\]\u0000-\u001f\u007f]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/** Below the 255-byte limit of ext4 / Google Drive, leaving room for sync suffixes such as " (1)". */
const MAX_NAME_BYTES = 200;

/** Turns a title into the `.md` file name a new knowledge note is created with. */
export function toFileName(title: string): string {
  let name = title.replace(UNSAFE, ' ').replace(/\s+/g, ' ');
  // Leading dots would hide the file; trailing dots and spaces are dropped by Windows.
  let previous;
  do {
    previous = name;
    name = name.trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  } while (name !== previous);

  if (name === '') throw new InputValidationError(`title "${title}" cannot be turned into a file name`);
  if (WINDOWS_RESERVED.test(name)) {
    throw new InputValidationError(`title "${title}" is a reserved file name on Windows; choose another title`);
  }
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) {
    throw new InputValidationError(`title is too long for a file name (over ${MAX_NAME_BYTES} bytes); shorten it`);
  }
  return `${name}.md`;
}
