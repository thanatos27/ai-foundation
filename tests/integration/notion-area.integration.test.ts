import { Client, isFullPage } from '@notionhq/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { NotionAreaConnector } from '../../src/connectors/notion/area-connector.js';
import { lazyNotionClient, NOTION_API_VERSION } from '../../src/connectors/notion/client.js';
import type { AreaResource } from '../../src/domain/index.js';
import { NotFoundError } from '../../src/errors.js';
import { credentials, enabled, hasEnv, integrationConfig } from './setup.js';

const run = enabled && hasEnv('NOTION_API_TOKEN');

/**
 * Read-only: nothing is created, changed or deleted. Needs sources.area.notion.parent_page_id in
 * config.local.yaml and at least one child page directly under that page (see README "Areas").
 * No page ID is written here: they come from the config and from area_list.
 */
describe.runIf(run)('Notion areas (real API)', () => {
  let connector: NotionAreaConnector;
  let raw: Client;
  let dataSourceId: string | undefined;
  let areas: AreaResource[];

  beforeAll(async () => {
    const config = await integrationConfig();
    const parentPageId = config.sources.area?.notion?.parent_page_id;
    if (!parentPageId) throw new Error('Set sources.area.notion.parent_page_id (e.g. in config.local.yaml)');
    dataSourceId = config.sources.collection.data_source_id;
    connector = new NotionAreaConnector({ client: lazyNotionClient(credentials), parentPageId });
    raw = new Client({ auth: await credentials.getNotionApiToken(), notionVersion: NOTION_API_VERSION });
    areas = await connector.list({});
  });

  it('lists at least one area, sorted by title', () => {
    expect(areas.length, 'create at least one child page under the Areas page').toBeGreaterThan(0);
    for (const area of areas) {
      expect(area).toMatchObject({ type: 'area', source: 'notion' });
      expect(area.id).toMatch(/^notion:[0-9a-f-]{36}$/);
      // Built from the id, so that list and get agree (the page URL itself is https://app.notion.com/p/...).
      expect(area.external_ref).toBe(`https://www.notion.so/${area.id.slice('notion:'.length).replaceAll('-', '')}`);
    }
    const titles = areas.map((area) => area.title.toLowerCase());
    expect(titles).toEqual([...titles].sort());
  });

  it('gets every listed area with the same title as the list', async () => {
    for (const area of areas) {
      const result = await connector.get(area.id);
      expect(result.area).toEqual(area);
      expect(typeof result.content).toBe('string');
    }
  });

  it('reads the title from the page property of type title', async () => {
    const [area] = areas;
    const page = await raw.pages.retrieve({ page_id: area!.id.slice('notion:'.length) });
    expect(isFullPage(page)).toBe(true);
    if (!isFullPage(page)) return;
    const titles = Object.values(page.properties).filter((property) => property.type === 'title');
    expect(titles).toHaveLength(1);
    expect(page.parent.type).toBe('page_id');
  });

  it('filters by part of a title', async () => {
    const [area] = areas;
    const query = [...area!.title].slice(0, 2).join('');
    expect((await connector.list({ query })).map((item) => item.id)).toContain(area!.id);
  });

  it('reports a collection page as not found', async (context) => {
    if (!dataSourceId) context.skip();
    const response = await raw.dataSources.query({ data_source_id: dataSourceId!, page_size: 1 });
    const [page] = response.results;
    if (!page) context.skip();
    await expect(connector.get(`notion:${page!.id}`)).rejects.toThrow(NotFoundError);
  });

  it('reports a page that does not exist as not found', async () => {
    await expect(connector.get('notion:00000000-0000-4000-8000-000000000000')).rejects.toThrow(NotFoundError);
  });
});
