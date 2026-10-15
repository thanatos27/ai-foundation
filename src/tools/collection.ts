import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { CollectionConnector } from '../connectors/types.js';
import {
  CollectionCreateInputSchema,
  CollectionItemSchema,
  CollectionSearchFilterSchema,
  CollectionUpdateInputSchema,
} from '../domain/index.js';
import { ConfigurationError } from '../errors.js';
import type { ToolContext } from './index.js';
import { jsonResult } from './result.js';

const ItemOutputSchema = z.object({ item: CollectionItemSchema });
const ItemListOutputSchema = z.object({ items: z.array(CollectionItemSchema) });

const STATUS =
  `status is free text chosen per collection, e.g. game: wishlist / playing / completed, ` +
  `book: wishlist / reading / read, movie: wishlist / watched. ` +
  `Check the statuses existing items use (collection_search) and reuse them. Commas are not allowed in status or tags.`;

/** Registers collection_create / collection_search / collection_update (Source of Truth: Notion). */
export function registerCollectionTools(server: McpServer, { connectors }: ToolContext): void {
  const connector = (): CollectionConnector => {
    if (!connectors.collection) throw new ConfigurationError('the collection source (Notion) is not configured');
    return connectors.collection;
  };

  server.registerTool(
    'collection_create',
    {
      title: 'Create collection item',
      description:
        `Add a book, game, movie or other item to the AI Foundation Collection in Notion. ${STATUS} ` +
        `metadata is a free-form object (e.g. {"platform": "Xbox", "rating": 5}). ` +
        `note (optional) is saved as-is as the first paragraph of the item's page, for impressions, reading notes and the like.`,
      inputSchema: CollectionCreateInputSchema,
      outputSchema: ItemOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (input) => jsonResult({ item: await connector().create(input) }),
  );

  server.registerTool(
    'collection_search',
    {
      title: 'Search collection',
      description:
        `Search the AI Foundation Collection in Notion. Every filter is optional and narrows the result: ` +
        `query matches part of the title, collection_type and status match exactly, and tags must all be present. ` +
        `An empty filter returns every item. Only properties are searched, not page content. ` +
        `Use the returned id with collection_update. An item without metadata in the result has metadata ` +
        `that is not valid JSON in Notion.`,
      inputSchema: CollectionSearchFilterSchema,
      outputSchema: ItemListOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (filter) => jsonResult({ items: await connector().search(filter) }),
  );

  server.registerTool(
    'collection_update',
    {
      title: 'Update collection item',
      description:
        `Update a collection item by its exact id ("notion:<page-id>", from collection_search or collection_create); ` +
        `find the item with collection_search first. Only the given fields change: status: null clears the status, ` +
        `metadata is merged into the existing metadata key by key (a null value is stored as null), ` +
        `tags REPLACES all tags (to add a tag, pass the existing tags plus the new one; [] removes all), ` +
        `and append_note adds a paragraph to the end of the item's page without touching existing content. ` +
        `title and collection_type cannot be changed. ${STATUS}`,
      inputSchema: CollectionUpdateInputSchema,
      outputSchema: ItemOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (input) => jsonResult({ item: await connector().update(input) }),
  );
}
