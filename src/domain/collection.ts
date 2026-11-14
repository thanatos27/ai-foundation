import { z } from 'zod';
import { OptionalMetadataShape, TagsSchema } from './common.js';

export const CollectionTypeSchema = z.enum(['game', 'book', 'movie', 'other']);
export type CollectionType = z.infer<typeof CollectionTypeSchema>;

/** Free-form per collection (e.g. `playing`, `read`, `wishlist`). */
const CollectionStatusSchema = z.string().min(1);

/** Free-form object. Values may be any JSON, including null. */
export const CollectionMetadataSchema = z.record(z.string(), z.unknown());
export type CollectionMetadata = z.infer<typeof CollectionMetadataSchema>;

/** Non-blank text, stored as given (not trimmed). */
const NoteSchema = z.string().refine((text) => text.trim().length > 0, { message: 'must not be blank' });

/** A book, game, movie, etc. and its item-specific state. Source of Truth: Notion (spec §5.5). */
export const CollectionItemSchema = z.object({
  ...OptionalMetadataShape,
  type: z.literal('collection'),
  title: z.string().min(1),
  collection_type: CollectionTypeSchema,
  /** null once cleared by `collection_update`. */
  status: CollectionStatusSchema.nullable(),
  metadata: CollectionMetadataSchema.optional(),
  tags: TagsSchema.optional(),
});
export type CollectionItem = z.infer<typeof CollectionItemSchema>;

/** Input of `collection_create`. `note` becomes the first paragraph of the item's page. */
export const CollectionCreateInputSchema = z.strictObject({
  title: z.string().min(1),
  collection_type: CollectionTypeSchema,
  status: CollectionStatusSchema,
  metadata: CollectionMetadataSchema.optional(),
  tags: TagsSchema.optional(),
  note: NoteSchema.nullable().optional(),
});
export type CollectionCreateInput = z.infer<typeof CollectionCreateInputSchema>;

/** Input of `collection_search`. Every field narrows the result; an empty filter returns every item. */
export const CollectionSearchFilterSchema = z.strictObject({
  /** Part of the title. */
  query: z.string().min(1).optional(),
  collection_type: CollectionTypeSchema.optional(),
  /** Exact match. */
  status: CollectionStatusSchema.optional(),
  /** Matches items that have all of the given tags. */
  tags: TagsSchema.optional(),
});
export type CollectionSearchFilter = z.infer<typeof CollectionSearchFilterSchema>;

const COLLECTION_UPDATE_FIELDS = ['status', 'metadata', 'tags', 'append_note'] as const;

/** The fields of `collection_update` besides `id`; the HTTP API takes them as the request body. */
export const CollectionUpdateFields = {
  status: CollectionStatusSchema.nullable().optional(),
  metadata: CollectionMetadataSchema.optional(),
  tags: TagsSchema.optional(),
  append_note: NoteSchema.nullable().optional(),
};

/**
 * The rule of `collection_update` that spans its fields, for any object schema holding them: at
 * least one change (`append_note: null` changes nothing, so it does not count).
 */
export function withCollectionUpdateRules<
  T extends z.ZodType<Partial<Record<(typeof COLLECTION_UPDATE_FIELDS)[number], unknown>>>,
>(schema: T): T {
  return schema.refine(
    (input) =>
      input.status !== undefined || input.metadata !== undefined || input.tags !== undefined || input.append_note != null,
    { message: `At least one of ${COLLECTION_UPDATE_FIELDS.join(', ')} must be specified` },
  );
}

/**
 * Input of `collection_update`. Only the given fields change: `status: null` clears the status,
 * `metadata` is shallow-merged, `tags` replaces the tags and `append_note` is added to the end of
 * the page. `append_note: null` changes nothing, so it does not count as an update.
 */
export const CollectionUpdateInputSchema = withCollectionUpdateRules(
  z.strictObject({ id: z.string().min(1), ...CollectionUpdateFields }),
);
export type CollectionUpdateInput = z.infer<typeof CollectionUpdateInputSchema>;

/**
 * Shallow merge for `collection_update`: the patch's keys overwrite the current ones (a null value is
 * kept as null) and nested objects are replaced, not merged. Keys are never removed.
 */
export function mergeMetadata(current: CollectionMetadata, patch: CollectionMetadata): CollectionMetadata {
  return { ...current, ...patch };
}
