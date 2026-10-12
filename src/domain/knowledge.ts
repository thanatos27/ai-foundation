import { z } from 'zod';
import { AreaSchema, TagsSchema } from './common.js';

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
  source: KnowledgeSourceSchema,
  external_ref: z.string().min(1),
  area: AreaSchema.nullable().optional(),
  tags: TagsSchema.optional(),
});
export type Knowledge = z.infer<typeof KnowledgeSchema>;
