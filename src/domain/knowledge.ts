import { z } from 'zod';
import { AreaSchema, NonBlankSchema, TagsSchema } from './common.js';

export const KnowledgeSourceSchema = z.enum(['obsidian', 'google_drive']);
export type KnowledgeSource = z.infer<typeof KnowledgeSourceSchema>;

/**
 * Reusable learning or insight. Source of Truth: Obsidian / Google Drive (spec §5.6).
 * The body is not held here; it is read from the source when needed.
 */
export const KnowledgeSchema = z.object({
  id: z.string().min(1).optional(),
  type: z.literal('knowledge'),
  title: z.string().min(1),
  /** Short summary of the knowledge, or null. */
  description: z.string().nullable(),
  source: KnowledgeSourceSchema,
  external_ref: z.string().min(1),
  area: AreaSchema.nullable().optional(),
  tags: TagsSchema.optional(),
});
export type Knowledge = z.infer<typeof KnowledgeSchema>;

/**
 * Sources a knowledge tool input may name. `auto` resolves to `sources.knowledge.default`.
 * `google_drive` stays reserved in the domain but is not offered until it is implemented.
 */
export const KnowledgeSourceInputSchema = z.enum(['auto', 'obsidian']);

/** Input of `knowledge_create`. Omitted `area` means the default area; null means none. */
export const KnowledgeCreateInputSchema = z.strictObject({
  title: NonBlankSchema,
  description: NonBlankSchema.nullable().optional(),
  content: NonBlankSchema,
  source: KnowledgeSourceInputSchema.optional(),
  area: AreaSchema.nullable().optional(),
  tags: TagsSchema.optional(),
});
export type KnowledgeCreateInput = z.infer<typeof KnowledgeCreateInputSchema>;

/** Input of `knowledge_search`. Every field narrows the result; an empty filter lists all knowledge. */
export const KnowledgeSearchFilterSchema = z.strictObject({
  /** Case-insensitive substring of the title, description, tags or body. */
  query: NonBlankSchema.optional(),
  /** Exact match. null matches knowledge without an area. */
  area: AreaSchema.nullable().optional(),
  /** Matches knowledge that has all of the given tags. */
  tags: TagsSchema.optional(),
});
export type KnowledgeSearchFilter = z.infer<typeof KnowledgeSearchFilterSchema>;

/** Input of `knowledge_get`: an exact ID from `knowledge_search` or `knowledge_create`. */
export const KnowledgeGetInputSchema = z.strictObject({ id: z.string().min(1) });
export type KnowledgeGetInput = z.infer<typeof KnowledgeGetInputSchema>;

/** Input of `knowledge_append`: `content` is added to the end of the body as given. */
export const KnowledgeAppendInputSchema = z.strictObject({
  id: z.string().min(1),
  content: NonBlankSchema,
});
export type KnowledgeAppendInput = z.infer<typeof KnowledgeAppendInputSchema>;

/** One `knowledge_search` result: metadata and a short excerpt, never the full body. */
export const KnowledgeSearchResultSchema = KnowledgeSchema.extend({ snippet: z.string() });
export type KnowledgeSearchResult = z.infer<typeof KnowledgeSearchResultSchema>;

/** `knowledge_get` result: the body is kept apart from the metadata. */
export const KnowledgeDocumentSchema = z.object({ knowledge: KnowledgeSchema, content: z.string() });
export type KnowledgeDocument = z.infer<typeof KnowledgeDocumentSchema>;
