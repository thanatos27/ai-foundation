import { APIErrorCode } from '@notionhq/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { matchesFilter, NotionAreaConnector, sortAreas } from '../../../src/connectors/notion/area-connector.js';
import type { AreaResource } from '../../../src/domain/index.js';
import {
  ConfigurationError,
  CredentialError,
  InputValidationError,
  NotFoundError,
  ProviderApiError,
} from '../../../src/errors.js';
import { apiError, FakeNotion, richTextItem } from './fake-client.js';

let notion: FakeNotion;
let parent: string;

beforeEach(() => {
  notion = new FakeNotion();
  parent = notion.seedPlainPage({ title: 'Areas' });
});

/** The connector for `parent`, or for the given parent page id (`undefined`: not configured). */
const connector = (...args: [parentPageId: string | undefined] | []) =>
  new NotionAreaConnector({ client: async () => notion.client, parentPageId: args.length > 0 ? args[0] : parent });

const id = (pageId: string) => `notion:${pageId}`;
const compact = (pageId: string) => pageId.replaceAll('-', '');
const url = (pageId: string) => `https://www.notion.so/${compact(pageId)}`;

const areaOf = (pageId: string, title: string): AreaResource => ({
  id: id(pageId),
  type: 'area',
  title,
  source: 'notion',
  external_ref: url(pageId),
});

/** A paragraph block seed. */
const paragraph = (text: string, children?: Parameters<FakeNotion['appendBlocks']>[1]) => ({
  type: 'paragraph',
  content: { rich_text: [richTextItem(text)] },
  ...(children ? { children } : {}),
});

const bullet = (text: string, children?: Parameters<FakeNotion['appendBlocks']>[1]) => ({
  type: 'bulleted_list_item',
  content: { rich_text: [richTextItem(text)] },
  ...(children ? { children } : {}),
});

/**
 * Areas page with: two areas, a trashed area, an area-like page inside a column, a grandchild page,
 * other blocks, and pages elsewhere (another parent, a collection item).
 */
function mixedWorkspace() {
  const meals = notion.seedPlainPage({ title: '食事管理', parentPageId: parent });
  const assets = notion.seedPlainPage({ title: 'Assets', parentPageId: parent });
  const trashed = notion.seedPlainPage({ title: 'ゴミ箱テスト', parentPageId: parent, inTrash: true });
  const [, columnList] = notion.appendBlocks(parent, [paragraph('intro'), { type: 'column_list', children: [{ type: 'column' }] }]);
  const column = notion.childBlocks.get(columnList!)![0]!.id as string;
  const inColumn = notion.seedPlainPage({ title: 'In column', parentBlockId: column });
  const grandchild = notion.seedPlainPage({ title: 'Recipes', parentPageId: meals });
  notion.appendBlocks(parent, [
    { type: 'child_database', content: { title: 'Areas DB' } },
    { type: 'link_to_page', content: { type: 'page_id', page_id: grandchild } },
  ]);
  const otherParent = notion.seedPlainPage({ title: 'Projects' });
  const elsewhere = notion.seedPlainPage({ title: 'Elsewhere', parentPageId: otherParent });
  const collectionItem = notion.seed({ title: 'Book' });
  return { meals, assets, trashed, inColumn, grandchild, elsewhere, collectionItem };
}

