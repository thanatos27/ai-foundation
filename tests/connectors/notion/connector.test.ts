import { APIErrorCode } from '@notionhq/client';
import { beforeEach, describe, expect, it } from 'vitest';
import type { NotionClient } from '../../../src/connectors/notion/client.js';
import { NotionCollectionConnector } from '../../../src/connectors/notion/connector.js';
import {
  ConfigurationError,
  CredentialError,
  InputValidationError,
  NotFoundError,
  ProviderApiError,
} from '../../../src/errors.js';
import { apiError, DATA_SOURCE_ID, FakeNotion, OTHER_DATA_SOURCE_ID } from './fake-client.js';

let fake: FakeNotion;
let warnings: string[];
let connector: NotionCollectionConnector;

function connectorFor(options: { dataSourceId?: string | undefined; client?: () => Promise<NotionClient> } = {}) {
  return new NotionCollectionConnector({
    client: options.client ?? (async () => fake.client),
    dataSourceId: 'dataSourceId' in options ? options.dataSourceId : DATA_SOURCE_ID,
    warn: (message) => warnings.push(message),
  });
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

const writes = () => [
  ...fake.callsTo('pages.create'),
  ...fake.callsTo('pages.update'),
  ...fake.callsTo('blocks.children.append'),
];

const idOf = (pageId: string) => `notion:${pageId}`;

beforeEach(() => {
  fake = new FakeNotion();
  warnings = [];
  connector = connectorFor();
});

describe('data source', () => {
  it('reports a missing data_source_id before reading credentials', async () => {
    let clientRequested = false;
    const bare = connectorFor({
      dataSourceId: undefined,
      client: async () => {
        clientRequested = true;
        throw new CredentialError('not configured');
      },
    });
    const error = await failure(bare.search({}));
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.message).toBe('Configuration error: sources.collection.data_source_id is not set');
    expect(clientRequested).toBe(false);
  });

  it('checks the schema once per process', async () => {
    await connector.search({});
    await connector.search({});
    await connector.create({ title: 'a', collection_type: 'book', status: 'read' });
    expect(fake.callsTo('dataSources.retrieve')).toEqual([{ data_source_id: DATA_SOURCE_ID }]);
  });

  it('reports every schema problem as a configuration error, and checks again next time', async () => {
    const { Metadata: _metadata, ...rest } = fake.dataSourceSchemas.get(DATA_SOURCE_ID)!;
    fake.dataSourceSchemas.set(DATA_SOURCE_ID, { ...rest, Status: { type: 'status' } });

    const error = await failure(connector.search({}));
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.message).toContain(`Notion data source ${DATA_SOURCE_ID} does not match the Collection schema`);
    expect(error.message).toContain('property "Status" is status, expected select');
    expect(error.message).toContain('missing property "Metadata" (rich_text)');
    expect(fake.callsTo('dataSources.query')).toEqual([]);

    fake.dataSourceSchemas.set(DATA_SOURCE_ID, { ...rest, Status: { type: 'select' }, Metadata: { type: 'rich_text' } });
    await expect(connector.search({})).resolves.toEqual([]);
    expect(fake.callsTo('dataSources.retrieve')).toHaveLength(2);
  });

  it('reports a data source that is missing or not shared as a configuration error', async () => {
    const error = await failure(connectorFor({ dataSourceId: OTHER_DATA_SOURCE_ID }).search({}));
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.message).toBe(
      `Configuration error: Notion data source ${OTHER_DATA_SOURCE_ID} was not found or is not shared with the AI Foundation connection`,
    );
  });

  it('refuses to write while a Type option differs from a collection type only in case', async () => {
    // Notion would reuse "Book" for "book", saving an item whose Type reads back as invalid.
    const schema = fake.dataSourceSchemas.get(DATA_SOURCE_ID)!;
    schema.Type = { type: 'select', select: { options: [{ name: 'Book' }] } };

    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await failure(connector.create({ title: 'DDIA', collection_type: 'book', status: 'unread' }));
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(error.message).toContain('option "Book" of property "Type" must be spelled "book"');
    }
    expect(fake.callsTo('pages.create')).toEqual([]);
    expect(fake.storedPages.size).toBe(0);

    schema.Type = { type: 'select', select: { options: [{ name: 'book' }] } };
    const item = await connector.create({ title: 'DDIA', collection_type: 'book', status: 'unread' });
    expect(item.collection_type).toBe('book');
    await expect(connector.search({})).resolves.toHaveLength(1);
  });

  it('returns an existing status option with its own spelling', async () => {
    const schema = fake.dataSourceSchemas.get(DATA_SOURCE_ID)!;
    schema.Status = { type: 'select', select: { options: [{ name: 'Wishlist' }] } };
    const item = await connector.create({ title: 'a', collection_type: 'game', status: 'wishlist' });
    expect(item.status).toBe('Wishlist');
  });

  it('reports missing capabilities as a configuration error', async () => {
    fake.failNext('dataSources.retrieve', apiError(403, APIErrorCode.RestrictedResource));
    await expect(connector.search({})).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('reports a rejected token as a credential error', async () => {
    fake.failNext('dataSources.retrieve', apiError(401, APIErrorCode.Unauthorized));
    const error = await failure(connector.search({}));
    expect(error).toBeInstanceOf(CredentialError);
    expect(error.message).toBe('Credential error: Notion rejected the API token (HTTP 401)');
  });
});

