import { z } from 'zod';
import { OptionalMetadataShape, TagsSchema } from './common.js';

export const CollectionTypeSchema = z.enum(['game', 'book', 'movie', 'other']);
export type CollectionType = z.infer<typeof CollectionTypeSchema>;

/** A book, game, movie, etc. and its item-specific state. Source of Truth: Notion (spec §5.5). */
export const CollectionItemSchema = z.object({
  ...OptionalMetadataShape,
  type: z.literal('collection'),
  title: z.string().min(1),
  collection_type: CollectionTypeSchema,
  /** Free-form per collection (e.g. `playing`, `read`, `wishlist`). */
  status: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  tags: TagsSchema.optional(),
});
export type CollectionItem = z.infer<typeof CollectionItemSchema>;