describe('NotionAreaConnector.list', () => {
  it('returns no areas for an empty parent page', async () => {
    expect(await connector().list({})).toEqual([]);
  });

  it('lists the child pages directly under the parent page, sorted by title', async () => {
    const { meals, assets } = mixedWorkspace();
    expect(await connector().list({})).toEqual([areaOf(assets, 'Assets'), areaOf(meals, '食事管理')]);
  });

  it('never retrieves the area pages themselves', async () => {
    mixedWorkspace();
    await connector().list({});
    expect(notion.callsTo('pages.retrieve')).toEqual([{ page_id: parent }]);
    expect(notion.callsTo('blocks.children.list').map((call) => call.block_id)).toEqual([parent]);
  });

  it('excludes child_page blocks in the trash', async () => {
    notion.appendBlocks(parent, [{ type: 'child_page', content: { title: 'Gone' }, inTrash: true }]);
    expect(await connector().list({})).toEqual([]);
  });

  it('filters by a case-insensitive substring of the title', async () => {
    const meals = notion.seedPlainPage({ title: 'Meal planning', parentPageId: parent });
    notion.seedPlainPage({ title: 'Assets', parentPageId: parent });
    expect(await connector().list({ query: 'MEAL' })).toEqual([areaOf(meals, 'Meal planning')]);
    expect(await connector().list({ query: 'nothing' })).toEqual([]);
  });

  it('reads every page of blocks', async () => {
    notion.pageSize = 2;
    const titles = ['e', 'd', 'c', 'b', 'a'];
    for (const title of titles) notion.seedPlainPage({ title, parentPageId: parent });
    const areas = await connector().list({});
    expect(areas.map((area) => area.title)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(notion.callsTo('blocks.children.list')).toHaveLength(3);
    expect(notion.callsTo('blocks.children.list')[1]).toMatchObject({ block_id: parent, start_cursor: '2' });
  });

  it('keeps an area once when a page of blocks repeats it', async () => {
    const meals = notion.seedPlainPage({ title: 'Meals', parentPageId: parent });
    notion.childBlocks.get(parent)!.push(structuredClone(notion.childBlocks.get(parent)![0]!));
    expect(await connector().list({})).toEqual([areaOf(meals, 'Meals')]);
  });

  it('calls an untitled page "Untitled"', async () => {
    const page = notion.seedPlainPage({ title: '', parentPageId: parent });
    expect(await connector().list({})).toEqual([areaOf(page, 'Untitled')]);
  });
});

describe('sortAreas / matchesFilter', () => {
  const a = (pageId: string, title: string) => areaOf(pageId, title);

  it('sorts by title ignoring case, then by exact title, then by id', () => {
    const ids = ['00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001'];
    const sorted = sortAreas([a(ids[0]!, 'beta'), a(ids[1]!, 'Alpha'), a(ids[2]!, 'beta'), a(ids[2]!.replace('1', '9'), 'alpha')]);
    expect(sorted.map((area) => [area.title, area.id.slice(-1)])).toEqual([
      ['Alpha', '2'],
      ['alpha', '9'],
      ['beta', '1'],
      ['beta', '3'],
    ]);
  });

  it('matches every area without a query', () => {
    expect(matchesFilter(a('x', '食事管理'), {})).toBe(true);
    expect(matchesFilter(a('x', '食事管理'), { query: '食事' })).toBe(true);
    expect(matchesFilter(a('x', '食事管理'), { query: '運動' })).toBe(false);
  });
});

describe('NotionAreaConnector.get', () => {
  it('returns the area and its table of contents', async () => {
    const meals = notion.seedPlainPage({ title: '食事管理', parentPageId: parent });
    const recipes = notion.seedPlainPage({ title: 'レシピ', parentPageId: meals });
    notion.appendBlocks(meals, [
      { type: 'heading_2', content: { rich_text: [richTextItem('Knowledge')] } },
      bullet('obsidian:Knowledge/栄養.md'),
      bullet('記録', [bullet('食事記録', [paragraph('メモ')])]),
    ]);
    notion.appendBlocks(recipes, [paragraph('secret recipe')]);

    const result = await connector().get(id(meals));
    expect(result).toEqual({
      area: areaOf(meals, '食事管理'),
      content: [
        `- [レシピ](${url(recipes)})`,
        '',
        '## Knowledge',
        '- obsidian:Knowledge/栄養.md',
        '- 記録',
        '  - 食事記録',
        '    メモ',
      ].join('\n'),
    });
    // Read-only, and the child page's own content is never fetched.
    expect(new Set(notion.calls.map((call) => call.method))).toEqual(new Set(['pages.retrieve', 'blocks.children.list']));
    expect(notion.callsTo('blocks.children.list').map((call) => call.block_id)).not.toContain(recipes);
  });

  it.each([
    ['the 32-hex form', (pageId: string) => `notion:${compact(pageId)}`],
    ['upper case', (pageId: string) => `notion:${pageId.toUpperCase()}`],
  ])('accepts %s and returns the canonical id', async (_, form) => {
    const meals = notion.seedPlainPage({ title: 'Meals', parentPageId: parent });
    expect((await connector().get(form(meals))).area).toEqual(areaOf(meals, 'Meals'));
  });

  it('reads the title from the title property whatever its name', async () => {
    const page = notion.seedPlainPage({ title: 'Meals', titleProperty: 'Name', parentPageId: parent });
    expect((await connector().get(id(page))).area.title).toBe('Meals');
  });

  it('joins a title made of several rich text items', async () => {
    const page = notion.seedPlainPage({ title: 'x', parentPageId: parent });
    const stored = notion.storedPages.get(page)!;
    stored.properties.title = { id: 'title', type: 'title', title: [richTextItem('食事'), richTextItem('管理')] } as never;
    expect((await connector().get(id(page))).area.title).toBe('食事管理');
  });

  it('fails without exactly one title property', async () => {
    const page = notion.seedPlainPage({ title: 'x', parentPageId: parent });
    notion.storedPages.get(page)!.properties = {};
    await expect(connector().get(id(page))).rejects.toThrow(ProviderApiError);
  });

  it('calls an untitled page "Untitled"', async () => {
    const page = notion.seedPlainPage({ title: '', parentPageId: parent });
    expect((await connector().get(id(page))).area.title).toBe('Untitled');
  });

  it('serves an archived page that is not in the trash, like list does', async () => {
    const page = notion.seedPlainPage({ title: 'Archived', parentPageId: parent, isArchived: true });
    expect(await connector().list({})).toEqual([areaOf(page, 'Archived')]);
    expect((await connector().get(id(page))).area).toEqual(areaOf(page, 'Archived'));
  });

  it.each(['trashed', 'inColumn', 'grandchild', 'elsewhere', 'collectionItem'] as const)(
    'reports the %s page as not found',
    async (key) => {
      const pages = mixedWorkspace();
      await expect(connector().get(id(pages[key]))).rejects.toThrow(new NotFoundError(`area ${id(pages[key])}`));
    },
  );

  it('reports a page that does not exist as not found', async () => {
    const missing = id('00000000-0000-4000-8000-999999999999');
    await expect(connector().get(missing)).rejects.toThrow(new NotFoundError(`area ${missing}`));
  });

  it('serves exactly the areas that list returns (same Notion state)', async () => {
    const pages = mixedWorkspace();
    const listed = (await connector().list({})).map((area) => area.id).sort();
    const gettable: string[] = [];
    for (const pageId of [...Object.values(pages), parent]) {
      const result = await connector().get(id(pageId)).catch(() => undefined);
      if (result) gettable.push(result.area.id);
    }
    expect(gettable.sort()).toEqual(listed);
  });

  it('rejects a malformed id before contacting Notion', async () => {
    await expect(connector().get('meals')).rejects.toThrow(InputValidationError);
    await expect(connector(undefined).get('meals')).rejects.toThrow(InputValidationError);
    expect(notion.calls).toEqual([]);
  });

  it('reads nested blocks up to three levels and notes the rest', async () => {
    const page = notion.seedPlainPage({ title: 'Deep', parentPageId: parent });
    notion.appendBlocks(page, [bullet('1', [bullet('2', [bullet('3', [bullet('4')])])])]);
    const { content } = await connector().get(id(page));
    expect(content).toBe(['- 1', '  - 2', '    - 3', '      [nested blocks not retrieved: depth limit 3]'].join('\n'));
    expect(notion.callsTo('blocks.children.list')).toHaveLength(3);
  });

  it('does not fetch the children of unsupported blocks and says so', async () => {
    const page = notion.seedPlainPage({ title: 'Table', parentPageId: parent });
    const [table] = notion.appendBlocks(page, [{ type: 'table', children: [{ type: 'table_row' }] }, { type: 'image' }]);
    const { content } = await connector().get(id(page));
    expect(content).toBe(
      [
        '[unsupported Notion block: table; its nested blocks were not retrieved]',
        '[unsupported Notion block: image]',
      ].join('\n'),
    );
    expect(notion.callsTo('blocks.children.list').map((call) => call.block_id)).not.toContain(table);
  });

  it('reads every page of the area blocks', async () => {
    notion.pageSize = 2;
    const page = notion.seedPlainPage({ title: 'Long', parentPageId: parent });
    notion.appendBlocks(page, ['a', 'b', 'c', 'd', 'e'].map((text) => paragraph(text)));
    expect((await connector().get(id(page))).content).toBe('a\nb\nc\nd\ne');
  });
});

describe('NotionAreaConnector errors', () => {
  it('requires the parent page id', async () => {
    const error = new ConfigurationError('sources.area.notion.parent_page_id is not set');
    await expect(connector(undefined).list({})).rejects.toThrow(error);
    await expect(connector(undefined).get(id(parent))).rejects.toThrow(error);
  });

  it.each([
    ['missing or not shared', () => '00000000-0000-4000-8000-999999999999'],
    ['in the trash', () => notion.seedPlainPage({ title: 'Old areas', inTrash: true })],
  ])('reports a parent page that is %s as a configuration error, from list and get', async (_, parentOf) => {
    const parentPageId = parentOf();
    const area = notion.seedPlainPage({ title: 'Meals', parentPageId });
    await expect(connector(parentPageId).list({})).rejects.toThrow(ConfigurationError);
    await expect(connector(parentPageId).get(id(area))).rejects.toThrow(ConfigurationError);
    await expect(connector(parentPageId).list({})).rejects.toThrow(/sources\.area\.notion\.parent_page_id/);
  });

  it('reports a rejected token as a credential error', async () => {
    notion.failNext('pages.retrieve', apiError(401, APIErrorCode.Unauthorized));
    await expect(connector().list({})).rejects.toThrow(CredentialError);
  });

  it.each([
    [429, APIErrorCode.RateLimited],
    [500, APIErrorCode.InternalServerError],
    [503, APIErrorCode.ServiceUnavailable],
  ])('reports HTTP %i as a provider error', async (status, code) => {
    notion.failNext('blocks.children.list', apiError(status, code));
    await expect(connector().list({})).rejects.toThrow(ProviderApiError);
  });

  it('fails the whole list when a later page of blocks fails', async () => {
    notion.pageSize = 1;
    notion.seedPlainPage({ title: 'a', parentPageId: parent });
    notion.seedPlainPage({ title: 'b', parentPageId: parent });
    notion.failures.set('blocks.children.list', [undefined as never, apiError(500, APIErrorCode.InternalServerError)]);
    await expect(connector().list({})).rejects.toThrow(ProviderApiError);
  });

  it('fails the whole get when a nested page of blocks fails', async () => {
    const page = notion.seedPlainPage({ title: 'Meals', parentPageId: parent });
    notion.appendBlocks(page, [bullet('a', [bullet('b')])]);
    notion.failures.set('blocks.children.list', [undefined as never, apiError(429, APIErrorCode.RateLimited)]);
    await expect(connector().get(id(page))).rejects.toThrow(ProviderApiError);
  });

  it('reports an area removed while its blocks are read as not found', async () => {
    const page = notion.seedPlainPage({ title: 'Meals', parentPageId: parent });
    notion.failNext('blocks.children.list', apiError(404, APIErrorCode.ObjectNotFound));
    await expect(connector().get(id(page))).rejects.toThrow(new NotFoundError(`area ${id(page)}`));
  });

  it('fails instead of dropping a block returned without its type', async () => {
    notion.seedPlainPage({ title: 'Meals', parentPageId: parent });
    notion.childBlocks.get(parent)!.push({ object: 'block', id: 'partial' });
    await expect(connector().list({})).rejects.toThrow(ProviderApiError);
  });
});