describe('create', () => {
  it('creates the page in the configured data source with every property and the note', async () => {
    const item = await connector.create({
      title: 'ペルソナ3 リロード',
      collection_type: 'game',
      status: 'wishlist',
      metadata: { platform: 'Xbox' },
      tags: ['RPG', 'RPG', 'Xbox'],
      note: 'セールになったら買いたい',
    });

    const [request] = fake.callsTo('pages.create');
    expect(request).toEqual({
      parent: { type: 'data_source_id', data_source_id: DATA_SOURCE_ID },
      properties: {
        Name: { title: [{ type: 'text', text: { content: 'ペルソナ3 リロード' } }] },
        Type: { select: { name: 'game' } },
        Status: { select: { name: 'wishlist' } },
        Tags: { multi_select: [{ name: 'RPG' }, { name: 'Xbox' }] },
        Metadata: { rich_text: [{ type: 'text', text: { content: '{"platform":"Xbox"}' } }] },
      },
      children: [
        { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'セールになったら買いたい' } }] } },
      ],
    });
    expect(item).toMatchObject({
      id: expect.stringMatching(/^notion:[0-9a-f-]{36}$/),
      source: 'notion',
      external_ref: expect.stringMatching(/^https:\/\/www\.notion\.so\//),
      type: 'collection',
      title: 'ペルソナ3 リロード',
      collection_type: 'game',
      status: 'wishlist',
      metadata: { platform: 'Xbox' },
      tags: ['RPG', 'Xbox'],
    });
    const pageId = item.id!.slice('notion:'.length);
    expect(fake.storedBlocks.get(pageId)).toEqual([{ type: 'paragraph', text: 'セールになったら買いたい' }]);
  });

  it.each([
    ['null', null],
    ['omitted', undefined],
  ])('adds no page content for a %s note and empty metadata/tags', async (_label, note) => {
    const item = await connector.create({ title: 'a', collection_type: 'book', status: 'read', ...(note === null ? { note } : {}) });
    const [request] = fake.callsTo('pages.create');
    expect(request).not.toHaveProperty('children');
    expect(request!.properties.Metadata).toEqual({ rich_text: [] });
    expect(request!.properties.Tags).toEqual({ multi_select: [] });
    expect(item).toMatchObject({ metadata: {}, tags: [] });
  });

  it.each([
    ['a comma in status', { status: 'a,b' }, 'status must not contain commas'],
    ['a comma in a tag', { tags: ['a,b'] }, 'tags must not contain commas'],
    ['101 distinct tags', { tags: Array.from({ length: 101 }, (_, i) => `t${i}`) }, 'tags has 101 distinct values'],
    ['metadata over 200,000 characters', { metadata: { text: 'x'.repeat(200_000) } }, 'metadata JSON is'],
    ['a note over 200,000 characters', { note: 'x'.repeat(200_001) }, 'note is 200001 characters'],
    [
      'Japanese metadata within 200,000 characters but over 500KB',
      { metadata: { text: 'あ'.repeat(190_000) } },
      'the Notion request would be',
    ],
    [
      'fields each within limits but over 500KB combined',
      { title: 'い'.repeat(60_000), metadata: { text: 'う'.repeat(60_000) }, note: 'え'.repeat(60_000) },
      '(title, metadata, note and tags combined)',
    ],
  ])('rejects %s without calling Notion', async (_label, overrides, message) => {
    const error = await failure(
      connector.create({ title: 'a', collection_type: 'book', status: 'read', ...overrides }),
    );
    expect(error).toBeInstanceOf(InputValidationError);
    expect(error.message).toContain(message);
    expect(fake.calls).toEqual([]);
  });

  it('accepts 100 tags and long option names', async () => {
    const tags = Array.from({ length: 100 }, (_, i) => `tag-${i}-${'x'.repeat(150)}`);
    const item = await connector.create({ title: 'a', collection_type: 'other', status: 'y'.repeat(150), tags });
    expect(item.tags).toHaveLength(100);
  });

  it('accepts a large request just under 500KB', async () => {
    const item = await connector.create({
      title: 'a',
      collection_type: 'book',
      status: 'read',
      note: 'お'.repeat(160_000), // ~480KB
    });
    expect(item.title).toBe('a');
  });

  it('maps API errors', async () => {
    fake.failNext('pages.create', apiError(429, APIErrorCode.RateLimited, 'slow down'));
    const error = await failure(connector.create({ title: 'a', collection_type: 'book', status: 'read' }));
    expect(error).toBeInstanceOf(ProviderApiError);
    expect(error.message).toBe('Notion API error: HTTP 429 rate_limited: slow down');
  });
});

