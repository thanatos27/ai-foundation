import { Client, isFullBlock } from '@notionhq/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lazyNotionClient, NOTION_API_VERSION } from '../../src/connectors/notion/client.js';
import { NotionCollectionConnector } from '../../src/connectors/notion/connector.js';
import type { CollectionItem } from '../../src/domain/index.js';
import { ConfigurationError, NotFoundError } from '../../src/errors.js';
import { credentials, enabled, hasEnv, integrationConfig, runLabel } from './setup.js';

const run = enabled && hasEnv('NOTION_API_TOKEN');

describe.runIf(run)('Notion collection (real API)', () => {
  let connector: NotionCollectionConnector;
  let dataSourceId: string;
  /** Direct SDK client, independent of the code under test (expectations and cleanup). */
  let raw: Client;
  const created: string[] = [];

  beforeAll(async () => {
    const config = await integrationConfig();
    const id = config.sources.collection.data_source_id;
    if (!id) throw new Error('Set sources.collection.data_source_id (e.g. in config.local.yaml)');
    dataSourceId = id;
    connector = new NotionCollectionConnector({ client: lazyNotionClient(credentials), dataSourceId });
    raw = new Client({ auth: await credentials.getNotionApiToken(), notionVersion: NOTION_API_VERSION });
  });

  afterAll(async () => {
    // The connector itself never deletes: move what this run created to the trash from here.
    await Promise.allSettled(created.map((pageId) => raw.pages.update({ page_id: pageId, in_trash: true })));
  });

  const pageIdOf = (item: CollectionItem) => item.id!.slice('notion:'.length);
  const remember = (item: CollectionItem) => {
    created.push(pageIdOf(item));
    return item;
  };

  async function paragraphs(item: CollectionItem): Promise<string[]> {
    const { results } = await raw.blocks.children.list({ block_id: pageIdOf(item) });
    return results.filter(isFullBlock).map((block) =>
      block.type === 'paragraph' ? block.paragraph.rich_text.map((text) => text.plain_text).join('') : `<${block.type}>`,
    );
  }

  it('creates an item with every property and an initial note', async () => {
    const item = remember(
      await connector.create({
        title: `${runLabel} ペルソナ3 リロード 😀`,
        collection_type: 'game',
        status: 'wishlist',
        metadata: { platform: 'Xbox', rating: null, nested: { a: 1 } },
        tags: ['RPG', 'af-it'],
        note: 'セールになったら買いたい\n2行目',
      }),
    );
    expect(item).toMatchObject({
      source: 'notion',
      title: `${runLabel} ペルソナ3 リロード 😀`,
      collection_type: 'game',
      status: 'wishlist',
      metadata: { platform: 'Xbox', rating: null, nested: { a: 1 } },
      tags: ['RPG', 'af-it'],
    });
    expect(item.external_ref).toMatch(/^https:\/\/(www\.)?notion\.so\//);
    expect(await paragraphs(item)).toEqual(['セールになったら買いたい\n2行目']);
  });

  it('searches by title part, type, status and all tags', async () => {
    const game = remember(
      await connector.create({ title: `${runLabel} Search Game`, collection_type: 'game', status: 'playing', tags: ['RPG', 'af-it'] }),
    );
    const book = remember(
      await connector.create({ title: `${runLabel} Search Book`, collection_type: 'book', status: 'reading', tags: ['af-it'] }),
    );
    const ids = (items: CollectionItem[]) => items.map((item) => item.id);

    expect(ids(await connector.search({ query: `${runLabel} Search` }))).toEqual(expect.arrayContaining([game.id, book.id]));
    // Notion's title "contains" is expected to ignore case (recorded in the plan / README).
    expect(ids(await connector.search({ query: `${runLabel} search game`.toLowerCase() }))).toContain(game.id);
    expect(ids(await connector.search({ query: runLabel, collection_type: 'book' }))).toEqual([book.id]);
    expect(ids(await connector.search({ query: runLabel, status: 'playing' }))).toEqual([game.id]);
    expect(ids(await connector.search({ query: runLabel, tags: ['af-it', 'RPG'] }))).toEqual([game.id]);
    expect(ids(await connector.search({}))).toEqual(expect.arrayContaining([game.id, book.id]));
  });

  it('merges metadata, replaces tags, clears status and appends notes by exact id', async () => {
    const item = remember(
      await connector.create({
        title: `${runLabel} Update`,
        collection_type: 'book',
        status: 'reading',
        metadata: { author: 'Martin Kleppmann', rating: null },
        tags: ['DB', 'af-it'],
        note: '最初のメモ',
      }),
    );

    const merged = await connector.update({ id: item.id!, status: 'read', metadata: { rating: 5 }, append_note: '読了' });
    expect(merged).toMatchObject({ status: 'read', metadata: { author: 'Martin Kleppmann', rating: 5 } });

    const replaced = await connector.update({ id: item.id!, tags: ['分散システム'], metadata: { rating: null } });
    expect(replaced).toMatchObject({ tags: ['分散システム'], metadata: { author: 'Martin Kleppmann', rating: null } });

    // The 32-hex form from Notion URLs addresses the same item.
    const compactId = `notion:${pageIdOf(item).replaceAll('-', '')}`;
    const cleared = await connector.update({ id: compactId, status: null, tags: [] });
    expect(cleared).toMatchObject({ id: item.id, status: null, tags: [] });

    expect(await paragraphs(item)).toEqual(['最初のメモ', '読了']);
  });

  it('creates select options that do not exist yet, and records how case differences behave', async () => {
    const status = `af-it-status-${Date.now()}`;
    const longTag = `af-it-long-${'x'.repeat(150)}`;
    const item = remember(
      await connector.create({ title: `${runLabel} Options`, collection_type: 'other', status, tags: ['af-it', longTag] }),
    );
    expect(item).toMatchObject({ status, tags: ['af-it', longTag] });

    const recased = await connector.update({ id: item.id!, tags: ['AF-IT'] });
    // Whatever Notion does here is recorded in the plan; the connector sends names as given.
    console.error(`[notion integration] tag "AF-IT" was stored as ${JSON.stringify(recased.tags)}`);
  });

  it('stores long metadata and notes split into 2,000-character chunks, and 100 tags', async () => {
    const longText = '長文メモ😀'.repeat(1_000); // 6,000 UTF-16 units including surrogate pairs
    const tags = ['af-it', ...Array.from({ length: 99 }, (_, i) => `af-it-${i}`)];
    const item = remember(
      await connector.create({
        title: `${runLabel} Long`,
        collection_type: 'other',
        status: 'x',
        metadata: { text: longText },
        tags,
        note: longText,
      }),
    );
    expect(item.metadata).toEqual({ text: longText });
    expect(item.tags).toHaveLength(100);
    expect(await paragraphs(item)).toEqual([longText]);
  });

  it('accepts a request close to the 500KB limit', async () => {
    const note = 'お'.repeat(160_000); // ~480KB of UTF-8
    const item = remember(await connector.create({ title: `${runLabel} Large`, collection_type: 'other', status: 'x', note }));
    expect((await paragraphs(item)).join('')).toBe(note);
  });

  it('reports a missing page as not found', async () => {
    await expect(
      connector.update({ id: 'notion:00000000-0000-4000-8000-000000000000', status: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reports a data source that is not shared as a configuration error', async () => {
    const other = new NotionCollectionConnector({
      client: lazyNotionClient(credentials),
      dataSourceId: '00000000-0000-4000-8000-000000000000',
    });
    await expect(other.search({})).rejects.toBeInstanceOf(ConfigurationError);
    expect(dataSourceId).toBeTruthy();
  });
});
