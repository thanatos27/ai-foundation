import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config/schema.js';
import type { Connectors } from '../../src/connectors/types.js';
import { ConfigurationError, CredentialError, NotFoundError, ProviderApiError } from '../../src/errors.js';
import { createServer } from '../../src/server.js';
import { FakeAreaConnector, FakeProjectConnector } from '../helpers/fake-connectors.js';
import { connectClient, repoConfig, resultText } from '../helpers/mcp.js';

const AREA = {
  id: 'notion:0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  type: 'area' as const,
  title: '食事管理',
  source: 'notion' as const,
  external_ref: 'https://www.notion.so/0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d',
};

let connector: FakeAreaConnector;
let client: Client;

beforeEach(async () => {
  connector = new FakeAreaConnector();
  client = await connectClient({ area: connector });
});

afterEach(async () => {
  await client.close();
});

async function connectWith(config: Config, connectors: Connectors): Promise<Client> {
  const server = createServer({ config, connectors });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const other = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), other.connect(clientTransport)]);
  return other;
}

describe('area tools', () => {
  it('lists the two read-only area tools with their schemas', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    const list = byName.area_list;
    expect(list?.inputSchema).toMatchObject({ additionalProperties: false });
    expect(list?.inputSchema.required ?? []).toEqual([]);
    expect(Object.keys(list?.inputSchema.properties ?? {})).toEqual(['query']);
    expect(list?.description).toContain('project_list');
    expect(list?.description).toContain('area_get');

    const get = byName.area_get;
    expect(get?.inputSchema).toMatchObject({ required: ['id'], additionalProperties: false });
    expect(get?.description).toContain('notion:<page-id>');
    expect(get?.description).toContain('knowledge_get');
    expect(get?.description).toContain('project_get');
    expect(get?.description).toContain('not retrieved');

    for (const tool of [list, get]) {
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
      expect(tool?.outputSchema).toBeDefined();
    }
  });

  it('passes the filter to the connector and returns the items', async () => {
    connector.areas = [AREA];
    const result = await client.callTool({ name: 'area_list', arguments: { query: '食事' } });
    expect(result.isError).toBeFalsy();
    expect(connector.calls).toEqual([{ method: 'list', arg: { query: '食事' } }]);
    expect(result.structuredContent).toEqual({ items: [AREA] });
    expect(JSON.parse(resultText(result))).toEqual(result.structuredContent);
  });

  it('lists everything with an empty filter', async () => {
    const result = await client.callTool({ name: 'area_list', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(connector.calls).toEqual([{ method: 'list', arg: {} }]);
  });

  it.each([
    ['a blank query', { query: ' ' }],
    ['an unknown filter', { limit: 10 }],
  ])('rejects %s', async (_label, args) => {
    const result = await client.callTool({ name: 'area_list', arguments: args });
    expect(result.isError).toBe(true);
    expect(connector.calls).toEqual([]);
  });

  it('gets an area with its contents', async () => {
    connector.content = '## Knowledge\n- obsidian:Knowledge/栄養.md';
    const result = await client.callTool({ name: 'area_get', arguments: { id: AREA.id } });
    expect(result.isError).toBeFalsy();
    expect(connector.calls).toEqual([{ method: 'get', arg: AREA.id }]);
    expect(result.structuredContent).toEqual({
      area: { ...AREA, title: 'Area' },
      content: '## Knowledge\n- obsidian:Knowledge/栄養.md',
    });
    expect(JSON.parse(resultText(result))).toEqual(result.structuredContent);
  });

  it('rejects a get without an id', async () => {
    const result = await client.callTool({ name: 'area_get', arguments: {} });
    expect(result.isError).toBe(true);
    expect(connector.calls).toEqual([]);
  });

  it('reports a configuration error when sources.area is missing', async () => {
    const { area: _area, ...sources } = repoConfig.sources;
    const other = await connectWith({ ...repoConfig, sources }, { area: connector });
    try {
      for (const call of [
        { name: 'area_list', arguments: {} },
        { name: 'area_get', arguments: { id: AREA.id } },
      ]) {
        const result = await other.callTool(call);
        expect(result.isError).toBe(true);
        expect(resultText(result)).toContain('Configuration error: sources.area is not configured');
      }
      expect(connector.calls).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it('reports a configuration error when no connector is wired', async () => {
    const other = await connectWith(repoConfig, {});
    try {
      const result = await other.callTool({ name: 'area_list', arguments: {} });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('Configuration error: the area source (Notion) is not configured');
    } finally {
      await other.close();
    }
  });

  it.each([
    new ConfigurationError('sources.area.notion.parent_page_id is not set'),
    new CredentialError('Notion rejected the API token (HTTP 401)'),
    new NotFoundError(`area ${AREA.id}`),
    new ProviderApiError('Notion', 'HTTP 429 rate_limited: slow down'),
  ])('returns the connector error as a tool error: %s', async (error) => {
    connector.failWith = error;
    const result = await client.callTool({ name: 'area_get', arguments: { id: AREA.id } });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(error.message);
  });

  it('keeps the project tools independent of the area tools', async () => {
    const project = new FakeProjectConnector();
    const other = await connectWith(repoConfig, { project });
    try {
      expect((await other.callTool({ name: 'project_list', arguments: {} })).isError).toBeFalsy();
      expect((await other.callTool({ name: 'area_list', arguments: {} })).isError).toBe(true);
    } finally {
      await other.close();
    }
  });
});
