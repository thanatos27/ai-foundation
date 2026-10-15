import { InputValidationError } from '../../errors.js';

/**
 * Vault-relative path with `/` separators (never an absolute or OS path), already checked to be a
 * `.md` file under knowledge_dir. Knowledge IDs, `external_ref` and the storage boundary use it.
 */
export type VaultPath = string & { readonly __brand: 'VaultPath' };

const PREFIX = 'obsidian:';
const MAX_ID_IN_MESSAGE = 200;

export function formatKnowledgeId(path: VaultPath): string {
  return `${PREFIX}${path}`;
}

/** `"obsidian:<path>"` for error messages: vault-relative, so it never contains a personal absolute path. */
export function quoteId(path: VaultPath): string {
  return `"${formatKnowledgeId(path)}"`;
}

/** File name without `.md`: the title of a note without frontmatter. */
export function fileTitle(path: VaultPath): string {
  return path.slice(path.lastIndexOf('/') + 1, -'.md'.length);
}

/** The segments of `path` below knowledge_dir. */
export function segmentsBelow(path: VaultPath, knowledgeDir: string): string[] {
  return path.slice(knowledgeDir.length + 1).split('/');
}

/** A path segment that can appear in a knowledge ID: no separators, control characters, `.` or `..`. */
export function isValidSegment(segment: string): boolean {
  return segment !== '' && segment !== '.' && segment !== '..' && !/[/\\\u0000-\u001f\u007f]/.test(segment);
}

/** A file name that is knowledge: `<name>.md` (lowercase extension, non-empty name). */
export function isKnowledgeFileName(name: string): boolean {
  return isValidSegment(name) && name.endsWith('.md') && name.length > '.md'.length;
}

/** The vault path of `segments` (each already valid) below knowledge_dir. */
export function vaultPathBelow(knowledgeDir: string, segments: string[]): VaultPath {
  return `${knowledgeDir}/${segments.join('/')}` as VaultPath;
}

/**
 * Validates an exact knowledge ID (`obsidian:<vault-relative-path>`) and returns its path. Only the
 * logical form is checked here; the storage separately checks where the path really leads.
 */
export function parseKnowledgeId(id: string, knowledgeDir: string): VaultPath {
  const shown = id.length > MAX_ID_IN_MESSAGE ? `${id.slice(0, MAX_ID_IN_MESSAGE)}…` : id;
  const invalid = (reason: string) =>
    new InputValidationError(`knowledge id "${shown}" ${reason}; use an id returned by knowledge_search`);

  if (!id.startsWith(PREFIX)) throw invalid('must start with "obsidian:"');
  const path = id.slice(PREFIX.length);
  if (path === '') throw invalid('has no path');
  if (/[\u0000-\u001f\u007f]/.test(path)) throw invalid('contains control characters');
  if (path.includes('\\')) throw invalid('must use "/" as the separator');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) throw invalid('must be relative to the vault, not absolute');

  const segments = path.split('/');
  if (!segments.every(isValidSegment)) throw invalid('must not contain empty, "." or ".." segments');
  const name = segments.at(-1) ?? '';
  if (!isKnowledgeFileName(name)) throw invalid('must name a .md file');

  const dirSegments = knowledgeDir.split('/');
  const inKnowledgeDir =
    segments.length > dirSegments.length && dirSegments.every((segment, index) => segments[index] === segment);
  if (!inKnowledgeDir) throw invalid(`is outside the knowledge directory "${knowledgeDir}"`);
  return path as VaultPath;
}
