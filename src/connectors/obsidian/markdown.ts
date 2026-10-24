import { Document, parseDocument } from 'yaml';
import { type Area, AreaSchema } from '../../domain/index.js';
import { ProviderApiError } from '../../errors.js';
import { tagProblem } from './tags.js';
import { normalizeBody } from './text.js';

/** Shared with life logs; re-exported for existing importers. */
export { appendText } from './text.js';

/**
 * Knowledge Markdown: optional YAML frontmatter between `---` lines, then the body. Pure text
 * handling; the file system is the storage's job.
 */

/** The frontmatter keys AI Foundation reads. Other keys are left alone. */
export interface KnowledgeMeta {
  title: string;
  description: string | null;
  area: Area | null;
  tags: string[];
}

export type ParsedKnowledgeFile =
  | { ok: true; meta: KnowledgeMeta; body: string }
  /** The frontmatter exists but cannot be used. Such files are never rewritten or repaired. */
  | { ok: false; reason: string };

const OPENING = /^---\r?\n/;
const CLOSING = /^---[ \t]*$/;

type Split = { yaml: string; body: string } | 'none' | 'unclosed';

function split(text: string): Split {
  const opening = OPENING.exec(text);
  if (!opening) return 'none';
  let lineStart = opening[0].length;
  for (;;) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    if (CLOSING.test(text.slice(lineStart, lineEnd).replace(/\r$/, ''))) {
      const rest = newline === -1 ? '' : text.slice(newline + 1);
      // The blank line separating frontmatter and body (written by knowledge_create) is not body.
      return { yaml: text.slice(opening[0].length, lineStart), body: rest.replace(/^\r?\n/, '') };
    }
    if (newline === -1) return 'unclosed';
    lineStart = newline + 1;
  }
}

/** Reads a knowledge file. `fileTitle` is the title used when the frontmatter has none. */
export function parseKnowledgeFile(text: string, fileTitle: string): ParsedKnowledgeFile {
  const parts = split(text);
  if (parts === 'none') return { ok: true, meta: { title: fileTitle, description: null, area: null, tags: [] }, body: text };
  if (parts === 'unclosed') return { ok: false, reason: 'the frontmatter is not closed with "---"' };

  const doc = parseDocument(parts.yaml, { uniqueKeys: true });
  if (doc.errors.length > 0) return { ok: false, reason: 'the frontmatter is not valid YAML' };
  let data: unknown;
  try {
    data = doc.toJS();
  } catch {
    return { ok: false, reason: 'the frontmatter is not valid YAML' };
  }
  if (data == null) data = {};
  if (typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'the frontmatter is not a mapping' };
  const fields = data as Record<string, unknown>;

  const title = fields.title ?? fileTitle;
  if (typeof title !== 'string' || title.trim() === '') return { ok: false, reason: 'title must be a non-empty string' };

  const description = fields.description ?? null;
  if (description !== null && typeof description !== 'string') {
    return { ok: false, reason: 'description must be a string' };
  }

  const area = fields.area ?? null;
  if (area !== null && !AreaSchema.safeParse(area).success) {
    return { ok: false, reason: 'area must be "work" or "personal"' };
  }

  const tags = fields.tags ?? [];
  if (!Array.isArray(tags)) return { ok: false, reason: 'tags must be a list' };
  for (const tag of tags) {
    if (typeof tag !== 'string') return { ok: false, reason: 'tags must be a list of strings' };
    const problem = tagProblem(tag);
    if (problem) return { ok: false, reason: `tag "${tag}" is not a valid Obsidian tag (${problem})` };
  }

  return {
    ok: true,
    meta: { title, description: description === '' ? null : description, area: area as Area | null, tags },
    body: parts.body,
  };
}

/**
 * Text of a new knowledge file: frontmatter, a blank line and the content, with LF line endings and
 * a final newline. Keys without a value (no description / area, no tags) are left out.
 */
export function createFileText(meta: KnowledgeMeta, content: string): string {
  const fields: Record<string, unknown> = { title: meta.title };
  if (meta.description !== null) fields.description = meta.description;
  if (meta.area !== null) fields.area = meta.area;
  if (meta.tags.length > 0) fields.tags = meta.tags;

  const yaml = new Document(fields).toString({ lineWidth: 0 });
  let body = content.replace(/\r\n?/g, '\n');
  if (!body.endsWith('\n')) body += '\n';
  const text = `---\n${yaml}---\n\n${body}`;

  // The file must read back exactly as written; anything else is a serializer bug, not user input.
  const parsed = parseKnowledgeFile(text, meta.title);
  if (!parsed.ok || JSON.stringify(parsed.meta) !== JSON.stringify(meta) || parsed.body !== body) {
    throw new ProviderApiError('Obsidian', 'the new note would not read back as written; it was not created');
  }
  return text;
}
