import type { KnowledgeSearchFilter } from '../../domain/index.js';
import type { KnowledgeMeta } from './markdown.js';
import { tagKey } from './tags.js';

/** Code points in a snippet, and how many of them come before the query hit. */
export const SNIPPET_LENGTH = 160;
const SNIPPET_LEAD = 40;

const fold = (text: string) => text.toLowerCase();

/** Whether a note matches every given filter. Tags in `filter` must already be valid. */
export function matches(meta: KnowledgeMeta, body: string, filter: KnowledgeSearchFilter): boolean {
  if (filter.area !== undefined && meta.area !== filter.area) return false;
  if (filter.tags) {
    const keys = new Set(meta.tags.map(tagKey));
    if (!filter.tags.every((tag) => keys.has(tagKey(tag)))) return false;
  }
  if (filter.query !== undefined) {
    const query = fold(filter.query);
    const fields = [meta.title, meta.description ?? '', ...meta.tags, body];
    if (!fields.some((field) => fold(field).includes(query))) return false;
  }
  return true;
}

/**
 * A short excerpt of the body: around the first query hit when the body contains it, otherwise its
 * beginning. Whitespace is collapsed and `…` marks cut ends. Never the full body of a long note.
 */
export function snippet(body: string, query?: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  let start = 0;
  if (query !== undefined) {
    const folded = fold(flat);
    const index = folded.indexOf(fold(query));
    // Lowercasing can change the length of a few characters; fall back to the beginning then.
    if (index >= 0 && folded.length === flat.length) {
      start = Math.max(0, Array.from(flat.slice(0, index)).length - SNIPPET_LEAD);
    }
  }
  if (start > 0 && chars.length - start < SNIPPET_LENGTH) start = Math.max(0, chars.length - SNIPPET_LENGTH);
  const end = Math.min(chars.length, start + SNIPPET_LENGTH);
  return `${start > 0 ? '…' : ''}${chars.slice(start, end).join('')}${end < chars.length ? '…' : ''}`;
}
