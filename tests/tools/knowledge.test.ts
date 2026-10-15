import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config/schema.js';
import type { Connectors } from '../../src/connectors/types.js';
import { ConfigurationError, NotFoundError, ProviderApiError } from '../../src/errors.js';
import { createServer } from '../../src/server.js';
import { FakeKnowledgeConnector } from '../helpers/fake-connectors.js';
import { connectClient, repoConfig, resultText } from '../helpers/mcp.js';

const ID = 'obsidian:AI Foundation/Knowledge/CAP定理.md';

let connector: FakeKnowledgeConnector;
let client: Client;

beforeEach(async () => {
  connector = new FakeKnowledgeConnector();
  client = await connectClient({ knowledge: connector });
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

describe('knowledge tools', () => {
  it('lists the four knowledge tools with their schemas and annotations', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    const create = byName.knowledge_create;
    expect(create?.inputSchema).toMatchObject({ required: ['title', 'content'], additionalProperties: false });
    const source = (create?.inputSchema.properties as Record<string, { enum?: string[] }>).source;
    expect(source?.enum).toEqual(['auto', 'obsidian']);
    expect(create?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(create?.description).toContain('knowledge_append');
    expect(create?.description).toContain(`area defaults to "${repoConfig.defaults.area}"`);

    expect(byName.knowledge_search?.inputSchema).toMatchObject({ additionalProperties: false });
    expect(byName.knowledge_search?.inputSchema.required ?? []).toEqual([]);
    expect(byName.knowledge_search?.annotations).toMatchObject({ readOnlyHint: true });

    expect(byName.knowledge_get?.inputSchema).toMatchObject({ required: ['id'], additionalProperties: false });
    expect(byName.knowledge_get?.annotations).toMatchObject({ readOnlyHint: true });

    expect(byName.knowledge_append?.inputSchema).toMatchObject({ required: ['id', 'content'], additionalProperties: false });
    expect(byName.knowledge_append?.annotations).toMatchObject({ destructiveHint: false, idempotentHint: false });

    for (const name of ['knowledge_create', 'knowledge_search', 'knowledge_get', 'knowledge_append']) {
      expect(byName[name]?.outputSchema).toBeDefined();
    }
  });

  it('creates knowledge with the default area when area is omitted', async () => {
    const result = await client.callTool({
      name: 'knowledge_create',
      arguments: { title: 'CAP定理', content: '本文', tags: ['database'] },
    });
    expect(result.isError).toBeFalsy();
    expect(connector.calls).toEqual([
      { method: 'create', arg: { title: 'CAP定理', content: '本文', tags: ['database'], area: repoConfig.defaults.area } },
    ]);
    expect(result.structuredContent).toMatchObject({ knowledge: { id: ID, source: 'obsidian', title: 'CAP定理' } });
    expect(JSON.parse(resultText(result))).toEqual(result.structuredContent);
  });

  it.each([
    ['null area means none', { area: null }, { area: null }],
    ['an explicit area', { area: 'work' }, { area: 'work' }],
    ['source auto', { source: 'auto' }, { area: repoConfig.defaults.area }],
    ['source obsidian', { source: 'obsidian', description: '説明' }, { area: repoConfig.defaults.area, description: '説明' }],
  ])('resolves %s before calling the connector', async (_label, extra, expected) => {
    const result = await client.callTool({ name: 'knowledge_create', arguments: { title: 't', content: 'c', ...extra } });
    expect(result.isError).toBeFalsy();
    expect(connector.calls).toEqual([{ method: 'create', arg: { title: 't', content: 'c', ...expected } }]);
  });

  it('passes search filters through unchanged and returns snippets', async () => {
    await connector.create({ title: 'CAP定理', content: 'x', area: 'personal' });
    const filter = { query: 'CAP', area: null, tags: ['distributed-systems'] };
    const result = await client.callTool({ name: 'knowledge_search', arguments: filter });
    expect(result.isError).toBeFalsy();
    expect(connector.calls.at(-1)).toEqual({ method: 'search', arg: filter });
    expect(result.structuredContent).toMatchObject({ items: [{ id: ID, snippet: 'snippet' }] });
  });

  it('searches with an empty filter', async () => {
    const result = await client.callTool({ name: 'knowledge_search', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ items: [] });
  });

  it('gets metadata and the full body by exact id', async () => {
    const result = await client.callTool({ name: 'knowledge_get', arguments: { id: ID } });
    expect(result.isError).toBeFalsy();
    expect(connector.calls).toEqual([{ method: 'get', arg: ID }]);
    expect(result.structuredContent).toMatchObject({ knowledge: { id: ID }, content: 'full body\n' });
  });

  it('appends by exact id', async () => {
    const args = { id: ID, content: 'PACELCについても関連して調べた。' };
    const result = await client.callTool({ name: 'knowledge_append', arguments: args });
    expect(result.isError).toBeFalsy();
    expect(connector.calls).toEqual([{ method: 'append', arg: args }]);
    expect(result.structuredContent).toMatchObject({ knowledge: { id: ID } });
  });

  it.each([
    ['knowledge_create', { content: 'x' }],
    ['knowledge_create', { title: 'x' }],
    ['knowledge_create', { title: ' ', content: 'x' }],
    ['knowledge_create', { title: 'x', content: '' }],
    ['knowledge_create', { title: 'x', content: 'y', source: 'google_drive' }],
    ['knowledge_create', { title: 'x', content: 'y', path: 'a.md' }],
    ['knowledge_search', { query: '' }],
    ['knowledge_search', { source: 'obsidian' }],
    ['knowledge_get', {}],
    ['knowledge_get', { title: 'CAP定理' }],
    ['knowledge_append', { id: ID }],
    ['knowledge_append', { id: ID, content: '  ' }],
  ])('rejects invalid %s input without calling the connector: %j', async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('Input validation error');
    expect(connector.calls).toEqual([]);
  });

  it.each([
    [new NotFoundError(`knowledge "${ID}" was not found`), `Not found: knowledge "${ID}" was not found`],
    [new ProviderApiError('Obsidian', 'the frontmatter is malformed'), 'Obsidian API error: the frontmatter is malformed'],
    [
      new ConfigurationError('sources.knowledge.obsidian.vault_path is not set'),
      'Configuration error: sources.knowledge.obsidian.vault_path is not set',
    ],
  ])('returns connector errors as tool errors: %s', async (error, message) => {
    connector.failWith = error;
    const result = await client.callTool({ name: 'knowledge_get', arguments: { id: ID } });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe(message);
  });
});

describe('knowledge source resolution', () => {
  it('fails when the configured default is not Obsidian', async () => {
    const config: Config = {
      ...repoConfig,
      sources: { ...repoConfig.sources, knowledge: { default: 'google_drive', providers: ['obsidian', 'google_drive'] } },
    };
    const fake = new FakeKnowledgeConnector();
    const other = await connectWith(config, { knowledge: fake });
    try {
      const auto = await other.callTool({ name: 'knowledge_create', arguments: { title: 't', content: 'c' } });
      expect(auto.isError).toBe(true);
      expect(resultText(auto)).toBe(
        'Configuration error: the knowledge source "google_drive" is not available in this version (only obsidian)',
      );
      const explicit = await other.callTool({
        name: 'knowledge_create',
        arguments: { title: 't', content: 'c', source: 'obsidian' },
      });
      expect(explicit.isError).toBeFalsy();
      expect(fake.calls.map((call) => call.method)).toEqual(['create']);
    } finally {
      await other.close();
    }
  });

  it('fails when Obsidian is not an enabled provider', async () => {
    const config: Config = {
      ...repoConfig,
      sources: { ...repoConfig.sources, knowledge: { default: 'google_drive', providers: ['google_drive'] } },
    };
    const fake = new FakeKnowledgeConnector();
    const other = await connectWith(config, { knowledge: fake });
    try {
      const result = await other.callTool({ name: 'knowledge_search', arguments: {} });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('Configuration error');
      expect(fake.calls).toEqual([]);
    } finally {
      await other.close();
    }
  });
});

describe('knowledge tools without a connector', () => {
  it('are still listed and return a configuration error', async () => {
    const bare = await connectClient({});
    try {
      const { tools } = await bare.listTools();
      expect(tools.map((tool) => tool.name)).toContain('knowledge_create');
      const result = await bare.callTool({ name: 'knowledge_search', arguments: {} });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toBe('Configuration error: the knowledge source (Obsidian) is not configured');
    } finally {
      await bare.close();
    }
  });
});