describe('search', () => {
  it('returns every item for an empty filter, most recently edited first, without reading page content', async () => {
    const older = fake.seed({ title: 'older', lastEdited: 1 });
    const newer = fake.seed({ title: 'newer', lastEdited: 2 });
    fake.seed({ title: 'elsewhere', parentDataSourceId: OTHER_DATA_SOURCE_ID });
    fake.seed({ title: 'trashed', inTrash: true });

    const items = await connector.search({});
    expect(items.map((item) => item.id)).toEqual([idOf(newer), idOf(older)]);

    const [query] = fake.callsTo('dataSources.query');
    expect(query).toEqual({
      data_source_id: DATA_SOURCE_ID,
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
      page_size: 100,
      result_type: 'page',
    });
    expect(fake.callsTo('pages.retrieve')).toEqual([]);
  });

  it('filters by title part, type, status and all tags', async () => {
    const match = fake.seed({ title: 'ペルソナ3 リロード', type: 'game', status: 'playing', tags: ['RPG', 'Xbox'] });
    fake.seed({ title: 'ペルソナ5', type: 'game', status: 'playing', tags: ['RPG'] });
    fake.seed({ title: 'ペルソナ3 リロード 攻略本', type: 'book', status: 'playing', tags: ['RPG', 'Xbox'] });
    fake.seed({ title: 'ペルソナ3', type: 'game', status: 'completed', tags: ['RPG', 'Xbox'] });

    const items = await connector.search({ query: 'ペルソナ3', collection_type: 'game', status: 'playing', tags: ['RPG', 'Xbox'] });
    expect(items.map((item) => item.id)).toEqual([idOf(match)]);
    expect(fake.callsTo('dataSources.query')[0]!.filter).toEqual({
      and: [
        { property: 'Name', title: { contains: 'ペルソナ3' } },
        { property: 'Type', select: { equals: 'game' } },
        { property: 'Status', select: { equals: 'playing' } },
        { property: 'Tags', multi_select: { contains: 'RPG' } },
        { property: 'Tags', multi_select: { contains: 'Xbox' } },
      ],
    });
  });

  it('follows pagination to the end', async () => {
    fake.pageSize = 2;
    for (let i = 0; i < 5; i++) fake.seed({ title: `item ${i}` });
    const items = await connector.search({});
    expect(items).toHaveLength(5);
    expect(fake.callsTo('dataSources.query').map((query) => query.start_cursor)).toEqual([undefined, '2', '4']);
  });

  it('fails rather than returning an incomplete result', async () => {
    fake.incompleteQuery = true;
    const error = await failure(connector.search({}));
    expect(error).toBeInstanceOf(ProviderApiError);
    expect(error.message).toContain('incomplete (query_result_limit_reached)');
  });

  it('skips pages without a valid Type and reports how many', async () => {
    const valid = fake.seed({ type: 'movie' });
    fake.seed({ type: null });
    fake.seed({ type: 'music' });
    const items = await connector.search({});
    expect(items.map((item) => item.id)).toEqual([idOf(valid)]);
    expect(warnings).toEqual([
      'collection_search skipped 2 Notion page(s) whose Type is empty or not game/book/movie/other',
    ]);
  });

  it('returns items with unreadable metadata without their metadata', async () => {
    fake.seed({ metadata: '{broken' });
    const [item] = await connector.search({});
    expect(item).not.toHaveProperty('metadata');
  });

  it('returns nothing for a status or tag that cannot exist, without querying', async () => {
    fake.seed({ status: 'read' });
    await expect(connector.search({ tags: ['a,b'] })).resolves.toEqual([]);
    expect(fake.callsTo('dataSources.query')).toEqual([]);
  });
});

