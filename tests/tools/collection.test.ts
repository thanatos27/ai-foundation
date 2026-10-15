import type { Client } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigurationError, NotFoundError } from '../../src/errors.js';
import { FakeCollectionConnector } from '../helpers/fake-connectors.js';
import { connectClient, resultText } from '../helpers/mcp.js';

const ID = 'notion:0f9e3c1a-1111-2222-3333-444455556666';

let connector: FakeCollectionConnector;
let client: Client;

beforeEach(async () => {
  connector = new FakeCollectionConnector();
  client = await connectClient({ collection: connector });
});

afterEach(async () => {
  await client.close();
});

describe('collection tools', () => {
  it('lists the three collection tools with their schemas and annotations', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    expect(byName.collection_create?.inputSchema).toMatchObject({
      required: ['title', 'collection_type', 'status'],
      additionalProperties: false,
    });
    const type = (byName.collection_create?.inputSchema.properties as Record<string, { enum?: string[] }>)
      .collection_type;
    expect(type?.enum).toEqual(['game', 'book', 'movie', 'other']);
    expect(byName.collection_create?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });

    expect(byName.collection_search?.inputSchema).toMatchObject({ additionalProperties: false });
    expect(byName.collection_search?.inputSchema.required ?? []).toEqual([]);
    expect(byName.collection_search?.annotations).toMatchObject({ readOnlyHint: true });

    const update = byName.collection_update?.inputSchema;
    expect(update).toMatchObject({ required: ['id'], additionalProperties: false });
    expect(Object.keys(update?.properties ?? {}).sort()).toEqual(['append_note', 'id', 'metadata', 'status', 'tags']);
    expect(byName.collection_update?.annotations).toMatchObject({ destructiveHint: true });
    expect(byName.collection_update?.annotations?.idempotentHint).toBeUndefined();
    expect(byName.collection_update?.description).toContain('REPLACES');
    expect(byName.collection_update?.outputSchema).toBeDefined();
  });

  it('creates an item and returns it as structured content and JSON text', async () => {
    const input = {
      title: 'ペルソナ3 リロード',
      collection_type: 'game',
      status: 'wishlist',
      metadata: { platform: 'Xbox' },
      tags: ['RPG'],
      note: 'セールになったら買いたい',
    };
    const result = await client.callTool({ name: 'collection_create', arguments: input });

    expect(result.isError).toBeFalsy();
    expect(connector.calls).toEqual([{ method: 'create', arg: input }]);
    expect(result.structuredContent).toMatchObject({
      item: { id: 'notion:1', source: 'notion', type: 'collection', title: 'ペルソナ3 リロード', status: 'wishlist' },
    });
    expect(JSON.parse(resultText(result))).toEqual(result.structuredContent);
  });

  it('passes search filters through unchanged', async () => {
    await connector.create({ title: 'a', collection_type: 'book', status: 'reading' });
    const filter = { query: 'a', collection_type: 'book', status: 'reading', tags: ['分散システム'] };
    const result = await client.callTool({ name: 'collection_search', arguments: filter });

    expect(result.isError).toBeFalsy();
    expect(connector.calls.at(-1)).toEqual({ method: 'search', arg: filter });
    expect(result.structuredContent).toMatchObject({ items: [{ id: 'notion:1' }] });
  });

  it('searches with an empty filter', async () => {
    const result = await client.callTool({ name: 'collection_search', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(connector.calls).toEqual([{ method: 'search', arg: {} }]);
    expect(result.structuredContent).toEqual({ items: [] });
  });

  it('updates by exact id, including a cleared status', async () => {
    const args = { id: ID, status: null, metadata: { rating: 5 }, tags: [], append_note: 'よかった' };
    const result = await client.callTool({ name: 'collection_update', arguments: args });

    expect(result.isError).toBeFalsy();
    expect(connector.calls).toEqual([{ method: 'update', arg: args }]);
    expect(result.structuredContent).toMatchObject({ item: { id: ID, status: null, metadata: { rating: 5 }, tags: [] } });
  });

  it.each([
    ['collection_create', { title: 'a', collection_type: 'game' }],
    ['collection_create', { title: 'a', collection_type: 'music', status: 'wishlist' }],
    ['collection_create', { title: 'a', collection_type: 'game', status: 'wishlist', note: '' }],
    ['collection_create', { title: 'a', collection_type: 'game', status: 'wishlist', data_source_id: 'x' }],
    ['collection_search', { database_id: 'x' }],
    ['collection_update', { id: ID }],
    ['collection_update', { id: ID, append_note: null }],
    ['collection_update', { id: ID, title: 'renamed' }],
    ['collection_update', { id: ID, collection_type: 'book' }],
    ['collection_update', { status: 'completed' }],
  ])('rejects invalid %s input without calling the connector: %j', async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('Input validation error');
    expect(connector.calls).toEqual([]);
  });

  it.each([
    [new NotFoundError(`collection item ${ID}`), `Not found: collection item ${ID}`],
    [
      new ConfigurationError('sources.collection.data_source_id is not set'),
      'Configuration error: sources.collection.data_source_id is not set',
    ],
  ])('returns connector errors as tool errors: %s', async (error, message) => {
    connector.failWith = error;
    const result = await client.callTool({ name: 'collection_update', arguments: { id: ID, status: 'read' } });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(message);
  });
});

describe('collection tools without a connector', () => {
  it('are still listed and return a configuration error', async () => {
    const bare = await connectClient({});
    try {
      const { tools } = await bare.listTools();
      expect(tools.map((tool) => tool.name)).toContain('collection_create');

      const result = await bare.callTool({ name: 'collection_search', arguments: {} });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toBe('Configuration error: the collection source (Notion) is not configured');
    } finally {
      await bare.close();
    }
  });
});
