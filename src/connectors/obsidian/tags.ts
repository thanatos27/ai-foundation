/**
 * Obsidian tag rules (https://obsidian.md/help/tags), shared by knowledge_create, the frontmatter
 * parser and the knowledge_search filter so that "a valid tag" means the same everywhere.
 */

/** ASCII punctuation other than `_`, `-` and `/`. */
const DISALLOWED_PUNCTUATION = /[\x21-\x2c\x2e\x3a-\x40\x5b-\x5e\x60\x7b-\x7e]/;

/** Why `tag` is not a valid Obsidian tag, or undefined when it is. */
export function tagProblem(tag: string): string | undefined {
  if (tag === '') return 'must not be empty';
  if (/\s/.test(tag)) return 'must not contain spaces';
  if (tag.includes('#')) return 'must be written without "#"';
  if (DISALLOWED_PUNCTUATION.test(tag)) return 'may only use letters, numbers, "_", "-", "/" and non-ASCII characters';
  if (tag.startsWith('/') || tag.endsWith('/') || tag.includes('//')) {
    return 'must not start or end with "/" or contain "//"';
  }
  if (/^[0-9/]+$/.test(tag)) return 'must contain at least one non-numeric character';
  return undefined;
}

/** Comparison key: Obsidian tags are case-insensitive. */
export function tagKey(tag: string): string {
  return tag.toLowerCase();
}

/** The first invalid tag and why, or undefined when all are valid. */
export function invalidTag(tags: readonly string[]): { tag: string; problem: string } | undefined {
  for (const tag of tags) {
    const problem = tagProblem(tag);
    if (problem) return { tag, problem };
  }
  return undefined;
}
