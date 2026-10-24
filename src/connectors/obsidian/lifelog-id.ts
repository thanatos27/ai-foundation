import { DateSchema } from '../../domain/index.js';
import { InputValidationError } from '../../errors.js';
import { MAX_FILE_NAME_BYTES, sanitizeFileTitle } from './filename.js';
import { isValidSegment } from './id.js';

/**
 * Life log articles are the files directly in the life log directory named `YYYY-MM-DD-<title>.md`,
 * however they were created. Their id is `lifelog:<file name>`: it holds neither the place of the
 * directory in the vault nor a provider-specific ID.
 */

const PREFIX = 'lifelog:';
const MAX_ID_IN_MESSAGE = 200;
const FILE_NAME = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/s;

export function formatLifeLogId(name: string): string {
  return `${PREFIX}${name}`;
}

/** `"lifelog:<file name>"` for error messages: never an absolute path. */
export function quoteLifeLogId(name: string): string {
  return `"${formatLifeLogId(name)}"`;
}

/**
 * The file name of a new article: `<date>-<title>.md`, with the title made safe as for knowledge.
 * Like a knowledge note, the name without `.md` is at most 200 UTF-8 bytes (the date included).
 */
export function lifeLogFileName(date: string, title: string): string {
  const name = `${date}-${sanitizeFileTitle(title)}`;
  if (Buffer.byteLength(name, 'utf8') > MAX_FILE_NAME_BYTES) {
    throw new InputValidationError(
      `title is too long for a file name (over ${MAX_FILE_NAME_BYTES} bytes with the date); shorten it`,
    );
  }
  return `${name}.md`;
}

/** The date and title of an article file name, or undefined when `name` is not one. */
export function parseLifeLogFileName(name: string): { date: string; title: string } | undefined {
  if (!isValidSegment(name)) return undefined;
  const match = FILE_NAME.exec(name);
  if (!match || !DateSchema.safeParse(match[1]).success) return undefined;
  return { date: match[1]!, title: match[2]! };
}

/**
 * Validates an exact life log id and returns its file name. Only the logical form is checked here;
 * the storage separately checks where the name really leads.
 */
export function parseLifeLogId(id: string): string {
  const shown = id.length > MAX_ID_IN_MESSAGE ? `${id.slice(0, MAX_ID_IN_MESSAGE)}…` : id;
  const invalid = (reason: string) =>
    new InputValidationError(
      `life log id "${shown}" ${reason}; use the id returned by lifelog_create or "lifelog:" followed by the exact file name`,
    );

  if (!id.startsWith(PREFIX)) throw invalid('must start with "lifelog:"');
  const name = id.slice(PREFIX.length);
  if (name === '') throw invalid('has no file name');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw invalid('contains control characters');
  if (name.includes('/') || name.includes('\\')) {
    throw invalid('must be a file name directly in the life log directory, without "/" or "\\"');
  }
  if (!parseLifeLogFileName(name)) throw invalid('must name a "YYYY-MM-DD-<title>.md" file with a real date');
  return name;
}