describe('update', () => {
  let pageId: string;

  beforeEach(() => {
    pageId = fake.seed({
      title: 'ペルソナ3 リロード',
      type: 'game',
      status: 'playing',
      tags: ['RPG'],
      metadata: '{"platform":"Xbox","rating":null}',
    });
    fake.storedBlocks.get(pageId)!.push({ type: 'paragraph', text: '既存のメモ' });
  });

  it('updates status, merges metadata, replaces tags and appends the note (spec example)', async () => {
    const item = await connector.update({
      id: idOf(pageId),
      status: 'completed',
      metadata: { rating: 5 },
      tags: ['RPG', 'Xbox'],
      append_note: 'ストーリー後半が特によかった',
    });

    expect(fake.callsTo('pages.update')).toEqual([
      {
        page_id: pageId,
        properties: {
          Status: { select: { name: 'completed' } },
          Tags: { multi_select: [{ name: 'RPG' }, { name: 'Xbox' }] },
          Metadata: { rich_text: [{ type: 'text', text: { content: '{"platform":"Xbox","rating":5}' } }] },
        },
      },
    ]);
    expect(fake.callsTo('blocks.children.append')).toEqual([
      {
        block_id: pageId,
        children: [
          { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'ストーリー後半が特によかった' } }] } },
        ],
        position: { type: 'end' },
      },
    ]);
    expect(fake.storedBlocks.get(pageId)).toEqual([
      { type: 'paragraph', text: '既存のメモ' },
      { type: 'paragraph', text: 'ストーリー後半が特によかった' },
    ]);
    expect(item).toMatchObject({
      id: idOf(pageId),
      title: 'ペルソナ3 リロード',
      collection_type: 'game',
      status: 'completed',
      metadata: { platform: 'Xbox', rating: 5 },
      tags: ['RPG', 'Xbox'],
    });
  });

  it('accepts the ID without hyphens', async () => {
    await connector.update({ id: idOf(pageId.replaceAll('-', '')), status: 'completed' });
    expect(fake.callsTo('pages.update')).toHaveLength(1);
  });

  it('clears the status and all tags', async () => {
    const item = await connector.update({ id: idOf(pageId), status: null, tags: [] });
    expect(fake.callsTo('pages.update')[0]!.properties).toEqual({ Status: { select: null }, Tags: { multi_select: [] } });
    expect(item).toMatchObject({ status: null, tags: [] });
  });

  it('stores null metadata values and keeps other keys', async () => {
    await connector.update({ id: idOf(pageId), metadata: { platform: null } });
    expect(JSON.parse(fake.metadataText(pageId))).toEqual({ platform: null, rating: null });
  });

  it('merges into empty metadata', async () => {
    const empty = fake.seed({ metadata: '' });
    await connector.update({ id: idOf(empty), metadata: { platform: 'Switch' } });
    expect(JSON.parse(fake.metadataText(empty))).toEqual({ platform: 'Switch' });
  });

  it('only appends the note when nothing else changes', async () => {
    const item = await connector.update({ id: idOf(pageId), append_note: '追記' });
    expect(fake.callsTo('pages.update')).toEqual([]);
    expect(fake.callsTo('blocks.children.append')).toHaveLength(1);
    expect(item).toMatchObject({ status: 'playing', tags: ['RPG'] });
  });

  it('never sends title or collection_type', async () => {
    await connector.update({ id: idOf(pageId), status: 'completed', metadata: {}, tags: ['x'] });
    expect(Object.keys(fake.callsTo('pages.update')[0]!.properties).sort()).toEqual(['Metadata', 'Status', 'Tags']);
  });

  it('rejects a malformed id without calling Notion', async () => {
    const error = await failure(connector.update({ id: 'todoist:1', status: 'x' }));
    expect(error).toBeInstanceOf(InputValidationError);
    expect(fake.calls).toEqual([]);
  });

  it.each([
    ['a page that does not exist', () => '00000000-0000-4000-8000-999999999999'],
    ['a page outside the collection data source', () => fake.seed({ parentDataSourceId: OTHER_DATA_SOURCE_ID })],
    ['a page in the trash', () => fake.seed({ inTrash: true })],
  ])('reports %s as not found without writing', async (_label, target) => {
    const id = idOf(target());
    const error = await failure(connector.update({ id, status: 'x', append_note: 'y' }));
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.message).toBe(`Not found: collection item ${id}`);
    expect(writes()).toEqual([]);
  });

  it('refuses to update a page without a valid Type, before writing', async () => {
    const untyped = fake.seed({ type: null });
    const error = await failure(connector.update({ id: idOf(untyped), status: 'x' }));
    expect(error).toBeInstanceOf(ProviderApiError);
    expect(error.message).toContain('has no valid Type');
    expect(writes()).toEqual([]);
  });

  it('refuses to merge into unreadable metadata, leaving Notion unchanged', async () => {
    const broken = fake.seed({ metadata: '{hand edited' });
    const error = await failure(connector.update({ id: idOf(broken), status: 'x', metadata: { rating: 5 } }));
    expect(error).toBeInstanceOf(ProviderApiError);
    expect(error.message).toContain('is not a JSON object; fix it in Notion');
    expect(writes()).toEqual([]);
    expect(fake.metadataText(broken)).toBe('{hand edited');
  });

  it('still updates other fields of an item with unreadable metadata', async () => {
    const broken = fake.seed({ metadata: '{hand edited' });
    const item = await connector.update({ id: idOf(broken), status: 'read' });
    expect(item.status).toBe('read');
    expect(item).not.toHaveProperty('metadata');
    expect(fake.metadataText(broken)).toBe('{hand edited');
  });

  it.each([
    ['101 distinct tags', { tags: Array.from({ length: 101 }, (_, i) => `t${i}`) }, 'tags has 101 distinct values'],
    ['a comma in status', { status: 'a,b' }, 'status must not contain commas'],
    ['a merged metadata over 500KB', { metadata: { text: 'あ'.repeat(190_000) } }, '(status, metadata and tags combined)'],
    ['a note over 500KB (properties within limits)', { status: 'ok', append_note: 'あ'.repeat(170_000) }, '(append_note combined)'],
  ])('rejects %s before writing anything', async (_label, fields, message) => {
    const error = await failure(connector.update({ id: idOf(pageId), ...fields }));
    expect(error).toBeInstanceOf(InputValidationError);
    expect(error.message).toContain(message);
    expect(writes()).toEqual([]);
  });

  it('says the properties were updated when appending the note fails afterwards', async () => {
    fake.failNext('blocks.children.append', apiError(503, APIErrorCode.ServiceUnavailable, 'down'));
    const error = await failure(connector.update({ id: idOf(pageId), status: 'completed', append_note: 'メモ' }));
    expect(error).toBeInstanceOf(ProviderApiError);
    expect(error.message).toBe(
      `Notion API error: the properties of collection item ${idOf(pageId)} were updated, but the note could not be appended: ` +
        'Notion API error: HTTP 503 service_unavailable: down',
    );
  });

  it('does not append the note when updating the properties fails', async () => {
    fake.failNext('pages.update', apiError(409, APIErrorCode.ConflictError));
    await expect(connector.update({ id: idOf(pageId), status: 'x', append_note: 'y' })).rejects.toBeInstanceOf(
      ProviderApiError,
    );
    expect(fake.callsTo('blocks.children.append')).toEqual([]);
  });

  it('maps an append failure as is when nothing else was written', async () => {
    fake.failNext('blocks.children.append', apiError(404, APIErrorCode.ObjectNotFound));
    await expect(connector.update({ id: idOf(pageId), append_note: 'y' })).rejects.toBeInstanceOf(NotFoundError);
  });
});
