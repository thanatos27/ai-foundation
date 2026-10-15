import type { QueryDataSourceParameters } from '@notionhq/client';
import type { CollectionSearchFilter } from '../../domain/index.js';
import { PROPERTY } from './schema.js';

export type QueryFilter = NonNullable<QueryDataSourceParameters['filter']>;

/**
 * False when no item can match: select option names cannot contain commas, so such a status or tag
 * would only make Notion reject the query.
 */
export function canMatch(filter: CollectionSearchFilter): boolean {
  return ![filter.status, ...(filter.tags ?? [])].some((name) => name?.includes(','));
}

/**
 * The Notion query filter for `collection_search`: every given field must match (AND), and each tag
 * is its own condition so items need all of them. Undefined for an empty filter (every item).
 */
export function toQueryFilter(filter: CollectionSearchFilter): QueryFilter | undefined {
  const conditions: QueryFilter[] = [];
  if (filter.query !== undefined) conditions.push({ property: PROPERTY.title, title: { contains: filter.query } });
  if (filter.collection_type !== undefined) {
    conditions.push({ property: PROPERTY.collectionType, select: { equals: filter.collection_type } });
  }
  if (filter.status !== undefined) conditions.push({ property: PROPERTY.status, select: { equals: filter.status } });
  for (const tag of filter.tags ?? []) {
    conditions.push({ property: PROPERTY.tags, multi_select: { contains: tag } });
  }
  return conditions.length > 0 ? ({ and: conditions } as QueryFilter) : undefined;
}
